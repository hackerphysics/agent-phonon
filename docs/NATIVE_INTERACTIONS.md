# Native Agent Interactions

Native chat exposes a human interaction channel, not an approval policy. The
agent decides when it needs input and authors the form. The mobile/control plane
renders it, validates typed values and permissions, and returns the human's
explicit decision to the originating turn.

## Turn-Scoped Channel

For native workflow Sessions, the controller provides these environment values
to adapters that forward per-turn process environments:

- `AGENT_PHONON_INTERACTION_URL`: loopback `POST /interaction`.
- `AGENT_PHONON_INTERACTION_RECEIPT_URL`: loopback `POST /applied`.
- `AGENT_PHONON_INTERACTION_TOKEN`: fresh current-turn bearer capability.
- `AGENT_PHONON_MCP_URL`: current-turn Streamable HTTP MCP on the same listener.

The listener binds only `127.0.0.1`. It rejects browser origins, wrong tokens,
caller-supplied routing identities and bodies larger than 64 KiB. A turn can
have at most eight concurrent requests and one hundred submissions. Application
acknowledgements remain possible at that submission limit. Turn end or interrupt
closes the listener and invalidates its capability. No file/process/device API
is exposed by this listener beyond separately declared, policy-bound native channels.

Post `{requestId?, form, presentation?, timeoutSeconds?}`. Forms support `text`,
`textarea`, `number`, `boolean`, `select`, `multiselect` and `date`. The channel
is blocking; zero/omitted timeout imposes no human-response deadline. Route,
Session, turn and native run identities are stamped by the controller, never
taken from model-authored fields. Embedded adapters can instead call the
equivalent `SendOptions.requestInteraction` callback.

An approval is explicitly described by
`presentation: {kind: "approval", decisionField: "approved", feedbackField?: "notes"}`.
The named decision field must actually be a boolean field; the optional feedback
field must be text/textarea. A field named `approved` alone is still an ordinary
form, not an app-created approval. Required boolean `false` is a valid explicit
response, not a missing value or approval.

The response contains `{requestId, action, values?, decisionHash}`. Only a
`submit` result carries a human submission. Do not interpret `cancel`, `timeout`
or transport failure as permission. After consuming a submitted result, the
agent may explicitly POST `{requestId, decisionHash}` to the receipt URL. Embedded
adapters use `SendOptions.acknowledgeInteraction` for that same scoped operation.

## Durable Proof

`native_interaction_receipts_v1` and `interaction.status` expose tenant-scoped,
immutable request/decision hashes and trusted native run/Session/turn lineage.
The device persists the request before issuing `interaction.request` and persists
its receipt before returning the response to the adapter. It distinguishes:

- `pending`: device requested human input.
- `delivered`: device received and persisted the submitted response.
- `applied`: agent/controller explicitly acknowledged consuming that response.
- `cancelled`, `timeout`, `unknown`: no application/success is invented.

The `applied` proof concerns the response, not completion of the agent's task or
any side effect. A workflow controller acknowledges a native human review only
after it has consumed the explicit values. Interrupting unanswered input cancels
it; disconnect/recovery never automatically approves it. Replayed identical IDs
reuse the same receipt; changed content under an existing ID is rejected.

TypeScript: `await device.interactionStatus(requestId)`.
Python: `await device.interaction_status(request_id)`.

Dev task workers use the same scoped native tools and durable receipt mechanism
when `dev_native_interactions_v1` is advertised. The controller stamps `devRunId`
from the accepted Workflow's `dev_run_id`; it never accepts this identity from
tool arguments. `devRunId` and the chat-domain `nativeRunId` are mutually
exclusive and participate in the timestamp-independent request hash. Both SDKs
preserve these fields and the original Workflow/Session/turn attribution.
Dev workers receive interaction tools only, not DE group, Board or delegation
authority. A stopped turn cannot accept a later approval or apply its receipt.

## Runtime Coverage

CLI adapters that forward the per-turn environment, such as Pi, can use this
loopback channel through their existing shell/HTTP tools. Native Codex and
Hermes use the [turn-scoped MCP transport](NATIVE_MCP.md) instead, preserving
native command restrictions and actual human decisions. Hermes consumes the
capability before native profile loading and withholds it from tool subprocess
environments; it does not fall back to shell calls when MCP is unavailable. No real
model is claimed to have called it merely because an environment was supplied.
OpenClaw Gateway does not forward these process environments. Its opt-in native
plugin integration is described below. Never put the bearer capability into an
ordinary persisted prompt as a workaround. DE profile/tool provisioning is a
separate prerequisite, not implied by this transport capability.

Deterministic tests cover the actual loopback/JSON-RPC path, tenant isolation,
duplicate identities, token/origin/body limits, interruption, response ACKs and
native workflow human review. Control-plane HTTP/PG tests also exercise all
field types, cross-owner/stale responses, timeout, stop and source acknowledgement.

## OpenClaw Native Tools

The built `packages/openclaw-plugin` adds these optional tools:

- `phonon_request_interaction({requestId?, form, presentation?, timeoutSeconds?})`:
  authors the same typed form and waits for an explicit result in the originating
  chat. A submitted `false` remains a rejection. The result is delivered, not
  automatically acknowledged as consumed.
- `phonon_acknowledge_interaction({requestId, decisionHash})`: explicitly records
  consumption of that response, not completion of the underlying task.
- `phonon_conversation_board(input)`: optional current-conversation board
  read/write with version checks and concise content; see [Native Boards](NATIVE_BOARDS.md).

Desktop setup must explicitly install/enable the plugin, set
`plugins.entries["agent-phonon-hitl"].config.nativeInteractions = true`, and allow
the applicable optional tool names in the OpenClaw tool policy. Existing
allowlists must be preserved. Do not overwrite personal Gateway configuration,
enable tools automatically from the phone, or install a plugin into a running
personal Gateway merely to run tests. Build the self-contained plugin artifact
locally using [the artifact preparation steps](agent-cli-integration.md#plugin-install--update).
It bundles the current protocol; an older published protocol with the same base
version is not a substitute for that verified runtime.

The Gateway must run on the same host as the daemon. Native chat uses the normal
`gateway-client`/`backend` identity, not a browser identity. Current OpenClaw
restricts public `chat.send.toolBindings` to a paired browser copilot, so Phonon
does **not** send that field or broaden that restriction. Instead, two plugin-owned
Gateway RPCs, `phonon.interactions.bind` and `phonon.interactions.release`, require
the existing authenticated `operator.admin` transport. They are OpenClaw plugin
APIs, not new Phonon device protocol methods or a bypass around server ownership.
The plugin requires the host's connection-retirement signal and rejects older
hosts that cannot supply it.

Before `chat.send`, the adapter binds a fresh current-turn loopback capability to
the native Session key and the exact native run ID used as `idempotencyKey`.
Bindings are in memory only, connection-owned and limited to 64 Sessions. Only
canonical numeric-loopback `/interaction` and same-origin `/applied` endpoints
are accepted. The response never contains the bearer capability. Successful
versioned registration is required before dispatch; an absent/disabled plugin
fails native chat clearly. Ordinary Phonon Gateway turns also require the
noninteractive policy described below; personal non-Phonon sessions are unchanged.

Tool factories capture that binding generation. The real `before_tool_call`
hook must prove the matching host-supplied agent, Session, run and tool-call ID;
execution consumes a one-use, parameter-bound permit. A model cannot supply a
destination chat, route, run, endpoint or bearer token in tool arguments. Stale
factories cannot adopt a later run's capability. Disconnect, interruption, run
end, host lifecycle cleanup, explicit release and lease expiry revoke access.
The lease is shorter than the adapter's existing 30-minute outer run guard; a
zero form timeout does not remove overall runtime/provider limits. Requests and
responses are bounded to 64 KiB; HTTP redirects are refused. Failures never grant
permission, fall back to legacy fail-open decisions, or auto-acknowledge input.

Verification includes an actual controller/loopback/Gateway-WebSocket/plugin-tool
path using a deterministic host fixture, plus an opt-in installed-SDK smoke:

```sh
PHONON_TEST_OPENCLAW_SDK=/absolute/path/to/openclaw/dist/plugin-sdk \
  node --test packages/test-server/dist/fn-openclaw-native-tools.test.js
```

The smoke runs the installed public SDK's actual before-tool execution wrapper
in an isolated home and checks valid calls, wrong-run blocking and disconnect
revocation. It does not start inference, activate a plugin in the user's Gateway,
or establish that every provider has called a tool. Live Gateway/plugin policy
activation and real-model end-to-end verification remain separate release work.

### OpenClaw Noninteractive Policy

All Phonon Gateway turns, including ordinary sessions, DE turns and retained or
reconnected sessions, now require `phonon.policy.bind` and a fresh
`phonon.policy.confirm` receipt before `chat.send`. These private plugin RPCs
register under the native `operator.write` session-resource contract, additionally
require a current `operator.admin` connection in the handler, and retain the
public Gateway `sessionAccess: {mode: "write"}` participation authority. A receipt binds the exact
native session UUID, run UUID, policy generation and caller-read catalog digest.
The client pins its connection epoch; a policy-bound send cannot reconnect.
Optional reasoning failures remain best-effort, but mandatory identity and policy
are rechecked after optional asynchronous work. Nothing retries the input.

The qualified contract is OpenClaw **2026.10.7**, native `openclaw` runtime,
explicitly enabled plugin, manifest-declared trusted policy, and explicit
`allowPromptInjection` and `allowConversationAccess` hook grants. Code Mode, Tool
Search and configured personal channels do not require global configuration
changes. The public `tools.effective({sessionKey, agentId})` inventory supplements
the catalog with session-owned plugin/channel/MCP tools. The host's public
`isMessagingTool` classifier removes native channel messaging tools while retaining
ordinary channel tools. Configuration is never rewritten by this policy. Old or
unqualified hosts and the local spawn CLI
refuse execution rather than fall back to unprotected inference.

The existing authenticated client reads public
`tools.catalog({agentId, includePlugins: true})` and session `tools.effective`. The plugin validates the selected
agent, bounded inventory, canonical exact names and duplicates, then derives a
per-turn `toolsAllow` from core, declared/instantiated plugin and effective tool IDs. Only the
qualified `*__*` MCP and `lsp_*` namespaces are added; `*`, plugin groups and
model-supplied policy overrides are never accepted. Inventory does not grant
tools: OpenClaw intersects the cap with existing native policy and approvals.
Unknown inventory sources or unrepresentable names cause explicit refusal.

The cap removes `ask_user` (including Web Control UI questions), `message`,
`secrets`, `conversations_send`, `conversations_turn`, `sessions_send`,
`sessions_spawn`, `sessions`, `subagents`, `automations`/`cron`, `openclaw`,
`gateway` and `plugins`. The latter native control/delegation mechanisms cannot
start an uncapped child or remove the policy. Code Mode and Tool Search control
tools remain available, and their nested targets retain the same trusted policy
and native approvals. Ordinary file/Web tools, unrelated catalogued
plugins, namespaced MCP/LSP, Phonon-native HITL/group tools and ordinary final
text remain available under their original native permissions and approvals.

An ordinary `before_prompt_build` hook submits the cap, and a native trusted
pre-tool policy independently refuses effects without the matching live grant.
Only an authenticated binding classifies a run as Phonon-owned; the session key
prefix alone neither grants nor denies authority to unrelated personal runs.
Release, agent end,
disconnect, expiry, native incarnation changes, configuration changes and host
lifecycle cleanup retire the binding. Old-owner/generation release and old-run
end events cannot retire a newer binding.

Receipts also attest `executionFence: "native-controller-v1"`. The policy captures
the public Gateway controller for the exact native run, session, agent and caller
connection. A retained native session-access borrow is also checked and released
with the binding; sharing or original-actor revocation cannot leave a live grant.
Revocation synchronously aborts that original signal so an already
pending native approval cannot execute after a later allow decision. Replacing a
registry entry cannot redirect cancellation to another execution. Retired run
provenance is bounded; active native executions are not evicted to admit new work.

`fn-openclaw-policy.test.ts` includes negative and lifecycle tests plus an opt-in
latest-SDK fixture using actual tool filtering, pre-tool wrappers and the host's
67-core-tool inventory without inference. This is not evidence of an active
Gateway deployment. Isolated Gateway/provider verification, independent full
commit gates and activation remain supervisor-owned work.
