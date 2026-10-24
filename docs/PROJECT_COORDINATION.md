# Project Coordination v1

`project.coordination` is a device-to-server request independent of DE group
messages. It never appends human chat, triggers group mention routing, answers
human forms or starts an execution. The server owns project consent, a durable
participant directory, activity declarations, directed mailboxes and receipts.

This is the Agent/DE session-collaboration surface, not a hidden variant of
human group chat. Collaboration includes intent, questions, negotiation,
dependencies, impact/conflict notices, intermediate artifacts and results; it
is not restricted to result exchange or notification. The current text inbox
and runtime checkpoint are an initial binding, not the full product definition.

The project collaboration channel is unobtrusive by default: no ordinary chat
entry, unread increment or routine human notification. Humans may explicitly
inspect its activity, messages and delivery evidence. Inspectable native hook
metadata is not a promise that collaboration is secret from the human owner.

Group exchange and session collaboration may share their underlying identity,
authenticated connections, routing, durable delivery, idempotency, reconnect,
receipt machinery and audit. Their upper-level membership, authority,
visibility, notification, execution/wakeup policy and receipt semantics remain
separate. Shared transport does not grant cross-channel publication. Publishing
a session's result into a human-visible group requires its own authorized group
operation; merely toggling visibility must not convert or copy a message.

## Current-Turn Access

An ordinary native Agent, project-bound DE, delegated native worker or Dev
execution receives `options.projectCoordination(input)`. Shell-capable harnesses
may use `AGENT_PHONON_COORDINATION_URL` and the current interaction Bearer token;
Codex/Pi/Hermes native MCP and the opt-in OpenClaw plugin expose
`phonon_project_coordination`. OpenClaw's manifest declares this optional tool;
existing installations need the updated prepared plugin and matching tool policy.
No settings are automatically changed outside the current invocation.

Claude Code CLI 2.0.1 uses its own bundled SDK's in-process MCP server for
`phonon_project_coordination`, independently from receive hooks. The invocation
publishes only that project tool, not forms or group tools. Native permission
configuration is unchanged; explicit deny and missing native approval do not
send. No `allowedTools`, `canUseTool`, permission bypass or persistent MCP
configuration is introduced. Other existing controller callbacks keep their
prior shell environment access; their presence does not grant native group tools.

Claude outgoing admission requires the exact root assistant tool ID/name/JSON
arguments, original root prompt, cwd/transcript/native session, startup-policy
proof, and matching PreToolUse observation. The MCP request must carry that
same native `claudecode/toolUseId`; a matching body alone is insufficient.
Accepted tool calls are one-shot and cannot be replayed after cancellation or
settlement. A late/failed result is unconfirmed, not approval or completion.
Actual Task children cannot publish as the parent, even when they copy its
tool name/arguments. The parent retains its own authorized continuation.

The runner holds the current coordination token in its own process and removes
it from the native child environment when no other controller capability needs
that channel. The token never appears in generated source/argv or the model
catalog. This is not isolation from arbitrary same-user memory inspection.
Coordination tool call/results are omitted from normal Phonon stream output;
native owner-inspectable transcripts are not promised secret. Same-session
resume uses a fresh runner and source guard, without replacing the CLI session.

The loopback/MCP endpoint is created for authorized coordination even when no
human-interaction callback exists. Catalogs and Codex/Hermes/Pi registration
select only the callbacks actually supplied: a coordination-only turn receives
`phonon_project_coordination`, not forms, approval acknowledgements or group
publication. Calling an absent route/tool fails without an effect. Pi's one
Phonon extension receives its exact expected catalog at invocation time; native
exclusions and provenance checks still apply.

The controller adds `{sourceKind,runId,workflowId,sessionId,turnId,action}`.
Model input is only `action`, strictly validated with no owner, sender, project,
device, routing URL or execution-control arguments. Private projectless DE
chats cannot use this channel. A delegated worker publishes as its executor,
not as its parent DE.

Operations:

- `peers` with optional `after`: current project participants and self identity.
- `presence`: refresh liveness without invoking a model.
- `activity`: UUID `requestId`, observed `baseRevision`, and an intentional
  `activity` declaration containing summary, phase, impact and dependencies.
- `send`: UUID `requestId`, canonical `recipientId`, kind (`intent`, `question`,
  `notice`, `request`, `result`), text, optional stable references and `inReplyTo`.
- `inbox`: optional `after`; returns pending messages without consuming them.
- `acknowledge`: distinct `messageIds` actually offered by the inbox. This
  confirms receiver consumption, not acceptance/completion of requested work.
- `receipt`: query a prior UUID `requestId` without resending.
- `leave`: retire this participant; pending inbound mail is withdrawn.

All model operations are current-turn-only. Retained callbacks reject after
turn completion or cancellation. SDKs reject absent handlers instead of
fabricating successful delivery. TypeScript uses
`device.setProjectCoordinationHandler(handler)`; Python uses
`device.set_project_coordination_handler(handler)`, including awaitable results.

### Device Receive Reports

The optional envelope `receive` is controller-owned, never an agent action.
Version 1 reports `tool_polling`, `runtime_pending` or `runtime_checkpoint`;
native modes include boundary, visibility and maximum evidence capability.
A native identity must be owned before reporting checkpoint readiness. No
native session IDs, tokens, message content, ACK or completion claims are sent
in this report. The evidence field describes a capability, not an observed
delivery or model consumption.

Each assigned turn probes support once with a presence-only request. Only a
matching source/self response with `receiveReporting: 1` enables reports on
subsequent requests and presence refreshes. Rejection or an old server response
retains existing polling/checkpoint behavior without retrying a mutating action.
Both SDKs forward this envelope and response unchanged to the host handler;
they never synthesize negotiation success.

The host authenticates the original device/run/session/turn before persisting
a report with its server timestamp and source epoch. Human inspection includes
the last report and a separate `current` flag. Current requires matching epoch,
an online device, current stored runtime session/turn, nonterminal/noncancelled
execution and at most 120 seconds of age. Missing runtime evidence conservatively
means noncurrent. A new turn without a report does not refresh old readiness.
Legacy device responses omit the additive fields until support is negotiated.
The inspection page also expires its displayed label locally. Reports do not
ACK messages, wake sessions, create group posts, unread counts or notifications.

### Per-Message Runtime Evidence

An accepting host advertises `evidenceVersion: 1` with the private presence
negotiation. Only the controller's internal native inbox requests include that
version. The server issues random delivery IDs bound to the actual offered
message, recipient, device, source epoch and selected evidence limit. Model
callbacks cannot select internal mode, even with extra callback arguments;
delivery capabilities are stripped from model results and never enter context.

The metadata-only journal stores the delivery ID and local boundary/content
hash with its existing `offered`, `context_hook` or `provider_payload` state.
`offered` means prepared by the controller, not injected. The separate device
RPC `project.coordination.evidence` accepts at most eight reports and returns
exact per-delivery recorded/rejected receipts. TypeScript uses
`setProjectCoordinationEvidenceHandler`; Python uses
`set_project_coordination_evidence_handler`. Missing handlers reject.

A connection-scoped reporter sends on change and retries every 30 seconds,
with at most eight bounded pages per pass. Reconnect resumes the same durable
queue, including after the original model turn has ended. In-flight responses
from replaced connections cannot acknowledge local records. Lost responses are
idempotent; stronger observations arriving during an older request stay pending.
Failed/unsupported reporting never replays peer context or creates model work.
Reports are partitioned by tenant and configured server origin; native session
IDs and message content are not transmitted. Expired records stop retrying after
30 days; local and server metadata have explicit capacity ceilings.

Migration 79 stores server-issued offers and monotonic observations. The host
authenticates the current device, original sender/recipient authority and current
project consent, even for historical observations. A report cannot change its
boundary/hash or exceed the original evidence limit. A retired/revoked source
is rejected without a fabricated success. Human inspection shows the strongest
recorded evidence separately from mailbox ACK; no notification or unread path
is added. Device runtime observations are not independent remote attestation,
proof of model consumption, acceptance of requested work or task completion.

## Runtime Behavior

At the start of an already authorized model turn, the controller attempts a
bounded directory read. For polling-only adapters it also reads the inbox and
prepends at most eight peer summaries and
eight whole messages (16 KB mail budget), labelled as untrusted peer data, to
that invocation only. No extra LLM invocation is created. No automatic ACK is
claimed: the model acknowledges IDs after consuming them. Active turns refresh
presence every 30 seconds without inference.

The tool description instructs agents to publish their intentional task/impact
summary, check mail before shared changes and before finishing, and notify
affected peers of results. Adapters without a peer-context binding still use
explicit tool polling; there is no automatic wake-up. An unavailable optional
channel does not replace or restart the user's assigned work. Idle/offline mail
stays at the server until the same authorized session resumes and polls it.

### Native Peer Checkpoints

Pi requires a native context budget at
every automatic receive boundary. Their invocation extension reads the current
model's window/output limit, native `getContextUsage`, effective system prompt
and active tool schemas. Input is charged at the greater of the native estimate
and UTF-8 bytes of the current message view; system/tool bytes plus 1024 framing
tokens are reserved separately. Core also reserves the maximum of model output,
2048 tokens and ten percent of the window. Peer wrappers cost UTF-8 bytes plus
64 framing tokens each, deducted cumulatively across the batch. These are
conservative estimates, not model-specific exact tokenization.

Unknown usage (including native post-compaction unknown), malformed metadata or
insufficient space defers whole messages without claiming or acknowledging them.
The cursor stays on deferred mail, while smaller fitting messages can proceed.
A later qualified boundary can accept pending mail after headroom recovers. No
compaction, steering, extra model turn or permission answer is triggered. These
budgeted bindings do not fall back to unbudgeted automatic initial mail when
native admission/bridge is pending or unavailable. Explicit agent inbox reads
remain separately available under their original semantics. The Hermes,
OpenCode, Codex, Copilot and Claude required-budget bindings qualify their own native
sources; other bindings retain byte/count ceilings without inheriting headroom
qualification.

Pi 0.84.1's qualified RPC lifecycle now waits for native `agent_settled` rather
than killing the process on an intermediate assistant/stream error. The native
runtime retains ownership of retry and overflow compaction; Phonon starts no
extra process or prompt to recover an attempt. Native abort, extension failure,
exhausted errors and closure without settlement cannot become success, nor can
an older successful message mask a later failed attempt. Unqualified JSON
lifecycles retain their prior immediate-failure behavior.

Installed controlled-provider checks cover transient retry, exhaustion and
cancellation during native backoff, plus actual overflow summarization. Peer
mail is not offered to the independent summary request. Post-compaction unknown
usage defers it until a later original-root boundary has fresh native headroom.
Mail already offered on a failed provider attempt is not blindly reinserted on
retry. Provider-payload evidence remains distinct from consumption/ACK.

The read-only native recovery inspector now accepts historical error records
only when the same original task reaches a later successful same-model assistant
response before another user input or model-change record. Error tails,
explicit aborts, unresolved tools and model changes cannot manufacture a settled
checkpoint. Failed attempts stay in the original file; native continuation
retains its exact session/path and passes the existing launch guard. Recovery
itself is read-only and rechecks the complete saved identity. Failed/aborted,
changed or unverified native sessions cannot trigger automatic tail repair or
a fresh-session send. See `SESSION_RECOVERY.md`; these paths do not grant a
new collaboration source or replay an uncertain attempt.

Hermes 0.21.1 also requires native budget metadata on every registered request
boundary. Its middleware reads the current context engine's window, requiring
engine/agent/request model, API mode and route agreement. It measures the actual
assembled request's UTF-8 JSON size (including system, tools and provider-specific
fields), reserves 1024 framing tokens and reads positive integer output caps from
the actual request and `extra_body`. Multiple caps use the largest reservation;
model overrides or missing/invalid output caps mean unknown, not a guessed
provider default. Native retry-adjusted caps are re-read per request. The same
Core reserve, deferral and no-unbudgeted-bootstrap rules apply. Tests cover three
request formats; installed full CLI qualification is chat-completions only.

Claude CLI 2.0.1 requires a fresh root assistant per-inference usage observation,
including uncached input, cache creation/read input and output. The init model
must match the current assistant model; child/helper/cumulative final usage is
not a source. The qualified runtime's native window rule is conservatively
limited to 200K even for a 1M variant. Installed controlled-provider acceptance
cross-checks the final native `modelUsage.contextWindow`; the active SDK does
not expose a stable window getter. This is exact-version native-contract
qualification, not a general model-catalog guarantee.

The output reserve is at least the native 32K maximum/default and the largest
possible configured thinking budget plus one. Bounded, stable, nonlinked reads
inspect user/project/local/managed settings (or the selected standalone file
and managed settings) without copying configuration or changing precedence.
All potentially active thinking values use the maximum, retained for the turn;
missing/malformed/oversized/linked configuration makes the budget unknown.
Current and parallel tool-result JSON bytes, later native tool records, earlier
peer debit, 1024 framing tokens and shared output/safety space are reserved.
Concurrent callbacks cannot reuse a budget already being offered; changed
usage/configuration or additional parallel results suppress a stale projection.

Initial/compacted/mismatched/unknown/exhausted contexts leave messages pending
without claim/ACK or unbudgeted automatic bootstrap. PreCompact and native
compact boundaries invalidate usage; later qualified observations can recover.
No compaction, extra task, permission answer or notification is initiated by
coordination. Actual native child/deny/plan/standalone/outgoing tests retain the
same task and policy. Other CLI/SDK/Node/OS, provider/fallback/compaction recovery
and physical-device/real-model combinations remain separate rollout gates.

The Pi RPC-capable session path exposes a separate peer-context capability.
Core creates a current-turn-only checkpoint endpoint and reuses the existing
Phonon invocation extension to read authorized inbox pages before native model
requests. Its bootstrap does not ask the model to poll. There is no extra
prompt, follow-up run, idle wakeup or user-input steering operation.

Peer messages enter a non-persisted custom context message with `display:false`
and an explicit untrusted-peer wrapper. A subsequent provider-payload hook
checks the exact content before recording `provider_payload` evidence. Other
extensions can still transform later payloads; this is not a server-side
`received` ACK, proof of model consumption or exactly-once execution. The model's
explicit `acknowledge` operation is unchanged.

Hermes 0.21.1 now has an owned-process middleware binding as well. A read-only
interface/version probe qualifies registration, then the actual root execution
registers `llm_request` and `llm_execution` callbacks through native registration
handles. It does not install a plugin, change profile settings, patch the native
middleware dispatcher, or use `/steer` to impersonate a human message. Unknown
versions retain polling-only behavior.

Hermes allocates its native session during startup. Core accepts checkpoints
only after the owning adapter observes that exact root identity. Callbacks are
restricted to the owning thread/session and first root invocation, and dispose
their registration handles on completion. The middleware modifies only the
outgoing request copy, not persisted native messages. Provider data formats
handled are chat completions, Anthropic messages and Responses; other runtime
modes decline registration. Their byte/role construction has controlled tests,
while the installed full-CLI acceptance currently covers chat completions only.
Native plugin-name conflicts also decline registration without replacing the
operator's plugin. Provider exceptions propagate without retrying the callback.

Both implementations record only pre-provider `provider_payload` observations,
not network acceptance or successful model consumption. Actual provider/fallback
mode readiness and public receipt presentation still need further qualification;
an interface probe alone is not universal model/backend certification.

OpenCode 1.14.20 has an invocation-scoped Phonon module loaded through the native
CLI configuration. Its `chat.message` hook verifies the root session through
the native read API. For explicitly configured `@ai-sdk/openai-compatible`
providers, its native config hook composes the existing provider fetch and
checks the actual assembled JSON request before adding labelled peer data to
that transient copy. Early `messages.transform` injection is no longer used:
that hook runs before native system/tool/output assembly. The existing provider
authentication, fetch return/error, timeout and retry ownership stay native;
the wrapper invokes the original fetch exactly once and never retries it.
No additions enter native message storage or a new user prompt.
The existing config and plugin list are preserved; the temporary module
contains no credentials and is removed after the owned native process ends.

Per-request admission uses an unguessable, one-shot native header binding to the
original root/user/Agent and current model/route. The wrapper removes that header
before calling the original fetch. Title/summary helper Agents and actual child
sessions cannot acquire a binding even with the same session/user IDs. If another
plugin replaces the fetch, no private header is added. Unknown backends, endpoint
shapes or substituted request formats stay unbudgeted/unqualified and receive no
automatic insertion; explicit coordination tools remain independent.

The budget uses the current native model window and actual request output cap,
charging the full assembled UTF-8 JSON (system, messages, tools and provider
options). Core's shared output/safety reserve applies, with another 17,024
tokens conservatively reserving framing and worst-case JSON escaping expansion
of the bounded 16KB peer batch. Unknown caps/window or exhausted space defer
without claims/ACK. The required-budget capability also prevents an unbudgeted
automatic initial-mail fallback. This is conservative estimation, not exact
tokenization or universal provider qualification.

The same 1.14.20 module optionally registers `phonon_project_coordination`,
independently from receive hooks. It reuses the installed native plugin's actual
tool/Zod/Effect dependencies, without installing a second tree or changing
native permissions. The custom tool explicitly executes native `context.ask`
for its own permission before forwarding; deny and CLI ask-rejection never
send. No permission hook, allow override or `dangerously-skip-permissions` flag
is introduced. The module publishes no human/group tools.

Outgoing calls require the original root, exact transformed CLI prompt and
original native user message, matching before-tool callID/arguments, current
assistant message/parent/ToolPart identity read from native APIs, and a pending
or running tool state. Native child sessions and unrelated later input cannot
borrow that authority. Calls are one-shot, including concurrent invocations;
revoked, cancelled or late uncertain results are not returned as confirmed.
Transient peer data changes only the outgoing request, so it cannot become a
human follow-up input or alter native parent-message identity. The adapter omits the collaboration tool call/results
from ordinary Phonon streams while native records remain owner-inspectable.
Coordinator secrets are captured by the module and removed from later shell
environments when no independent controller callback needs the channel.

This binding can observe only `context_hook` output, not the final provider
payload. Core enforces that evidence ceiling and never labels it as a
`provider_payload` or consumption ACK. A weaker observation cannot downgrade an
existing stronger one. Installed acceptance separately inspects the actual next
provider request and the native database; that test evidence is not silently
promoted into a stronger production receipt.

OpenCode pure mode and unqualified versions remain polling-only. In particular,
the separately installed 1.15.10 did not complete its final reply in the tested
controlled-provider baseline even without the Phonon module, so it is not enabled
by this implementation. The operator-selected executable is never silently
replaced with another installation. Native process `PWD` is fixed to the
controller-bound working directory; recovery requests cannot create a replacement
session without a verified recovery implementation.

OpenCode and Pi capture their private checkpoint credentials in the bridge and
remove them from the environment inherited by later tools. This is ordinary
child-environment minimization, not a security boundary against arbitrary
same-user process inspection or memory access. Backend identity/authority and
the current-turn/native-session checks remain mandatory.

Codex 0.163.0-alpha.10.2 and 0.163.0-alpha.11.2 are explicitly version-fenced for
the invocation-scoped native hook binding. Before an
authorized coordination turn, the optional internal `preparePeerContext` step
uses native read-only hook discovery to assess readiness. Plain Session creation
and recovery do not start extra probes. Disabled hooks and unqualified versions
retain the polling bootstrap. No plugin installation, persistent settings write
or hook-trust bypass is required.

Required native headroom is locally qualified on installed .11.2/macOS with a
controlled Responses provider. The current-turn transcript must identify the
original thread, workspace, exact native turn and requested model. A matching
`task_started` supplies the native usable input window, which already reserves
native output/system/tool headroom. Current `token_usage_record` per-inference
usage is available before PostToolUse; cumulative billing totals are not used.
Legacy `token_count` cannot enlarge the task-start window. Serialized transcript
events since that inference, the current hook's tool-response JSON and a
cumulative debit for previously returned peer text are charged conservatively
by UTF-8 bytes. Core additionally reserves 17024 overhead tokens and its shared
2048-token/ten-percent minimum safety allowance. This is not exact tokenization.

First-input hooks have no current inference usage, so initial pending mail waits
for a later qualified tool checkpoint. Missing/stale/compacted usage, unresolved
model identity, exhausted headroom or an unavailable budgeted bridge leaves mail
pending without claim/ACK or unbudgeted automatic bootstrap. The assigned task
still runs; explicit agent inbox reads keep their separate semantics. Native
reads are bounded to a 1 MiB tail; missing matching metadata in that tail also
means unknown. Transcripts are not a stable public budget API, so other versions, compaction
recovery and model/provider fallbacks require their own qualification. Earlier
.10.2 receive evidence does not establish its new headroom qualification.

The original-input and post-tool hooks are discovered through native RPC. Only
the generated Phonon handlers receive their exact current hashes in invocation
configuration; a second discovery verifies their approval and unchanged trust
and enabled state for other handlers. Native approval/denial policies are not
rewritten. A configuration change or unavailable optional receiver does not
restart or replace the assigned task.

Admission requires the root identity observed by the owning CLI adapter, exact
working directory and transcript suffix, original one-shot prompt and native
turn. Post-tool checkpoints must match that same native turn. Actual native
subagent execution is tested: newly pending parent mail reaches the parent
continuation, not child requests or child inbox drains. Completion/cancellation
closes admission. The output contains only sourced peer `additionalContext`,
never a permission decision, human input, group publication or idle wakeup.

Codex tools inherited the first candidate's environment token in an installed
test; that candidate failed acceptance. The current binding instead keeps its
narrow, short-lived local transport credential in a private turn-owned file,
separate from generated code, argv and the native process environment. The file
is removed after observed native process-tree termination. This prevents normal
environment inheritance, not arbitrary same-user file inspection. No provider
credential is copied to that file. Production evidence is only `context_hook`,
and owner-inspectable native hook context is not described as secret or as model
consumption. Other OS/version/provider combinations and physical cross-device
acceptance remain rollout requirements.

OpenClaw Gateway 2026.9.3 now has an opt-in binding in the same Phonon plugin.
`config.peerContext: true` is independent of `nativeInteractions`; it additionally
requires explicit `hooks.allowPromptInjection: true` and
`hooks.allowConversationAccess: true` on that plugin entry. This does not enable
human/group tools, rewrite their policies or install a second plugin. No existing
Gateway/profile settings are automatically changed.

The host-owned capability RPC uses the native public runtime-policy resolver and
latest native Session entry. This binding admits only the selected `openclaw`
runtime and original Session generation. Codex/Copilot/CLI backends, missing
native identity, disabled grants and unqualified hosts keep polling-only
readiness rather than inheriting another backend's receive claim. The new native
resolver subpath loads lazily only for the qualified, opted-in capability path;
older-host/package qualification remains a release gate.

An admin-transport-owned, current-run binding grants only the authenticated
loopback peer checkpoint. Initial pending mail waits for a qualified native
budget after the first model call; it is not injected before request assembly.
Native async tool-result middleware supplies an
explicitly sourced collaboration block at later tool boundaries, preserving the
original tool content/details and declining failure/pending-approval results.
The block is not a new user message, command result claim, approval or idle
wakeup. The normal Phonon tool projection removes only this run's marked carrier;
unrelated tool data remains unchanged. Foreign-run tool events are not attributed
to the current turn. Inspectable native tool context may retain the block; this
is not secrecy from the owner.

Live grant/config/Session checks, transport disconnect, run end and native cleanup
fence retained callbacks. Admission failures preserve the assigned task instead
of starting a replacement. Existing loopback/authenticated-transport helpers are
shared with other plugin features; their grants and upper-level semantics remain
separate. Production receipts stay at `context_hook`, not provider acceptance or
model consumption. Native Gateway acceptance verifies baseline/initial/in-flight
provider requests, original file bytes, no ordinary stream leak and no peer prose
in native user/assistant history. Real-model/cross-device, native child/fallback/
compaction and additional-plugin interoperability still require qualification.

The updated plugin advertises required native headroom; older plugin capability
responses do not qualify this adapter. Its original-run `llm_input` snapshot
charges UTF-8 JSON bytes of the complete native system/prompt/history/tool
surface. Each matching `model_call_started` supplies the effective native window
with a nondefault source and reserves that call's full configured output plus
1024 framing. Tool-result bytes/framing and earlier peer context are cumulative;
Core reserves another 2048 overhead tokens and shared output/safety space. This
is a deliberately conservative estimate, not an exact provider-payload counter.

Only explicit config-owned `openai-completions` models with positive context and
output limits qualify. Model/default/agent output aliases use their maximum;
missing/invalid limits, `extra_body` request substitution, media/nontext history
or results, missing/replayed call metadata, changed model/route/parameter config
and compaction invalidate automatic admission. Separate native snapshots may
requalify after compaction, but actual recovery still needs qualification. The
plugin does not wrap/replace provider fetch, copy keys, start compaction, modify
model settings or create inference. Unknown/exhausted mail remains pending
without claim/ACK or unbudgeted bootstrap, while the original task continues.

The same plugin also supports a strictly coordination-only native tool binding
under `peerContext` without `nativeInteractions`. The Gateway sends only the
coordination URL, not fabricated human-request/receipt endpoints. The factory
and one-use native tool permits expose only `phonon_project_coordination`; group,
form, board, workflow and publication authority is not inherited. Native tool
policy must separately allow that tool. Its call/results remain out of ordinary
Phonon output, while native owner inspection is possible. Real Gateway tests
exercise full SessionEngine receive/send and exact-native-session two-turn
reuse, in addition to known/unknown/exhausted budgets and ordinary history.

The private runtime checkpoint capability is independent of the model MCP tool
catalog and can run without HITL tools. Core rejects wrong native sessions,
closed/canceled turns and checkpoints while its human interaction is pending.
No ordinary message/unread event is emitted. Runtime request failures leave the
main task running, with pending/unknown mail rather than fabricated receipts.

Copilot CLI 1.0.82 has a default-off receive binding selected by local
`copilotPeerContext: true`. One invocation-scoped Phonon plugin supplies the
native hooks while CLI lifecycle/authentication/resume stay direct. Native
extensions and native Phonon permission access must already be authorized;
Phonon does not force experimental mode, approve tools or change native settings.
Pending native admission retains polling guidance but cannot inject unbudgeted
automatic initial mail. Only an exact current-run native acknowledgement can
supply the receiver's native identity. Explicit agent inbox reads remain
independent; already offered bootstrap IDs are not reinserted by a later hook.

This binding now requires native headroom. Only original-root `session.usage_info`
can supply the actual prompt window and system/conversation/tool counts. A fresh
read-only `metadata.contextInfo` and native model snapshots verify the current
count/model; current tool-result JSON bytes and cumulative earlier peer bytes
cover not-yet-flushed additions. Core keeps 1024 framing tokens plus its shared
output/safety reserves. Compaction, model/context changes and truncation
invalidate usage; child events never replace the root baseline. Initial mail
waits for current native statistics at a later tool checkpoint.

For explicitly configured OpenAI/Azure chat-completions, the one-use private
capsule contains only bounded model/route/limit configuration already used by
the native invocation, never API keys, bearer tokens or credential-bearing URLs.
The native usable prompt allocation excludes output; the positive configured
output limit adds a conservative reserve inside it. Installed 1.0.82 does not
send that limit as a chat-completions request cap, so this is not a claim of
provider-enforced output truncation. Missing/invalid output reserves stay
unknown, not guessed. The alternative exact native model-catalog path has unit
coverage, not installed CAPI qualification. Provider-endpoint access stays
disabled; no credential-export setting is enabled for coordination.

Installed macOS/Node 24 controlled-provider tests cover normal, unknown and
known-exhausted budgets, configured native prompt-window observation, children,
native consent and exact UUID resume. Other backend/route/auth/model/version,
compaction recovery and physical-device/real-model acceptance remain open.

Root tool events, a fresh native task snapshot and native `task` telemetry fence
child callbacks even when their session ID, cwd or arguments match the root.
Unknown native metadata closes optional receive admission. The one-use capsule
and readiness lifecycle do not create a prompt, idle run, group post or human
notification. Native hook/tool history may remain explicitly inspectable, and
receipts are only `context_hook`. Local controlled-provider tests cover the
full SessionEngine path and exact native UUID reuse; other OS/version/provider,
real-model/cross-device and public readiness/receipt rollout remain gates.

The same Copilot extension now optionally exposes the project coordination
tool when its current-turn controller callback exists. Its handler requires
the exact root native tool-call ID/arguments and no active child or pending
native approval before reaching the existing controller. It registers no
human/group tools, no permission handler and no `skipPermission` override.
Native custom-tool consent remains separate from extension-hook consent.
Without it the original CLI can remain pending at the tool call; the binding
does not answer that decision, publish a result or restart the task. Real
native tests cover a recorded root send, denied child impersonation and
unapproved-call cancellation. `recorded` still does not mean task completion.

The metadata-only `<device-db>.peers.sqlite` journal reserves message IDs before
exposing their content. Unknown native effects are not automatically replayed
after restart. Journal capacity is 20,000 entries per tenant; saturation refuses
new offers and does not evict tombstones. Each checkpoint reads one mailbox page,
adds at most eight whole messages/16,000 bytes, and caps a turn at 64 messages /
128,000 bytes. Oversized whole messages remain pending with an explicit budget
deferral; smaller mail is not blocked. A checkpoint has a bounded local HTTP
deadline and cannot authorize later delivery after its client has disconnected.

These are checkpoint-driven receivers, not a new background push service. Public
receive capability metadata, server runtime-observation receipts, remaining
harness bindings and full cross-device acceptance are still in progress; see
`PROJECT_COORDINATION_RECEIVE_PROGRESS.md`.

Peer text and referenced artifacts are observations, never human authorization.
Do not repeat routine coordination in human replies. References are opaque
project/commit/artifact references, not automatic downloads or local-path file
transfers. The first version does not add broadcast, task assignment, resource
locks, cross-project routing or automatic conflict resolution.

## Kimi Capability Plan, Not Implemented

Choose a mechanism per operation and original session, not a mandatory plugin:

- Native Wire external tools are a candidate outgoing path for a directly owned
  Wire session. Any future binding must preserve native approval and exact
  original-root tool-call identity, without a replacement-session fallback.
- Wire `steer` is an in-flight user-input API. The 1.40.0 implementation appends
  a regular user message and emits `SteerInput`. A queued response does not prove
  application or consumption. It is not the quiet peer receive binding.
- `PostToolUse` is fire-and-forget; hook stdout is not an additional-context
  API. Reusing Claude's hook JSON would not supply a Kimi receiver.
- `KimiSoul.add_injection_provider` is a native per-step extension point, but
  this version stores injections as user history wrapped in system reminders.
  It cannot by itself establish source-labelled, untrusted peer context or
  provider-payload evidence. A request-bound provider adapter or a suitable
  native extension is a candidate only after its invocation loading, original
  profile preservation, root/child ownership, actual headroom, retry/compaction
  and lifecycle behavior can be exercised on a working runtime.

The acceptance gate requires initial and execution-time unpredictable mail,
exact same-TUI/session continuation, unknown/exhausted headroom deferral,
child/stale/permission-wait rejection, native outgoing deny and unapproved
behavior, one-use uncertain effects, and no routine human chat/unread/notification
or idle execution. Until that gate passes, report unsupported/pending honestly
and retain mail in the durable mailbox; do not substitute human steering,
synthetic approvals or an automatically created task. This is unfinished work,
not native acceptance inferred from source inspection or fixtures.

### Kimi Original-Root Wire Proof

An internal `adapters/kimi-context.ts` reader now implements preparatory
source proof for Kimi CLI 1.40.0 / Wire 1.9 on POSIX. It is not exported as a
new adapter, registered as a tool or connected to a receiver. Kimi's subagent
runtime can share both its parent's native session and its LLM instance; a
session-ID match alone cannot authorize a checkpoint or tool callback.

The reader accepts only the canonical original `wire.jsonl` beneath the
owner-selected share directory's cwd-hash/session path. Reads are bounded to
4 MiB/8192 rows and reject links, writable/unowned paths, incomplete/invalid
UTF-8 or JSONL and detected source/directory changes. The native md5 cwd path
is a locator, not an authentication primitive. A SHA-256 fingerprint of the
exact prefix through the assigned `TurnBegin` distinguishes repeated inputs
and rewritten history; it is a local proof anchor, not a native turn ID,
consumption receipt or independent attestation.

Exact root tool IDs/names/raw argument strings must remain pending. Returned,
duplicated or child-only calls cannot supply root call proof. Nested
`SubagentEvent` records never contribute root tools, status or completion, and
an unreturned root `Agent` call prevents proof even after a child's TurnEnd.
Recorded pending approval/question/hook waits defer proof; rejection, steering,
interruption, compaction, end-of-turn and unsupported events invalidate the old
turn. Child-forwarded approval/external requests and `/btw` are deliberately
unqualified rather than adopted as root authority.

This file does not prove the absence of native waits that were never recorded,
the current foreground PID, model/provider, native approval, actual request
headroom, success or message consumption. Wire `StatusUpdate` is not sufficient
for these claims, and native TurnEnd also follows prompt blocking/rejection.
A future binding still needs independent original native runtime ownership,
request-bound budget and observation, native call/permission checks and actual
working-runtime acceptance. Synthetic format/boundary tests do not enable Kimi
communication or claim its missing runtime has been repaired.

## Verification

`fn-project-coordination.test.ts` verifies native and Dev source stamping,
loopback isolation, callback lifetime, no chat output and SDK behavior.
`sdk-python/test_project_coordination.py` checks missing-handler rejection and
awaitable parity. The Phonon Work repository's coordination acceptance test
uses real local Auth/Registry/Agents/Dev/PostgreSQL, two authenticated daemon
connections and controlled adapters, including a provisioned DE. It is not
evidence of paid inference or physical Mac/Linux/Windows devices.

`hermes-peer-context.test.ts` also exercises the installed 0.21.1 CLI, the existing
Hermes adapter, a real native `read_file` and its next actual provider request
against a local controlled provider. A random peer notice becomes available
only after the first main request. It must appear in the second request, with no
human timeline echo and no additional tool execution. This is installed-harness
evidence, not inference by a real remote model or physical cross-device proof.
