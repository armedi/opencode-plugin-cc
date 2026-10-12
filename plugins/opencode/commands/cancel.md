---
description: Cancel an active background OpenCode job
argument-hint: '[job-id-prefix]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

Run the cancel command and return output verbatim.

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/opencode-companion.mjs" cancel $ARGUMENTS
```
