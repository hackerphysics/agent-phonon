# agent-phonon

> Orchestrate many agents as one — run them on your device, command them from anywhere.

**agent-phonon** unifies the local AI coding agents on your machine
(Claude Code · Codex · OpenCode · OpenClaw · Hermes …) behind a **single wire
protocol**, so a server — or any other program — can dispatch work to them
remotely and use your local agents the way you'd use a cloud service.

> The name comes from the **phonon** in condensed-matter physics — the collective
> quasiparticle that emerges when a huge number of atoms vibrate in concert.
> Individual agents act alone; orchestrated together they emerge as one system.
> *More is different.*

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

---

## Why

Local AI agents are powerful but siloed: each has its own CLI, session model,
streaming format, and quirks. agent-phonon puts a **device-side daemon** in front
of them that:

- **discovers** which agents and models are available on the device,
- exposes a **uniform protocol** for sessions, streaming, projects/worktrees,
  skills, files, env vars, and human-in-the-loop hooks,
- lets one **server orchestrate many devices**, and one device serve many
  servers, with tenant isolation.

Adapters declare what each runtime natively supports (`AgentCapabilities`) and
the core fills the gaps — no pretending every agent is the same.

## Architecture

```
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

agent-phonon is a **single repository, multiple independently published
packages**. Three packages are published:

| Directory | Published package | For |
|---|---|---|
| `packages/daemon` | `agent-phonon` (npm) | Installing/running the phonon daemon on a device |
| `packages/protocol` | `@agent-phonon/protocol` (npm) | Reusing protocol types & zod schemas in TS |
| `packages/sdk-server-ts` | `@agent-phonon/server-sdk` (npm) | A TS/Node server orchestrating phonon devices |
| `sdk-python` | `agent-phonon` (PyPI) | A Python/AI server orchestrating phonon devices |

`@agent-phonon/core` is the device-side implementation library; it is **bundled
into the `agent-phonon` daemon** rather than published separately. The
`@agent-phonon/console` (web UI) and `@agent-phonon/openclaw-plugin` live in the
repo but aren't published to npm — the console is a reference/demo server, and
the plugin is installed through OpenClaw (`openclaw plugins install`).
`@agent-phonon/test-server` is a reference server for the test suite, **not for
production**.

### Why one repo, many packages

- Protocol and implementations co-evolve — one PR can touch protocol, core, both
  SDKs, console, and tests together.
- Cross-language e2e is straightforward — verify the TS and Python SDKs both
  drive a real phonon core from the same repo.
- Install experience is unaffected — users still
  `npm install @agent-phonon/server-sdk` or `pip install agent-phonon`.
- Splittable later — once the protocol/API stabilize and release cadences
  diverge, individual packages can move to their own repos.

## Quick start

> Requires Node.js >= 20 and pnpm >= 9. (Python SDK needs Python >= 3.10.)

```bash
pnpm install
pnpm -r build
pnpm -r test
```

Orchestrate from a server (TypeScript):

```bash
npm install @agent-phonon/server-sdk
```

Orchestrate from a server (Python):

```bash
pip install agent-phonon
```

See [`docs/PROTOCOL.md`](./docs/PROTOCOL.md) for the wire protocol,
[`docs/design.md`](./docs/design.md) for design decisions (ADRs), and
[`docs/agent-cli-integration.md`](./docs/agent-cli-integration.md) for how each
agent CLI is integrated.

## Security

agent-phonon is a remote control plane for local agents, so security is central:
local policy is the authorization boundary, filesystem access is sandboxed
(realpath, no symlink escapes), env-var secrets are encrypted at rest, and skill
archives are verified. See [`SECURITY.md`](./SECURITY.md).

## Contributing

Contributions welcome — see [`CONTRIBUTING.md`](./CONTRIBUTING.md).

## License

[MIT](./LICENSE) © agent-phonon contributors
