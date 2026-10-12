---
name: opencode-runtime
description: Internal helper contract for calling the opencode-companion runtime from Claude Code
user-invocable: false
---

# OpenCode Runtime

Use only inside `opencode:opencode-rescue`. Follow the agent's dispatch-and-wait instructions; use the companion rather than direct CLI or HTTP calls.

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/opencode-companion.mjs" task --background --write '<parent-prepared prompt>'
```

The parent supplies the prompt and routing selections separately. Forward the prompt unchanged; it is not raw slash-command arguments. Source reading and task execution belong to OpenCode.

- Pass explicit `--model` and `--agent` selections; otherwise leave them unset.
- Map `--resume` to `--resume-last`. For `--fresh`, omit `--resume-last`.
- Claude's `--background`/`--wait` selects child execution mode. The companion uses `--background` internally in either case.
- Default to `--write` unless read-only work was requested; `--agent plan` is read-only.

Use one `task` call, then the agent's wait loop. Return its terminal report unchanged; report dispatch failures without substituting a Claude implementation.
