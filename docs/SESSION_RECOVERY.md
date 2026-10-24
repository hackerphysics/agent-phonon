# Verified Native Session Recovery

Device capability: `session_recovery_v1`. Registry:
`packages/protocol/src/schemas/methods.ts` (101 methods).

## Contract

`session.status` and `session.list` optionally include:

```json
{"recovery":{"detached":true,"canAttempt":true}}
```

`canAttempt` is not proof that the native file still exists or that recovery has
succeeded. Read-only status never starts an adapter. A blocked record provides
`checkpoint_missing`, `interrupted_turn`, `adapter_unsupported`,
`control_unconfirmed`, `session_owned_elsewhere` or `session_terminated` as applicable.

Recover explicitly with the retained identities, not a new task:

```ts
await session.recover({project: "registered-project", agent: "codex", model: "model"});
```

```python
await session.recover(project="registered-project", agent="codex", model="model")
```

The request contains no prompt, filesystem path, new model or workflow strategy.
Tenant, current device method/agent policy, project/worktree directory and exact
Session identity are rechecked. Repeat success on an already idle attached
Session is observational: it does not send another turn. Concurrent controls,
unconfirmed compression and terminated/running Sessions cannot be adopted.
Teardown fences late recovery results before they can overwrite a successor.
Late model-switch and context-injection completions cannot rewrite that
successor's paused checkpoint either.
Status/list/recover parsing also preserves the original optional `worktreeId`;
recovery cannot select a different directory or worktree.

## Controller Ownership

`session_native_owners` records a private controller instance and PID in the
device database. SQLite serializes claims across independent store instances.
A different live process/controller cannot claim the same native Session;
process-probe uncertainty is treated as still owned. After process death or
bounded controller teardown, adoption still requires the exact current settled
checkpoint, agent/model/project and employee revision. A stale observer reloads
the durable stream cursor before attaching, even if the native checkpoint itself
is unchanged. Observer disposal cannot overwrite another controller's checkpoint.

This is a single-host owner fence, not a distributed timeout lease or permission
to force takeover of a live PID. PID reuse can conservatively block recovery;
it cannot authorize a new attempt. Interrupted model work remains blocked after
the owning process dies. Recovery never treats process death as task success.

## Checkpoints

Native/Dev chat workflow completion waits for the original turn's adapter and
bridge finalization after its final model event. A short `settleTurn` observation
deadline is not execution failure: the workflow continues observing with its
current lease/control epoch and original total timeout, without another model
attempt. Cancellation, disposal and lease loss fence late settlement. This
preserves a recoverable idle checkpoint only after actual cleanup, not merely a
successful final string. `fn-workflow-finalization.test.ts` covers delayed cleanup,
cancel and timeout; Phonon Work's October24 Mac coding report records actual
provider/simulator evidence and its selectively activated runtime.

The optional `sessions.recovery_json` column is a bounded versioned device-local
record, not a wire field. It retains adapter state, original agent/model/project
and directory, plus whether the controller settled. Task success and native
conversation continuation are separate facts. Every turn invalidates the
settled marker before the adapter can start, including automatic queue draining.
An idle shutdown preserves a valid checkpoint. Unconfirmed live work stays
pending rather than being assumed stopped. A legacy missing checkpoint can be
observed only by an adapter implementing `observeSessionCheckpoint`, using the
original device-owned identity and directory. Malformed, oversized and
unknown-version records are not replaced with an empty native conversation.

Only an adapter implementing both `recoveryCheckpoint` and `recoverSession`
participates. `nativeSession:true` alone is not recovery proof. Implicit send on
a detached Session uses the same observation and verification. An unresolved
identity is a recovery condition: the server retains the pending input instead
of marking it failed before delivery.
No recovery operation replays input, clears an unknown attempt, drains queues,
changes review decisions, or calls `workflow.resume`.

Explicit Dev workflow retry is a different operation. A cursor-bound
`workflow.run` with the original plan, a stable `clientRequestId`, and
`resumeFrom: {workflowId, strategy, expectedSeq}` uses the durable resume receipt.
A fresh operation with a changed event cursor fails with
`errWorkflowObservationChanged`; an identical recorded retry returns its original
acceptance even after restart, without another model turn. Devices advertise
this contract as `dev_idempotent_resume_v1`. It is not automatic replay of an
uncertain tool effect or permission to replace a native Session.

## Codex

The first production adapter path is Codex. After an actual native turn, its
checkpoint retains the thread UUID, canonical native storage root and pending
injected context. Recovery checks the existing rollout's bounded JSON metadata,
thread identity and canonical working directory without launching the CLI.
Missing, symlinked, corrupt or mismatched records are refused. Subsequent input
uses `codex exec resume <original-thread-id>`; a different `thread.started` ID is
a failed turn, not a silently adopted replacement thread.

An explicit `CodexEnv.codexHome`, then `CODEX_HOME`, then the native default
selects the same storage for CLI execution, recovery, compression and discovery.
No arbitrary home/path can be supplied through `session.recover`.

## Pi

Pi verifies its native v3 transcript, canonical device-selected home,
cwd/session directory, exact file path, UUID/start time, filesystem owner and
identity, byte/snapshot hashes and retained provider/model. Recovery is read-only:
it does not trim a tail, repair a checkpoint, spawn the CLI or create an empty
conversation. Linked, changed, malformed or mismatched identities cannot be
silently replaced. Failure, cancellation, a user-only tail or an unfinished tool
is not an identity mismatch. Pi owns message normalization; Phonon does not
delete or fabricate those records. Active branches and custom context remain in
the complete snapshot, and the selected branch supplies the retained model.

Every retained send rechecks the saved observation before releasing input. A
failed/aborted turn can expose an identity-only `continuation` snapshot after its
supervised process tree stops. The outcome stays failed/aborted, and only newly
supplied input is sent. No failed input or uncertain tool effect is automatically
replayed. A failed launch before input acceptance can retry without poisoning
the conversation. A failed guard cannot fall back through `--session-id`;
a still-unchanged prior snapshot remains retryable.
Stateless older CLIs keep their explicitly stateless repeated-send behavior.
The independent low-level `rescuePiSession` maintenance utility is not called by
normal send, finalization or `recoverSession`. Trimming native bytes cannot prove
that an interrupted task or its external effects completed.

### Graceful Close Stop Evidence

Connection teardown still fences new work immediately and has a bounded cleanup
window. If the original live adapter finishes termination, its original turn
settles and it reports a matching `process_tree_exit` or `native_terminal`
within that window, SessionEngine preserves that real proof before releasing
native ownership. It can capture the stopped native checkpoint for later
explicit recovery without publishing a fabricated stream terminal or changing
the execution result. A replacement controller can reconcile the original
cancelled workflow, then send only a newly supplied input in the same Session.

A termination acknowledgement alone is insufficient. Missing evidence,
unsettled turns, owner changes and callbacks arriving after the close window
stay unconfirmed; late callbacks cannot write after ownership release. This
fix prevents losing a newly observed proof during graceful teardown. It cannot
retroactively certify old controller-restarted records or a hard crash without
the original source evidence. Installed Codex held-inference testing confirms
actual process-tree exit without a provider response; it is not paid-model or
physical-phone acceptance.

Native Pi retry and overflow compaction are different: within the original
assigned RPC turn, Pi itself may recover a provider error and eventually settle.
Historical error records remain intact. Successful native retry is distinct
from continuing after an exhausted failure. Actual installed 0.84.1/macOS controlled-provider
checks verify observational recovery after successful retry/compaction, then
continuation through the original session/path guard. Backoff cancellation and
exhausted retries retain unchanged failure history; a stopped, verified original
conversation can receive new input without a replacement session.
These are local controlled-provider checks, not all-version/provider/OS or
physical cross-device qualification.

For legacy Pi records with no saved checkpoint, the adapter inspects the unique
canonical native file matching the original Phonon Session ID and cwd. Recovery
still claims the unchanged device database identity before attaching. It sends
no model input, and a missing file is never created as an empty conversation.
Discovery retains an installed Pi executable through a transient probe failure
and refreshes capabilities when a later scan succeeds.

## Hermes

Hermes verifies its original native Session through installed read-only
SessionDB APIs. The profile/home, canonical cwd, native UUID, model, start time,
database identity and nonempty history are checked. Native turn/compression lease
rows, even expired-but-unsettled rows, block adoption. Verification never calls
CLI main, repairs storage or reopens a conversation. Private/group histories,
long-term memory and pending context remain distinct. A newer installed employee
profile is staged for the next turn without inference during recovery.

On Windows, recovery requires the same locally prepared native file runtime
assets as managed Hermes profiles. A no-follow broker read captures only one
byte and the native volume/file ID; matching non-delete-shared directory/file
handles pin that identity while installed read-only SessionDB APIs inspect the
metadata. Root and file IDs are rechecked before accepting the observation.
Missing assets, reparse points, multiply linked files and changed identities
fail closed. No Windows path-based write or empty-history fallback is used;
Mac/Linux retain the existing POSIX descriptor path.

Hermes 0.16's quiet `chat -Q -q` exit skips its interactive `cli_close` path.
The execution bridge closes only its single, successfully completed root turn
through that agent's existing native SessionDB on normal/zero exit, after
checking the actual profile database, Session, cwd, source and lineage. Failed,
partial, interrupted, delegated-lineage and multi-turn invocations are not marked
settled. This is execution cleanup, not a recovery-time repair: the later probe
remains read-only and still requires native `ended_at` and a stopped process.
Older records without verified checkpoints are not retroactively adopted.

## OpenClaw Gateway

The Gateway adapter persists a versioned checkpoint with the original native
UUID/key, local Gateway identity, agent/profile, cwd, selected model, creation
time, native history size/leaf and pending context. A bounded `chat.history`
read verifies inactive native work, no pending native inputs, no archived or
restart-tombstoned source, local placement and retained nonempty history.
Missing fields, a different identity/directory/model, shorter history or an
unreported/active state fail closed. The Gateway must advertise native settings
CAS support. Legacy CLI and unsupported Gateway versions are not silently
recreated or presumed recoverable.

Recovery only reconnects, reads and resubscribes. It never calls `sessions.create`,
`chat.send`, `sessions.compact`, `chat.abort` or native `sessions.recover`.
OpenClaw's own `sessions.recover` creates a fresh identity and starts a continuation;
that is not Phonon's observational recovery contract. Passive candidate teardown
does not abort native work. Owned interrupts include the native run ID.

New Gateway sessions declare the authorized project `cwd` with worktrees disabled.
Native chat/recovered sends recheck identity, cwd and model, then bind `sessionId`
and `expectedLeafEntryId` to the native send admission. A native identity/leaf
change can be rejected before another inference. This does not assert a lock
against arbitrary concurrent external Gateway model/configuration edits. Pending
injection is consumed only on native acceptance or a matching native terminal.
Confirmed compaction/model controls refresh the checkpoint without creating a
new conversation. Terminal stopped/failed history is not relabelled task success;
the outer controller checkpoint and unresolved-work checks still govern adoption.

Gateway connections clear stale capabilities/requests on close, fence obsolete
socket events and bound authentication handshakes. Recovery also fences adapter
closure and concurrent claims. No Gateway token enters the persisted checkpoint.
Native recovery is local-Gateway only; remote worker placement is unsupported.

Claude retained recovery remains unsupported. A static nativeSession capability
alone never proves that any adapter can preserve its native history.

## Generic Workflow Compatibility

Generic L3 graph/discussion cursor recovery intentionally retries unfinished
attempts. If its internally cached, non-employee Session cannot be recovered,
that retry creates a NEW Session identity and records
`payload.warn=native_session_replaced_for_retry` with `previousSessionId` in the
node event. Earlier attempt identities, completed routes and speaker results
remain unchanged. This is a new attempt with a fresh context, not restoration of
the previous native conversation. Explicitly bound Sessions, employees and
native-run workflows never use this fallback.

## Native Stop Settlement

`native_stop_settlement_v1` adds optional `nativeStop` observations to Session
metadata/interrupt results and workflow status, events and cancellation results.
Both SDKs preserve these fields. Coordinator `status: cancelled` is a logical
decision, not evidence that the external executor stopped. For a cancelled
native execution, clients must wait for `nativeStop.state: confirmed`; `pending`,
`unknown`, missing proof or an abort acknowledgement cannot authorize a new
attempt or input-queue resume. Already completed/failed workflows retain their
actual outcome instead of being relabelled cancelled by a later stop request.

Each target binds the original Session, optional turn and workflow node, with an
observation time and one of `not_started`, `process_tree_exit`, `native_terminal`
only on confirmed targets. CLI proof requires the supervised process tree to
disappear, not merely its leader, a sent signal or a deadline. Probe uncertainty
remains unconfirmed. Windows has no default process-tree exit proof. OpenClaw
Gateway requires a terminal event for the exact dispatched native run; an abort
RPC reply or another run's terminal is insufficient. A native terminal is the
runtime's end-of-run evidence, not proof that arbitrary remote side effects were
rolled back or that detached external jobs have ended.

Unconfirmed stops retain their workflow lease and block cleanup/resume. Original
turn finals are fenced immediately, but the interrupted final is emitted only
after evidence arrives. Stale callbacks cannot become a late success. Controller
teardown/restart preserves uncertainty rather than assuming that all work died.
Read-only workflow status can reconcile a lost stop event without fabricating
journal sequence numbers, repeating model input or automatically draining queues.

## Evidence Boundary

Maintained tests exercise the actual Codex adapter against an isolated synthetic
CLI subprocess, persisted SQLite close/reopen and recreated protocol connections.
They verify zero CLI starts/stream events during recovery, original thread use on
the next input, pending-context preservation, monotonic sequence, uncertainty,
scope/policy fences and late teardown. Additional tests cover competing stores,
stale observers and a real child-process owner killed before idle adoption.
The Agents HTTP/PostgreSQL/Gateway chain uses a newly prepared maintained daemon
to verify actual daemon stop/start, service recreation, lost recovery response,
read-only reconciliation and separate wait-batch/FIFO resume. Additional coverage
uses the production OpenClaw adapter over a controlled Gateway transport for DE
private/group recovery, retained memory and lost-response reconciliation. Native
model execution is explicitly simulated; this is not a paid provider or phone test.

An opt-in installed-OpenClaw check seeds only an isolated temporary native database
through native SDK APIs. The real native history handler and production adapter
verify identity/active-work refusal without changing session/transcript DB bytes.
It also verifies explicit cwd on native session creation with no initial turn.
No personal Gateway, provider credentials, cron source or plugin is activated.

Agents migration 24 stores frozen recovery requests and current observations.
`GET /native/v1/conversations/:id/sessions/:person/recovery` only inspects native
state. `recoverSession` freezes the native Session ID and observation revision,
rechecks current membership, project/workspace identity, grant and existing work,
and pauses pending inputs. A dispatching/unknown operation is reconciled only by
reading the original Session, never by automatic repeat recovery or task replay.
Successful verification means that original Session was observed attached/idle,
not that an old model attempt completed. Source/grant changes fence publication.
Explicit pending-input resume performs another native idle/identity check.

iOS exposes bilingual connection controls from runtime settings and paused
inputs. It keeps verification, uncertain submissions and queue resume separate;
late account/Session replies cannot retarget the action. Preview controls are
simulations. Codex/Hermes/OpenClaw Gateway have the bounded adapter paths above;
Claude, wider unknown active-attempt reconciliation, account/provider phone use,
signed-device and wider storage/OS/accessibility/downgrade checks remain incomplete.
