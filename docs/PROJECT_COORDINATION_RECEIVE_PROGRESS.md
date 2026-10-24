# Project Coordination Receive Progress

Updated October 24, 2026. Removed runtime checkpoints have been deleted;
current support follows the [native-runtime decision](decisions/2026-10-24-native-agents-only.md).
Historical test counts below are dated evidence, not a fresh whole-worktree gate.
 The active objective remains completion of
agent-phonon capability gaps across every maintained harness, particularly
active-session communication. This checkpoint does not declare that objective
complete and does not authorize deployment.

## Collaboration

The user authorized coordination with the existing chats:

- `01a15c56-775e-7993-ab22-1b01925ca93d`: current observed work includes
  source-aware managed MCP and archive transfer/binding authority.
- `01a147e0-263b-7663-9001-58d73eac24d9`: current observed work includes DE
  profiles/recovery, mobile delivery and busy-vs-unsupported compression state.

This chat owns the shared peer receive path and harness bindings. Ownership
notices and progress were sent to both chats. Their unrelated changes are
preserved; their tests are not claimed as receive-path acceptance.

## Implemented In This Checkpoint

- Separate internal `peerContextCapability` / current-turn `peerContext`
  contracts; ordinary user-input steering retains its existing semantics.
- Authorized native checkpoint reads through existing `project.coordination`:
  no new server permission or synthetic sender identity.
- Bounded peer batches and a metadata-only durable journal. Offered and
  provider-payload-observed are distinct; ambiguous effects are not replayed.
- Private, authenticated local checkpoint endpoint with exact host/origin,
  native session, turn and pending-human-input checks. It is not an MCP tool.
- SessionEngine binding for native and legacy transport sources, with bootstrap
  inbox polling disabled only for the native receive binding.
- Pi context/provider-payload hooks in the existing Phonon extension. It can
  receive without HITL/model tools and does not add a second plugin, new task,
  human timeline item or idle trigger.
- Hermes 0.21.1 owned-process native middleware, with no plugin installation or
  persistent settings change. Dynamic native identity binding is supplied by
  the owning adapter, never self-selected by a checkpoint caller. Child/native
  session mismatch, foreign threads and recursive root invocations cannot drain
  the inbox. Registration handles and temporary bodies are released at turn end.
- OpenCode 1.14.20 invocation-scoped Phonon context module with native root-session
  verification, per-model-boundary delivery and a separately enforced
  `context_hook` evidence ceiling. Existing settings/plugins are retained; pure
  mode and unqualified versions do not gain a module. No replacement session or
  executable is created as a compatibility fallback.
- Peer checkpoint secrets are removed from later Pi/OpenCode tool environments.
  This reduces accidental exposure; it does not claim isolation from arbitrary
  same-user process/memory inspection.
- Claude Code 2.0.1 uses its installed public SDK hooks, with an exact original
  input checkpoint and root-only tool checkpoints. Real native Task children
  were exercised without receiving the parent's pending peer mail. No plugin
  installation, installed-SDK patch or persistent user-setting write is needed.
- A root-only startup normalizer removes the bundled SDK's forced default
  permission flag, restoring the original CLI's config resolution. Unknown
  startup arguments fail before the CLI runs; hook admission also requires its
  one-time compatibility confirmation. Actual plan mode, explicit Read denial
  and standalone-settings behavior were checked against native CLI baselines.

## Harness Ledger

| Harness | Current receive state | Remaining acceptance/work |
| --- | --- | --- |
| Pi | Installed 0.84.1 receive/outgoing and required headroom; direct RPC retry/exhaustion/backoff cancellation, native overflow compaction, read-only recovery and exact-session continuation accepted locally with a controlled provider | Actual model/cross-device and other fallback/compaction/retry/provider/version/OS paths; explicit maintenance is not ordinary recovery |
| Codex | Invocation-scoped hooks; earlier .10.2 receive evidence and installed 0.163.0-alpha.11.2/macOS receive plus required headroom accepted with a controlled Responses provider, actual child isolation and same-root resume | .10.2 budget and broader OS/version/provider/default-model/fallback/compaction qualification; actual model/cross-device tests |
| Hermes | Installed 0.21.1 owned middleware/outgoing and required native request headroom accepted with a controlled provider | Actual model/cross-device; other provider modes, fallback/compaction/retries and supported OS/version qualification |
| OpenClaw | Gateway 2026.9.3 / native `openclaw` binding with required headroom in the existing plugin; real-Gateway initial/in-flight/known-exhausted/unknown, same-session reuse and full-engine receive/send acceptance | Explicit opt-in and prepared plugin; other backends/CLI stay polling-only; native child/fallback/compaction/media, other providers/OS/version and real-model/cross-device qualification |
| Claude Code | CLI 2.0.1/public-SDK receive/outgoing and required native headroom; installed Node 24 checks include initial/mid-turn mail, Task-child isolation, native permission baselines and full-engine receive | Other CLI/SDK/Node/OS, provider/fallback/compaction recovery and real-model/cross-device; existing Node 26 incompatibility is not hidden |
| OpenCode | Installed 1.14.20 invocation-module receive/outgoing and required request headroom, including helper/Task-child isolation | Other versions including 1.15.10, other providers/auth/fallback/compaction, prepared native dependencies and real-model/cross-device acceptance |
| Copilot | Default-off CLI 1.0.82 receive/outgoing and required native headroom in one invocation-scoped Phonon extension; native/engine admission, in-flight delivery, child isolation and exact UUID resume accepted locally | Requires native extensions and native Phonon permission access; CAPI/model-catalog budget path, broader OS/version/provider/background/compaction and real-model/cross-device qualification |

All bindings use the shared versioned device receive reports and durable runtime
evidence reconciliation implemented below. These surfaces are not consumption
ACKs or independent remote attestation. Project collaboration remains quiet by
default and human-inspectable on demand, separate from human group discussion.

## Shared Remaining Work

## Evidence

Source typechecking (`tsconfig.source-tests.json --noEmit`) passed after the new
receiver and tests were added. Local protocol and Core TypeScript builds use the
existing compiler; no dependency installation or server work is needed.

The installed Pi test uses the real local 0.84.1 CLI and a local controlled
OpenAI-compatible provider. The first response requests a real local `printf`
tool execution. A random peer notice becomes available after execution started;
the second actual provider request must contain it. The original input never
asks the model to poll. The test verifies no peer text in native human timeline
output, one task continuation and an independent provider-payload observation.
It is installed-harness evidence, not paid/real-model or cross-device evidence.

Test sources:

- `packages/core/src/peer-context.test.ts`
- `packages/core/src/adapters/pi-peer-context.test.ts`
- `packages/core/src/adapters/hermes-peer-context.test.ts`
- `packages/core/src/adapters/opencode-peer-context.test.ts`
- `packages/core/src/adapters/claude-peer-context.test.ts`
- `packages/test-server/src/fn-peer-context-runtime.test.ts`
- Existing coordination, Pi tools/RPC, native interactions/chat/stop regressions.

The expanded local test run writes its generated report to
`/tmp/phonon-peer-context-20261023-r1.log`. It completed with 63 passing tests,
zero failures and one skipped optional installed-Codex stop test (that test's
binary environment variable was not enabled). Both installed-Pi checks ran and
passed. This is scoped regression evidence, not full harness qualification.
No commit, release, installed user
configuration change, remote build or deployment is included in this checkpoint.

## Hermes Continuation Evidence

The native runtime uses `PluginContext.register_middleware` with scoped cleanup
handles; no private callback-list patching or replacement inference engine.
The installed dispatcher test proves scoped callbacks and cleanup without
inference. Three controlled request-format tests cover chat completions,
Anthropic messages and Responses, including exception propagation and one-shot
provider execution. The installed full CLI test proves actual file-tool execution
and next-provider-request delivery on its original run for chat completions.
The initial fixture runs were rejected by the native 64K minimum context check;
the isolated local provider fixture was corrected to advertise 128K, not by
weakening Hermes policy. Auxiliary `/models`/helper requests remain separate
from the two actual tool-bearing main requests in this evidence.

`/tmp/phonon-peer-hermes-regression-20261023-r1.log` completed with 145 passes,
zero failures and four skipped optional checks: copied Hermes 0.16 source,
legacy installed-httpx redirects, installed MCP client and real YAML parsing.
The new installed Hermes middleware/full-CLI tests and both installed Pi checks
did run. Existing Hermes tools, streaming, recovery, quiet lifecycle and profile
compatibility tests were included. Source typechecking and the local Core build
passed. Final post-cleanup verification is recorded separately when completed.

Post-cleanup `/tmp/phonon-peer-hermes-final-20261023-r2.log` completed with 81
passes, zero failures and one skipped copied-0.16-source check. It explicitly
enabled the installed Hermes MCP/httpx and real YAML-parser checks that the
broader run had skipped, and reran installed Hermes/Pi receive acceptance plus
the shared/current-turn tests. The preceding final-r1 invocation used an invalid
optional Python interpreter path and also observed one bounded 30-second native
run timeout; it is retained as failed evidence, not counted as green. The
interpreter was corrected to the installed console script's actual environment.
The native timeout did not reproduce in final-r2; its cause is unproven, so
repeated native-startup/latency qualification remains a rollout requirement.
No receive deadline, permission or native policy was relaxed to get a pass.

The full objective remains active: four other harness bindings are still pending,
and the shared public capability/receipt and real cross-device/model acceptance
requirements have not been replaced by these local tests.

## OpenCode Continuation Evidence

The module uses native APIs/hooks rather than editing a live transcript or
writing keystrokes. The root-session read checks the native ID, absence of a
parent and exact native directory before issuing the private ready marker.
Foreign roots, child sessions and mixed-session model contexts cannot acquire
that binding. The selected evidence ceiling is enforced by Core, not chosen by
the module's observation request. Versions other than 1.14.20 remain disabled
for active receive, including the installed 1.15.10.

The installed acceptance has a no-Phonon baseline followed by the peer-enabled
case. Both must complete one real native `read` and a final assistant reply.
For the peer case, a random message becomes available only after the first main
provider request; the second actual provider request must contain it. Native
CLI output and all stored `part` data must omit the peer body, and every native
session row must retain the fixture directory. The acceptance logs exposed
inherited `PWD` pointing at the daemon's project; the adapter now overrides it
with the controller's bound directory while preserving the operator's permission
configuration.
The isolated fixture additionally grants only its own external-directory path
where that native rule is required; there is no global permission bypass.

Local plugin dependencies were prepared with scripts disabled in
`/tmp/phonon-opencode-deps-11420-20261023-r1` and copied with their real manifests
and lockfile into the isolated acceptance home. The package version must match
the native binary. The test never fabricates installed package metadata, changes
the real user's profile or requires deployment-server installation. This prepared
tree is a local fixture, not a production release artifact. A separate 1.15.10
dependency preparation is retained for the failed-version investigation.

Versioned primary interfaces inspected: OpenCode v1.14.20 and v1.15.10
`packages/plugin/src/index.ts`, native config loading, session prompt and message
conversion paths from the upstream source. Installed behavior, not source names,
determines the supported binding.

`/tmp/phonon-opencode-peer-11420-20261023-r2.log` completed with 19 passing tests,
zero failures or skips, including the installed native baseline and peer case
and shared receipt/authority checks. Subsequent native version/recovery guards
and private-environment changes are covered by the broader regression recorded
below when it finishes. Source typechecking and the local Core build passed.

Failed attempts are retained under `/tmp/phonon-opencode-peer-20261023-r*.log`:
the first native read was denied by its external-directory policy; a fresh
isolated startup timed out while preparing native dependencies; 1.15.10 then
accepted tool execution and the peer-containing second request but did not
produce a final reply. A no-Phonon 1.15.10 baseline failed in the same way.
That rules out claiming successful end-to-end support for that combination;
the underlying native/provider cause is still unproven. Neither its terminal
requirement nor its permissions were weakened to obtain acceptance.

The expanded `/tmp/phonon-peer-opencode-regression-20261023-r1.log` finished with
170 passes, one failure and one skipped copied-0.16-source check (172 cases).
Both installed OpenCode baseline/peer cases, Pi cases, shared authorization/
evidence checks and adapter normalization passed. The failing case is the
previously recorded Hermes 30-second native deadline: its trace includes a
successful real read and final response text, but the controlled native run did
not settle within the test's bound. It is not counted as success and its cause
remains unproven. The focused diagnostic rerun
`/tmp/phonon-hermes-peer-latency-20261023-r1.log` passed with the same deadline.
The test now captures bounded native stdout/stderr and isolated logs on failure;
this is diagnostic coverage, not a fix or a removed reliability gate.

No full objective completion, release, installed user-configuration change or
deployment is claimed. All dependency preparation and tests in this checkpoint
were local. Whole-worktree and repeated native/physical-device acceptance remain
open in addition to the four remaining harness bindings and public surfaces.

The final focused three-harness selection
`/tmp/phonon-peer-three-harness-final-20261023-r1.log` passed all 34 cases with no
failures or skips, including the installed Pi/Hermes/OpenCode paths and shared
current-turn checks. It does not erase the earlier broad-run Hermes timeout or
certify the unqualified OpenCode version. Final OpenCode acceptance reads the
supervised native stdout passively, without a replacement executable wrapper.

That direct-executable selection completed in
`/tmp/phonon-opencode-peer-direct-final-20261023-r1.log`: seven passes, no failures
or skips. It includes both native baseline and peer-enabled task completion,
native database/directory checks, version/pure-mode/recovery guards and isolated
module tests. It is separate, overlapping evidence rather than an additional
seven unique requirements on top of the three-harness selection.

## Claude Continuation Evidence

The supported candidate is the inspected CLI 2.0.1 and its sibling `sdk.mjs`,
tested on the installed Node 24.19.0. The same CLI fails during startup on the
observed Node 26 environment; no crypto/library shim or global Node replacement
was used to hide that incompatibility. Unknown CLI/SDK layouts remain inactive.
The owned SDK uses the original native UUID, working directory and authorized
turn. The public hook output is `additionalContext`, not user steering, a new
prompt, a permission answer or a provider-payload receipt.

The original-input hook is exact and one-shot. In this installed version the
SDK's SessionStart hook alone did not populate the first actual request, so the
tested UserPromptSubmit boundary handles initial pending mail. PostToolUse is
limited to native tool IDs observed on the original root assistant, not child
messages. A real native Task/Read sequence verifies that child provider requests
do not receive pending parent mail, while the parent continuation does.

Native terminal evidence is explicit for CLI and SDK paths: the original session,
successful native subtype, `is_error:false`, a final response and process
completion must agree. Exit code zero alone, intermediate planning, missing
native results and foreign session frames cannot claim completion. The SDK
runner stops accepting new checkpoints after the root result.

`/tmp/phonon-claude-policy-20261023-r1.log` preserved the discovered mismatch:
the SDK forced `--permission-mode default` and reset an existing project plan
mode. The project Read denial itself was retained (Read was removed from the
catalog, not executed). The normalizer now validates that exact SDK override,
removes only it in the intended root process, and removes its own preload from
fork inheritance. It does not choose a new permission mode, parse/merge the
user's policy hierarchy, modify installed code or approve a tool. A private
one-time startup record is a compatibility check, not consumption evidence.
An unsupported launch contract is a required safety failure; unavailable peer
mail remains an optional-channel failure and does not restart the task.

Standalone settings are passed by their existing owner-selected path with the
original native setting-source flags. No credential values are copied into
generated source, new settings files or command-line values. Real baselines
verify selected-file authentication, no unwanted project-settings merge,
retained plan mode and unchanged original file bytes.

`/tmp/phonon-claude-peer-20261023-r6.log` completed all 22 checks with no failures
or skips, including installed native CLI and SDK paths, initial/mid-turn delivery,
real Task-child isolation, Read denial, plan mode, standalone settings and
fail-closed startup contracts. This is local controlled-provider evidence, not
real-model or physical cross-device certification. Production observations stay
at `context_hook`; ordinary Phonon assistant/result events do not contain peer
text, but owner-inspectable native/tool context is not represented as secret.

## Resource Lifecycle

The latest user disk-hygiene rules apply to these tests. Before resuming, disk,
existing Core/protocol build output and task-tagged processes were inspected.
The old compiler handle was absent, not presumed still live. There were no
leftover peer fixture directories or matching active test processes. Existing
build locations are reused; this work creates no simulators, app copies or
deployment-side test services.

`packages/core/src/testing/peer-fixture.ts` is test-only and not exported by the
production entry point. It records ownership before setup, puts native temporary
files inside an isolated synthetic fixture, registers cleanup immediately and
verifies ownership/native-process inactivity before removal. Setup/assertion
errors keep their original failure; cleanup still runs and cleanup failures
cannot turn a run green. Signal cleanup is tested, including a nonzero signal
exit. Uncatchable termination can retain an owner manifest; this is not a claim
of guaranteed zero leftovers.

OpenCode acceptance now leases its matching existing prepared tree and links
`node_modules`, copying only the two small real manifests. Both the unit and
installed checks verify the shared view remains a link and its metadata stays
unchanged. No new dependency tree is installed per run. The two previously
prepared 1.14.20/1.15.10 trees are deliberately retained, about 57 MB each, for
the accepted native path and unresolved-version investigation. They are local
test caches, not deployment artifacts or production dependencies.

New combined-run output uses the stable `/tmp/phonon-peer-validation.latest.log`
instead of another dated retry directory. Older small logs referenced above
remain audit evidence for the prior failures; no raw fixtures or native homes
are retained as evidence. The resource unit tests cover failure cleanup,
ownership changes, leased dependency reuse, live-process refusal/retry and
catchable interruption. Full installed revalidation after this helper change is
recorded below when complete.

## Codex Continuation Evidence

The added binding targets the installed 0.163.0-alpha.10.2 CLI, tested on macOS
with Node 24.19.0 and a local controlled Responses provider. An optional internal
readiness step runs before an already authorized coordination turn; ordinary
Session creation/recovery does not acquire a new probe or invoke a model.
Disabled hooks and unknown versions retain polling-only behavior. The direct
path combines CLI-scoped settings, native read-only hook-discovery RPC and native
UserPromptSubmit/PostToolUse hooks; no persistent plugin installation is needed.

Native discovery supplies each generated handler's actual declaration hash.
Only those two definitions receive invocation-local approval. A second discovery
checks that unrelated hooks' hashes, enabled states and trust remain unchanged.
No hook-trust bypass, permission-mode override or automatic approval is added.
The CLI dotted override syntax did not preserve literal dots inside quoted state
keys; a native-verified inline state table now carries only the owned entries.

The ingress binds to the root UUID observed by its own CLI adapter, bound cwd,
native transcript suffix, one-shot original prompt and exact native turn.
Checkpoints close on native completion/cancellation. Installed acceptance covers
initial and in-flight mail, an actual command and final reply, two turns on the
same native root, and a real namespaced native child/spawn/wait sequence. Newly
pending parent mail appears in the parent continuation but not child requests.
An existing trusted native PreToolUse denial still prevents the command's file
effect. No peer body appears in ordinary Phonon output or native exec output.
The receipt remains `context_hook`, never provider acceptance or model ACK.

The first candidate failed because native commands inherited its environment
token; that assertion was retained. The narrow loopback capability now lives in
a private, turn-owned channel file, not generated source, native argv, config
values or the native process environment. Cleanup follows observed process-tree
termination; arbitrary same-user file inspection is outside this boundary. No
provider credential is copied. A probe force-signal deadline is likewise not
treated as process exit; teardown briefly waits for actual stopped evidence.

Focused source checks and existing command/final behavior passed 39 cases.
Native-stop/recovery/reasoning regressions passed 33, with two optional installed
cases not enabled in that selection. A first combined five-harness run passed
all native paths but failed one newly added fallback test whose synthetic server
response omitted the authorized self identity. The fixture was corrected rather
than weakening source checks; the fallback and resumed-peer focused rerun passed.
The final combined run and post-cleanup audit are recorded separately below.

Final combined output is `/tmp/phonon-peer-codex-validation.latest.log`: 69
passes, no failures or skips, approximately 100 seconds. It includes all five
installed harness receive paths, Codex same-root resume/native child/native
denial cases, shared receive authority/evidence, readiness fallback and resource
lifecycle checks. Source typechecking and the local Core build passed using the
existing compiler and stable build directory; there was no dependency install.

The post-run audit found no matching receive test/build processes, scratch
fixtures or active cache leases. The stable fixture base contains only its
existing prepared-cache reference. Existing local OpenCode version caches remain
intentionally retained as described above; no new dependency tree or simulator
was created. Available disk space was 219 GiB, an observation of the shared
machine rather than a claimed cleanup saving. Only source/docs, stable build
outputs and concise test logs are retained from this checkpoint.

## OpenClaw Continuation Evidence

The existing Phonon plugin now has a separate, default-off `peerContext` feature.
It requires explicit prompt-injection/conversation-access hook grants and does
not depend on `nativeInteractions` or register another model tool. No personal
OpenClaw settings, running shared Gateway or remote server was changed.

Support is checked against installed native 2026.9.3 on macOS / Node 24.19.0.
The private capability RPC resolves the actual Session generation and native
runtime through public native APIs, rather than guessing from model prefixes.
Only the selected `openclaw` backend is admitted. The runtime resolver is lazy so
the new subpath is not loaded on the old HITL-only code path; this is not a claim
that untested older plugin hosts or nested Codex/Copilot backends are qualified.

The binding reuses authenticated local transport helpers but has its own token,
source scope and lifecycle. Post-policy prompt enrichment requires live native
tool authority. Subsequent delivery uses the supported async tool-result
middleware: original tool result fields/content remain intact and a separately
attributed untrusted-peer block is appended. Production receipts remain only
`context_hook`. Gateway projection removes the exact current-run carrier, and
the event router now rejects foreign/missing run identities before publishing
tool events. A foreign-run frame is tested during an actual native read.
Failure and pending-approval results are not rewritten.

Native acceptance uses an isolated local Gateway, the minimal prepared plugin
artifact and a controlled local provider. Baseline, already-pending mail and
mail published during the original native run all complete the actual file read
and original final reply. Tests inspect the next real provider request, assert
carrier-only metadata is absent from provider fields, preserve real tool bytes,
and check both normal Phonon output and native user/assistant history for peer
prose. The plugin runs with human-input/model tools disabled. Native tool history
may retain inspectable collaboration context; routine human chat, unread and
notification semantics are not changed.

The first native attempt passed receive/result checks but failed an overly broad
config-byte assertion: native startup migrated the isolated legacy canvas
setting and added native migration metadata. The corrected test snapshots the
settled native config before collaboration and verifies it remains byte-identical
through the turn, while also retaining the authored tool policy. No adapter
permission/config override or acceptance condition was relaxed. An initial
disconnect test now waits for the checkpoint's actual disconnect signal before
releasing a held read; sending cancellation alone is not exit/admission evidence.

`/tmp/phonon-peer-openclaw-validation.latest.log` completed 44 cases: 42 passes,
no failures and two optional installed cases not enabled (Codex held-inference
stop and a separate isolated OpenClaw history-reader fixture). All three actual
Gateway/provider cases and the installed middleware runner did run. Existing
human/group tools, minimal artifact, recovery, proactive output, native-stop and
shared readiness/receive regressions were included. Source typechecking, local
Core compilation and the existing stable plugin build passed without dependency
installation. Post-run resource audit is recorded below when complete.

Post-run audit found no remaining peer scratch fixtures, active cache leases or
matching task-owned Gateway/test/build processes. The existing shared Gateway
was not stopped or reconfigured. The stable fixture base contains only its
previous prepared-cache reference; the isolated plugin artifacts, native homes,
SQLite stores and test provider services were removed by their registered
cleanup. Disk availability was 220 GiB, not a claimed saving attributable to this
chat. Existing bounded OpenCode caches remain retained; no extra dependency tree,
simulator, application copy, server-side build or deployment was introduced.

## Copilot Candidate And API Qualification

This historical candidate checkpoint is superseded by the integration evidence
below. Its direct-SDK limitations remain relevant; that alternative is not the
implemented production binding.

October 23, 2026: the owner-selected binary executes built-in Copilot 1.0.82
with the adapter's `--no-auto-update` flag. A plain version invocation may select
a different cached release and is not this qualification target. Tests reuse
the existing native runtime/SDK cache with isolated homes; no dependency tree
is downloaded, installed or copied for each fixture.

`copilot-peer-context.ts` prepares one invocation-scoped Phonon plugin through
the native bundled extension SDK. It is deliberately not wired into
`CopilotSession` or advertised as a production receive capability yet. It does
not install a plugin, change user/project settings or grant native permission
access. Native tests supply consent for exactly the synthetic Phonon extension;
that fixture flag is not a production auto-approval mechanism. Without consent
the extension cannot join, read mail or claim receipts; the original CLI task
still finishes.

Actual native `task` children share their root's session ID and cwd. An ID-only
or cwd-only check therefore leaks root context. The candidate requires the
exact original prompt first, tracks native tool-start identities with
`agentId` / `parentToolCallId`, and admits only an unambiguous live root tool
checkpoint. Unknown/ambiguous tools, duplicate callbacks, unsuccessful results,
closed turns and revoked checkpoints cannot receive context. A failed attempt
to start a child is explicitly not child-isolation evidence.

A repeated native run exposed reordered lifecycle events: the root tool can
finish before `subagent.completed` is observed. Receive admission therefore
checks the exact live root-tool identity, rather than treating child-count
notifications as a synchronization barrier. A deterministic late-terminal
regression and five consecutive installed child runs passed after this fix.

Pending mail and mail arriving during a real native file read reach the local
controlled provider. Mail available before a native child starts is absent from
both child provider requests and appears only after the root resumes. Original
file bytes and final task text remain intact. Hooks return only
`additionalContext`, not modified prompts/results or permission decisions.
One-use private capsules are deleted before joining; checkpoint credentials
are absent from native shell/MCP environments. Receipts remain `context_hook`,
not consumption/completion. There is no new human prompt, group post or idle run.

Native user-message `data.content` and assistant content stay unchanged. Hook
context may remain in internal `transformedContent` metadata and collapsed
native tool history. This is owner-inspectable context, not secrecy from humans;
ordinary Phonon chat, unread and routine notification semantics do not change.

A separate direct-SDK probe can create an isolated native session before
inference and supply initial context without a plugin. It is not accepted as
the production replacement: CLI BYOK environment selection is not inherited
automatically, and conservative unresolved-permission rejection also denies
fixture reads under the tested SDK bootstrap. A rejected action may end the
original task without a confirmed native final message. Tests record this gap
and reject missing final evidence. Creating that isolated test session is not
a read-only production inventory operation.

`/tmp/phonon-peer-copilot-validation.latest.log`: 56 passes, zero failures/skips.
This includes 19 candidate unit cases, five installed extension cases, four
explicitly unqualified SDK probes, and shared receiver/runtime, group and
Copilot baseline regressions. Source typechecking also passed. This is not a
whole-worktree release gate. Post-run audit found no remaining peer fixtures,
active leases, task-owned native/test/compiler processes or extra runtime-cache
copies. Existing bounded caches remain; disk availability was 221 GiB.
No release, deployment or personal configuration change was performed.

## Copilot Adapter Integration Evidence

The current adapter now binds the extension for owner-selected
`copilotPeerContext: true` (library `CopilotEnv.peerContext`). This is a strict
boolean local option, default off, propagated through daemon and local commands.
It is not a native permission grant. The production invocation does not add
`--experimental`, `--allow-tool`, allow-all or yolo flags and does not edit native
settings. Native extensions must already be enabled and the native operator
must have authorized `plugin:agent-phonon:peer-context` in the relevant location.
Explicit native experimental/extension disablement and missing consent remain
pending/polling, preserving the original assigned task.

Lifecycle, authentication, provider selection and known-UUID resume remain on
the selected CLI; only the missing receive boundary uses the Phonon plugin.
Discovery and execution both retain `--no-auto-update`, with bare and offline
banner version formats normalized. The extension also checks its actual native
bundled-SDK package version before joining. There is no SDK/runtime download or
separate persistent plugin installation.

Shared capability state now distinguishes pending from ready. A pending binding
does not suppress bootstrap inbox data or tell the model to stop checking mail.
Current-turn IDs already offered in that bootstrap are excluded from subsequent
native offers, without fabricating a receipt or ACK. Native admission requires
this invocation's nonce, exact native session ID and a live extension process.
Readiness files are revoked on native closure; late files cannot revive a
closed slot. A capsule not consumed before the original native prompt is
disabled, and all private assets are removed after the owned process settles.

Copilot children share the root session ID, and callback inputs do not carry
the tool-call ID. Receive therefore combines the native root tool-start ledger
with a fresh, read-only native task snapshot. Successful root `task` results
also require the native telemetry agent ID to match the native task's owning
tool-call ID. Identical nested arguments, delayed notifications, ambiguous or
missing metadata, failure results and closed/revoked turns cannot borrow a root
caller's receive authority. Queries are bounded and never start/cancel tasks.
Unavailable metadata closes optional native admission rather than modifying
permissions, restarting the original task or claiming delivery.

Native final text is taken from the root's completed assistant message and
confirmed native terminal frame, not accumulated child/intermediate prose or
an exit-zero process alone. Foreign native identities and unconfirmed/error
completion fail. Interruption waits on the owned runtime before plugin cleanup.

Actual installed CLI tests exercise the complete SessionEngine path with
controlled local providers: initial bootstrap deduplication, in-flight native
file read, a real Task child, no native consent, native experimental disablement
and native extension disablement. A two-turn test retains the same native UUID
while rotating bridge/token/nonce and rejecting the old endpoint. The fixture
uses the public native API to authorize only its synthetic extension in its own
isolated location; production code never invokes that grant API. Original
results and file bytes remain intact, with no extra run or peer prose in normal
human message/result text. Native tool/history inspection remains possible.

The latest `/tmp/phonon-peer-copilot-validation.latest.log` records 119 passes,
zero failures and 22 optional installed tests for other harnesses not enabled.
All Copilot installed cases did run, including the four explicitly unqualified
direct-SDK probes; those probes are not counted as accepted adapter behavior.
The separate strict local-config test passed. Source typechecking and local
Core compilation passed, and the in-flight native test also passed using the
actual compiled package entry with the generated runner checked against source.
This is not fresh installed acceptance for the skipped harnesses, whole-tree
release acceptance, physical cross-device delivery or real-model evaluation.

## Coordination-Only Tools And Copilot Sending

The controller endpoint no longer requires a human-interaction callback to
exist. Its catalog and direct HTTP routes are built from the actual callbacks:
coordination-only means only project coordination, with no form, approval ACK,
group sender, board or document authority. The paired human request/ACK
callbacks must either both exist or both be absent. SessionEngine constructs
this independent endpoint when any authorized controller channel is present.

Codex, Hermes and Pi now select their native controller tools from those same
actual callbacks. Hermes native setup accepts a bounded nonempty subset rather
than requiring the two human-interaction names. Both modern and 0.16 native
registry fixtures check coordination-only child isolation and unchanged native
memory/config selection. Pi's existing Phonon extension compares its exact
invocation-selected catalog, rather than requiring forms. An installed Pi
controlled-provider test invokes project coordination without any human/group
tool and observes its confirmed result in the original provider continuation.

Copilot's same invocation-scoped Phonon extension also registers project
coordination when that controller callback exists. It uses the protocol-derived
object JSON schema, bounded direct loopback requests and the controller's
existing validation/idempotency. Root native session/tool-call ID/name/arguments
and native task/permission snapshots gate each call. Child calls, unknown IDs,
duplicate invocation, active child work and pending approvals cannot borrow the
root's identity. Outgoing invocation admission does not consume the later
receive-hook boundary. The extension still declares no permission handler,
human/group tools, `skipPermission` or global allow flags.

Native extension consent and native custom-tool consent are distinct. In the
isolated fixture, the public native API authorizes just the selected synthetic
extension/tool before inference; production never invokes that grant API.
Installed SessionEngine cases prove a real recorded root send and receipt,
child-sender rejection and no send/evidence while a custom call lacks approval.
The installed noninteractive CLI does not forward a permission-request event
for that pending extension call. The test therefore checks a still-active
original tool call with no controller effect or false completion, then cancels
and cleans it. This is not reported as a surfaced human prompt or resolved
approval. UI presentation of such native waits remains a public readiness gap.

## Latest Integration Verification

## October 24: Public Receive Reports

Implemented optional version-1 device receive reports on the existing stamped
`project.coordination` envelope, outside the model action. Pending native
admission and absent native identity remain `runtime_pending`; only the owning
adapter's admitted native identity permits `runtime_checkpoint`. The maximum
evidence field is capability metadata, not per-message runtime observation or
model ACK. The receive bridge/journal remain independent.

Each assigned turn negotiates once on presence, then includes current reports
on authorized calls/heartbeats only after exact source/self support is returned.
Rejected/malformed/legacy responses leave normal coordination intact. Both SDKs
preserve report/result fields without inventing support. Native IDs and tokens
are not included. Model-facing tools and human/group permissions are unchanged.

Phonon Work migration 78 stores nullable report, source epoch and server time.
Its device host authenticates source lineage before writing; external MCP and
model actions cannot claim these fields. Inspection computes a separate current
flag from epoch, online device, actual stored native/dev session/turn, active
noncancelled runtime and a 120-second freshness limit. The page displays current,
noncurrent and unreported states and expires labels locally, without background
network reads, human unread/notifications, group posts or extra tasks.

Still incomplete: per-message runtime-evidence reconciliation (distinct from
capability reports), remaining native outgoing bindings, context
headroom and actual physical-device/real-model/release-wide qualification.

## October 24: Runtime Evidence Reconciliation

Implemented server-issued per-message runtime offers and the device-only
`project.coordination.evidence` request. Controller-only inbox negotiation keeps
delivery capabilities out of model catalogs/results/context; even extra model
callback arguments cannot select the private mode. SQLite stores only delivery
identity, authority and synced state alongside existing boundary/hash metadata.
The lazy connection reporter does not create a database for unrelated sessions.
It coalesces updates, validates exact receipts, retries bounded pages and resumes
after restart without waking a model or replaying context. Replaced connections
cannot acknowledge records. Protocol and both SDK handlers remain in parity;
the exact hash-pinned Phonon Work SDK backport was extended and checked idempotent.

Migration 79 adds bounded runtime offers with exact recipient/device/source epoch
and original evidence limit. Reconciliation checks original sender/recipient
source authorization plus current project grants and device identity, including
transaction fences. Historical completed executions can report prior observations
without acquiring live tool authority. Boundary/hash changes and evidence
upgrades beyond the selected binding are rejected. Observations are monotonic
and never update mailbox received_at. Only explicit human inspection exposes
runtime evidence; group chat, notifications, unread and dispatch remain untouched.

## October 24: Claude Native Outgoing Coordination

Claude Code CLI 2.0.1 / bundled SDK now exposes project coordination through its
public in-process MCP API. This is invocation-only, independent of native peer
receive and existing human/group channels. No plugin or installed SDK edit is
needed. The runner uses its bundled SDK and the existing packaged MCP request
schemas; no dependency tree is installed or copied per run.

The source guard ties the SDK MCP request's native `claudecode/toolUseId` metadata
to a root assistant tool ID/name/exact arguments and matching original-root
PreToolUse hook, native session/cwd/transcript, exact original prompt and
startup-policy proof. Unknown/child/changed/duplicate/cancelled calls fail
without forwarding. A call is consumed once before the controller request;
uncertain effects require the original request identity to be reconciled, never
an automatic retry. PreToolUse admission returns no allow decision. Existing
native permissions remain authoritative: explicit deny and absent approval
both produce no send. The existing default-mode startup normalizer and its
plan/standalone-settings acceptance remain unchanged.

Only `phonon_project_coordination` is registered. It does not add native forms,
approval acknowledgements, group publications or worker execution tools.
Coordination secrets stay out of generated source/argv and are removed from the
native tool environment when no independent controller callback needs them.
Other authorized shell controller capability routes retain their existing
environment contract. This does not claim same-user memory isolation.
The adapter suppresses coordination tool-call/results from ordinary Phonon
stream events; native transcripts remain owner-inspectable. No unread, human
notification, idle task or extra prompt is introduced.

Verification for this outgoing checkpoint: 63 source tests passed, zero failures
or skips, including all installed Claude cases and installed Pi coordination.
Nine compiled-Core checks independently passed native outgoing, deny, unapproved,
child/root continuation, coordination-only, same-native-UUID resume, full engine
attribution and direct one-shot/cancellation guards. Source typecheck, local
Core compilation, protocol/SDK consistency guard and whitespace checks passed.

A subsequent cancellation lifecycle test exposed the existing early cleanup
race: termination's force timer could resolve before the process close event.
The adapter now waits for observed native process-tree exit before deleting its
runner; a bounded extra observation wait handles that event race, and unknown
termination retains assets with an explicit error. The synthetic held SDK test
passed after this fix. Its failed fixture/process-group ownership was audited
before removing a stale cleanup marker; no unrelated resource was touched.
Final compiled-Core rerun passed four additional checks after that lifecycle
fix: held cancellation cleanup and actual native child/root, unapproved and
SessionEngine outgoing cases. Final resource audit found no task-owned Claude
or test/compiler processes or peer scratch roots; the existing bounded cache
reference and stable Core output remain. Available disk was 219 GiB. Other
chats' active test/simulator resources were left untouched.

## October 24: OpenCode Native Outgoing Coordination

OpenCode 1.14.20 now uses the same invocation-scoped Phonon module for the
native project-coordination tool, independently of receive. Native plugin/tool
and Effect dependencies are resolved from its existing configured native
dependency tree; no second plugin/dependency install or fabricated package
manifest is introduced. The strict version fence and pure-mode fallback remain.
The input comparison follows 1.14.20's actual positional-argument quoting and
stdin newline behavior, not an assumed raw-prompt equivalence.

The module requires original root session/directory/no-parent, original user
message, a before-tool callID with exact JSON arguments and a native read of the
current assistant/parent/ToolPart call/state/arguments. The custom tool explicitly
executes `context.ask` with its own permission using the native Effect runtime.
It adds no allow decision, permission callback or settings override. A native
deny hides/refuses the tool; CLI ask rejection remains a failed/unconfirmed
assigned execution with no send, rather than fabricated completion.

Calls are single-use and rechecked after asynchronous native authorization and
after controller response. Concurrent identical calls cannot forward twice.
Children, changed source/native part, terminal tool state, unrelated new root
input, cancellation during permission wait and late changed-source responses
fail closed. Module-created temporary peer context is identified locally, so
receiving a peer does not disable a valid root send. Ordinary Phonon stream
output omits collaboration tool data; native owner inspection is still possible.

Installed controlled-provider acceptance covers baseline, in-flight receive,
recorded send, deny, unapproved CLI rejection, actual task-child identical send
attempt followed by valid parent send, same-native-session two-turn resume,
coordination-only, full SessionEngine source attribution and combined native
receive/send. Unit checks cover concurrent duplicate, exact part/args/parent,
cancelled permission wait, one-shot failure, new input and late response fences.
Cancellation stops the owned native process before removing its module, with
unconfirmed termination retaining assets. Existing JSONL UTF-8/EOF/cancel and
human/group MCP/message regressions remain separate.

Verification: 49 source cases passed without skips, including ten installed
OpenCode cases and the installed Pi coordination-only acceptance. Ten compiled
Core cases independently passed the exact/one-shot/permission/cancel guards and
all eight installed outgoing cases, without source aliases. Eleven native
MCP/group-message regressions and two OpenCode ToolPart/UTF-8/EOF/cancel checks
passed. Core build, full source typecheck, protocol/SDK consistency and diff
whitespace checks passed. Early fixtures exposed ESM-only dependency exports,
native CLI input wrapping and unapproved CLI termination behavior; the tests
were corrected to actual native contracts, not permissions or fabricated success.
Prepared native dependency caches were reused with exclusive fixture leases,
and temporary modules/processes were cleaned after each run.

## October 24: Pi Native Headroom

Added a private, strict known/unknown native budget on peer boundaries, separate
from observation identity and all model tools. Pi reads its actual context usage,
model window/output limit, effective system prompt and active tool schemas.
Core reserves
output/safety space and system/tool/framing overhead; input and peer wrappers use
conservative UTF-8-byte estimates, cumulative across a batch. These are not exact
model tokenizer counts or proof that later third-party transforms cannot grow
the request.

Unknown, invalid or exhausted budget defers whole mail without a journal claim,
runtime receipt or ACK. Later boundaries recover without cursor loss. Small
fitting mail can pass a larger deferred message. Required-budget bindings cannot
omit the budget to regain the old path. SessionEngine also suppresses unbudgeted
automatic initial mail while these bindings are pending/unavailable.
Explicit model inbox calls retain their original separate contract. No automatic
compaction, idle wakeup, human notification, group publication or permission is
introduced.

Other harness headroom, actual compaction/provider fallback qualification,
physical cross-device/real-model/release gates
remain incomplete. No dependency install, personal configuration change or
deployment occurred. Existing bounded caches and stable build outputs are reused.

## October 24: Hermes Native Headroom

Hermes 0.21.1 now declares the same required-budget capability. Its owned native
request middleware derives each budget from the actual assembled provider
request and the current context engine, not startup catalog guesses or cumulative
billing usage. Agent/context-engine/request model, native API mode and base URL
must agree. Actual request UTF-8 JSON bytes conservatively charge system prompt,
messages, tools and provider-specific fields. Positive integer output limits are
read from the current request and `extra_body`; all applicable caps use the
largest reservation. Missing cap, invalid value, changed-model overrides or stale
engine/route metadata produce unknown. No default output cap is invented and no
runtime setting is modified to obtain space. The existing native retry path is
not changed; a later request is assessed afresh.

Shared Core output/safety/framing reservations, whole-message deferral, cumulative
batch charging and no unbudgeted bootstrap apply. The mailbox/journal does not
gain claims or ACKs for unknown/exhausted budgets. Native middleware preserves
history and provider exception/call-count semantics, thread/root provenance and
scoped registration cleanup. Device-private metadata needs no protocol/SDK/DB
change or human notification.

Three controlled request-format tests exercise chat-completions, Anthropic and
Responses budget behavior, including bad/missing windows, stale model/route/API,
invalid/oversized output caps, extra-body model/cap overrides, large tool schemas,
unknown-to-known recovery and unchanged original requests. Installed Hermes
middleware plus actual CLI/provider acceptance verifies known, unknown and
exhausted budgets while preserving the same native task and real file tool.
The known fixture supplies its own synthetic provider output cap; production
code never adds one. The three actual CLI cases also passed from compiled Core
directly without source aliases. Installed full CLI evidence remains limited to
chat-completions; fallback/compaction/provider/OS/version combinations need their
own qualification.

Focused source/shared lane: 37 passed, zero failures/skips. Hermes streaming,
quiet lifecycle, native tools and reporter regression: 50 passed with three
explicitly disabled optional installed checks. Core build, full source
typecheck, consistency and whitespace guards passed. Other harness native
headroom and the wider objective remain active, not marked complete.

## October 24: OpenCode Native Request Headroom

OpenCode 1.14.20 now declares required-budget receive. Its early message
transform runs before native system/output/tool assembly, so the same invocation
module now composes the public native provider `options.fetch` hook for explicit
`@ai-sdk/openai-compatible` providers. It measures the actual assembled JSON,
checks native model window and actual output limits, and adds peer data only to
the transient request copy. Existing custom fetch/authentication/native retries
and errors remain owned by OpenCode; the original fetch is called exactly once.
No global fetch patch, credential copy, new provider executable, persistent
configuration change or new dependency tree is used.

A private one-use header ties each request to the original root/user/Agent,
model and route; it is removed before network/custom fetch. Root source is
rechecked around awaited mailbox and observation operations. A replaced provider
fetch cannot receive a marker. Foreign endpoints, helpers, children, replayed
markers, changed native source, cancellation and unsupported body shapes do not
read mail. Byte accounting covers the complete request, including system/tool
schemas, plus framing and worst-case escaping expansion for the bounded peer
batch. Unknown or exhausted budgets do not claim/ACK or inject initial mail.
Outgoing tools retain native permission and exact call identity independently.

An actual installed exchange test exposed title-helper requests sharing the
root session/user. The first candidate incorrectly claimed pending mail on that
helper; it failed acceptance. Binding the original native Agent as well prevents
helper drains; the actual first main request now contains initial peer data,
and Task-child parent continuations remain isolated. This failure is not counted
as success. Installed tests also check provider authentication unchanged, no
private header leaves the process, and no peer text reaches native history or
ordinary output.

The final source/shared lane passed 58 cases without skips, including 12 actual
OpenCode cases and installed Pi coordination. They cover baseline, normal
receive, unknown/exhausted headroom, send, native deny/ask rejection, actual child,
same-session resume, coordination-only, full engine attribution and exchange.
Unit checks cover system/tool payload size, missing caps, helper/substituted
fetch exclusion, marker replay, endpoint mismatch, cancelled/late source and
single-shot provider exceptions. Native MCP/group regressions passed 11 cases.
Core compilation, full source typecheck and whitespace checks passed. Compiled
native verification and final cleanup are recorded after completion below.

Qualification is explicit-provider OpenAI-compatible chat-completions only.
Other provider backends/routes/auth plugins, 1.15.10, fallback/compaction,
physical devices/real models and other harness headroom remain on the original
active goal. Evidence remains context_hook, not consumption/completion or remote
attestation. Quiet-by-default and human on-demand inspection are unchanged.

Final compiled verification passed all 21 module cases directly as JavaScript
without a loader/source alias, including all 12 actual native cases. After the
provider-wrapper identity check was added, focused source tests verified normal
native receive and substituted-fetch exclusion again. Native ToolPart/UTF-8/EOF/
cancel checks passed two cases. Core build, full source typecheck, consistency
guard and whitespace checks passed. Final audit found no task-owned native,
test, compiler or fetch process and no peer fixture/cache lease; only the
existing bounded dependency-cache reference remained. Stable Core output was
about 5.2 MB, protocol output 4.6 MB and free disk about 217 GiB. Other chats'
resources were left untouched. No installation, deployment, commit or release.

## October 24: Codex Native Headroom

The installed Codex binary is now 0.163.0-alpha.11.2. Both the earlier .10.2
and this exact version are fenced by the native hook qualifier; new headroom
acceptance is .11.2/macOS/Node 24 with a controlled local Responses provider,
not inherited .10.2, real-model or cross-device qualification. No plugin,
dependency installation, native settings write or permission override is added.

Codex now declares required native budget. Its bounded, identity-checked
transcript reader requires the original thread/workspace/current native turn,
matching requested model and fresh per-inference usage. `task_started` supplies
the native usable window. Actual installed ordering shows `token_usage_record`
before PostToolUse, while legacy `token_count` can flush only afterward; reading
the latter alone deferred every active boundary. Billing totals are never used.
Legacy window observations cannot enlarge the same task-start usable window.
Post-inference serialized events, current tool-response JSON and a cumulative
debit for previously offered peer context are charged by UTF-8 bytes. Native
usable-window output reservation does not waive Core's extra 17024-token
overhead and shared safety reserve. These are conservative, not exact tokens.

Initial hooks have no current inference usage and leave initial mail pending
until a qualified tool boundary. Missing/invalid/stale/compacted usage, metadata
outside the 1 MiB tail, unresolved model identity and exhausted headroom defer
without journal claim or ACK. Required-budget bindings cannot inject automatic
initial mail through a pending/unavailable bridge. A later known boundary can
recover; explicit agent polling remains separate. No compaction, extra model
turn, restart or human notification is triggered by coordination.

The first low-headroom fixture reported 120000 input tokens and legitimately
triggered native auto-compaction, so that failing candidate is not counted as
acceptance. The accepted 100000-input case is below native compaction onset but
above conservative peer headroom; the original native task completes with no
peer injection or journal claim. Native compaction was not disabled to pass.
An initial-unknown case finishes directly without a tool or any automatic mail.
Other installed cases retain baseline, initial/in-flight receive, real native
child isolation, same-root resume, native denial and exact hook-trust checks.
Unit cases also cover oversized current tool output, cumulative peer debit,
foreign/malformed records and post-compaction invalidation.

Final verification:
- Source receive/shared lane: 57 passed, zero failures/skips, including actual
  Codex and Pi processes. It was rerun after the final test/type assertions.
- Related regression: 39 passed, zero failures/skips, including installed Codex
  workspace/outside-write sandbox checks, recovery, command/final output,
  native MCP, human group separation and native-budget bridge fallback.
- Compiled Core: the same 57 cases passed directly as JavaScript, without a
  TypeScript loader or source aliases, including all installed Codex cases.
- Core build, full source typecheck, protocol/TS/Python consistency, generated
  rescue-knowledge check, four hook guard tests and both whitespace checks pass.

The recovery regression previously compared the full checkpoint after a new
input, incorrectly requiring `contextNotBefore` to remain unchanged. It now
checks exact checkpoint preservation immediately after recovery, then unchanged
native identity/storage/pending input with normal usage invalidation on send.
No recovery production behavior was weakened. A new test type-narrowing error
found by the compiler was corrected before the final green build.

## October 24: Copilot Native Headroom

Copilot 1.0.82 now declares required-budget automatic receive in the existing
one-use Phonon extension. CLI lifecycle/authentication/native consent and UUID
resume remain unchanged; no second plugin, dependency installation, personal
setting or native approval is added. Native extensions must already be enabled
and authorized. Pending or unavailable admission cannot bypass the budget via
automatic initial inbox bootstrap; explicit model inbox reads remain separate.

The original root's native `session.usage_info` supplies its prompt window and
system/conversation/tool counts. Fresh read-only `metadata.contextInfo` counts
and model snapshots fence current identity. The larger native count, current
tool-result JSON bytes and cumulative peer debit cover post-observation growth;
Core adds 1024 framing tokens and shared output/safety reserves. Child usage
never overwrites the root baseline. New input, model/context changes, truncation
and compaction invalidate usage; usage arriving during compaction is ignored.
Late changed-generation projections are suppressed around awaited operations.
Budget API reads are bounded; a timeout cannot later continue to the next RPC.

Actual installed inspection found that the extension environment strips provider
configuration and offline BYOK model lists may be empty. The native invocation's
bounded noncredential model/route/limit configuration is therefore carried in
the already private one-use capsule. API keys, bearer tokens and credential/query
URLs are not copied. Native `provider.getEndpoint` is disabled by default and
would expose credentials; production never calls it or enables that export.
An initial candidate using the stripped extension environment correctly deferred
all mail and failed the normal-receive tests; that candidate is not acceptance.

Explicit OpenAI/Azure chat-completions BYOK requires a positive configured output
reserve and matching current model. The actual native prompt allocation excludes
output; the configured output value is an additional conservative reserve inside
that input allocation, not a claim that the provider receives an output cap.
A proposed request-cap assertion failed: installed 1.0.82 does not serialize
`max_tokens` or `max_completion_tokens` there. Native prompt-allocation semantics
were independently checked by setting 128000 in an isolated fixture and observing
that exact window in the root event. Production never sets a limit to gain room.
Missing/invalid reserves remain unknown rather than borrowing runtime defaults.
The exact model-catalog path has controlled unit coverage, not installed CAPI
qualification. Other routes, provider reconfiguration/fallback and compaction
recovery require separate acceptance.

Installed tests verify initial mail waits for a later qualified tool boundary,
in-flight receive reaches the original continuation, actual child mail isolation,
native deny/missing-consent/disabled paths, outgoing sender authority, unchanged
file results and exact native UUID reuse with fresh capsules. Unknown and
known-exhausted cases leave mail unclaimed without observations or ACKs while
the assigned native task completes. A hook/real-journal combination also proves
later known-budget recovery and single delivery without cursor loss. Ordinary
human output, unread counts, group discussion and notifications remain separate.

Final verification: 95 source/shared/engine tests passed without failures or
skips, including eight actual extension checks and twelve full native engine/
resume cases. Four direct-SDK probes verify known native permission limits; they
are not counted as qualified replacement adapter paths. Another 28 shared
reporter/MCP/group/coordination/resource cases passed, including installed Pi
outgoing coordination. Direct compiled JavaScript ran 75 Core cases without a
loader or source alias, including all eight actual extension checks. Core build,
full source typecheck, consistency/knowledge guards, four hook tests and both
whitespace checks passed. An added fixture's widened enum type was corrected
before the final compiler/source/compiled runs; no production relaxation.

## October 24: Claude Native Headroom

Claude Code CLI/public SDK 2.0.1 now declares required-budget automatic receive
through its existing SDK hooks. No additional plugin, SDK patch, dependency,
permission grant or personal settings change is introduced. Initial pending
mail waits for a qualified root tool boundary; missing/stale/compacted/mismatched
or exhausted budgets do not claim/ACK or use unbudgeted automatic bootstrap.
Explicit agent inbox reads retain their independent semantics.

The active SDK has no public native window getter. This exact installed runtime
uses 200K or 1M windows; the budget conservatively uses 200K and real CLI tests
cross-check native final `modelUsage.contextWindow`. Only a fresh original-root
assistant per-inference observation matching the init model supplies input,
cache-creation/read input and output counts. Child, helper and cumulative final
accounting do not supply active usage. Unknown aliases/provider model identity
stay unknown. Native PreCompact and compact boundaries invalidate the baseline.

Output reserve is at least 32000 and the maximum potentially active thinking
budget plus one. Settings inspection includes the exact invocation environment,
user/project/local ancestors and managed settings, or standalone plus managed
settings when selected. It takes a conservative maximum rather than guessing
native precedence, retains the startup/highest reserve for the turn, and never
copies or changes settings. Reads are bounded at 256 KiB per regular nonlinked
file with stable FD/path checks and bounded ancestor traversal. Malformed,
linked, oversized, changing or inaccessible configuration makes budget unknown;
absent optional settings are normal. A mistaken initial assumption that 150K
was a thinking cap was corrected after native source inspection showed it was
the Bash-output cap; no final implementation relies on that assumption.

Current and parallel tool-result JSON bytes, later native tool records, earlier
peer-context debit, 1024 framing tokens and shared output/safety reserves charge
the batch conservatively. Parallel callbacks cannot drain independently from
one inference budget. Additional tool results or changed native/configuration
evidence while awaiting the inbox suppress a stale projection; a new inference
baseline settles prior tool debit. Observations remain only `context_hook`, not
model consumption, provider acceptance or human approval.

A first 170000-input fixture triggered legitimate native automatic compaction
and failed its two-request expectation; it is not counted as acceptance and
native compaction was not disabled. The accepted low-headroom case reports
150000 input with a synthetic 55000 thinking setting. Its actual native request
uses 55001 output tokens, remains below compaction onset, completes its original
task and leaves mail unclaimed. A no-tool initial-unknown case also completes
without injection. The hook/journal test proves unknown/exhausted-to-known
recovery and deduplication; an early recovery expectation without a new native
baseline was corrected instead of weakening cumulative tool accounting.

Local verification:
- The full source/shared/engine lane passed 63 cases without failures/skips.
  Later final-source focused checks passed nine cases, including real native
  in-flight/initial receive, full-engine receive, low-headroom and unknown paths.
- Shared reporter/MCP/group/coordination/resource regressions passed 28 cases,
  including installed Pi coordination. Native permission behavior is unchanged.
- Final compiled Core ran all 56 module/shared cases directly as JavaScript,
  without a loader or source alias, zero failures/skips. All nineteen installed
  Claude cases ran: baseline, child, deny, plan, standalone, outgoing, same-UUID
  resume, pure coordination, full-engine send/receive and budget limits.
- Core build, full source typecheck, protocol/TS/Python consistency, generated
  knowledge check, four hook guards and both whitespace checks passed.

Acceptance remains macOS/Node 24/CLI-SDK 2.0.1 with a controlled Anthropic-shaped
provider, not all aliases/models/providers or actual paid-model evaluation.
Other versions/OS/Node, fallback and actual compaction recovery need their own
qualification. Full-engine receive records the original session/turn and adds
peer text only to its next request, not ordinary human output. Native history
remains owner-inspectable on demand, with no group publication or notification.

## October 24: OpenClaw Native Headroom And Coordination-Only Binding

The existing Phonon plugin now declares required native budget for Gateway
2026.9.3's selected `openclaw` runtime. Core requires the updated capability
contract rather than treating an older plugin as budget-qualified. No native
installation, provider replacement, user-config write or second plugin occurs.
The current implementation qualifies explicit config-owned text-only
`openai-completions` models; other routes remain unknown until independently
qualified, not silently inherited from another harness/backend.

The host's `llm_input` snapshot includes assembled system/prompt/history/tools.
UTF-8 JSON bytes charge that surface; original-run/model/native-session
`model_call_started` events provide the actual effective window and a nondefault
source. Each unique model call conservatively charges its entire configured
output allocation plus 1024 framing, including retries. Tool-result bytes and
framing plus earlier peer contexts accumulate for that run. Core reserves 2048
overhead and the shared output/safety allowance. This bounds growth without
pretending that the late whole-attempt `llm_output` is a current inference count.

Explicit model/default/agent output aliases use the largest positive limit.
Missing/invalid limits, request-substituting `extra_body`, nontext/media history
or tool results, missing/replayed native call metadata, duplicate input snapshots,
model/route/config changes and compaction invalidate admission. No automatic
compaction, replacement session, permission answer or extra model call is made.
Initial mail waits until native evidence exists at a later tool boundary.
Unknown/exhausted budgets preserve pending IDs without journal claim or ACK;
qualified later snapshots can recover. Concurrent tool growth, changed source,
cancellation, transport revocation and turn end fence late projections.

Real Gateway tests cover baseline, initial/in-flight, native-window=128000,
known-exhausted versus unknown, exact native Session two-turn reuse and full
SessionEngine receive/send. Actual provider requests retain their original file
result and output ceilings; peer carriers never become provider schema fields,
ordinary Phonon output or native user/assistant prose. Production evidence stays
`context_hook`, not model consumption or independent provider attestation.

Full-engine acceptance exposed a genuine prior integration gap: a project-only
controller token was treated as requiring native human-interaction enablement,
and its bind schema required a nonexistent human receipt URL. The same plugin's
native tool registration/binding now supports `coordinationOnly` under opt-in
`peerContext`, without `nativeInteractions`. The Gateway supplies only its
authorized coordination endpoint, never fabricated interaction/receipt URLs.
Factory catalogs and one-use native permits expose only project coordination;
attempts to acquire forms/group/board/workflow/document tools are rejected.
Ordinary human-tool bindings retain their prior contract. Actual native send
is still separately allowed by the owner's tool policy, retains original
session/turn/run lineage and is omitted from ordinary Phonon tool output.

Verification:
- Source native/shared/engine lane passed 68 tests, zero failures/skips. Final
  focused checks passed four more cases after extra-body and permit hardening.
- Shared reporter/MCP/group/resource/recovery lane passed 35 cases, zero skips,
  including installed Pi coordination and an installed OpenClaw read-only
  history/recovery check without inference or transcript writes.
- Compiled JavaScript directly passed all 60 plugin/Core/shared cases without a
  TS loader or source alias, including all eight real Gateway scenarios and
  installed middleware/native hook/artifact checks. Test transpilation reused
  the stable test-server/dist directory after full source typechecking; no
  second dependency/build tree was created.
- Plugin bundle/declarations, Core build, full source/plugin typechecks,
  protocol/SDK consistency, generated knowledge, four hook guards and both
  whitespace checks passed. Full release-wide gates are not implied.

Early fixture failures are not counted as success: the micro-fixture's 60000
reserve still left a little space and was corrected to 64000; a repeated input
snapshot needed explicit compaction invalidation before recovery; an engine
test omitted its required options. Full-engine tests then exposed and drove
the production coordination-only fix above. A Gateway process group once
outlived its termination promise, causing cleanup refusal and the next fixture
to stop. Cleanup now waits for observed process-group exit. The retained failure
marker was removed only after verifying task ownership, absent fixture and dead
process group; no unrelated resource was removed.

## Kimi Original-Root Wire Proof Preparation

The internal `kimi-context.ts` reader and its eighteen focused format/boundary
tests implement one required source-proof component for CLI 1.40.0 / Wire 1.9.
They do not register a Kimi adapter/plugin/tool, enable receive/send or alter
the unsupported communication state. Runtime prerequisites remain unchanged.

Installed source inspection found that subagents can share the root native
session ID and LLM object. Root Wire content is persisted as `ContentPart`
envelopes, not `TextPart` envelopes. Child events are normally nested under an
original root Agent call, but native approvals/questions/external requests can
also be forwarded unwrapped. The reader accepts only original-root source
records and refuses unqualified forwarded requests; the session field alone
never grants authority.

The reader checks the canonical cwd-md5/session wire path under the explicit
owner share directory, owned nonwritable directories, regular nonlinked files,
bounded complete UTF-8 JSONL and stable opened/current file and directory
identities. An exact-prefix SHA-256 turn anchor distinguishes same-text later
input and source rewrites. Only one original TurnBegin after assignment is
eligible. Root tool ID/name/raw arguments must agree and remain unreturned.
Child tool/completion/status records cannot replace parent proof; a pending
Agent prevents proof until its original root result. Recorded human waits defer;
deny/block, cancelled/interrupted, compacted, ended or unsupported turns cannot
recover their old proof by appending normal events.

No budget/permission/completion/consumption field is synthesized. Wire status
counts lack the actual request output cap and model/provider binding; TurnEnd
also occurs after native blocking. The reader cannot prove waits absent from
the recording, root process/session ownership or actual model consumption.
Those remain independent native runtime/provider/permission acceptance gates.
The helper is internal and unwired, not a successful communication binding.

Source tests for Kimi/Claude/Codex context proof passed 39 cases; compiled
JavaScript context/shared receive/reporting checks passed 59 cases, zero skips.
Core build and full source typecheck passed after fixing the Node filesystem
Stats-overload annotation. Tests used owned synthetic fixtures only, not a
running Kimi. No dependency installation, native settings write, replacement
session, deployment, commit or release occurred. Preparing a bounded compatible
Python 3.13 test runtime was requested from the user; no permission was assumed.

Final audit found no related task-owned compiler/test process or owned peer
fixture. Stable Core/protocol outputs (~6.6/4.6 MB) were reused; free disk stayed
about 210 GiB. Both authorized collaborating chats received this partial
checkpoint and its remaining native gates. The full objective remains active.

## Pi Native Retry And Overflow Recovery

Actual Pi 0.84.1/macOS controlled-provider reproduction exposed an active receive
lifecycle defect: after the first HTTP 500, native Pi emitted `auto_retry_start`,
but the adapter killed its RPC process on the intermediate assistant error.
Only one request occurred and the original task incorrectly failed. Qualified
RPC now waits for original `agent_settled`; native Pi owns retry/compaction.
Phonon starts no extra recovery prompt or process. Explicit abort and extension
failure remain terminal; exhaustion, a failed latest attempt or closure without
settlement cannot reuse an old successful reply. Unqualified JSON behavior is
unchanged.

Successful native retries then exposed a second defect: strict transcript
inspection rejected historical failed attempts even after original native
recovery completed. The read-only inspector now requires subsequent same-model
successful assistant progress before any new user or model-change record.
Error tails, aborted records and unresolved tool calls still cannot settle.
The original file is not rewritten or filtered. Actual continuation after both
transient retry and overflow compaction retains the exact path/session through
the existing launch guard, with failed-attempt records still present.

Installed cases cover HTTP failure followed by native success, exhausted native
retry, cancellation during actual native backoff, and overflow recovery with a
real native summarization request and post-compaction file read. Recovery stays
in one RPC PID during its assigned turn. New unpredictable mail reaches the
retry/next eligible root request without a polling tool, timeline echo or
persisted native peer-history record. A failed attempt's already-offered mail is
not automatically replayed. The summarizer receives no newly pending peer mail;
post-compaction unknown headroom defers it until fresh original-root usage.
Provider-payload observations remain distinct from consumption or ACK.

### Broader Regression Conflicts (Resolved Below)

The expanded Pi adapter/native-tool/recovery/RPC lane was not green: 46 passed,
five failed and one was cancelled at timeout. Current pre-existing automatic
fresh-session fallback in `PiSession.send`/recovery conflicts with assertions
about altered checkpoints, missing-file/guard races, provider pinning, failed
turn recovery and verification before continuation. The RPC interruption test
also waited for rejection of a new send that the fallback instead started.
These assertions must not be silently weakened or counted as native acceptance.
The fallback code was inspected before this turn's edits and was not reverted.
Its owner was notified for coordination; this is unfinished integration work,
not a passing package/release gate.

The timed-out test's live native child was identified by exact command and
parent chain and stopped so its owning runner could finish. A legacy tail
helper also lacked cleanup; it now uses the existing owned PeerFixture with
environment restoration and failure cleanup. Its one task-created leftover
directory was checked for exact synthetic contents, creation/owner identity and
inactivity before removal. No other task's files or processes were removed.

The final compiled-Core lane also passed 43 cases, zero skips, using Node's
native test TypeScript stripping only for the tail helper, with no TSX source
alias for production Core. Consistency/generated-knowledge checks and both
repository whitespace checks passed. Final audit found no related task-owned
test/compiler/native process, owned peer fixture or legacy Pi test directory.
Stable Core/protocol output directories (~6.7/4.6 MB) were reused; global free
disk was about 207 GiB. No native dependency/runtime installation, personal
profile mutation, deployment, commit or release occurred. The complete goal is
still active, with the broader regression conflicts and remaining harnesses
explicitly unfinished.

## Pi Read-Only Recovery Contract Reconciliation

The five recovery failures and one RPC timeout above are now resolved against
the existing `SESSION_RECOVERY.md` contract, not by weakening their assertions.
`recoverSession` only verifies the full checkpoint; failed verification cannot
invoke rescue and thereby adopt a forged/changed owner or file observation.
Retained sends reverify their exact saved source. Already-started but failed or
unverified sessions refuse another input instead of silently resetting creation
state. Failure/abort finalization cannot trim history or re-adopt an older
successful turn as its settled checkpoint. The low-level maintenance helper is
preserved separately and is no longer an implicit adapter recovery path.

The full Pi adapter/native-tools/recovery/RPC regression lane passed 52 cases,
zero failures, timeouts or skips. This includes altered checkpoint bindings,
native owner/file/guard races, pinned provider, failed/aborted/unsettled turns,
read-only daemon restart recovery, exact original RPC steering and interruption
without a replacement prompt. It ran in an owned supervised process tree with
a hard deadline and fixture cleanup, rather than relying on legacy helpers to
clean up after a timeout.

A first supervised run passed 51 cases but exposed a wrapper path issue: its
deep macOS temporary root plus the project namespace exceeded Pi's encoded-cwd
directory-component limit. A focused rerun confirmed native `ENAMETOOLONG`
before inference. The final run used a short, still-owned bounded temporary
base; no production storage layout, recovery condition or test assertion was
relaxed to hide the error. The engine test now asserts the actual final result
before inspecting its persisted checkpoint instead of reporting a null-access
error after a failed turn. Native arbitrary deep-path support is not claimed.

Installed direct-Pi retry/compaction tests additionally recover through a new
adapter session without any provider request or native-file mutation, then
continue the identical native UUID/path. Actual exhausted/cancelled runs verify
their original failure bytes remain unchanged, expose no recoverable checkpoint
and reject a fresh prompt. Focused source lifecycle/retry/receive lane passed
18 cases, zero skips. This preserves the prior successful original-run recovery
work while closing the separate failure/adoption loopholes. Kimi and remaining
harness/native cross-device/provider/version/OS gates remain unfinished.

Final compiled-Core lifecycle/receive/recovery lane passed 43 cases, zero skips,
including seven installed direct-Pi scenarios. Core build/full source typecheck,
protocol/SDK consistency, generated knowledge and both repository whitespace
checks passed. These scoped gates are not whole-worktree release qualification.
The final audit found no related task-owned test/compiler/native process, owned
fixture in either temporary base, or legacy Pi test directory. The short base
is a small empty reusable directory, not a copied runtime/dependency tree.
Stable Core/protocol outputs (~6.7/4.6 MB) were reused; free disk remained about
207 GiB. No dependency/runtime installation, personal native configuration
write, deployment, commit or release occurred. The full goal remains active.

## Installed Pi Across Two Authenticated Device Identities

The local compatibility audit could not unblock Kimi without installation.
Its Python 3.13 target is still missing. The existing bundled Python 3.12.14
provides Pydantic 2.14.1, while the browser-use 3.12.15 environment provides
2.13.5; Kimi 1.40.0 requires exactly 2.12.5 / pydantic-core 2.41.5. A bounded
read-only audit of the existing uv archive metadata found CPython-3.12 native
artifacts at different versions (including core 2.46.5, aiohttp 3.14.3, Pillow
12.3.0 and lxml 6.1.3), not a matching runtime set. No ABI forcing, mixed-package
launch, dependency tree, download or personal launcher/config change was made.
The pending compatible-runtime request is not treated as user approval.

Work continued on a separate real end-to-end gap, rather than repeating the
controlled-adapter routing test. The new Phonon Work
`project-coordination-native.integration.test.ts` and isolated native worker
run actual installed Pi 0.84.1 sessions through current PhononDaemon/PiAdapter,
two independent Node processes, separate profiles/SQLite/workspace roots,
different device credentials and production Auth/Registry/Agents/WebSocket/
PostgreSQL implementations. A local controlled provider drives seven original
native requests across exactly two explicit tasks. No test directly calls a
project callback or fabricates a runtime receive boundary.

Actual native tools publish activity/impact, send a question, receive it during
the original task, acknowledge it, send a correlated result and acknowledge the
reply. Both native provider payloads contain their incoming messages. Exactly
two runtime offers reach provider-payload evidence; canonical source keys and
epochs match the actual devices/sessions and execution runs/turns. Human
inspection sees both live checkpoint reports and the activity, without ACK.
While final outputs are gated, human unread snapshots/message/push counts stay
unchanged from the pre-coordination baseline. Final human history/push records
exclude private markers; device, bridge and native-app credentials are absent
from provider bodies. No extra input/run is created by collaboration.

Final Agents typechecking and the native/host lane passed six cases, zero skips.
The earlier baseline native exchange passed; a strengthening run exposed a test
query using a nonexistent conversation document column, not a product failure.
That assertion now uses the actual human snapshot read model for unread values;
the corrected strengthened exchange passed. Local database/table cleanup was
verified after the failed run as well as success. This proves two authenticated
device identities on one Mac with real installed harnesses, not physical
Mac/Linux/Windows exchange, mixed harnesses, managed DE profiles or paid/remote
model reasoning. Those gates and unimplemented remaining kinds stay open.

The existing idle local coordination database was reused under the advisory
lease, not recreated. Final audit found zero fixture tables and zero remaining
connections in that database, no related worker/native/test/compiler process
and no owned short-root fixture. Device credentials, two native profiles and
per-device SQLite files were removed, including on the failed assertion run.
Existing built Core/daemon outputs and dependencies were reused; free disk was
about 207 GiB. No deployment, server-side build/test, package installation,
personal credential/configuration copy or native launcher repair occurred.
The full goal remains active.

## October 24 Local V1 Handoff Checkpoint

The user requested a usable first version rather than continued compatibility
expansion. The current handoff distinguishes the supported local communication
path from the still-open all-harness objective and production activation.

The installed native test was generalized to also exercise a managed Hermes DE.
Actual employee provisioning and profile read-back passed, but this extra case
timed out waiting for a coordination-capable original native provider request.
The cause is not established; this is not passing Agent/DE end-to-end evidence.
It remains an explicitly opted-in experiment using
`PHONON_RUN_COORDINATION_HERMES_DE=1` plus the explicit Hermes binary, not an
automatic additional gate when a binary path happens to be configured.

After that change, the maintained installed-Pi baseline and source-adapter lane
were rerun: six passed, one experimental case excluded. Full Agents test
typechecking passed. The baseline still verifies activity/impact, original-task
checkpoint receive, correlated question/result, explicit ACKs, real source
attribution and no ordinary human chat/unread/push effects. The Phonon Work
acceptance document records the exact V1 evidence, unproven experiment and
activation requirements. Its delivery contract now distinguishes qualified
native checkpoints from polling-only bindings; neither interrupts inference.

This checkpoint does not complete every remaining harness or establish physical
cross-device/production readiness. No deployment, installation, personal native
configuration write, service restart, commit or release was performed.
Final cleanup verification found zero fixture tables and zero other database
connections, no related test/compiler/native worker process and an empty owned
short-root base. Existing outputs/dependencies were reused; free disk remained
about 300 GiB. No new large build artifacts were retained by this handoff.

## Managed Hermes DE Native Exchange Resolved

The user requested a usable V1; work stayed on the already exposed managed-DE
failure instead of expanding to another harness. A bounded diagnostic rerun
showed a successful original Hermes task with native Tool Search bridge tools,
not a missing execution or failed employee provisioning. The controlled provider
had classified that original request as metadata because the directly exposed
coordination tool was absent.

Installed Hermes 0.21.1 reads `tools.tool_search`; the fixture incorrectly set
top-level `tool_search`. Setting the native fixture configuration at its actual
key exposes the already registered current-turn tool as intended. No production
adapter, native library, personal profile or permission policy was changed.
Normal nonempty tool catalogs missing the expected coordination tool now fail
immediately. Failure diagnostics are bounded to native catalogs, execution
states and worker output, redact known synthetic credentials and do not retain
provider request bodies or ordinary result text.

The focused managed-DE rerun passed. The final combined installed native and
source-adapter lane then passed seven tests, zero skips, with strengthened
assertions that both actual native file reads reach later provider payloads.
Full Agents test typechecking passed. The mixed test uses real profile
provisioning/read-back, actual DE participant identity, group mutual mentions
disabled, and exactly two original assigned runs with seven coordination-capable
provider requests. Activity, checkpoint receive, correlated question/result,
explicit ACKs and no human chat/unread/push effects all pass.

This supersedes the previous checkpoint's unproven managed-DE status, not the
remaining all-harness/OS/version or physical-device/paid-model gaps. The new
evidence qualifies the fixture's explicit direct-tool native configuration, not
default/deferred Tool Search behavior. The optional managed-DE gate remains
explicitly selected so Pi-only development needs no additional runtime.
Production deployment and personal runtime activation remain unperformed.

The final strengthened rerun passed the same seven cases with zero skips.
Actual current-turn interaction/peer tokens are observed over private worker
IPC, excluded from turn diagnostics, and checked against all bounded provider
requests including metadata helpers. Credential failures use generic messages
and the entire bounded wait diagnostic is redacted without an unredacted cause
chain. Final cleanup found zero fixture tables and other connections, no related
native test/worker process and an empty owned short-root base. Free disk remained
about 300 GiB; existing dependency/output directories were reused, with no new
large artifacts retained.
