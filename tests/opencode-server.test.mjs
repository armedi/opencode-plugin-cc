import assert from "node:assert/strict";
import { createServer } from "node:http";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { createClient } from "../plugins/opencode/scripts/lib/opencode-server.mjs";
import { autoHealJob } from "../plugins/opencode/scripts/lib/auto-heal.mjs";
import { jobDataPath, loadState, updateState, upsertJob } from "../plugins/opencode/scripts/lib/state.mjs";
import { spawn } from "node:child_process";
import { createTmpDir, cleanupTmpDir } from "./helpers.mjs";
import { runCommand } from "../plugins/opencode/scripts/lib/process.mjs";

const authorization = `Basic ${Buffer.from("opencode:fixture").toString("base64")}`;

// An independent HTTP contract fixture, not a mocked SDK. Unknown V1 routes,
// missing authentication, or invalid V2 prompt fields are rejected.
async function serveV2(t, {
  outcome = "succeeded", permission = false, active = false, stall = false, text = "Final V2 output",
  status = [{ file: "src/app.js", additions: 3, deletions: 1, status: "modified" }],
  base = { name: "main", ref: "refs/heads/main", source: "default" },
} = {}) {
  const sessionID = "ses_fixture";
  const now = Date.now();
  const session = {
    id: sessionID, location: { directory: "/workspace" },
    permissions: [{ action: "edit", resource: "secrets/*", effect: "deny" }],
    time: { created: now, updated: now },
  };
  let polls = 0;
  let admitted = false;
  let commandAccepted = false;
  const calls = [];
  const assistant = (final) => ({
    id: final ? "msg_final" : "msg_tool", type: "assistant",
    time: { created: now + 1, completed: now + 2 },
    finish: final ? "stop" : "tool-calls",
    content: final
      ? [{ type: "reasoning", text: "private reasoning" }, { type: "text", text }]
      : [{ type: "text", text: "Still working" }, { type: "tool", tool: "read", state: { status: "completed" } }],
  });
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    let body = "";
    for await (const chunk of req) body += chunk;
    body = body ? JSON.parse(body) : undefined;
    calls.push({ method: req.method, path: url.pathname, query: url.searchParams, body, headers: req.headers });
    const json = (value, status = 200) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(value));
    };
    if (req.headers.authorization !== authorization) return json({ error: "unauthorized" }, 401);
    const path = url.pathname;
    if (path === "/api/info") return json({ version: "2.0.26" });
    if (path === "/api/agent") return json({ data: [{ id: "plan", model: { providerID: "cfg", id: "agent-model" } }] });
    if (path === "/api/session" && req.method === "POST") return json({ data: { ...session, ...body } });
    if (path === `/api/session/${sessionID}/agent` || path === `/api/session/${sessionID}/model`) {
      res.writeHead(204).end(); return;
    }
    if (path === `/api/session/${sessionID}` && req.method === "PATCH") {
      session.permissions = body.permissions;
      res.writeHead(204).end(); return;
    }
    if (path === `/api/session/${sessionID}/prompt`) {
      if (!body.text || body.parts || body.agent || body.model) return json({ error: "invalid prompt" }, 400);
      admitted = true;
      return json({ data: { id: "msg_user", sessionID, time: { created: now }, type: "user", payload: { text: body.text }, delivery: body.delivery ?? "steer" } });
    }
    if (path === `/api/session/${sessionID}/command` && req.method === "POST") {
      if (!body?.name) return json({ error: "missing command" }, 400);
      admitted = true;
      commandAccepted = true;
      res.writeHead(204).end();
      return;
    }
    if (path === "/api/vcs/status") return json({ data: status });
    if (path === "/api/vcs/base") return json({ data: base });
    if (path === "/api/session/active") {
      polls++;
      return json({ data: active || (admitted && polls < 2) ? { [sessionID]: { type: "running" } } : {} });
    }
    if (path === `/api/session/${sessionID}`) {
      return json({ data: { ...session, outcome, time: { ...session.time, idle: commandAccepted ? now + 10 : now + 3 } } });
    }
    if (path === `/api/session/${sessionID}/context`) {
      if (stall) return; // Deliberately leave this HTTP response open.
      return json({ data: [assistant(polls >= 2 || !admitted)] });
    }
    if (path === `/api/session/${sessionID}/inbox`) return json({ data: [] });
    if (path === `/api/session/${sessionID}/permission`) {
      return json({ data: permission ? [{ id: "per_fixture", action: "external_directory", resources: ["/private/*"] }] : [] });
    }
    if (path === `/api/session/${sessionID}/interrupt`) return json({ interrupted: true });
    if (path === `/api/session/${sessionID}/message`) {
      return json({ data: [assistant(true)], cursor: { next: null, previous: null } });
    }
    if (path === `/api/session/${sessionID}/diff`) return json({ data: [{ file: "src/fixed.js", additions: 1, deletions: 0 }] });
    return json({ error: `unknown route ${path}` }, 404);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const headers = { authorization };
  return { client: createClient(baseUrl, { directory: "/workspace", headers }), baseUrl, headers, calls, sessionID, now };
}

function cli(t, baseUrl, overrides = {}) {
  const workspace = createTmpDir();
  t.after(() => cleanupTmpDir(workspace));
  const script = path.resolve("plugins/opencode/scripts/opencode-companion.mjs");
  const env = {
    ...process.env,
    OPENCODE_SERVER_URL: baseUrl,
    OPENCODE_SERVER_PASSWORD: "fixture",
    OPENCODE_SERVER_USERNAME: "opencode",
    OPENCODE_COMPANION_DATA: workspace,
    OPENCODE_COMPLETION_POLL_MS: "10",
    OPENCODE_PROMPT_TIMEOUT_MS: "5000",
    OPENCODE_COMPANION_SESSION_ID: "cli-fixture",
    ...overrides,
  };
  return (...args) => runCommand(process.execPath, [script, ...args], { cwd: workspace, env });
}

test("prompt admission waits past tool-call completion and applies agent/model/permissions", async (t) => {
  const { client, calls, sessionID } = await serveV2(t);
  const session = await client.createSession({ title: "Review", readOnly: true });
  assert.deepEqual(session.location, { directory: "/workspace" });
  assert.ok(session.permissions.some((p) => p.action === "shell" && p.effect === "deny"));
  const response = await client.sendPrompt(sessionID, "Review the code", { agent: "plan", model: "vendor/model/name#high" });
  assert.equal(response.id, "msg_final");
  const prompt = calls.find((c) => c.path.endsWith("/prompt"));
  assert.equal(prompt.body.delivery ?? "steer", "steer", "Immediate tasks must not be deferred behind the Plan reminder");
  const model = calls.find((c) => c.path.endsWith("/model"));
  assert.deepEqual(model.body, { model: { providerID: "vendor", id: "model/name", variant: "high" } });
  assert.equal(calls.find((c) => c.path.endsWith("/agent")).body.agent, "plan");
  const permissions = calls.find((c) => c.method === "PATCH").body.permissions;
  assert.ok(permissions.some((p) => p.resource === "secrets/*" && p.effect === "deny"));
  assert.ok(permissions.some((p) => p.action === "question" && p.effect === "deny"));
  assert.ok(permissions.some((p) => p.action === "edit" && p.resource === "*" && p.effect === "deny"));
  assert.ok(calls.every((c) => c.headers["x-opencode-directory"] === "/workspace"));
});

test("prompt without explicit model uses the model configured for the agent", async (t) => {
  const { client, calls, sessionID } = await serveV2(t);
  await client.sendPrompt(sessionID, "Review the code", { agent: "plan" });
  assert.deepEqual(calls.find((c) => c.path.endsWith("/model")).body, { model: { providerID: "cfg", id: "agent-model" } });
});

test("permission requests fail clearly and interrupt instead of hanging or auto-approving", async (t) => {
  const { client, sessionID, calls } = await serveV2(t, { permission: true, active: true });
  await assert.rejects(client.sendPrompt(sessionID, "Read external files"), /needs permission for external_directory: \/private\/\*/);
  assert.equal(calls.filter((c) => c.path.endsWith("/interrupt")).length, 1);
  assert.equal(calls.filter((c) => c.path.endsWith("/reply")).length, 0);
});

test("failed and interrupted session outcomes are not successful model output", async (t) => {
  for (const outcome of ["failed", "interrupted"]) {
    const { client, sessionID } = await serveV2(t, { outcome });
    await assert.rejects(client.sendPrompt(sessionID, "Run task"), new RegExp(`session ${outcome}`));
  }
});

test("V2 paginated messages, diffs and cancellation use the released contract", async (t) => {
  const { client, sessionID, calls } = await serveV2(t);
  assert.equal((await client.getMessages(sessionID, { limit: 1 }))[0].type, "assistant");
  const listed = calls.find((c) => c.path.endsWith("/message"));
  assert.equal(listed.query.get("limit"), "1");
  assert.equal(listed.query.get("order"), "desc");
  assert.equal((await client.getSessionDiff(sessionID))[0].file, "src/fixed.js");
  await client.abortSession(sessionID);
  assert.equal(calls.find((c) => c.path.endsWith("/interrupt")).query.get("resume"), "false");
});

test("auto-heal persists V2 final text, not reasoning, and preserves active or stale jobs", async (t) => {
  const workspace = createTmpDir();
  const previous = process.env.OPENCODE_COMPANION_DATA;
  process.env.OPENCODE_COMPANION_DATA = workspace;
  t.after(() => {
    if (previous === undefined) delete process.env.OPENCODE_COMPANION_DATA;
    else process.env.OPENCODE_COMPANION_DATA = previous;
    cleanupTmpDir(workspace);
  });
  const fixture = await serveV2(t);
  const job = { id: "task-heal", type: "task", status: "investigating", opencodeSessionId: fixture.sessionID, startedAt: new Date(fixture.now).toISOString() };
  upsertJob(workspace, job);
  const healed = await autoHealJob(workspace, job, fixture);
  assert.equal(healed.job.status, "completed");
  assert.equal(loadState(workspace).jobs[0].status, "completed");
  assert.equal(JSON.parse(fs.readFileSync(jobDataPath(workspace, job.id), "utf8")).rendered, "Final V2 output");
  const active = await serveV2(t, { active: true });
  assert.equal((await autoHealJob(workspace, job, active)).action, "skip");
  const stale = { ...job, startedAt: new Date(fixture.now + 10_000).toISOString() };
  assert.equal((await autoHealJob(workspace, stale, fixture)).action, "skip");
  const failed = await serveV2(t, { outcome: "failed" });
  assert.equal((await autoHealJob(workspace, job, failed)).job.status, "failed");
});

test("foreground and detached CLI tasks honor --model and expose their final result", async (t) => {
  const { baseUrl, calls } = await serveV2(t);
  const run = cli(t, baseUrl);
  const foreground = await run("task", "--model", "vendor/requested#high", "Reply with the final output");
  assert.equal(foreground.exitCode, 0, foreground.stderr);
  assert.match(foreground.stdout, /Final V2 output/);
  const background = await run("task", "--background", "--model", "vendor/requested#high", "Reply with the final output");
  assert.equal(background.exitCode, 0, background.stderr);
  const jobID = background.stdout.match(/background: (\S+)/)[1];
  const result = await run("wait-and-result", jobID, "--max-wait", "10");
  assert.equal(result.exitCode, 0, result.stderr);
  assert.match(result.stdout, /Final V2 output/);
  const switches = calls.filter((c) => c.path.endsWith("/model"));
  assert.equal(switches.length, 2);
  for (const call of switches) {
    assert.deepEqual(call.body, { model: { providerID: "vendor", id: "requested", variant: "high" } });
  }
  const prompts = calls.filter((c) => c.path.endsWith("/prompt"));
  assert.equal(prompts.length, 2);
  for (const call of prompts) {
    assert.equal(call.body.text, "Reply with the final output");
  }
});

test("review runs OpenCode's built-in /review command instead of a pasted diff", async (t) => {
  const dirty = await serveV2(t);
  const dirtyRun = cli(t, dirty.baseUrl);
  const working = await dirtyRun("review");
  assert.equal(working.exitCode, 0, working.stderr);
  assert.match(working.stdout, /Target: working tree changes/);
  assert.match(working.stdout, /Final V2 output/);
  const command = dirty.calls.find((c) => c.path.endsWith("/command"));
  assert.equal(command.body.name, "review");
  assert.equal(command.body.text, "");
  assert.equal(command.body.delivery ?? "steer", "steer", "Immediate reviews must not be queued behind the Plan reminder");
  assert.equal(dirty.calls.filter((c) => c.path.endsWith("/prompt")).length, 0);
  const permissions = dirty.calls.find((c) => c.method === "PATCH").body.permissions;
  assert.ok(permissions.some((p) => p.action === "edit" && p.effect === "deny"));
  assert.ok(permissions.some((p) => p.action === "question" && p.effect === "deny"));
  assert.equal(permissions.some((p) => p.action === "shell" && p.effect === "deny"), false);
  assert.equal(dirty.calls.find((c) => c.path.endsWith("/agent")).body.agent, "plan");

  const branched = await serveV2(t, { status: [] });
  const branch = await cli(t, branched.baseUrl)("review", "--scope", "branch");
  assert.equal(branch.exitCode, 0, branch.stderr);
  assert.match(branch.stdout, /Target: branch diff against main/);
  assert.equal(branched.calls.find((c) => c.path.endsWith("/command")).body.text, "main");

  const explicit = await serveV2(t);
  const named = await cli(t, explicit.baseUrl)("review", "--base", "develop");
  assert.equal(named.exitCode, 0, named.stderr);
  assert.equal(explicit.calls.find((c) => c.path.endsWith("/command")).body.text, "develop");
  assert.equal(explicit.calls.some((c) => c.path.startsWith("/api/vcs")), false);

  const rejected = await serveV2(t);
  const focus = await cli(t, rejected.baseUrl)("review", "focus on auth");
  assert.equal(focus.exitCode, 1);
  assert.match(focus.stderr, /\/opencode:delegate --agent plan/);
  assert.equal(rejected.calls.some((c) => c.path.endsWith("/command")), false);
});

function runStopHook(baseUrl, workspace, input) {
  const script = path.resolve("plugins/opencode/scripts/stop-review-gate-hook.mjs");
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script], {
      cwd: workspace,
      env: {
        ...process.env,
        OPENCODE_SERVER_URL: baseUrl,
        OPENCODE_SERVER_PASSWORD: "fixture",
        OPENCODE_SERVER_USERNAME: "opencode",
        OPENCODE_COMPANION_DATA: workspace,
        OPENCODE_COMPLETION_POLL_MS: "10",
        OPENCODE_PROMPT_TIMEOUT_MS: "5000",
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("close", (exitCode) => resolve({ stdout, stderr, exitCode: exitCode ?? 1 }));
    child.stdin.end(JSON.stringify({ cwd: workspace, session_id: "claude-session", ...input }));
  });
}

test("stop gate sends the previous assistant message and blocks an unexpected answer", async (t) => {
  const workspace = createTmpDir();
  t.after(() => cleanupTmpDir(workspace));
  const previous = process.env.OPENCODE_COMPANION_DATA;
  process.env.OPENCODE_COMPANION_DATA = workspace;
  t.after(() => {
    if (previous === undefined) delete process.env.OPENCODE_COMPANION_DATA;
    else process.env.OPENCODE_COMPANION_DATA = previous;
  });
  updateState(workspace, (state) => {
    state.config = { reviewGate: true };
  });

  const allowed = await serveV2(t, { text: "ALLOW: the previous turn made no edits" });
  const allow = await runStopHook(allowed.baseUrl, workspace, { last_assistant_message: "I only reported status." });
  assert.equal(allow.exitCode, 0, allow.stderr);
  assert.equal(allow.stdout, "");
  const prompt = allowed.calls.find((c) => c.path.endsWith("/prompt")).body.text;
  assert.match(prompt, /Previous Claude response:\nI only reported status\./);
  assert.doesNotMatch(prompt, /session_id|claude_response/);

  const blocked = await serveV2(t, { text: "Final V2 output" });
  const block = await runStopHook(blocked.baseUrl, workspace, { last_assistant_message: "Edited auth." });
  assert.equal(block.exitCode, 0, block.stderr);
  assert.equal(JSON.parse(block.stdout).decision, "block");
});

test("prompt timeout cancels an in-flight V2 request and interrupts server execution", async (t) => {
  const { baseUrl, calls } = await serveV2(t, { active: true, stall: true });
  const run = cli(t, baseUrl, { OPENCODE_PROMPT_TIMEOUT_MS: "100" });
  const result = await run("task", "Run task");
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /timeout/i);
  assert.equal(calls.filter((c) => c.path.endsWith("/interrupt")).length, 1);
});
