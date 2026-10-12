---
name: opencode-result-handling
description: Guidance for interpreting and presenting OpenCode task results, plus how to poll live progress of a running background task
user-invocable: false
---

# OpenCode Result Handling

## Result Structure

OpenCode returns results as structured session data containing:
- **Messages**: The full conversation between the user prompt and OpenCode's agent
- **Tool calls**: All tool invocations (shell, edit, read, write, grep, glob, etc.)
- **File changes**: Diffs of all files modified during the session
- **Status**: Whether the session completed successfully, was aborted, or errored

## Presenting Results

When displaying results from `/opencode:result`:
1. Show the session ID for reference
2. Present the final assistant message as the primary output
3. If file changes were made, summarize which files were modified
4. Include the session status (completed/aborted/error)

## Resuming Sessions

OpenCode sessions can be resumed by sending additional messages to the same session.
The `--resume-last` flag in the companion script handles this by reusing the last session ID
from the current workspace state.

## Inspecting Live Progress (while a task is still running)

A dispatched opencode task produces live progress in several layers — use the appropriate tool for the granularity you need.

### Layer 1: Companion phase (coarse, whole-task)

Phase-level signals like `starting → investigating → running → completed/failed`. Useful to confirm the task is alive, not the specific work.

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/opencode-companion.mjs" status <task-id> --json
```

Returns JSON with `job.status`, `job.phase`, `job.elapsed`, `job.opencodeSessionId`, and a `progressPreview` string (just phase-transition lines).

### Layer 2: Full tool-call trace (fine, every action)

Use the V2 CLI to inspect the session trace. It discovers the background service and supplies authentication; the service does not have a fixed port.

```bash
opencode api get /api/session/<sessionId>/message
```

Get `<sessionId>` from Layer 1's `job.opencodeSessionId`. The response contains `data` (messages) and `cursor` (pagination). Messages have `type`, `time`, and assistant `content[]`:
- `type: "text"` → `part.text` is visible assistant output
- `type: "reasoning"` → reasoning, separate from visible output
- `type: "tool"` → `part.tool`, `part.input`, and `part.state` describe the invocation

A completed assistant message may end with `finish: "tool-calls"` while the agent continues. Use companion status for whole-job completion; V2 session outcomes are `succeeded`, `failed`, or `interrupted`.

Typical usage — tail the last N messages for a quick "what is it doing now":

```bash
opencode api get /api/session/<sessionId>/message | python3 -c '
import json, sys
msgs = json.load(sys.stdin)["data"]
for m in msgs[:10]:
  role = m.get("type", "?")
  for p in m.get("content", []):
    t = p.get("type")
    if t == "text":
      print("  [{}/text] {}".format(role, p.get("text", "")[:200]))
    elif t == "tool":
      st = p.get("state", {})
      inp = p.get("input", {}) or {}
      cmd = inp.get("command") or inp.get("file_path") or inp.get("pattern") or ""
      print("  [{}/tool/{}/{}] {}".format(role, p.get("tool"), st.get("status"), str(cmd)[:160]))
'
```

### Layer 3: Bash wrapper output (when subagent tails companion --wait)

When the rescue subagent runs `companion task --wait` via Bash `run_in_background=true`, the subagent's Bash tool emits a local_bash task-id (e.g. `buzkqvlq7`). Use `TaskOutput(task_id=<bash-id>, block=false)` to see the raw tail of the companion's stdout — this has phase lines, **not** the inner opencode session messages. Prefer Layer 2 for real content.

### Which layer to use

- "Is the task still alive / which phase?" → Layer 1 (companion status).
- "What has opencode actually been doing the last few minutes?" → Layer 2 (session messages via HTTP).
- "What did the subagent's shell emit?" → Layer 3 (TaskOutput on the bash-id).

## When to Ask the User

If Layer 2 shows the opencode task has been stuck on the same tool call for many minutes without progress, or is looping on the same error, surface that to the user — they can decide whether to cancel or let it continue. Do not silently wait through apparent deadlocks.
