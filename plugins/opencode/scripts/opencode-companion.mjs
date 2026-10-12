#!/usr/bin/env node

// OpenCode Companion - Main entry point for the Claude Code plugin.
// Mirrors the codex-plugin-cc codex-companion.mjs architecture but uses
// OpenCode's HTTP REST API instead of JSON-RPC over stdin/stdout.

import path from "node:path";
import process from "node:process";
import fs from "node:fs";

import { parseArgs, extractTaskText } from "./lib/args.mjs";
import { isOpencodeInstalled, getOpencodeVersion, spawnDetached } from "./lib/process.mjs";
import { isServerRunning, discoverServer, connect, extractResponseText } from "./lib/opencode-server.mjs";
import { resolveWorkspace } from "./lib/workspace.mjs";
import { loadState, updateState, upsertJob, generateJobId, jobDataPath, jobLogPath } from "./lib/state.mjs";
import { buildStatusSnapshot, resolveResultJob, resolveCancelableJob, enrichJob, matchJobReference } from "./lib/job-control.mjs";
import { createJobRecord, runTrackedJob, getClaudeSessionId } from "./lib/tracked-jobs.mjs";
import { renderStatus, renderResult, renderReview, renderNativeReview, renderSetup } from "./lib/render.mjs";
import { buildAdversarialReviewPrompt } from "./lib/prompts.mjs";
import { readJson } from "./lib/fs.mjs";
import { autoHealJob, autoHealJobs, getSessionLastActivity } from "./lib/auto-heal.mjs";
import { stateRoot } from "./lib/state.mjs";
import { runCommand } from "./lib/process.mjs";

const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT || path.resolve(import.meta.dirname, "..");

// ------------------------------------------------------------------
// Subcommand dispatch
// ------------------------------------------------------------------

const [subcommand, ...argv] = process.argv.slice(2);

const handlers = {
  setup: handleSetup,
  review: handleReview,
  "adversarial-review": handleAdversarialReview,
  task: handleTask,
  "task-worker": handleTaskWorker,
  "task-resume-candidate": handleTaskResumeCandidate,
  status: handleStatus,
  result: handleResult,
  "wait-and-result": handleWaitAndResult,
  cancel: handleCancel,
  heal: handleHeal,
  doctor: handleDoctor,
  config: handleConfig,
};

const handler = handlers[subcommand];
if (!handler) {
  console.error(`Unknown subcommand: ${subcommand}`);
  console.error(`Available: ${Object.keys(handlers).join(", ")}`);
  process.exit(1);
}

handler(argv).catch((err) => {
  console.error(`Error in ${subcommand}: ${err.message}`);
  process.exit(1);
});

// ------------------------------------------------------------------
// Setup
// ------------------------------------------------------------------

async function handleSetup(argv) {
  const { options } = parseArgs(argv, {
    booleanOptions: ["json", "enable-review-gate", "disable-review-gate"],
  });

  const installed = await isOpencodeInstalled();
  const version = installed ? await getOpencodeVersion() : null;

  let serverRunning = false;
  let providers = [];

  if (installed) {
    serverRunning = await isServerRunning();

    if (serverRunning) {
      try {
        const client = await connect({ start: false, cwd: process.cwd() });
        const providerList = await client.listProviders();
        providers = providerList.data.map((p) => p.id);
      } catch {
        // Server may not be fully ready
      }
    }
  }

  // Handle review gate toggle
  const workspace = await resolveWorkspace();
  let reviewGate = false;

  if (options["enable-review-gate"]) {
    updateState(workspace, (state) => {
      state.config = state.config || {};
      state.config.reviewGate = true;
    });
    reviewGate = true;
  } else if (options["disable-review-gate"]) {
    updateState(workspace, (state) => {
      state.config = state.config || {};
      state.config.reviewGate = false;
    });
    reviewGate = false;
  } else {
    const state = loadState(workspace);
    reviewGate = state.config?.reviewGate ?? false;
  }

  const status = { installed, version, serverRunning, providers, reviewGate };

  if (options.json) {
    console.log(JSON.stringify(status, null, 2));
  } else {
    console.log(renderSetup(status));
  }
}

// ------------------------------------------------------------------
// Review
// ------------------------------------------------------------------

const REVIEW_SCOPES = new Set(["auto", "working-tree", "branch"]);

// Permissions for a review session. Plan denies edits. Shell and subagents
// stay available because OpenCode's /review command runs git and may call Explore.
const REVIEW_SESSION = { readOnly: true, allowShell: true, allowSubagent: true };
const REVIEW_PROMPT = { agent: "plan", allowShell: true, allowSubagent: true };

async function resolveReviewTarget(client, options) {
  const scope = options.scope ?? "auto";
  if (!REVIEW_SCOPES.has(scope)) {
    throw new Error(`Unsupported review scope "${scope}". Use one of: auto, working-tree, branch, or pass --base <ref>.`);
  }
  if (options.base) {
    return { kind: "branch", base: options.base, label: `branch diff against ${options.base}`, commandText: options.base };
  }
  if (scope === "working-tree") {
    return { kind: "working", label: "working tree changes", commandText: "" };
  }
  if (scope === "auto") {
    const status = await client.vcsStatus();
    if (status.length > 0) {
      return { kind: "working", label: "working tree changes", commandText: "", status };
    }
  }
  const base = await client.vcsBase();
  if (!base?.name) {
    throw new Error("Unable to detect the repository review base. Pass --base <ref> or use --scope working-tree.");
  }
  return { kind: "branch", base: base.name, label: `branch diff against ${base.name}`, commandText: base.name };
}

async function withReviewSession(workspace, job, title, run) {
  return runTrackedJob(workspace, job, async ({ report, log }) => {
    report("starting", "Connecting to OpenCode server...");
    const client = await connect({ cwd: workspace });
    report("reviewing", "Creating review session...");
    const session = await client.createSession({ title, ...REVIEW_SESSION });
    upsertJob(workspace, { id: job.id, opencodeSessionId: session.id });
    return run({ client, session, report, log });
  });
}

async function handleReview(argv) {
  const { options, positional } = parseArgs(argv, {
    valueOptions: ["base", "scope"],
    booleanOptions: ["wait", "background"],
  });

  const focus = positional.join(" ").trim();
  if (focus) {
    console.error(`\`/opencode:review\` uses OpenCode's built-in /review and does not support custom focus text. Retry with \`/opencode:adversarial-review ${focus}\`.`);
    process.exit(1);
  }

  const workspace = await resolveWorkspace();
  const job = createJobRecord(workspace, "review", { base: options.base });

  try {
    const result = await withReviewSession(workspace, job, `Code Review ${job.id}`, async ({ client, session, report, log }) => {
      const target = await resolveReviewTarget(client, options);
      report("reviewing", "Running OpenCode /review...");
      log(`Built-in /review target: ${target.label}`);

      const response = await client.sendCommand(session.id, "review", target.commandText, REVIEW_PROMPT);
      report("finalizing", "Processing review output...");
      return { rendered: renderNativeReview(extractResponseText(response), target) };
    });

    console.log(result.rendered);
  } catch (err) {
    console.error(`Review failed: ${err.message}`);
    process.exit(1);
  }
}

async function handleAdversarialReview(argv) {
  const { options, positional } = parseArgs(argv, {
    valueOptions: ["base", "scope"],
    booleanOptions: ["wait", "background"],
  });

  const focus = positional.join(" ").trim();
  const workspace = await resolveWorkspace();
  const job = createJobRecord(workspace, "adversarial-review", {
    base: options.base,
    focus,
  });

  try {
    const result = await withReviewSession(workspace, job, `Adversarial Review ${job.id}`, async ({ client, session, report, log }) => {
      const target = await resolveReviewTarget(client, options);
      const diffs = await client.vcsDiff(target.kind === "branch"
        ? { mode: "committed", base: target.base }
        : { mode: "working" });
      const files = target.kind === "working" ? (target.status ?? await client.vcsStatus()) : diffs;
      const prompt = buildAdversarialReviewPrompt(PLUGIN_ROOT, {
        targetLabel: target.label,
        focus,
        files,
        diffs,
      });

      report("reviewing", "Running adversarial review...");
      log(`Prompt length: ${prompt.length} chars, focus: ${focus || "(none)"}`);

      const response = await client.sendPrompt(session.id, prompt, REVIEW_PROMPT);
      report("finalizing", "Processing review output...");

      const text = extractResponseText(response);
      const structured = tryParseJson(text);
      return {
        rendered: structured ? renderReview(structured) : text,
        raw: response,
        structured,
      };
    });

    console.log(result.rendered);
  } catch (err) {
    console.error(`Adversarial review failed: ${err.message}`);
    process.exit(1);
  }
}

// ------------------------------------------------------------------
// Task (rescue delegation)
// ------------------------------------------------------------------

async function handleTask(argv) {
  const { options, positional } = parseArgs(argv, {
    valueOptions: ["model", "agent"],
    booleanOptions: ["write", "background", "wait", "resume-last", "fresh"],
  });

  const taskText = extractTaskText(argv, ["model", "agent"], [
    "write", "background", "wait", "resume-last", "fresh",
  ]);

  if (!taskText) {
    console.error("No task text provided.");
    process.exit(1);
  }

  const workspace = await resolveWorkspace();
  const isWrite = options.agent === "plan" ? false : options.write !== undefined ? options.write : true;
  const agentName = options.agent ?? (isWrite ? "build" : "plan");

  // Check for resume
  let resumeSessionId = null;
  if (options["resume-last"]) {
    const state = loadState(workspace);
    const sessionId = getClaudeSessionId();
    const lastTask = state.jobs
      ?.filter((j) => j.type === "task" && j.opencodeSessionId)
      ?.filter((j) => !sessionId || j.sessionId === sessionId)
      ?.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))?.[0];

    if (lastTask?.opencodeSessionId) {
      resumeSessionId = lastTask.opencodeSessionId;
    }
  }

  const job = createJobRecord(workspace, "task", {
    agent: agentName,
    resumeSessionId,
  });

  // Background mode: spawn a detached worker
  if (options.background) {
    const logFile = jobLogPath(workspace, job.id);
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    upsertJob(workspace, {
      id: job.id,
      status: "queued",
      phase: "queued",
      logFile,
      request: {
        taskText,
        agentName,
        isWrite,
        resumeSessionId,
        model: options.model,
      },
    });

    const workerArgs = [
      path.join(PLUGIN_ROOT, "scripts", "opencode-companion.mjs"),
      "task-worker",
      "--job-id", job.id,
      "--workspace", workspace,
      "--task-text", taskText,
      "--agent", agentName,
    ];
    if (isWrite) workerArgs.push("--write");
    if (resumeSessionId) workerArgs.push("--resume-session", resumeSessionId);
    if (options.model) workerArgs.push("--model", options.model);

    const child = spawnDetached("node", workerArgs, { cwd: workspace, logFile });
    upsertJob(workspace, { id: job.id, pid: child.pid });
    console.log(`OpenCode task started in background: ${job.id}`);
    console.log("Check `/opencode:status` for progress.");
    return;
  }

  // Foreground mode
  try {
    const result = await runTrackedJob(workspace, job, async ({ report, log }) => {
      report("starting", "Connecting to OpenCode server...");
      const client = await connect({ cwd: workspace });

      let sessionId;
      if (resumeSessionId) {
        report("starting", `Resuming OpenCode session ${resumeSessionId}...`);
        sessionId = resumeSessionId;
      } else {
        report("starting", "Creating new OpenCode session...");
        const session = await client.createSession({ title: `Task ${job.id}`, readOnly: !isWrite });
        sessionId = session.id;
      }
      upsertJob(workspace, { id: job.id, opencodeSessionId: sessionId });

      report("investigating", "Sending task to OpenCode...");
      log(`Agent: ${agentName}, Write: ${isWrite}, Prompt: ${taskText.length} chars`);

      const response = await client.sendPrompt(sessionId, taskText, {
        agent: agentName,
        model: options.model,
        readOnly: !isWrite,
      });

      report("finalizing", "Processing task output...");

      const text = extractResponseText(response);

      // Get changed files if write mode
      let changedFiles = [];
      if (isWrite) {
        try {
          const diff = await client.getSessionDiff(sessionId);
          changedFiles = diff.map((f) => f.file).filter(Boolean);
        } catch {
          // diff endpoint may not be available
        }
      }

      return {
        rendered: text,
        messages: response,
        changedFiles,
        summary: text.slice(0, 500),
      };
    });

    console.log(result.rendered);
  } catch (err) {
    console.error(`Task failed: ${err.message}`);
    process.exit(1);
  }
}

async function handleTaskWorker(argv) {
  const { options } = parseArgs(argv, {
    valueOptions: ["job-id", "workspace", "task-text", "agent", "model", "resume-session"],
    booleanOptions: ["write"],
  });

  const workspace = options.workspace;
  const jobId = options["job-id"];
  const taskText = options["task-text"];
  const agentName = options.agent ?? "build";
  const isWrite = !!options.write;
  const resumeSessionId = options["resume-session"];

  if (!workspace || !jobId || !taskText) {
    process.exit(1);
  }

  try {
    await runTrackedJob(workspace, { id: jobId }, async ({ report, log }) => {
      report("starting", "Background worker connecting to OpenCode...");
      const client = await connect({ cwd: workspace });

      let sessionId;
      if (resumeSessionId) {
        sessionId = resumeSessionId;
        report("starting", `Resuming session ${resumeSessionId}...`);
      } else {
        const session = await client.createSession({ title: `Task ${jobId}`, readOnly: !isWrite });
        sessionId = session.id;
        report("starting", `Created session ${sessionId}`);
      }
      upsertJob(workspace, { id: jobId, opencodeSessionId: sessionId });

      report("investigating", "Running task...");

      const response = await client.sendPrompt(sessionId, taskText, {
        agent: agentName,
        model: options.model,
        readOnly: !isWrite,
      });

      const text = extractResponseText(response);
      report("finalizing", "Done");

      return { rendered: text, summary: text.slice(0, 500) };
    });
  } catch (err) {
    // Error is already logged by runTrackedJob
    process.exit(1);
  }
}

async function handleTaskResumeCandidate(argv) {
  const { options } = parseArgs(argv, { booleanOptions: ["json"] });

  const workspace = await resolveWorkspace();
  let state = loadState(workspace);
  const sessionId = getClaudeSessionId();

  // Heal first so "latest completed" reflects session reality, not a stale
  // "running" flag from a dead worker.
  const healable = (state.jobs ?? []).filter(
    (j) => j.type === "task" && j.opencodeSessionId &&
      ["starting", "investigating", "running", "finalizing"].includes(j.status),
  );
  if (healable.length > 0) {
    await autoHealJobs(workspace, healable);
    state = loadState(workspace);
  }

  const lastTask = state.jobs
    ?.filter((j) => j.type === "task" && j.opencodeSessionId)
    ?.filter((j) => j.status === "completed" || j.status === "running")
    ?.filter((j) => !sessionId || j.sessionId === sessionId)
    ?.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))?.[0];

  const result = {
    available: !!lastTask,
    jobId: lastTask?.id ?? null,
    opencodeSessionId: lastTask?.opencodeSessionId ?? null,
  };

  if (options.json) {
    console.log(JSON.stringify(result));
  } else {
    console.log(result.available ? `Resumable session: ${result.opencodeSessionId}` : "No resumable session.");
  }
}

// ------------------------------------------------------------------
// Status / Result / Cancel
// ------------------------------------------------------------------

async function handleStatus(argv) {
  const { options, positional } = parseArgs(argv ?? [], {
    booleanOptions: ["json", "all"],
  });

  const workspace = await resolveWorkspace();
  let state = loadState(workspace);
  const sessionId = getClaudeSessionId();
  // Auto-heal stuck jobs before building the snapshot so `status` never lies
  // about completion. Safe on ECONNREFUSED (probe returns reachable:false).
  const healable = (state.jobs ?? []).filter(
    (j) => j.opencodeSessionId &&
      ["starting", "investigating", "running", "finalizing"].includes(j.status),
  );
  if (healable.length > 0) {
    await autoHealJobs(workspace, healable);
    state = loadState(workspace);
  }
  const jobs = state.jobs ?? [];
  const wantJson = !!options.json;
  // --all widens the snapshot filter to every session's jobs; without --all we
  // still filter to the current Claude session for the existing markdown UX.
  const sessionFilter = options.all ? undefined : sessionId;
  const ref = positional?.[0];

  // Single-task query — `status <tid> [--json]`.
  if (ref) {
    const { job, ambiguous } = matchJobReference(jobs, ref);
    if (ambiguous) {
      if (wantJson) {
        console.log(JSON.stringify({ workspaceRoot: workspace, job: null, error: "ambiguous" }));
      } else {
        console.error(`Ambiguous job reference "${ref}". Please provide a more specific ID prefix.`);
      }
      process.exit(ambiguous ? 2 : 0);
      return;
    }
    if (wantJson) {
      const enriched = job ? enrichJob(job, workspace) : null;
      console.log(JSON.stringify({ workspaceRoot: workspace, job: enriched }));
      return;
    }
    if (!job) {
      console.log(`No job found for "${ref}" in workspace ${workspace}.`);
      return;
    }
    console.log(renderStatus({ running: [], latestFinished: null, recent: [enrichJob(job, workspace)] }));
    return;
  }

  const snapshot = buildStatusSnapshot(jobs, workspace, { sessionId: sessionFilter });

  // Enrich running jobs with a live breadcrumb from the opencode session —
  // gives newcomers a human-legible "running — bash: docker exec ..." line
  // instead of a stale "investigating" phase from state.json. Runs in parallel
  // and gracefully falls back if the server is unreachable.
  if (snapshot.running.length > 0) {
    await Promise.all(snapshot.running.map(async (job) => {
      if (!job.opencodeSessionId) return;
      const act = await getSessionLastActivity(job.opencodeSessionId, { cwd: workspace });
      if (!act) return;
      const age = act.ageSec != null ? `${act.ageSec}s ago` : "";
      if (act.kind === "tool") {
        const head = act.command ? `: ${act.command}` : "";
        job.breadcrumb = `running — ${act.tool}${head}${age ? ` (${age})` : ""}`.trim();
      } else if (act.kind === "text") {
        job.breadcrumb = `running — "${act.text}"${age ? ` (${age})` : ""}`;
      }
    }));
  }

  if (wantJson) {
    // Machine-readable shape mirrors the single-task case so callers can treat
    // both uniformly: a `.job` field is present for single-task, otherwise
    // `.running`/`.recent` arrays describe the whole workspace snapshot.
    console.log(JSON.stringify({
      workspaceRoot: workspace,
      running: snapshot.running,
      latestFinished: snapshot.latestFinished,
      recent: snapshot.recent,
    }));
    return;
  }

  console.log(renderStatus(snapshot));
}

async function handleResult(argv) {
  const { positional } = parseArgs(argv, {});
  const ref = positional[0];

  const workspace = await resolveWorkspace();
  let state = loadState(workspace);
  // Auto-heal before resolving so that if the caller asks for the latest
  // result, we don't return "no finished job" while a silently-completed
  // session is waiting to be reconciled.
  const healable = (state.jobs ?? []).filter(
    (j) => j.opencodeSessionId &&
      ["starting", "investigating", "running", "finalizing"].includes(j.status),
  );
  if (healable.length > 0) {
    await autoHealJobs(workspace, healable);
    state = loadState(workspace);
  }

  const { job, ambiguous } = resolveResultJob(state.jobs ?? [], ref);

  if (ambiguous) {
    console.error("Ambiguous job reference. Please provide a more specific ID prefix.");
    process.exit(1);
  }

  if (!job) {
    console.log("No finished job found.");
    return;
  }

  const enriched = enrichJob(job, workspace);

  // Try to load detailed result data
  const dataFile = jobDataPath(workspace, job.id);
  const resultData = readJson(dataFile);

  console.log(renderResult(enriched, resultData));
}

async function handleWaitAndResult(argv) {
  const { options, positional } = parseArgs(argv, {
    valueOptions: ["max-wait"],
    booleanOptions: ["json"],
  });

  const ref = positional[0];
  if (!ref) {
    console.error("No task ID provided.");
    process.exit(1);
  }

  const maxWait = parseInt(options["max-wait"] ?? "480", 10);
  if (isNaN(maxWait) || maxWait < 1 || maxWait > 600) {
    console.error("--max-wait must be between 1 and 600 seconds.");
    process.exit(1);
  }

  const workspace = await resolveWorkspace();
  const state = loadState(workspace);
  const jobs = state.jobs ?? [];

  const { job, ambiguous } = matchJobReference(jobs, ref);
  if (ambiguous) {
    console.error(`Ambiguous job reference "${ref}". Please provide a more specific ID.`);
    process.exit(1);
  }
  if (!job) {
    console.error(`No job found for "${ref}".`);
    process.exit(1);
  }

  const startTime = Date.now();
  const pollInterval = 250;
  const maxWaitMs = maxWait * 1000;
  const logFile = jobLogPath(workspace, job.id);

  const terminalStatuses = ["completed", "failed", "cancelled"];

  const isTerminal = (j) => terminalStatuses.includes(j?.status);

  if (isTerminal(job)) {
    const enriched = enrichJob(job, workspace);
    const dataFile = jobDataPath(workspace, job.id);
    const resultData = readJson(dataFile);
    console.log(renderResult(enriched, resultData));
    process.exit(0);
  }

  while (Date.now() - startTime < maxWaitMs) {
    await new Promise((r) => setTimeout(r, pollInterval));

    const currentState = loadState(workspace);
    const { job: currentJob } = matchJobReference(currentState.jobs ?? [], ref);
    if (isTerminal(currentJob)) {
      const enriched = enrichJob(currentJob, workspace);
      const dataFile = jobDataPath(workspace, currentJob.id);
      const resultData = readJson(dataFile);
      console.log(renderResult(enriched, resultData));
      process.exit(0);
    }
  }

  const elapsedSec = Math.floor((Date.now() - startTime) / 1000);
  const timeoutOutput = {
    status: "running",
    elapsed: elapsedSec,
    task_id: job.id,
    log_file: logFile,
  };

  if (options.json) {
    console.log(JSON.stringify(timeoutOutput));
  } else {
    console.log(JSON.stringify(timeoutOutput));
  }
  process.exit(2);
}

async function handleCancel(argv) {
  const { positional } = parseArgs(argv, {});
  const ref = positional[0];

  const workspace = await resolveWorkspace();
  const state = loadState(workspace);

  const { job, ambiguous } = resolveCancelableJob(state.jobs ?? [], ref);

  if (ambiguous) {
    console.error("Multiple running jobs. Please specify a job ID prefix.");
    process.exit(1);
  }

  if (!job) {
    console.log("No active job to cancel.");
    return;
  }

  // Abort the OpenCode session if we have one
  if (job.opencodeSessionId) {
    try {
      const client = await connect({ start: false, cwd: workspace });
      await client.abortSession(job.opencodeSessionId);
    } catch {
      // Server may not be running
    }
  }

  // Kill the process if we have a PID
  if (job.pid) {
    try {
      process.kill(job.pid, "SIGTERM");
    } catch {
      // Process may already be gone
    }
  }

  upsertJob(workspace, {
    id: job.id,
    status: "failed",
    completedAt: new Date().toISOString(),
    errorMessage: "Canceled by user",
  });

  console.log(`Canceled job: ${job.id}`);
}

// ------------------------------------------------------------------
// Heal (batch auto-reconcile stuck jobs)
// ------------------------------------------------------------------

async function handleHeal(argv) {
  const { options } = parseArgs(argv ?? [], {
    booleanOptions: ["json", "dry-run", "all"],
  });

  const workspace = await resolveWorkspace();
  const state = loadState(workspace);
  const sessionId = getClaudeSessionId();
  const dryRun = !!options["dry-run"];

  let jobs = state.jobs ?? [];
  if (!options.all && sessionId) {
    jobs = jobs.filter((j) => !j.sessionId || j.sessionId === sessionId);
  }

  const healable = jobs.filter(
    (j) => j.opencodeSessionId &&
      ["starting", "investigating", "running", "finalizing"].includes(j.status),
  );

  const { actions } = await autoHealJobs(workspace, healable, { dryRun });

  if (options.json) {
    console.log(JSON.stringify({
      workspaceRoot: workspace,
      dryRun,
      scanned: healable.length,
      actions,
    }, null, 2));
    return;
  }

  console.log(`## Auto-Heal ${dryRun ? "(dry-run)" : ""}\n`);
  console.log(`- Workspace: ${workspace}`);
  console.log(`- Scanned stuck jobs: ${healable.length}`);
  if (actions.length === 0) {
    console.log(`- No actions needed.`);
    return;
  }
  console.log(`- Actions: ${actions.length}\n`);
  for (const a of actions) {
    const det = a.details ? ` — ${JSON.stringify(a.details)}` : "";
    console.log(`- **${a.id}**: ${a.action}${det}`);
  }
}

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------

/**
 * Extract text from an OpenCode API response.
 * @param {any} response
 * @returns {string}
 */
// ------------------------------------------------------------------
// Doctor (onboarding self-test + optional auto-repair)
// ------------------------------------------------------------------

async function handleDoctor(argv) {
  const { options } = parseArgs(argv ?? [], {
    booleanOptions: ["json", "fix", "verbose"],
  });
  const fix = !!options.fix;
  const wantJson = !!options.json;
  const verbose = !!options.verbose;
  const IS_WINDOWS = process.platform === "win32";

  const checks = [];
  const push = (name, status, detail, hint) => checks.push({ name, status, detail, hint });

  // 1. opencode binary in PATH
  const which = await runCommand("which", ["opencode"]).catch(() => ({ exitCode: 1, stdout: "" }));
  if (which.exitCode === 0 && which.stdout.trim()) {
    push("opencode-binary", "PASS", which.stdout.trim(), null);
  } else {
    push("opencode-binary", "FAIL", "not in PATH",
      "Install OpenCode V2: https://opencode.ai/v2/docs/cli/");
  }

  // 2. opencode version
  const ver = await runCommand("opencode", ["--version"]).catch(() => ({ exitCode: 1, stdout: "" }));
  if (ver.exitCode === 0 && /(?:^|\s)v?2\./.test(ver.stdout)) {
    push("opencode-version", "PASS", ver.stdout.trim() || "(unknown)", null);
  } else {
    push("opencode-version", "FAIL", ver.stdout.trim() || "could not resolve version", "OpenCode V2 is required.");
  }

  // V2 honors the user's configuration. Never rewrite global permissions.
  push("opencode-permissions", "PASS", "session-scoped headless policy; global config unchanged", null);

  // 4. server reachable
  const endpoint = await discoverServer().catch(() => undefined);
  const serverUrl = endpoint?.url || "(not discovered)";
  const reachable = await isServerRunning();
  if (reachable) {
    push("opencode-server", "PASS", `${serverUrl} reachable`, null);
  } else {
    push("opencode-server", "WARN", `${serverUrl} not reachable`,
      "Start OpenCode or run: opencode service start");
  }

  // 5. CLAUDE_PLUGIN_DATA sanity check
  const envData = process.env.CLAUDE_PLUGIN_DATA;
  if (envData && !/opencode/i.test(path.basename(envData))) {
    push("plugin-data-env", "WARN",
      `CLAUDE_PLUGIN_DATA=${envData} — basename lacks "opencode"`,
      "State will self-derive from script path; env is ignored to avoid cross-plugin leak.");
  } else {
    push("plugin-data-env", "PASS", envData ? envData : "(unset — self-derived)", null);
  }

  // 6. resolved state dir
  const workspace = await resolveWorkspace();
  const sRoot = stateRoot(workspace);
  push("state-dir", "PASS", sRoot, null);

  // 7. stuck jobs for this workspace
  const state = loadState(workspace);
  const sessionId = getClaudeSessionId();
  const jobs = (state.jobs ?? []).filter((j) => !sessionId || j.sessionId === sessionId);
  const healable = jobs.filter(
    (j) => j.opencodeSessionId &&
      ["starting", "investigating", "running", "finalizing"].includes(j.status),
  );
  if (healable.length === 0) {
    push("stuck-jobs", "PASS", "none", null);
  } else if (fix) {
    const { actions } = await autoHealJobs(workspace, healable);
    push("stuck-jobs", "PASS", `healed ${actions.length}/${healable.length}`, null);
  } else {
    push("stuck-jobs", "WARN", `${healable.length} in non-terminal state`,
      "Run: companion heal  (or companion doctor --fix)");
  }

  // 8. disk free on state-dir parent
  if (IS_WINDOWS) {
    push("disk-free", "PASS", "N/A (Windows)", null);
  } else {
    // Walk up to the first existing ancestor — stateRoot may not exist yet.
    let probe = sRoot;
    while (probe && probe !== "/" && !fs.existsSync(probe)) probe = path.dirname(probe);
    const df = await runCommand("df", ["-h", probe]).catch(() => ({ exitCode: 1, stdout: "" }));
    const lines = (df.stdout || "").split("\n").filter(Boolean);
    const last = lines[lines.length - 1] || "";
    if (last && last !== lines[0]) {
      push("disk-free", "PASS", last.split(/\s+/).slice(0, 5).join(" "), null);
    } else {
      push("disk-free", "WARN", "df unavailable", null);
    }
  }

  // Summary
  const nFail = checks.filter((c) => c.status === "FAIL").length;
  const nWarn = checks.filter((c) => c.status === "WARN").length;
  const summary = nFail + nWarn === 0
    ? "All good"
    : `${nWarn} warnings, ${nFail} failures${!fix ? " — run with --fix to repair" : ""}`;

  if (nFail > 0) process.exitCode = 1;

  if (wantJson) {
    console.log(JSON.stringify({
      summary: { failures: nFail, warnings: nWarn, fix },
      checks,
      workspace,
      stateRoot: sRoot,
    }, null, 2));
    return;
  }

  // Compact text output — ~1 line per check
  for (const c of checks) {
    const tag = c.status === "PASS" ? "PASS" : c.status === "WARN" ? "WARN" : "FAIL";
    console.log(`[${tag}] ${c.name} — ${c.detail}`);
    if (verbose && c.hint) console.log(`       ${c.hint}`);
    else if (c.status !== "PASS" && c.hint) console.log(`       ${c.hint}`);
  }
  console.log(`\n${nFail + nWarn === 0 ? "OK" : "!! "} ${summary}`);
}

// ------------------------------------------------------------------
// Config (resolved settings dump — easier onboarding than reading source)
// ------------------------------------------------------------------

async function handleConfig(argv) {
  const { options } = parseArgs(argv ?? [], { booleanOptions: ["json"] });
  const wantJson = !!options.json;

  const envSpec = [
    ["OPENCODE_REQUEST_TIMEOUT_MS", "1800000", "Per-HTTP-request abort timeout"],
    ["OPENCODE_PROMPT_TIMEOUT_MS",  "14400000", "Session completion timeout"],
    ["OPENCODE_COMPLETION_POLL_MS", "5000", "Watcher poll interval during sendPrompt"],
    ["OPENCODE_MONITOR_RESULT_CHARS","(hook)", "Monitor hook: max chars per tool-result snippet"],
    ["OPENCODE_MONITOR_HEARTBEAT_POLLS","(hook)", "Monitor hook: polls between heartbeat pings"],
    ["OPENCODE_COMPANION_DATA",     "(self-derived)", "Override for plugin data dir"],
    ["OPENCODE_SERVER_URL",        "(discovered)", "Explicit V2 server URL (otherwise use the local service)"],
    ["OPENCODE_SERVER_PASSWORD",    "(unset)", "HTTP Basic auth password"],
    ["OPENCODE_SERVER_USERNAME",    "opencode", "HTTP Basic auth username"],
  ];
  const envRows = envSpec.map(([name, dflt, desc]) => {
    const v = process.env[name];
    return {
      name,
      value: name === "OPENCODE_SERVER_PASSWORD" && v ? "(redacted)" : v != null ? v : dflt,
      source: v != null ? "env" : (dflt.startsWith("(") ? "default" : "default"),
      description: desc,
    };
  });

  const workspace = await resolveWorkspace();
  const sRoot = stateRoot(workspace);
  const endpoint = await discoverServer().catch(() => undefined);
  const serverUrl = endpoint?.url || "(not discovered)";
  const serverReachable = await isServerRunning();

  const out = {
    env: envRows,
    workspace,
    stateRoot: sRoot,
    permissions: "session-scoped; global config unchanged",
    server: { url: serverUrl, reachable: serverReachable },
  };

  if (wantJson) {
    console.log(JSON.stringify(out, null, 2));
    return;
  }

  console.log("## OpenCode Companion Config\n");
  console.log(`- Workspace: ${workspace}`);
  console.log(`- State dir: ${sRoot}`);
  console.log(`- Permissions: ${out.permissions}`);
  console.log(`- Server: ${serverUrl} (${serverReachable ? "reachable" : "unreachable"})`);
  console.log("\n### Environment variables\n");
  for (const r of envRows) {
    const src = r.source === "env" ? "env" : "default";
    console.log(`- ${r.name} = ${r.value} [${src}] — ${r.description}`);
  }
}

/**
 * Try to parse a string as JSON, returning null on failure.
 * @param {string} text
 * @returns {object|null}
 */
function tryParseJson(text) {
  // Look for JSON in the text (may be wrapped in markdown code blocks)
  const jsonMatch = text.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
  const candidate = jsonMatch ? jsonMatch[1] : text;
  try {
    return JSON.parse(candidate.trim());
  } catch {
    return null;
  }
}
