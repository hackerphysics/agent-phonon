# Turn-Scoped Native MCP

Native Codex, Hermes and Pi turns use the existing local `AgentInteractionBridge` through a
Streamable HTTP MCP endpoint. This is a device-local transport, not a new Phonon
RPC, resource catalog, account store or business approval policy.

## Connection And Tools

The controller supplies `AGENT_PHONON_MCP_URL` on `127.0.0.1`, beside its existing
interaction/board/workflow/message/document URLs. The existing fresh
`AGENT_PHONON_INTERACTION_TOKEN` authenticates requests. Models do not select a
remote MCP address or supply an owner, conversation, Session or native run.

Codex receives an invocation-only `mcp_servers.phonon_current_turn` table via
`-c`, with the canonical loopback URL and `bearer_token_env_var`. The adapter
never serializes the token value into argv, generated prompts, tool arguments or
persisted user config. Startup is required; an older runtime without a verified
native MCP endpoint fails explicitly rather than silently falling back to a
blocked shell request. Ordinary non-native turns do not receive this connection.

Only these six existing controller tools are enabled and granted host-tool
access on that temporary server:

- `phonon_request_interaction`
- `phonon_acknowledge_interaction`
- `phonon_conversation_board`
- `phonon_workflow`
- `phonon_conversation_message`
- `phonon_project_coordination` (independent project directory and private cross-device mailbox; see `PROJECT_COORDINATION.md`)
- `phonon_publish_document`

Each uses Codex's per-tool `approval_mode="approve"` in this reserved server
table. This permits access to the authenticated Phonon channel; it does not
approve a human form, workflow, file-policy exception or another MCP tool.
Global `approval_policy`, command sandbox/network settings, other MCP servers
and personal configuration remain unchanged. A real `review=request` plan still
waits for the human, and a submitted boolean false remains false. Optional tools
are absent when the controller has no corresponding callback; workers still
cannot become group members or execute coordinator-only operations.

## Pi Registration

Pi receives an invocation-scoped extension that discovers the actual current-turn
tool catalog and registers only those controller tools. It is independent of
Pi's optional pre-tool HITL hook. The adapter waits for a fresh catalog/extension
acknowledgement, plus any native-recovery acknowledgement, before releasing stdin.
Tool registration and active-selection/provenance checks run when Pi binds its
Session, before inference. Tokens remain in the child environment and never enter the extension
source or arguments; generated invocation assets are removed after settlement.
See `PI_NATIVE_TOOLS.md`. Missing/changed channels fail explicitly, without a
shell/HTTP fallback or a change to personal settings/approval policy.

## Hermes Registration

Hermes receives an invocation-only capability capsule, frozen and removed from
the environment before native profile/dotenv loading. The bridge verifies the
expected DE profile home before configuring tools or starting inference. It
registers the reserved `phonon_current_turn` alias through the installed native
MCP client and refreshes the root agent's tool selection. No YAML or personal
configuration is rewritten. Only tools with supplied controller callbacks are
registered; resources and prompts are disabled.

Native safe mode, disabled MCP toolsets, reserved-alias conflicts and missing
runtime APIs fail closed before inference. Existing enabled/disabled tool
filters are preserved; only the reserved controller alias is added to this
turn. Owned tool handlers reject delegated-child and non-owning/cron contexts
using Hermes' native context predicate. This is runtime identity scoping, not
confinement against arbitrary code reading process memory.

Controller tokens and loopback URLs are removed from the tool subprocess
environment. Native registration carries the bearer in memory, uses strict
redirect-header handling, and bypasses proxies for `127.0.0.1` in this invocation
only. Bridge output and adapter failure diagnostics redact the exact capability.
There is no fallback that relaxes terminal safety or asks model-written shell
commands to expose the token.

## Boundaries

The MCP SDK handles the protocol with fresh stateless transports, not a custom
JSON-RPC implementation or retained MCP session cache. The broker requires the
current bearer and exact loopback Host, rejects browser Origin headers and
bodies over 64 KiB, and limits protocol concurrency/requests. Native effects
share the HTTP channel's eight-pending/100-submission budget and schemas;
acknowledgements remain available at the submission limit.

Both transports call the same controller callbacks, including native source,
project, role, device-file policy, version/hash and human-decision checks.
Document calls accept a project-relative path, not model-authored bytes or a
new route. The controller reads the actual bounded regular file and returns a
confirmed serverRef; a local path is never publication.

Ending/interruption of the turn closes active MCP transports, clears delivered
proofs and revokes the bearer. A new turn accepts neither the old bearer nor
its consumed-response proof. Errors do not reveal capabilities or imply that
effects were absent; reconcile uncertainty using the original request identity.
Native failure diagnostics redact the native capability along with configured
inference credentials.

## Observation And Verification

Native Codex `mcp_tool_call` start/completion items become actual tool argument
and result events, deduplicated by turn/item identity. Private reasoning items
are not collected by this mapping. This is not a claim that all legacy CLI item
types or interrupted external jobs have complete observation.

Hermes chains native text streaming and the root agent's stable-ID native
`tool_start_callback` / `tool_complete_callback`. Calls and results can arrive
before the native turn returns, with the actual native tool name (including
unwrapped tool-search calls). Original callbacks remain chained/restored;
concurrent output uses a locked JSON-lines writer. Delegated/non-owning contexts,
historical IDs and callbacks after native return do not become new root events.
No thinking or reasoning-preview callback is subscribed.

The final native transcript reconciles calls that have no callback, such as
blocked/unstarted calls or older runtimes without the stable-ID/context APIs.
Live pairs are deduplicated by the original call ID. That fallback is buffered
evidence, not proof of live tool progress. A thrown/interrupted turn does not
invent missing tool results. Native failure classification is retained; terminal
nonzero exit codes also remain failed results. Oversized display results have
an explicit bounded excerpt marker rather than an unbounded live payload.
Installed-client tests separately verify registration, actual current-turn MCP
calls and delegated-context denial without model inference; these alone do not
establish real DE collaboration or physical-phone acceptance.

Focused tests exercise actual MCP SDK client/server calls, shared HTTP/MCP
proofs/budgets, invalid identities/paths/Host/Origin/body sizes, stale/late
responses and invocation-only config. The local mobile gate additionally
publishes real Codex-generated bytes while native turn records still show
workspace-write, command network disabled and global approval policy never.
Phone preview/provenance in English and Chinese and real workflows are tracked
separately in phonon-work's execution reports; Auth/Registry fixtures do not
prove real OAuth or production acceptance.

Codex configuration reference: https://developers.openai.com/codex/mcp
