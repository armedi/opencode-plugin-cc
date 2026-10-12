---
description: Delegate investigation, an explicit fix request, or follow-up rescue work to the OpenCode rescue subagent
argument-hint: "[--background|--wait] [--resume|--fresh] [--model <provider/model>] [--agent <build|plan>] [what OpenCode should investigate, solve, or continue]"
allowed-tools: Agent AskUserQuestion Bash(node:*)
---

User request: $ARGUMENTS

Give OpenCode the user's request and the context needed to carry it out. If the request refers to an earlier plan, fix, or decision, include that material inline or reference its existing artifact.

Reference existing artifacts (plans, specs, issues, commits, diffs) by path or URL instead of duplicating their contents. Include context not captured in those artifacts. Redact sensitive information.

Ask for a missing request or ambiguous required context before dispatching.

Unless the user supplied `--resume` or `--fresh`, check for a resumable session:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/opencode-companion.mjs" task-resume-candidate --json
```

If `available: true`, use `AskUserQuestion` once: "Continue current OpenCode session" (`--resume`) or "Start a new OpenCode session" (`--fresh`). Recommend continue for follow-ups, otherwise a new session. If unavailable, proceed without asking.

Invoke `Agent` with `subagent_type: "opencode:opencode-rescue"`, supplying only the prepared prompt for OpenCode and the routing flags separately. The child forwards that prompt unchanged, not the raw `$ARGUMENTS`. Use `Agent`, not `Skill`; leave dispatch and waiting to the child.

- `--background` runs the child in the background; otherwise use foreground (`--wait`). These flags control Claude execution, not the OpenCode task text.
- Pass explicit `--resume`, `--fresh`, `--model`, and `--agent` selections to the child, outside the task text. Leave model and agent unset unless requested. Fresh/resume changes session routing, not context preparation.

Return the child's terminal OpenCode output verbatim, without commentary. If OpenCode is missing or unauthenticated, direct the user to `/opencode:setup`.
