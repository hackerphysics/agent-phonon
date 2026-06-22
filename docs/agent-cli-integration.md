# Agent CLI Integration Guide

How agent-phonon's adapters drive each local AI coding agent. This is the
reference for how each runtime is invoked, what session model it uses, and the
non-obvious gotchas discovered while implementing the adapters.

> **Boundary note**: phonon is gateway-agnostic. Every adapter takes its
> endpoint/credentials from config — phonon never hardcodes a provider, gateway,
> or API key. Examples below use placeholders like `<your-gateway>` and
> `<token>`; substitute your own gateway or a direct official API endpoint.

---

## OpenClaw adapter

OpenClaw is a **multi-agent runtime** (one install hosts multiple agents, keyed
by workspace). Composite agentId is `openclaw:<subAgent>`.

Three integration paths exist; phonon uses **Gateway WebSocket as primary** with
**spawn-CLI as fallback** and an **OpenClaw plugin** for hook/HITL.

### Path A — spawn CLI (fallback)
- `openclaw agent --local --json --session-key <key> --message <text> --model <id>`
- Result via `meta.finalAssistantVisibleText`; same `--session-key` resumes
  context across calls (native resume).
- ✅ Simple, zero-dependency, e2e-proven.
- ❌ Spawns a process per turn (heavy); **no streaming deltas / tool events /
  unsolicited output** (cron bubbles invisible); interrupt = kill process.

### Path B — OpenClaw Gateway WebSocket (primary)
- Connect to the Gateway's WS. Rich RPC surface:
  - `createSession / patchSession / getSessionStatus / deleteSession / resetSession`
  - `compactSession` (native compression), `abortChat` (interrupt),
    `injectAssistantMessage` (inject)
  - **`sessions.messages.subscribe`** (unsolicited output) — maps to phonon's
    subscription model
  - `onToolEvent` (tool event stream) — maps to `verbosity=tools`
- Handshake: ws → receive `connect.challenge` event → send `connect` req
  (with token + scopes `operator.read/write/admin`).
- ✅ **Full capability**: streaming, tool events, unsolicited-output subscription,
  native compact/abort/inject — nearly 1:1 with phonon protocol primitives.
- ✅ Reuses the Gateway process; no per-turn spawn.
- ❌ Requires a running Gateway + token; more complex than spawn.

### Path C — OpenClaw plugin (HITL / directive emit)
- OpenClaw's plugin system has five kinds: channel / provider / CLI backend /
  tool / hook.
- phonon ships an **OpenClaw plugin** (`packages/openclaw-plugin`) that hooks
  `before_tool_call` and bridges to phonon-core's HookBridge for HITL.
- Tool-level interception **must** go through plugin hooks (`before_tool_call`);
  internal hooks can't do it.

### `before_tool_call` contract (verified)
- It's a **two-argument** hook: `(event, ctx)`. The
  `sessionKey/agentId/sessionId/runId` live in the **second arg `ctx`**
  (`PluginHookToolContext`), not in `event`. (Easy to miss — if you only read
  `event`, sessionKey is always undefined and everything silently passes.)
- Return values:
  - allow: `return undefined`
  - block: `return { block: true, blockReason: "<reason>" }`
  - rewrite args: `return { params: {...} }`
  - human approval: `return { requireApproval: { title, description, severity, timeoutMs, timeoutBehavior } }`
- **fail-open**: if the HookBridge is unreachable (or the sessionKey doesn't
  route to a phonon-managed session), the call is allowed — the plugin only
  adjudicates sessions phonon actually owns.

### Plugin install / update
```bash
cd packages/openclaw-plugin && pnpm build
openclaw plugins install <path-to-built-plugin>
```
- Configure `bridgeUrl` (default `http://127.0.0.1:4318`) and `interceptTools`
  (empty = intercept all).
- Note: pnpm workspace `node_modules` may contain symlinks pointing outside the
  monorepo (e.g. typescript), which OpenClaw's install-time security scan
  rejects (`node_modules symlink target outside install root`). The plugin has
  zero runtime deps, so export a clean artifact (dist + package.json without
  devDeps + manifest, no node_modules) and `install --force` from there.
  `scripts/update-plugin.sh` automates build → export → force-install.

---

## runtime vs agent (design D32)

- **Multi-agent runtimes** (OpenClaw, Hermes): one runtime, many agents (keyed by
  workspace/profile). `discoverAgents()` enumerates several; composite agentId is
  `<runtime>:<subAgent>` (e.g. `openclaw:main`, `hermes:default`).
- **Single-agent runtimes** (Codex, Claude Code, OpenCode): the runtime *is* the
  agent; `discoverAgents()` returns one.
- `AdapterRegistry.resolve(agentId)` routes by runtime prefix.

---

## Claude Code adapter

Single-agent runtime; `discoverAgents` returns one `claude-code`.

### Invocation (each part matters)
1. **CLI**: `claude -p --output-format stream-json --input-format stream-json
   --verbose --permission-mode bypassPermissions --allowedTools <tools>
   [--model X] [--session-id <uuid> | --resume <uuid>]`
2. **Prompt goes on stdin** (not argv):
   `{"type":"user","message":{"role":"user","content":[{"type":"text","text":"..."}]}}\n`
   — using `-p "prompt"` together with `--input-format stream-json` hangs waiting
   on stdin.
3. **Strip outer env**: `env -u CLAUDECODE` (and `CLAUDECODE_*` / `CLAUDE_CODE_*`)
   to avoid a wrapping Claude Code's state leaking in.
4. **Auth via `--settings`** injecting a complete env set:
   ```json
   {"env":{
     "ANTHROPIC_BASE_URL":"<your-endpoint>",
     "ANTHROPIC_AUTH_TOKEN":"<token>",
     "ANTHROPIC_MODEL":"<model>",
     "ANTHROPIC_DEFAULT_OPUS_MODEL":"<model>",
     "ANTHROPIC_DEFAULT_SONNET_MODEL":"<model>",
     "ANTHROPIC_DEFAULT_HAIKU_MODEL":"<model>",
     "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC":"1"
   }}
   ```
   - Setting only BASE_URL + TOKEN is **not enough** — internal calls use the
     default model names, so map all `DEFAULT_*_MODEL` to your endpoint's model or
     they'll be rejected.
   - `--settings` overrides the global `~/.claude/settings.json` **without**
     polluting the user's global config.

### Gotcha
- If `~/.claude/settings.json` was rewritten by a proxy/switcher tool to point at
  a non-running local proxy with a fake token, default Claude Code hangs. The
  adapter sidesteps this entirely by supplying a clean config via `--settings`.

---

## Codex adapter

Single-agent runtime (`discoverAgents` returns one `codex`).

### Invocation
1. **CLI**: `codex exec - --json -c model_provider=<id>
   -c model_providers.<id>.base_url=... -c model_providers.<id>.wire_api=responses
   -c model_providers.<id>.env_key=OPENAI_API_KEY --model <m>
   --dangerously-bypass-approvals-and-sandbox`
   - Prompt on **stdin** (argv uses `-` as placeholder).
   - Resume: `codex exec resume <thread_id> - --json ...`
2. **Provider override via `-c`** so you don't touch `~/.codex/config.toml`.
   - If your endpoint's model only speaks the Responses protocol
     (`/v1/responses`, not chat/completions), set `wire_api=responses`.
   - Auth via the `OPENAI_API_KEY` env (named by `env_key`).
3. **Event stream** (JSON lines): `thread.started` (thread_id = session) →
   `turn.started` → `item.completed` (item.type: `agent_message` /
   `command_execution` / …) → `turn.completed` (usage).
   - session_id = thread_id (captured from `thread.started`, not pre-assigned).

---

## Hermes adapter

**Multi-agent runtime** (like OpenClaw): a Hermes profile = an independent agent
(its own config/.env/SOUL.md/skills). Composite agentId `hermes:<profile>`.

- Enumerate: `hermes profile list`; select via `HERMES_PROFILE=<profile>` env.
- Invoke: `hermes -z <prompt> -m <model> [--provider X] --continue <name>`
- `-z`/`--oneshot`: plain-text single-shot output (non-streaming → final event).
- Session: `--continue <name>` (creates on first turn, resumes after). The name
  is stored as the session **title**, which is how the session is later located.
- `--pass-session-id` is a flag, not a parameter.

---

## OpenCode adapter

Single-agent runtime.
`opencode run --format json --dangerously-skip-permissions --model <m>
[--session <ses_id>] <prompt>`

- **Key gotcha**: Node's `spawn` defaults stdin to a pipe; OpenCode detects this
  and hangs waiting for interactive input. You **must** set
  `stdio: ["ignore", "pipe", "pipe"]` (stdin = /dev/null).
- Event stream: `step_start` / `text` (part.text) / `tool`; session id is `ses_…`
  (captured from events for `--session` resume).
- Binary auto-detected at `~/.opencode/bin/opencode` if not on PATH.
