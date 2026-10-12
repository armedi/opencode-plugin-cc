// Session-level auto-heal for tracked jobs.
//
// Background: task-worker subprocesses wrap `client.sendPrompt(sid, ...)` in
// runTrackedJob so that on successful return the job flips status→completed
// and the response text is persisted to jobDataPath. But sendPrompt can hang
// or the worker can be killed before that return happens — even though the
// OpenCode session itself completed cleanly server-side. The job then stays
// in a non-terminal state ("investigating"/"running") forever and downstream
// Monitor scripts never see the true finish.
//
// This module provides a best-effort reconciliation pass: given a job with
// an `opencodeSessionId`, query the V2 session outcome and active drain state.
// Persist completed results, surface failed/interrupted outcomes, and never
// confuse a completed tool-call message or a dead worker with session completion.
//
// All functions are no-ops (or log to stderr and return the original job)
// when the server is unreachable, so callers can sprinkle autoHealJob at
// the top of status-reading paths without wrapping in try/catch themselves.

import fs from "node:fs";
import path from "node:path";

import { ensureDir } from "./fs.mjs";
import { upsertJob, jobDataPath } from "./state.mjs";
import { connect, createClient } from "./opencode-server.mjs";

/**
 * Query V2 session completion without starting an unavailable service.
 * @param {string} sessionId
 * @param {number} startedAtMs - epoch ms; only treat completions >= this as ours
 * @param {object} [opts]
 */
export async function probeSessionTerminal(sessionId, startedAtMs, opts = {}) {
  try {
    const client = opts.baseUrl
      ? createClient(opts.baseUrl, { directory: opts.cwd, headers: opts.headers })
      : await connect({ start: false, cwd: opts.cwd });
    const result = await client.readSessionResult(sessionId, startedAtMs);
    return { ...result, reachable: true };
  } catch (err) {
    return { terminal: false, reachable: false, error: err.message };
  }
}

/**
 * Fetch the session's last activity summary for display in `status` output.
 * Never throws — returns null on any failure (unreachable, bad response).
 *
 * Return shape:
 *   null                                         — server unreachable / no info
 *   { kind:"tool", tool, command, ageSec }       — last part is a tool call
 *   { kind:"text", text, ageSec }                — last part is text
 *   { kind:"none", ageSec }                      — session has info but empty parts
 *
 * @param {string} sessionId
 * @param {object} [opts]
 * @returns {Promise<object|null>}
 */
export async function getSessionLastActivity(sessionId, opts = {}) {
  if (!sessionId) return null;
  try {
    const client = await connect({ start: false, cwd: opts.cwd });
    const arr = await client.getMessages(sessionId, { limit: 1, type: "assistant" });
    const last = arr[0];
    if (!last) return null;
    const info = last;
    const parts = Array.isArray(last.content) ? last.content : [];

    const updatedMs = Math.max(
      typeof info?.time?.completed === "number" ? info.time.completed : 0,
      typeof info?.time?.created === "number" ? info.time.created : 0,
    );
    const ageSec = updatedMs ? Math.max(0, Math.floor((Date.now() - updatedMs) / 1000)) : null;

    // Walk backwards to find the most recent meaningful part.
    for (let i = parts.length - 1; i >= 0; i--) {
      const p = parts[i];
      if (!p) continue;
      if (p.type === "tool") {
        const tool = p.tool || "tool";
        let command = "";
        const input = p.state?.input || p.input || {};
        if (tool === "shell") command = String(input.command || input.cmd || "");
        else if (tool === "edit" || tool === "write") command = String(input.filePath || input.file_path || input.path || "");
        else if (tool === "read") command = String(input.filePath || input.file_path || input.path || "");
        else command = JSON.stringify(input).slice(0, 120);
        return { kind: "tool", tool, command: command.slice(0, 80), ageSec };
      }
      if (p.type === "text" && typeof p.text === "string" && p.text.trim()) {
        return { kind: "text", text: p.text.trim().slice(0, 80), ageSec };
      }
    }
    return { kind: "none", ageSec };
  } catch {
    return null;
  }
}

/**
 * Parse an ISO-ish timestamp that might be a number or string. Returns epoch ms, or 0.
 */
function toEpochMs(v) {
  if (v == null) return 0;
  if (typeof v === "number") return v < 1e12 ? v * 1000 : v; // tolerate seconds
  const t = new Date(v).getTime();
  return Number.isFinite(t) ? t : 0;
}

/**
 * Attempt to auto-heal a single job. Mutates persistent state via upsertJob
 * on transitions. Returns the up-to-date job record (healed or not).
 *
 * @param {string} workspace
 * @param {object} job
 * @param {object} [opts]
 * @param {string} [opts.baseUrl]
 * @param {boolean} [opts.dryRun] - when true, do not write state; return `{job, action, details}`
 */
export async function autoHealJob(workspace, job, opts = {}) {
  const dryRun = !!opts.dryRun;
  const HEALABLE = new Set(["starting", "investigating", "running", "finalizing"]);

  if (!job || !job.opencodeSessionId) {
    return { job, action: "skip", reason: "no opencodeSessionId" };
  }
  if (!HEALABLE.has(job.status)) {
    return { job, action: "skip", reason: `status=${job.status} not healable` };
  }

  const startedAtMs =
    toEpochMs(job.startedAt) ||
    toEpochMs(job.createdAt) ||
    toEpochMs(job.updatedAt) ||
    0;

  const probe = await probeSessionTerminal(job.opencodeSessionId, startedAtMs, { ...opts, cwd: workspace });

  if (probe.terminal && probe.outcome !== "succeeded") {
    const errorMessage = probe.error || `OpenCode session ${probe.outcome || "failed"}`;
    if (dryRun) return { job, action: "would-fail", details: { errorMessage } };
    upsertJob(workspace, { id: job.id, status: "failed", errorMessage, completedAt: new Date(probe.completed).toISOString(), healed: true });
    return { job: { ...job, status: "failed", errorMessage, healed: true }, action: "healed-failed", details: { errorMessage } };
  }

  if (probe.terminal) {
    const completedIso = new Date(probe.completed).toISOString();
    const summary = (probe.text || "").slice(0, 500);
    if (dryRun) {
      return {
        job,
        action: "would-complete",
        details: {
          finish: probe.finish,
          completedAt: completedIso,
          textLen: (probe.text || "").length,
        },
      };
    }

    // Persist the result payload to disk so handleResult can surface it.
    try {
      const dataFile = jobDataPath(workspace, job.id);
      ensureDir(path.dirname(dataFile));
      const payload = {
        rendered: probe.text,
        summary,
        healed: true,
        finish: probe.finish,
      };
      fs.writeFileSync(dataFile, JSON.stringify(payload, null, 2), "utf8");
    } catch (err) {
      // Non-fatal: the status transition below is still useful.
      process.stderr.write(`auto-heal: failed to write data file for ${job.id}: ${err.message}\n`);
    }

    upsertJob(workspace, {
      id: job.id,
      status: "completed",
      completedAt: completedIso,
      phase: "completed",
      result: summary || job.result || null,
      healed: true,
      finish: probe.finish,
    });
    return {
      job: { ...job, status: "completed", completedAt: completedIso, result: summary, healed: true, finish: probe.finish },
      action: "healed-completed",
      details: { finish: probe.finish, textLen: (probe.text || "").length },
    };
  }

  // A dead companion worker does not imply a dead V2 server-side session.
  // Keep jobs resumable when the service is unavailable or still running.
  if (!probe.reachable) {
    return { job, action: "skip", reason: `server unreachable: ${probe.error}` };
  }

  return { job, action: "skip", reason: "session has not completed this job" };
}

/**
 * Auto-heal a list of jobs, returning the (possibly updated) jobs in the same
 * order, plus a list of heal actions for reporting.
 *
 * @param {string} workspace
 * @param {object[]} jobs
 * @param {object} [opts]
 * @returns {Promise<{ jobs: object[], actions: object[] }>}
 */
export async function autoHealJobs(workspace, jobs, opts = {}) {
  const actions = [];
  const out = [];
  for (const j of jobs ?? []) {
    try {
      const r = await autoHealJob(workspace, j, opts);
      out.push(r.job ?? j);
      if (r.action && r.action !== "skip") {
        actions.push({ id: j.id, action: r.action, details: r.details });
      }
    } catch (err) {
      // Auto-heal must never crash the caller.
      process.stderr.write(`auto-heal: ${j.id} errored: ${err.message}\n`);
      out.push(j);
    }
  }
  return { jobs: out, actions };
}
