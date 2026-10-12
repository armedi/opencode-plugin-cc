#!/usr/bin/env node

// Stop review gate hook for the OpenCode companion.
// When enabled, asks OpenCode to review the previous Claude turn before the
// session stops. The built-in /review command is not used here: that command
// reviews git state, and this gate reviews one Claude turn.

import process from "node:process";
import fs from "node:fs";
import path from "node:path";
import { resolveWorkspace } from "./lib/workspace.mjs";
import { loadState } from "./lib/state.mjs";
import { isServerRunning, connect, extractResponseText } from "./lib/opencode-server.mjs";

const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT || path.resolve(import.meta.dirname, "..");
const ACTIVE_JOB = new Set(["pending", "queued", "running", "starting", "investigating", "finalizing"]);

function readHookInput() {
  const raw = fs.readFileSync(0, "utf8").trim();
  if (!raw) return {};
  return JSON.parse(raw);
}

function runningTaskNote(state, sessionId) {
  const jobs = state.jobs ?? [];
  const running = jobs.find((job) => ACTIVE_JOB.has(job.status) && (!sessionId || job.sessionId === sessionId));
  return running
    ? `OpenCode task ${running.id} is still running. Check /opencode:status and use /opencode:cancel ${running.id} if you want to stop it before ending the session.`
    : null;
}

function buildStopReviewPrompt(input) {
  const lastAssistantMessage = String(input.last_assistant_message ?? "").trim();
  const template = fs.readFileSync(path.join(PLUGIN_ROOT, "prompts", "stop-review-gate.md"), "utf8");
  const block = lastAssistantMessage ? ["Previous Claude response:", lastAssistantMessage].join("\n") : "";
  return template.replaceAll("{{CLAUDE_RESPONSE_BLOCK}}", block);
}

function parseStopReviewOutput(raw) {
  const text = String(raw ?? "").trim();
  if (!text) {
    return { ok: false, reason: "The stop-time OpenCode review returned no final output. Run /opencode:review manually or bypass the gate." };
  }
  const firstLine = text.split(/\r?\n/, 1)[0].trim();
  if (firstLine.startsWith("ALLOW:")) return { ok: true, reason: null };
  if (firstLine.startsWith("BLOCK:")) {
    const reason = firstLine.slice("BLOCK:".length).trim() || text;
    return {
      ok: false,
      reason: `OpenCode stop-time review found issues that still need fixes before ending the session: ${reason}`,
    };
  }
  return {
    ok: false,
    reason: "The stop-time OpenCode review returned an unexpected answer. Run /opencode:review manually or bypass the gate.",
  };
}

function emitDecision(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function logNote(message) {
  if (message) process.stderr.write(`${message}\n`);
}

async function main() {
  const input = readHookInput();
  const workspace = await resolveWorkspace(input.cwd || process.env.CLAUDE_PROJECT_DIR);
  const state = loadState(workspace);
  const note = runningTaskNote(state, input.session_id);

  if (!state.config?.reviewGate) {
    logNote(note);
    return;
  }

  if (!(await isServerRunning())) {
    logNote("OpenCode is not set up for the review gate. Run /opencode:setup.");
    logNote(note);
    return;
  }

  try {
    const client = await connect({ cwd: workspace });
    const session = await client.createSession({ title: "Stop Review Gate", readOnly: true, allowShell: true });
    const response = await client.sendPrompt(session.id, buildStopReviewPrompt(input), {
      agent: "plan",
      allowShell: true,
    });
    const verdict = parseStopReviewOutput(extractResponseText(response));
    if (!verdict.ok) {
      emitDecision({ decision: "block", reason: note ? `${note} ${verdict.reason}` : verdict.reason });
      return;
    }
    logNote(note);
  } catch (err) {
    const reason = `The stop-time OpenCode review failed: ${err.message}`;
    emitDecision({ decision: "block", reason: note ? `${note} ${reason}` : reason });
  }
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
