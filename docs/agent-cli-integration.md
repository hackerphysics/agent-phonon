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
- Map native `chat` delta/final/error/aborted events to one terminal turn; abort and
  termination settle the local wait and clear its guard timer. Tool streams support
  both `agent.stream=tool` and the current `agent.stream=item, data.kind=tool`
  start/end events. Item-only payloads prove lifecycle/status, not raw tool I/O.
- `chat.inject` is transcript/UI-only on current Gateways, so context injection is
  queued into the next real `chat.send` input. It does not claim mid-turn injection.
- Model discovery uses `models.list(view=default)`, respecting the Gateway allowlist.
  Switching uses a separate read/write-only connection: no admin sticky-default
  mutation authority. Native errors propagate; local model state changes only after
  a response with a resolved model.
- Native compaction requires `sessions.compact` to confirm `compacted=true`;
  no-op/unsupported responses are not success. Custom dropToolIO supports only
  resolvable legacy JSONL, not Gateway-owned SQLite transcripts without a public API.
- Subscription capability is not proof of spontaneous output or installed hooks;
  validate the native integration separately without changing host policy for a test.
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
- **Single-agent runtimes** (Codex, Claude Code, GitHub Copilot CLI, OpenCode):
  the runtime *is* the agent; `discoverAgents()` returns one.
- `AdapterRegistry.resolve(agentId)` routes by runtime prefix.

---

## Claude Code adapter

Single-agent runtime; `discoverAgents` returns one `claude-code`.

### Invocation (each part matters)
1. **CLI**: `claude -p --output-format stream-json --input-format stream-json
   --verbose
   [--model X] [--session-id <uuid> | --resume <uuid>]`
2. **Prompt goes on stdin** (not argv):
   `{"type":"user","message":{"role":"user","content":[{"type":"text","text":"..."}]}}\n`
   — using `-p "prompt"` together with `--input-format stream-json` hangs waiting
   on stdin.
3. **Strip outer env**: `env -u CLAUDECODE` (and `CLAUDECODE_*`; preserve native `CLAUDE_CODE_*` safety settings)
   to avoid a wrapping Claude Code's state leaking in.
4. **Native auth and approvals are preserved**. Keep HOME; do not auto-add bypass
   flags. Explicit host-configured endpoint/auth overrides are passed only through
   the child environment, never a temporary credential file or command argument.
   A missing native provider, unavailable proxy or unapproved action must remain
   an observable failure/blocker; do not rewrite native settings to make a test pass.
5. **Independent settings (Claude 2.1.123)**: owner daemon adapter config may set
   `claudeSettingsPath` to an absolute standalone JSON file. This is not a remote
   session/agentConfig option. The adapter passes `--settings <path>` and
   `--setting-sources ''`, without rewriting the file. Selected settings replace
   legacy `claudeBaseUrl`/`claudeAuthToken` and discovery default-model overrides;
   `session.create.model != default` remains an explicit native `--model` override.
   Inherited Anthropic credentials/models/provider selectors are removed before
   applying the selected `env`. A settings endpoint must carry its own auth or
   apiKeyHelper, never borrow credentials from the old endpoint. Without
   `claudeSettingsPath`, existing native/legacy override behavior is unchanged.

---

## Codex adapter

Single-agent runtime (`discoverAgents` returns one `codex`).

### Invocation
1. **CLI**: `codex exec - --json -c model_provider=<id>
   -c model_providers.<id>.base_url=... -c model_providers.<id>.wire_api=responses
   -c model_providers.<id>.env_key=OPENAI_API_KEY --model <m>`
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

## GitHub Copilot CLI adapter

Single-agent runtime (`discoverAgents` returns one `copilot`). This integrates
with the current official CLI command, **`copilot`**, not the retired
`gh copilot` extension.

### Invocation

1. The prompt is piped over stdin in programmatic mode so it does not leak into
   the process list. The CLI is invoked with:
   ```text
   copilot --name=agent-phonon-<sessionId>
     --output-format json --stream on --no-ask-user
     --no-remote --no-auto-update --no-color [--model <model>]
   ```
2. Later turns use `--resume=agent-phonon-<sessionId>`. After a daemon restart,
   core marks the reconstructed adapter session as a reattachment, so its first
   turn resumes the existing Copilot Chronicle session instead of creating a
   duplicate display name.
3. The JSONL mapping is:
   - `assistant.message_delta` → streaming `message`
   - `tool.execution_start` → `tool_call`
   - `tool.execution_complete` → `tool_result`
   - final `result.sessionId` → native Copilot session identity
4. `copilot help config` is only a static inventory; those model rows are marked
   unavailable/unverified. Prefer the native `default` selection unless the host
   explicitly configures a model/inventory. A help entry is not auth or availability proof.

### Verified gotcha

Copilot CLI 1.0.49 help text says a previously unseen UUID can be passed to
`--resume` to start a session, but the real command rejects it with “No session,
task, or name matched”. The adapter therefore creates with `--name` and resumes
by that stable name; it does not rely on the inaccurate UUID behavior.

---

## Hermes adapter

**Multi-agent runtime** (like OpenClaw): a Hermes profile = an independent agent
(its own config/.env/SOUL.md/skills). Composite agentId `hermes:<profile>`.

- Enumerate: `hermes profile list`; select via native `--profile <profile>` before
  native modules load (the installed 0.16 CLI does not select by HERMES_PROFILE).
- Invoke the installed Python console script's own interpreter with a bundled
  narrow observer, then native `hermes --profile <profile> chat -Q -q <prompt>`.
  The first turn creates a native session; subsequent turns `--resume` its observed
  native id. `--continue <nonexistent-name>` does not create a session in 0.16.
- Native `main` retains HOME/HERMES_HOME/profile/dotenv/config/provider/key-ref
  loading. A configured named `model.provider` under `providers` is retained when
  Phonon supplies a model; an explicit owner `hermesProvider` wins. There is no
  separate JSON-settings loader, provider credential copy, or auth-cache reader.
- The observer reads actual `AIAgent.run_conversation` result fields and new tool
  messages, preserving model tool-call ids, arguments and full native tool output.
  It does not reconstruct results from prose. Tool events are buffered until the
  turn returns (`streaming:false`), not advertised as live token deltas.
- 0.16 `-z` discards structured failures, and ACP can return `end_turn` after an
  error. Neither is a safe success oracle. Completion requires exit 0, an explicit
  `completed:true`, no failed/partial/error/interrupted flags, and nonempty final
  text. No structured result is a failure; ordinary prose mentioning HTTP 404 is
  not a failure. Windows/non-console-script Hermes launchers require a validated
  structured integration; the adapter fails closed rather than falling back to
  exit-code-only success.
- Native tool approval policy is preserved; no automatic yolo/accept-hooks flags.
  A failed **turn** emits error/status=failed, making workflow/run retry paths
  fail. The reusable session lifecycle returns to `idle` by the existing protocol;
  SessionStatus has no `failed` member. Timeout/cancel remain non-success terminals.
- Custom `dropToolIO` uses the observed session id, retaining native SQLite backup
  behavior. Native compression and mid-turn injection remain unsupported.

## OpenCode adapter

- Native 1.14.48 `tool_use.part` is a ToolPart: `callID` identifies the actual
  call and `state.input/output/error/status` carry its I/O and lifecycle. Normalize
  completed-only snapshots into a same-id call/result pair; deduplicate repeated
  pending/running/terminal phases within each turn. A part id or final assistant
  text is not a substitute for a missing native tool id/output. Decode UTF-8 across
  chunk boundaries and consume a final JSONL record even without a trailing LF.

Single-agent runtime.
`opencode run --format json [--model <m>]
[--session <ses_id>] <prompt>`

- **Key gotcha**: Node's `spawn` defaults stdin to a pipe; OpenCode detects this
  and hangs waiting for interactive input. You **must** set
  `stdio: ["ignore", "pipe", "pipe"]` (stdin = /dev/null).
- Event stream: `step_start` / `text` (part.text) / `tool`; session id is `ses_…`
  (captured from events for `--session` resume).
- Binary auto-detected at `~/.opencode/bin/opencode` if not on PATH.
