# agent-phonon

[中文说明](./README.zh-CN.md)

> From your personal AI assistant to the digital team you lead.

**agent-phonon** is a device-side daemon that discovers local AI coding agents
(Claude Code, Codex, GitHub Copilot CLI, Pi, OpenCode, OpenClaw, Hermes, and more) and exposes them to a
server through one uniform WebSocket/JSON protocol.

Herdr is not supported. There is no compatibility or automatic session migration;
use a supported native adapter. See the [runtime-scope decision](docs/decisions/2026-10-24-native-agents-only.md).

The name comes from the **phonon** in condensed-matter physics: a collective
quasiparticle that emerges when many atoms vibrate together. Individual agents
act alone; orchestrated together they become one system. *More is different.*

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

---

## Product positioning

**One system for your personal assistant and your team of digital employees.**
The experience depends on the devices and agents you connect, not on choosing
between two separate products.

- **Personal assistant:** Create a dedicated OpenClaw agent on your own computer
  and let it handle personal tasks on that computer, using the tools and
  permissions available to it.
- **Digital employee team:** Give multiple agents distinct responsibilities and
  let the connected application or server coordinate their work. They can run on
  the same device or across several devices; a team does not require one device
  per employee.

**Devices determine where tasks run; agents determine who does the work and how
they collaborate.** Start with one useful assistant and add collaborators as
needed, without an upfront choice between an assistant and a team.

agent-phonon provides the shared device-side execution foundation; the connected
application or server provides the user experience and cross-device coordination.
Agent creation and task execution remain subject to each adapter's declared
capabilities and the device owner's local authorization. See the
[product design](docs/design.md#11-产品定位私人助手与数字员工团队).

## What it does

Local AI agents are powerful but siloed. Each has a different CLI, session model,
streaming format, model switch mechanism, and set of capabilities. agent-phonon
puts a small daemon in front of them so a server can:

- discover which agents and models are available on a device,
- create/send/interrupt/terminate sessions through one protocol,
- stream output and receive unsolicited/proactive agent output,
- manage projects, worktrees, skills, files, env vars, and HITL hooks,
- orchestrate many devices while each device still enforces its own local policy,
- keep a built-in `phonon-rescue` recovery agent and deterministic maintenance plane available even when every external agent is broken.

Adapters declare their real capabilities; agent-phonon does **not** pretend every
agent works the same way.

Native mobile chat transports, retained Sessions, bounded stream repair and
durable dispatch cancellation are described in [Native Chat](docs/NATIVE_CHAT.md).

## Architecture

```text
        server(s)                          your device(s)
   ┌────────────────┐   wire protocol   ┌────────────────────────────┐
   │  server SDK    │◄─────WS / JSON────►│  phonon daemon (core)      │
   │  (TS / Python) │                   │   ├─ adapter: OpenClaw      │
   │  console / app │                   │   ├─ adapter: Claude Code   │
   └────────────────┘                   │   ├─ adapter: Codex         │
                                        │   ├─ adapter: Copilot CLI   │
                                        │   ├─ adapter: OpenCode      │
                                        │   ├─ adapter: Hermes        │
                                        │   └─ adapter: Pi            │
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
  - GitHub Copilot CLI: `copilot`
  - OpenCode: `opencode`
  - Hermes: `hermes`
  - Pi: `pi` — install with `curl -fsSL https://pi.dev/install.sh | sh`
  - OpenClaw Gateway/plugin for OpenClaw integration

User-service management supports **systemd --user** on Linux and **launchd** on
macOS. Windows currently provides manual nssm/Task Scheduler guidance.

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

## Run as a macOS user service

Run these commands as the signed-in macOS user, without `sudo`:

```bash
agent-phonon init                 # only if no config exists yet
agent-phonon service install
agent-phonon service start
agent-phonon service status
```

The LaunchAgent is `~/Library/LaunchAgents/ai.phonon.agent.plist`. Installation
prepares login autostart but does **not** start or interrupt a running daemon.
`start` registers it in the user's GUI login session; an already-running service
is left alone. launchd restarts crashes with a five-second throttle.

```bash
agent-phonon service stop         # stays stopped until start or the next login
agent-phonon service restart      # waits for exit, then reloads the installed plist
agent-phonon service uninstall    # removes only the service; keeps all user data
```

The plist pins absolute Node/CLI paths and captures executable search paths
(including the selected Node installation and Homebrew). Only `HOME`, `PATH`,
and the selected `PHONON_CONFIG` path are recorded; shell API keys are not copied.
Use protected config/key files for service credentials, not interactive exports.
Logs go to `~/.agent-phonon/daemon.out.log` and `daemon.err.log`; installation
preserves their content and sets owner-only permissions (`0600`). This is a
login service, not a system-wide boot daemon; it
does not stay active after logout or prevent macOS sleep.

Service support does not imply platform parity for every RPC: the current secure
file broker uses Linux `/proc` fd anchors and rejects file-broker operations on
macOS rather than weakening symlink-race protection.

After changing the Node/npm installation path, run `service install --force`
from the new CLI, then `service restart`. Existing configuration, credentials,
SQLite data and logs are preserved. Do not also run a foreground daemon against
the same configuration while the service is active.

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
- GitHub Copilot CLI models are parsed from `copilot help config`; the adapter
  uses JSONL streaming and native named-session resume.
- Hermes models are discovered from Hermes profile/config/catalog information
  with provider fallbacks when the catalog is incomplete.
- No user-specific provider names, endpoints, or local machine paths are
  hard-coded.

## Built-in recovery agent and maintenance plane

`phonon-rescue` is built into the daemon. It does not depend on OpenClaw,
Claude Code, Codex, Copilot, OpenCode, or Hermes. Configure any endpoint that
supports **OpenAI Chat Completions or Responses plus tool calling**:

```bash
agent-phonon rescue configure \
  --base-url https://your-endpoint.example/v1 \
  --model your-tool-capable-model \
  --api-key-ref ~/.agent-phonon/rescue.key
```

The CLI probes the selected transport and tool calling using the runtime provider before saving. `--api-key-env`
is also supported; a `0600` key file is recommended for a
background service.

For an explicitly unauthenticated loopback endpoint, use `--no-auth` (saved as
`rescueAgent.authMode: "none"`). Only `127.0.0.1`, `localhost`, and `[::1]` are
accepted; remote endpoints still require authentication. This mode rejects
explicit key settings, ignores the fallback key environment variable, and sends
no Authorization, x-api-key, x-goog-api-key or query key. The default remains `"api-key"`. Discovery checks
configuration readiness, not live endpoint compatibility. A failed CLI tool
probe does not save configuration.

Transport defaults to `chat` for existing configurations. Select Responses with
`--wire-api responses` (saved as `rescueAgent.wireApi: "responses"`), for example:

```bash
agent-phonon rescue configure --base-url http://127.0.0.1:4000/v1 \
  --model gpt-5.6-sol --wire-api responses --no-auth
```

### Bundled Rescue repair knowledge

Fresh Rescue sessions can query a read-only, version-scoped repair pack with `query_knowledge` before using maintenance tools. The pack ships inside the daemon bundle, not in a previous chat or a global skill directory. It covers OpenCode, Claude protocol/roles and conditional GPT compatibility, Hermes YAML, limited Codex/Copilot facts, and five-format checksum/rollback safety. Unknown versions/platforms do not receive repair procedures; native verification and stopped-service limitations remain explicit. See [knowledge architecture, boundaries and provenance](docs/rescue-knowledge.md).

### Rescue wire protocols

`rescueAgent.wireApi` / `--wire-api` selects the protocol **independently of the
model ID**. The default remains `chat`; there is no model-name inference, HTTP
error fallback, or automatic retry that could re-execute maintenance tools.
Supply an explicit endpoint and a model ID listed by that endpoint. Rescue never
falls back to a provider's public default URL.

| wireApi | Official AI SDK provider | baseUrl example (include API prefix) | SDK suffix | Text delivery |
|---|---|---|---|---|
| `chat` | `@ai-sdk/openai-compatible` | `https://endpoint.example/v1` | `/chat/completions` | token stream |
| `responses` | `@ai-sdk/openai` | `https://endpoint.example/v1` | `/responses` | completed step |
| `anthropic` | `@ai-sdk/anthropic` | `https://endpoint.example/v1` | `/messages` | completed step |
| `gemini` | `@ai-sdk/google` | `https://endpoint.example/v1beta` | `/models/{model}:generateContent` | completed step |

The examples are placeholders, not configured services. Custom path prefixes are
preserved; trailing slashes are removed. Do not supply the operation suffix or
append another `/v1`. For official services the corresponding prefixes are
`https://api.anthropic.com/v1` and
`https://generativelanguage.googleapis.com/v1beta`. Gemini accepts a bare model ID
or the endpoint's resource ID (`models/...`); the SDK does not double `models/`.
`baseUrl` must not contain userinfo, query parameters (including keys), or a fragment.

For an already provisioned key file, use the native **`--api-key-ref <file>`**
entry point; the secret value stays out of command arguments, shell history and
the persisted rescue settings. Provision the file through your local secure
credential workflow, with owner-only `0600` permissions. Do not paste a secret
into chat or a CLI argument. For example, using only endpoint/model placeholders:

```bash
agent-phonon rescue configure --base-url https://endpoint.example/v1 \
  --model endpoint-listed-model --wire-api anthropic \
  --api-key-ref /secure/path/rescue-key
agent-phonon rescue configure --base-url https://endpoint.example/v1beta \
  --model endpoint-listed-model --wire-api gemini \
  --api-key-ref /secure/path/rescue-key
```

Authenticated Anthropic uses the official `x-api-key` plus `anthropic-version`;
Gemini uses `x-goog-api-key`; Chat/Responses use Bearer Authorization. Rescue
resolves explicit key/ref/env settings (or its existing `PHONON_RESCUE_API_KEY`
fallback) itself, rather than implicitly reading provider-specific key env vars.
Explicit loopback `--no-auth` works for all four protocols, rejects key settings,
and does not read key env variables. Pinned official `/internal` constructors
bypass mandatory key-loading factories for Responses/Anthropic/Gemini, without
fake keys or stripping a factory-generated secret. These version-sensitive
exports require regression tests on upgrades: openai `4.0.43`, anthropic `4.0.41`,
google `4.0.50` (provider `4.0.7`, compatible with ai `7.0.58`).

Responses/Anthropic/Gemini use official `ToolLoopAgent.generate`: complete step
text is emitted as one append message, not fabricated token deltas; real tool
execution callbacks are forwarded live. Invalid tool inputs rejected before
execution are reported from the SDK step content with their real call IDs.
Responses retains stateless replay (`store: false`, `parallelToolCalls: false`)
to support endpoints that omit SSE text deltas. Chat retains token streaming.
All protocols keep Zod validation, local maintenance policy and expected-SHA
checks. Only Gemini's `patch_config.patch` is a JSON-encoded object string,
because the official OpenAPI converter drops open-ended `additionalProperties`.
The tool parses it and validates the decoded object with Zod before calling the
same maintenance manager; other protocols keep the object argument. This is a
tool schema adaptation, not an HTTP protocol converter. Timeout/abort, unfinished tool loops at the step limit, truncation and
filtered/error finishes are not reported as completed. No HTTP redirects are
followed. Protocol implementation and simulated regressions do **not** imply
that any particular endpoint supports it; discovery is only a configuration
readiness check, while the CLI performs a live tool-call probe before saving.
Native Anthropic/Gemini probes select `toolChoice: auto` up front because some
thinking endpoints reject forced tool choice; an actual `phonon_probe` call is
still required. Chat/Responses retain forced tool choice. A 200 response with no
probe call fails, without saving, retrying or switching protocols.
Restart a daemon separately to load saved settings; configuring or probing does
not start production.

The rescue agent has no arbitrary shell or host filesystem tool. It can only
invoke locally registered semantic maintenance operations. The same operations
are also exposed directly through the server SDK as `device.maintenance.*`, so
recovery still works when the rescue model endpoint is unavailable:

- inventory and diagnostics,
- redacted JSON/JSONC/YAML/TOML config reads and explicitly public UTF-8 text,
- optimistic-lock JSON/JSONC/YAML merge patch and exact public text edits with automatic raw-byte backup,
- checksum-verified rollback,
- allowlisted user-level npm/pnpm package updates,
- allowlisted user-service status and restart.

All maintenance capabilities are controlled by independent device policy flags
and default to **off**. `trustLocal` does **not** enable host maintenance;
each server must opt in explicitly with its local `policy`. Raw paths, package names, service names,
and shell strings are never accepted over the wire.

See [multi-format maintenance](docs/PROTOCOL.md#多格式维护配置与文本编辑) for exact edit authorization, size/syntax limits, comment handling and TOML edit-only semantics. Hermes YAML and Codex TOML defaults are registered read-only.

## Adapter overrides

Most users should rely on auto-detection. Add an adapter override only when you
need to force a path/model/provider:

```bash
agent-phonon adapter add codex --bin /path/to/codex --model default
agent-phonon adapter add claude-code --bin /path/to/claude --model default
# Native CLI installations additionally select a prepared Agent SDK:
agent-phonon adapter add claude-code --bin /path/to/claude --sdk-path /path/to/claude-agent-sdk/sdk.mjs --model default
agent-phonon adapter add copilot --bin /path/to/copilot --model default
agent-phonon adapter add hermes --bin /path/to/hermes
agent-phonon adapter add opencode --bin /path/to/opencode
```

OpenClaw integration:

```bash
agent-phonon plugin install openclaw
agent-phonon adapter add openclaw --agent main
```

## Server SDKs

Current-turn input is capability-gated and never silently becomes a queue or
interrupt. See [tool-gap insertion and acknowledgement semantics](docs/MID_TURN_INPUT.md).

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
- [L3 orchestration protocol](./docs/L3_ORCHESTRATION.md)
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

### Secure server connection defaults

Daemon `servers[]` supports `expectedTenantId` (optional non-empty exact tenant
identity; surrounding whitespace/control characters rejected) and `allowInsecure`
(optional **boolean**, default false). Both reach the device client. A mismatched
welcome tenant is rejected; non-loopback plaintext still requires an explicit
owner exception. Prefer WSS: tenant pinning does not replace TLS authentication.
No production configuration is changed by these options or tests.

TS `new PhononServer()` binds **127.0.0.1** when `host` is omitted. Explicit
non-loopback binds require `authenticate`, unless the owner deliberately opts
into `allowAnonymous: true`. Python provides equivalent `allow_anonymous=True`
and keeps its async authentication callback contract. A supplied callback still
controls acceptance even when anonymous opt-in is set.

For isolated default/local E2E/Python tests and separately gated live tests, see
[Local testing](docs/LOCAL_TESTING.md). RPC method presence checks alone do not
prove authentication or bind-address parity.


## Local session history

Verified recovery is separate from retained history. Devices exposing
`session_recovery_v1` support identity-bound `session.recover`, which never
sends input or resumes a workflow. Only settled, adapter-verifiable native
checkpoints can be reopened; unsupported/legacy/interrupted retained Sessions
are not silently recreated. Codex is the first production adapter path. See
[Verified Native Session Recovery](docs/SESSION_RECOVERY.md), including the
distinct generic workflow retry behavior and current integration gaps.

Session transcript files are retained by default for all sessions, including Dev workflows. Completing or terminating a session, acknowledging delivery, restarting the daemon, or writing another session does not rotate, truncate or expire that history. Existing transcript files and earlier `.jsonl.1` archives are left untouched.

Users may explicitly delete history using the existing `agent-phonon sessions prune --older-than <days>` or `--keep <n>` command. It previews candidates unless `--yes` is supplied; review them before deletion. This is an owner-invoked operation, not a scheduled retention policy or a general reference-safe garbage collector. Deletion cannot recover already-lost historical content.

The unacknowledged-event outbox is separate from history: it stores events still needing server delivery, and removes acknowledged entries after a receipt. ACK does **not** delete session transcript files. Automatic retention policy is deferred; files can grow while users retain them. Transcript writing remains best-effort and is not a guarantee against disk-full or I/O failure.


### Unacknowledged delivery warning threshold

`delivery.maxPendingBytes` defaults to **1 GiB (1073741824)** and accepts only a positive safe integer:

```json
{ "delivery": { "maxPendingBytes": 1073741824 } }
```

Despite the compatibility field name, this is a **warning threshold, not an admission/write cap**. Device-wide serialized UTF-8 payload bytes of stream/workflow/run unACKed events (all tenants, including disconnected tenants) warn at 80% and become critical at 100%. Byte pressure alone never rejects, defers, cancels or deletes new tasks, input messages, workflows or scheduled executions. Events/results still persist and replay; ACK drains the actual backlog. `/health.delivery` and metrics expose counts, bytes, pressure and persistence health without payloads; pressure makes health degraded, not stopped.

There is **no new end-to-end durable inbound task/input queue**; a rejected request must not be described as saved. Actual storage/read failure still explicitly fails new work closed and marks unhealthy, rather than pretending to accept it. ACKed histories and Session JSONL remain retained. This threshold does **not** bound disk or RAM: SQLite/WAL/history overhead is separate and the existing Outbox still mirrors payloads in memory. See [delivery measurement, reliability and limits](docs/DELIVERY_CAPACITY.md).
