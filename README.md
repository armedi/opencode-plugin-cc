# OpenCode V2 plugin for Claude Code

Use OpenCode from inside Claude Code for code reviews or to delegate tasks.
This fork of [tasict/opencode-plugin-cc](https://github.com/tasict/opencode-plugin-cc)
targets **OpenCode V2** and is tested against **2.0.26**. V1 is not supported by
this version; use the upstream project for V1.

> **Tribute:** Inspired by [codex-plugin-cc](https://github.com/openai/codex-plugin-cc)
> by OpenAI. Its architecture, command structure, and design patterns were adapted
> to work with [OpenCode](https://github.com/anomalyco/opencode).

This is a **Claude Code plugin**, not a native OpenCode plugin. It uses the
released `@opencode/client` V2 API to connect to OpenCode's background service.
Do not add it to OpenCode's `plugins` configuration.

## Requirements

- [Claude Code](https://claude.com/claude-code)
- [OpenCode V2](https://opencode.ai/v2/docs/) in your PATH
- A configured AI provider in OpenCode (open OpenCode and use `/connect`)
- Node.js **22 or later**, npm, Git, and Python 3 (for the installer)

If you already have V2, keep your existing installation and configuration.
For a new installation:

```bash
npm install -g @opencode/cli
opencode --version
```

## Install this fork

Inside Claude Code:

```bash
! curl -fsSL https://raw.githubusercontent.com/armedi/opencode-plugin-cc/main/install.sh | bash
```

The installer clones this fork, caches version 2.0.0, installs its locked V2
client dependencies, and registers `opencode@armedi-opencode-plugin-cc`.
It tries SSH first, then HTTPS.

If the upstream plugin is installed, uninstall it first to avoid duplicate
commands and hooks:

```text
/plugin uninstall opencode@tasict-opencode-plugin-cc
```

Then reload and verify:

```text
/reload-plugins
/opencode:setup
```

For a fuller diagnostic:

```bash
node ~/.claude/plugins/cache/armedi-opencode-plugin-cc/opencode/2.0.0/scripts/opencode-companion.mjs doctor
```

Delegate a task:

```text
/opencode:rescue grep for XXX in src/ and summarize
```

### Uninstall

```text
/plugin uninstall opencode@armedi-opencode-plugin-cc
/reload-plugins
```

## Commands

| Command | Purpose |
| --- | --- |
| `/opencode:review` | Read-only code review; supports `--base <ref>` |
| `/opencode:adversarial-review` | Read-only challenge review with optional focus text |
| `/opencode:rescue` | Delegate work; supports `--model`, `--agent`, `--resume`, `--fresh`, `--background` |
| `/opencode:status` | Running/recent jobs for the current repository |
| `/opencode:result` | Finished output and OpenCode session ID |
| `/opencode:cancel` | Interrupt the V2 session and stop its companion worker |
| `/opencode:setup` | Check installation/service/providers and toggle the review gate |

Model references use `provider/model` or `provider/model#variant`. An explicit
`--model` applies to both foreground and background tasks; otherwise OpenCode
uses its configured default. Resuming reuses the same OpenCode session.

### Permissions and review gate

The companion **never rewrites global OpenCode permissions**. Delegated sessions
deny interactive questions so unattended jobs do not wait for a user response.
Other configured permissions remain in effect. If an operation requests approval,
the companion interrupts the session and reports the requested action/resources;
add an appropriately narrow allow rule yourself before retrying.

Read-only sessions additionally deny edits, shell execution, and subagents.
They can inspect code through read/glob/grep tools, but cannot run tests or shell
commands. This is permission enforcement, not an OS sandbox; custom tools/plugins
must also enforce their own permissions. A resumed read-only session retains
its restrictions; use `--fresh` when switching to writable work.

Enable the optional Stop review gate with `/opencode:setup --enable-review-gate`.
It reviews Claude's response before allowing a stop. It is disabled by default
and may increase latency and model usage.

## V2 service and job lifecycle

The companion discovers (or starts) the shared local V2 service with
`Service.discover()` / `Service.ensure()`, using its registered URL and
authentication. No fixed port, manually spawned V1 daemon, or global config repair
is needed. Status, diagnostics, and hooks do not start a service just to inspect it.

V2 prompt admission returns an inbox acknowledgement, not model output. The
companion polls session outcome, active execution, and pending inbox state before
returning the final assistant message. A completed tool-call step is **not** a
completed job. Failed or interrupted sessions are reported as failures.

Status/result automatically reconcile jobs whose worker exited after the server
finished. `companion heal --dry-run --json` previews this reconciliation;
`--all` includes jobs from other Claude sessions. Unreachable services or sessions
that are still running are left alone rather than incorrectly marked failed.

Inspect live messages with the V2 CLI (which handles discovery/authentication):

```bash
opencode api get /api/session/<session-id>/message
```

## Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `OPENCODE_SERVER_URL` | Discovered service | Explicit V2 server URL; never falls back to starting a different server |
| `OPENCODE_SERVER_PASSWORD` | Unset | Basic authentication for an explicit server |
| `OPENCODE_SERVER_USERNAME` | `opencode` | Basic authentication username for an explicit server |
| `OPENCODE_REQUEST_TIMEOUT_MS` | `1800000` | HTTP request timeout |
| `OPENCODE_PROMPT_TIMEOUT_MS` | `14400000` | Session completion timeout; interrupts the session on expiry |
| `OPENCODE_COMPLETION_POLL_MS` | `5000` | Session completion poll interval |
| `OPENCODE_COMPANION_DATA` | Self-derived | Override plugin data directory |
| `OPENCODE_MONITOR_RESULT_CHARS` | Hook default | Maximum tool-result snippet length |
| `OPENCODE_MONITOR_HEARTBEAT_POLLS` | Hook default | Polls between monitor heartbeats |

`companion config --json` prints resolved settings (passwords are redacted).
The old V1 idle/pgrep/strict-terminal environment settings are no longer used.

## Troubleshooting

- **Service unavailable:** run `opencode service status`, then
  `opencode service start`. For an unhealthy service, use
  `opencode service restart`.
- **No providers:** open OpenCode and use `/connect`, then rerun setup.
- **Missing `@opencode/client`:** rerun this fork's installer. A manually copied
  plugin needs `npm ci --omit=dev --ignore-scripts --workspaces=false` in its root.
- **Permission requested:** configure a narrow V2 `permissions` rule for the
  reported action/resource; the companion deliberately does not auto-approve.
- **Plugin not loading:** rerun the installer, `/reload-plugins`, and restart
  Claude Code if necessary.

V2 reads global `~/.config/opencode/opencode.json(c)` (or `$XDG_CONFIG_HOME`)
and project `opencode.json(c)` / `.opencode/opencode.json(c)` through normal
configuration discovery. Existing supported V1 configuration remains compatible.

## Development

```bash
npm ci
npm test
node plugins/opencode/scripts/opencode-companion.mjs setup --json
node plugins/opencode/scripts/opencode-companion.mjs doctor --json
```

Runtime dependencies and a standalone lockfile live in `plugins/opencode/` so
the cached Claude Code plugin can run independently of this repository.

## License

Copyright 2026 OpenCode Plugin Contributors.
Licensed under the Apache License, Version 2.0. See [LICENSE](LICENSE) and
[NOTICE](NOTICE) for the license and attribution notices.
