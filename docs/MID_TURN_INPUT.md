# Current-Turn Input

`session.send(whenBusy="inject")` is not an interrupt, a restart, a transcript-only
update, or an implicit queue entry. An explicit injection requires an existing
active turn and must not start another task. The adapter must both advertise
`injectMidTurn=true` and implement
`AdapterSession.insertAtToolGap(input, {turnId, signal})`.
The daemon advertises `device.info.capabilities` entry `current_turn_input_v1` so
servers can distinguish this contract from older implementations that queued
unsupported input. Check both the daemon flag and the adapter capability.

The adapter resolves only after the running model has accepted the input at a
tool boundary. The `injected` acknowledgement refers to the existing active
`turnId`, not a newly created turn. The operation must respect `signal`, reject
unconfirmed input when its turn closes, and never retain it for a future turn.
An unconfirmed response is not evidence of application and must not be silently
reclassified as queued. The caller may retry its original idempotency key to
reconcile a lost acknowledgement.

Unsupported modes fail with `errCapabilityUnsupported`. A caller can explicitly
request a supported `fallback`; omitting it never supplies `queue` automatically.
The same rule applies to unsupported interruption. Built-in adapters that do not
provide genuine current-turn model input continue to report `injectMidTurn=false`.
Ordinary `session.inject` remains separate context injection and is not used to
pretend that current-turn input was applied.

TypeScript `session.send` exposes `whenBusy`, `fallback`, `turnId` and
`clientRequestId`. Python forwards the same wire option names through `**opts`.
Session creation in both SDKs accepts `initialContext`, `agentConfig` and
`clientTag`; these do not grant permission to override device policy.

## Current Source Status

All seven maintained harness names have a qualified original-turn input path:

| Harness | Qualified Path |
| --- | --- |
| Pi | Native RPC steering, verified lifecycle from 0.84.1 |
| Claude Code | 2.0.1 single-input SDK query and native root context continuation |
| Codex | 0.165.0-alpha.1.2 native app-server steering and exact input completion |
| Copilot | 1.0.82 owner-authorized invocation plugin and exact root lifecycle |
| Hermes | 0.21.1 native provider middleware with exact payload observation |
| OpenCode | 1.14.20 qualified openai-compatible native fetch |
| OpenClaw | Gateway 2026.10.7 native tool context acceptance and run continuation |

This is not certification of every version, provider or personal configuration.
Native operator opt-ins and approvals remain mandatory; unsupported paths do
not become queued input. The shared input fence freezes the original logical
subject and revalidates the caller at each native effect. Its scoped snapshot
builds without importing separate directory-admission changes; those existing
working-tree guards remain preserved rather than absorbed into this feature.
The seven adapter integrations are committed and pushed as `e57cbea`. Codex
cross-session end-to-end acceptance now passes through both public HTTP and
the actual managed stdio proxy. Phonon Work commit `56e8bd5` contains the
reproducible six-case matrix and 513 passing configured delivery regressions;
see the [October 30 MCP evidence](https://github.com/hackerphysics/phonon-work/blob/56e8bd5df45b1c203426dc91bece81f0a60843e1/agents/NATIVE_MID_TURN_MCP_TEST_RUN_2026-10-30.md).
Two actual installed Codex sessions, native tool execution, original receiver
session/turn/run identity, exact retry, closed-window refusal and native MCP
approval denial are verified with controlled local provider responses. The
receiver sees inserted content before its original execution completes, not
in a replacement task. Test-owned processes, database and fixtures are removed.

That complete real-MCP matrix has not yet been run for the other six harnesses;
their native adapter/SessionEngine tests are separate evidence, not substitute
full-chain receipts. All-harness MCP acceptance remains open. Production
release/activation and broader provider/version/OS acceptance are not claimed.
For OpenClaw the qualified path is Gateway, not the unqualified one-shot CLI.

Mobile waiting batches and FIFO input are separate scheduling requirements.
This contract does not claim that durable waiting batches, pending-input
cancellation, or employee profile provisioning have been added by this change.

## Native Context Ingress

`CurrentTurnInput` is a bounded, per-turn inbox for adapters whose native
extension can inspect the assembled provider payload. It shares the existing
private checkpoint transport with peer mail but not its admission, identities
or receipts. A peer observation cannot acknowledge an ordinary insertion.

An offer is not an insertion receipt: the default binding requires exact,
original-native-session `provider_payload` observation. An explicitly qualified
adapter-owned `native_context` binding instead requires pre-effect authorization
and a separate native application confirmation; ordinary hook observations alone
cannot settle input or opt into that binding. Missing or exhausted native headroom leaves
the input unconfirmed; turn settlement rejects it without a future prompt.
Each input carries a distinct marker, including concurrent identical texts.
Cancellation or a denied source check also denies a later native observation.

`InsertionOptions.beforeApply` is a repeatable controller authority check at the
native boundary. It is separate from the one-shot durable receipt reservation;
native integrations must withdraw rejected batches before provider effects.
The Hermes middleware can remove only its own exact rows, preserving other
native middleware options, or fail closed if withdrawal cannot be established.

The checkpoint history below records earlier source-verification stages and
temporary integration dependencies; the current-source status above supersedes
those temporary blocks.

Hermes integration was under local source verification. Installed native tests
use an isolated native home, a controlled local provider, one real file-tool
call and the original task. Default bundled plugins remain enabled. A temporary
safe-mode diagnostic is not a substitute for that acceptance. These tests do
not certify every personal plugin configuration, paid model, platform or
production deployment. Earlier default-plugin fixture runs exposed intermittent
startup deadlines before any provider request; those are not successful
insertion evidence.

October 29 local checkpoint: the final default-plugin run passed 64 focused
tests with zero failures or skips, including the installed native receiver,
ordinary insertion, source withdrawal, child isolation, Pi RPC and durable
workflow-input regressions. Consistency, recursive build and recursive test
gates also passed. The reusable inbox/interface/test-runner base is committed
and pushed as `b2609cc`; the Hermes/engine integration remains local because its
effect-boundary project check depends on concurrent, uncommitted authority work.
That work must not be absorbed into an unrelated commit. There is no release,
production activation or cross-device/managed-MCP acceptance claim here.

OpenCode 1.14.20 has local source integration through the existing invocation
module and qualified `@ai-sdk/openai-compatible` default native fetch. Its real
installed tests verify original-task insertion, output/headroom deferral,
unchanged native history, private headers, permission rejection, child isolation
and exact-session continuation. Custom fetch retains its weaker peer receipt
and rejects ordinary insertion; other provider formats/versions remain open.
Pure pre-effect authorization is separate from application: it never changes a
receipt. A native payload observation follows transport invocation, not the
other way around. Confirmed IDs remain tied to their exact original boundary.

Codex `0.165.0-alpha.1.2` has local native app-server integration. It requires the
original `turn/steer` acknowledgement and exact `clientUserMessageId` input
completion in the original native turn; it never starts a replacement turn.
Installed acceptance verifies original-task delivery, same-session continuation,
SessionEngine dispatch, native approval allow/deny, observed stop, ordinary MCP
calls and refreshed per-turn MCP credentials. Native configuration and legacy
history remain intact. The independently testable transport/request-handler
components are committed and pushed as `5ddb7e6`; adapter enablement and the
controller's shared authority checks remain local. See `CODEX_APP_SERVER_INPUT.md`.

The all-harness objective remains open. Pi has its separate RPC steering path;
the new OpenClaw binding is in broader installed-runtime regression. The
Claude/Copilot/Hermes/OpenCode/OpenClaw
and Codex integrations and shared effect-boundary checks remain uncommitted source until
the concurrent project-authority dependency can be safely integrated. Do not
enable insertion flags from plugin presence or hook offers alone.

The OpenCode checkpoint passed 114 combined focused tests with no failures or
skips, including installed OpenCode 1.14.20 and Hermes 0.21.1, the private
authorization contract, Pi RPC and durable input regressions. The independent
authorization/interface/runner enhancement is committed and pushed as
`c159163`; adapter integration remains local under the shared authority
dependency above.

The first full-gate attempt at this checkpoint had six timeouts: four strict
SQLite-failure child processes hit their existing eight-second parent deadline,
and two legacy Hermes recovery cases did not observe turn completion. Host
resource pressure was observed at that time (no idle CPU and about 173 MB free
memory). All six passed a focused rerun without source or deadline changes;
the subsequent complete consistency/recursive-test run also passed. This is
recorded as observed timing contention, not a proven code fix or certification
of all behavior under saturation. No failing gate was bypassed, timeout relaxed,
new dependency tree installed, production runtime activated or release made.

The Codex checkpoint passed 28 dedicated cases and 142 combined focused cases
with zero failures/skips. Full consistency, recursive build and recursive tests
passed. One earlier full run timed out the existing eight-second strict SQLite
scheduler-timeout child without output; the unchanged focused case and complete
rerun passed. A formatting-only trailing blank line was then removed from the
unpublished component commit, and the complete required checks passed again
before the final commit was pushed. No test deadline was relaxed.

The installed Claude Code 2.0.1 now has a locally qualified native-context path.
Its generic launcher fails under Node 26, so the existing paired Node 24 runtime
is used without patching installed launchers, SDKs or personal configuration.
The same single-input SDK query receives root PostToolUse context; insertion is
confirmed only at the subsequent original-root native model continuation.
Streaming stdin was experimentally rejected because it also repeats the input
as later native work. No synthetic user message or provider-payload receipt is
created. See `CLAUDE_CURRENT_TURN_INPUT.md`.

October 29 Claude checkpoint: 195 combined focused tests passed with no failures
or skips, including installed Claude, Codex, Hermes and OpenCode, source
withdrawal, root/child isolation, native MCP and same-session continuation, Pi
RPC and durable workflow input. This is local acceptance, not production
activation or end-to-end managed-MCP cross-session delivery. Full repository
gates passed. The independent native-context foundation is committed and pushed
as `52e3754`; adapter activation remains local under the shared authority boundary.

Copilot 1.0.82 has a locally qualified invocation-plugin insertion binding.
Its 161 combined focused tests passed with no failures or skips, including
installed insertion, SessionEngine dispatch, pre-effect source withdrawal,
child isolation, native denial, headroom, stop, same-UUID resume, existing native
collaboration tools and shared durable input/Pi regressions. Its
confirmation follows exact root hook acceptance, matching native tool-result
content and the same interaction's root continuation, not a plugin offer alone.
The local/native permission opt-ins remain mandatory. See
`COPILOT_CURRENT_TURN_INPUT.md`.

Copilot fixture characterization also handles native nonstreaming completions,
asynchronous original-process creation and the CLI's own startup settings
migration. No native permission decision or execution deadline was relaxed.
Full repository gates passed. The independent Copilot receipt/plugin component
is committed and pushed as `9a1936c`; adapter activation remains under the shared
authority boundary.

OpenClaw Gateway 2026.10.7 has a local native-context insertion binding under
verification. Ten candidate lifecycle/source cases and an actual isolated
Gateway context-application probe passed. Actual ordinary insertion, application
source withdrawal and SessionEngine dispatch also passed, with acceptance before
the original task completed. Broader native/legacy and cancellation regression
is running. It uses the existing plugin, original native tool-result acceptance
and the same native run's next model call, never `chat.inject` or another task.
See `OPENCLAW_CURRENT_TURN_INPUT.md`.

The final OpenClaw lane passed 147 tests with no failures or skips. It includes
the native gateway, ordinary insertion, source withdrawal, headroom/unknown
budget, actual native stop, one original run and controller/peer regressions.
An earlier lane was not accepted: one gateway missed its unchanged cold-start
deadline, and a direct-stop fixture omitted the controller's logical abort.
The unchanged startup case passed on rerun; the stop fixture now follows the
actual controller contract and observes the native terminal. Task-owned,
version-scoped native compile-cache reuse reduces repeated cold compilation
without enlarging deadlines or retaining a dependency copy.

Integration isolation now has a concrete check: the staged Core snapshot
typechecks against indexed sources only. A compatible existence check fixes
the Codex approval handler's optional future `responder` field without adopting
the unrelated protocol extension. Twenty original-turn/source/workflow cases
also pass with the staged engine and workflow code loaded in memory, excluding
the uncommitted directory-authority engine changes. No checkout or dependency
tree copy was required.

Final indexed-source native integration passed 383 combined focused cases with
zero failures, cancellations or skips. The workspace runtime/test modules were
read from indexed TypeScript in memory; attempts to load an unindexed workspace
module were rejected. Installed native runtimes, controlled local providers,
original-turn acceptance, legacy receive, source/child isolation, approvals,
cancellation and durable input were included. This is not a clean release build
or a managed-MCP cross-session acceptance claim.

The first normal repository gate exposed two stale recovery read-only RPC
allowlists and an adversarial filesystem fixture race. Recovery now recognizes
the read-only capability probe without permitting mutations. The filesystem
fixture waits for a real attacker symlink, preserves a broker-created internal
directory on EEXIST/ENOTEMPTY, and still checks external bytes and exclusive
writes. The three failed cases and five additional serial adversarial repeats
passed. No application security check or timeout was relaxed; the complete
repository gate is rerun before committing.
