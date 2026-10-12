---
name: opencode-result-handling
description: Guidance for returning OpenCode terminal reports and inspecting task progress
user-invocable: false
---

# OpenCode Result Handling

## Returning Results

Return the companion's terminal report verbatim. It includes job status, session ID when available, and output or an error. Changed files appear only when captured; the report is not a full session trace.

Claude dispatches and waits directly through Bash. Return OpenCode's report rather than implementing a substitute solution.

## Resuming Sessions

`task --resume-last` reuses the latest task session in the workspace, filtered to the current Claude session when its ID is available.

## Inspecting Progress

Claude can inspect progress when needed while a background Bash waiter handles completion.

### Job Status

Phase-level signals like `starting → investigating → running → completed/failed`. Useful to confirm the task is alive, not the specific work.

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/opencode-companion.mjs" status <task-id> --json
```

Returns JSON with `job.status`, `job.phase`, `job.elapsed`, `job.opencodeSessionId`, and a `progressPreview` string (just phase-transition lines).

### Session Messages

Use the V2 CLI to inspect the session trace. It discovers the background service and supplies authentication; the service does not have a fixed port.

```bash
opencode api get /api/session/<sessionId>/message
```

Get `<sessionId>` from the status response's `job.opencodeSessionId`. The response contains `data` (messages) and `cursor` (pagination). Messages have `type`, `time`, and assistant `content[]`:
- `type: "text"` → `part.text` is visible assistant output
- `type: "reasoning"` → reasoning, separate from visible output
- `type: "tool"` → `part.tool`, `part.input`, and `part.state` describe the invocation

A completed tool-call message does not mean the job finished. Use companion status for completion; V2 session outcomes are `succeeded`, `failed`, or `interrupted`.

## When to Ask the User

If session messages show repeated errors or prolonged lack of progress, ask whether to cancel or continue. Cancel only when the user requests it.
