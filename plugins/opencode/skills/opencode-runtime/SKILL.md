---
name: opencode-runtime
description: Delegate directly to OpenCode when the user requests it, Claude is stuck, or a substantial debugging or implementation task needs a second pass. Use the companion runtime without a Claude subagent.
user-invocable: false
allowed-tools: Skill Read AskUserQuestion Bash
---

# OpenCode Runtime

Call the companion directly from the main Claude thread. OpenCode performs the investigation and implementation; Claude prepares context, dispatches, and returns the report.

## Prepare and route

Invoke the inline `opencode:opencode-prompting` skill when preparing a prompt. Send the prepared prompt, not raw slash-command arguments. Keep routing selections separate from task text.

Unless the user supplied `--resume` or `--fresh`, check:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/opencode-companion.mjs" task-resume-candidate --json
```

If `available: true`, ask once whether to continue the current OpenCode session (`--resume`) or start a new one (`--fresh`). Recommend continue for follow-ups, otherwise new. If unavailable, proceed.

- Pass explicit `--model` and `--agent` selections; otherwise leave them unset.
- Map `--resume` to `--resume-last`. For `--fresh`, omit `--resume-last`.
- Default to `--write`; for read-only work, select `--agent plan` (the companion enforces read-only permissions for this selection). Resolve a conflicting explicit agent selection with the user before dispatch.
- Foreground (`--wait`) is the default. `--background` selects a Claude background Bash waiter, not a Claude subagent.

## Dispatch once

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/opencode-companion.mjs" task --background --write '<prepared prompt>'
```

Apply the routing selections above. Pass the prompt as one safely shell-quoted argument, preserving quotes, newlines, backticks, and `$` literally. Capture the `task-...` ID from stdout. The companion's `--background` starts its tracked worker in both execution modes so each foreground wait can stay within Bash's execution limit.

## Foreground waiting

Before each wait round, run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/opencode-companion.mjs" status <task-id> --json
```

Status reconciles server-side completion when a detached worker exited before saving its result; the wait then returns the terminal report. A dead worker alone does not mean the OpenCode session finished.

Call the following with a Bash timeout of 600000 ms, up to 20 rounds:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/opencode-companion.mjs" wait-and-result <task-id> --max-wait 480
```

- Exit 0: return stdout verbatim after verifying it contains `## Job:`. Failed and cancelled jobs are terminal reports too.
- Exit 2: the job is still running; wait again using the same task ID.
- Exit 1 or missing report: report `ERROR: companion dispatch failed (<reason>)`.
- After 20 timeouts: report the task ID and that waiting timed out; the OpenCode job may still be running. Offer `/opencode:status`, `/opencode:result`, or `/opencode:cancel` rather than dispatching a duplicate job.

## Background waiting

Launch this shell loop through `Bash` with `run_in_background: true`, replacing `<task-id>` with the captured ID:

```bash
for ((round = 0; round < 20; round++)); do
  node "${CLAUDE_PLUGIN_ROOT}/scripts/opencode-companion.mjs" status <task-id> --json
  node "${CLAUDE_PLUGIN_ROOT}/scripts/opencode-companion.mjs" wait-and-result <task-id> --max-wait 480
  code=$?
  if [ "$code" -ne 2 ]; then
    exit "$code"
  fi
done
printf '%s\n' 'OpenCode task <task-id> is still running after 20 wait rounds; check /opencode:status or /opencode:result.'
exit 2
```

Return a brief started acknowledgement with the OpenCode task ID. Let Claude's background Bash completion notification bring the result back; no extra Monitor or Agent is needed. On completion, return the terminal `## Job:` report verbatim. A timeout or waiter failure is not job completion; check status/result for the same ID before retrying anything.

For progress inspection or failure handling, invoke the inline `opencode:opencode-result-handling` skill so its plugin paths resolve too. Report dispatch failures without substituting a Claude implementation.
