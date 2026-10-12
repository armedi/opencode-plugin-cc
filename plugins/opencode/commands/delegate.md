---
description: Delegate investigation, implementation, or follow-up work directly to OpenCode
argument-hint: "[--background|--wait] [--resume|--fresh] [--model <provider/model>] [--agent <build|plan>] [what OpenCode should investigate, solve, or continue]"
allowed-tools: Skill Read AskUserQuestion Bash
---

User request: $ARGUMENTS

Give OpenCode the user's request and the context needed to carry it out. If the request refers to an earlier plan, fix, or decision, include that material inline or reference its existing artifact.

Reference existing artifacts (plans, specs, issues, commits, diffs) by path or URL instead of duplicating their contents. Include context not captured in those artifacts. Redact sensitive information.

Ask for a missing request or ambiguous required context before dispatching.

Invoke `Skill` with `skill: "opencode:opencode-runtime"` and follow its direct dispatch and waiting flow. The skill runs inline and resolves plugin paths without creating a subagent. Pass only the prepared prompt as task text, with the user's routing flags separately. Default to foreground waiting unless `--background` was requested.

Return the companion's terminal OpenCode report verbatim, without commentary. If OpenCode is missing or unauthenticated, direct the user to `/opencode:setup`.
