# agent-phonon

[中文说明](./README.zh-CN.md)

> Orchestrate many agents as one — run them on your device, command them from anywhere.

**agent-phonon** is a device-side daemon that discovers local AI coding agents
(Claude Code, Codex, OpenCode, OpenClaw, Hermes, and more) and exposes them to a
server through one uniform WebSocket/JSON protocol.

The name comes from the **phonon** in condensed-matter physics: a collective
quasiparticle that emerges when many atoms vibrate together. Individual agents
act alone; orchestrated together they become one system. *More is different.*

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

---

## What it does

Local AI agents are powerful but siloed. Each has a different CLI, session model,
streaming format, model switch mechanism, and set of capabilities. agent-phonon
puts a small daemon in front of them so a server can:

- discover which agents and models are available on a device,
- create/send/interrupt/terminate sessions through one protocol,
- stream output and receive unsolicited/proactive agent output,
- manage projects, worktrees, skills, files, env vars, and HITL hooks,
- orchestrate many devices while each device still enforces its own local policy.

Adapters declare their real capabilities; agent-phonon does **not** pretend every
agent works the same way.

## Architecture

```text
        server(s)                          your device(s)
   ┌────────────────┐   wire protocol   ┌────────────────────────────┐
   │  server SDK    │◄─────WS / JSON────►│  phonon daemon (core)      │
   │  (TS / Python) │                   │   ├─ adapter: OpenClaw      │
   │  console / app │                   │   ├─ adapter: Claude Code   │
   └────────────────┘                   │   ├─ adapter: Codex         │
                                        │   ├─ adapter: OpenCode      │
                                        │   └─ adapter: Hermes        │
                                        └────────────────────────────┘
```

## Packages

| Directory | Published package | For |
|---|---|---|
| `packages/daemon` | `agent-phonon` (npm) | Device daemon / CLI |
| `packages/protocol` | `@agent-phonon/protocol` (npm) | Protocol types and zod schemas |
| `packages/sdk-server-ts` | `@agent-phonon/server-sdk` (npm) | TypeScript/Node server SDK |
| `sdk-python` | `agent-phonon-sdk` (PyPI) | Python server SDK |

`@agent-phonon/core` is bundled into the daemon package and is not published as a
separate runtime dependency. Console/test/plugin packages are kept in the repo
for development and integration testing.

## Requirements

- Node.js >= 22.5
- npm or pnpm
- Optional local agents:
  - Claude Code: `claude`
  - Codex CLI: `codex`
  - OpenCode: `opencode`
  - Hermes: `hermes`
  - OpenClaw Gateway/plugin for OpenClaw integration

Linux service management currently targets **systemd --user**. macOS launchd and
Windows service support are planned separately.

## Install the device daemon

```bash
npm install -g agent-phonon
agent-phonon --help
```

Initialize local config:

```bash
agent-phonon init
```

The config file is created at:

```text
~/.agent-phonon/config.json
```

It contains the device id, local database path, adapter overrides, server
connections, and local policy. Secrets are redacted by default when printed:

```bash
agent-phonon config
agent-phonon config --show-secrets   # only when you really need it
```

## Configure a server connection

If your server gives you a WebSocket URL and device key:

```bash
agent-phonon server add wss://your-server.example/phonon --device-key <device-key>
```

For local development only, you can mark a server as trusted-local:

```bash
agent-phonon server add ws://127.0.0.1:4317/phonon --trust-local
```

List configured servers:

```bash
agent-phonon server list
```

## Run as a Linux user service

Install the systemd user unit:

```bash
agent-phonon service install
```

Start it:

```bash
agent-phonon service start
```

Useful service commands:

```bash
agent-phonon service status
agent-phonon service restart
agent-phonon service stop
agent-phonon service uninstall
```

`service install` writes:

```text
~/.config/systemd/user/agent-phonon.service
```

and runs:

```bash
systemctl --user daemon-reload
systemctl --user enable agent-phonon.service
```

It does not start the daemon until you explicitly run `service start`.

If the daemon should run after logout on a Linux server, you may need to enable
linger for your user:

```bash
loginctl enable-linger "$USER"
```

## Run in the foreground

For debugging or non-systemd environments:

```bash
agent-phonon start
```

## Discover local agents and models

Run:

```bash
agent-phonon doctor
agent-phonon discover
```

`doctor` checks whether local CLIs and integrations are available. `discover`
returns normalized agent descriptors, including available models and declared
capabilities.

Adapter auto-detection is conservative:

- CLI availability is checked by executing each CLI's version command.
- Commands are resolved to absolute paths when possible, so systemd/launchd PATH
  differences do not hide globally installed CLIs.
- Codex models are discovered from the user's Codex config provider endpoint
  (`GET <base_url>/models`) when available, with safe fallback models.
- Hermes models are discovered from Hermes profile/config/catalog information
  with provider fallbacks when the catalog is incomplete.
- No user-specific provider names, endpoints, or local machine paths are
  hard-coded.

## Adapter overrides

Most users should rely on auto-detection. Add an adapter override only when you
need to force a path/model/provider:

```bash
agent-phonon adapter add codex --bin /path/to/codex --model default
agent-phonon adapter add claude-code --bin /path/to/claude --model default
agent-phonon adapter add hermes --bin /path/to/hermes
agent-phonon adapter add opencode --bin /path/to/opencode
```

OpenClaw integration:

```bash
agent-phonon plugin install openclaw
agent-phonon adapter add openclaw --agent main
```

## Server SDKs

### TypeScript / Node

```bash
npm install @agent-phonon/server-sdk
```

```ts
import { PhononServer } from "@agent-phonon/server-sdk";

const server = new PhononServer({ port: 4317 });
server.listen();
```

### Python

```bash
pip install agent-phonon-sdk
```

```python
from agent_phonon import PhononServer

server = PhononServer(port=4317)
server.run()
```

## Development

```bash
pnpm install
pnpm run consistency
pnpm -r build
pnpm -r test
```

Before committing or tagging releases, install the project git hook:

```bash
pnpm run install-hooks
```

Release guardrails live in:

- `AGENTS.md`
- `docs/COMMIT_RELEASE_CHECKLIST.md`
- `scripts/check-consistency.mjs`
- `scripts/release-guard.mjs`

## Documentation

- [Wire protocol](./docs/PROTOCOL.md)
- [Design decisions](./docs/design.md)
- [Agent CLI integration](./docs/agent-cli-integration.md)
- [Release checklist](./docs/COMMIT_RELEASE_CHECKLIST.md)
- [Security](./SECURITY.md)

## Security model

agent-phonon is a remote control plane for local agents. The local device owner
is the authorization boundary. Filesystem access is policy-gated, secrets are
redacted by default and encrypted at rest where stored by phonon, and dangerous
operations are denied unless local policy explicitly allows them.

## License

[MIT](./LICENSE) © agent-phonon contributors
