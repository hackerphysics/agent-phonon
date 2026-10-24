# Native Chat Transport

`native_chat_workflow_v1` marks support for a durable single-node workflow as a
chat turn. Clients must also require `durable_workflow_dispatch_v1`. A transport
workflow is not a human approval request; agent-produced interactions remain
separate and must never be automatically approved by this mechanism.
See [Native Agent Interactions](NATIVE_INTERACTIONS.md) for the current-turn
channel, typed forms and durable response consumption receipts.

## Session Identity

Use `metadata.native_chat: true`, a UUID `metadata.native_run_id`, and a stable
`clientRequestId`. The first node creates a Session; subsequent turns explicitly
reuse its `sessionId`. Bind `plan.finalNodeId` to the reply node to obtain the
final reply. Native turns retain the Session after completion. Stopping or timing
out a native turn interrupts rather than destroys that Session.

The daemon stamps `nativeRunId` alongside `workflowId` and `nodeId` on native
stream events before sending them. Consumers can correlate output even if the
dispatch acknowledgement has not arrived. Reject identity changes, journal
events before ACK, and ACK only the highest contiguous persisted sequence.

Disconnect/restart pauses native workflows. It does not automatically start a
second model attempt. If acceptance cannot be verified, retain the frozen
request identity and reconcile rather than inventing a new dispatch key.

## Cancellation Before Acceptance

`workflow.dispatch.cancel` accepts `{ dispatchKey, project, reason? }`. It records
a tenant-scoped durable tombstone before looking for the accepted workflow. A
later new `workflow.run` with that dispatch key cannot start. The project must
match the dispatch/tombstone scope. An existing completed workflow remains
completed; cancellation must not rewrite a successful result as cancelled.

- TypeScript: `device.workflow.cancelDispatch({ dispatchKey, project, reason })`.
- Python: `await device.workflow_cancel_dispatch(dispatch_key, project, reason=...)`.

## Stream Repair

`stream.replay` accepts `{ sessionId, fromSeq?, limit? }`, with `limit` bounded to
1,000. It resends only retained, unacknowledged stream frames, scoped to the
connection tenant and the named Session. It does not restart a model, clear the
outbox, or acknowledge any event. Applications needing longer history keep
their own durable journal before ACKing.

- TypeScript: `device.replayStream(sessionId, { fromSeq, limit })`.
- Python: `await device.replay_stream(session_id, fromSeq=..., limit=...)`.

## Input Modes

See [tool-gap input](MID_TURN_INPUT.md) for genuine current-turn insertion. This
requires a capable adapter and `current_turn_input_v1`; native chat support alone
does not imply insertion. Never silently convert insertion into queue/interrupt.
Waiting-message merging and one-message-per-turn FIFO are control-plane
scheduling policies, not new implicit daemon fallbacks.

Manual compression uses the separate durable
[Session Compression](SESSION_COMPRESSION.md) contract. Require
`session_compression_receipts_v1`, freeze the displayed Session identity and
prefer background acknowledgement plus status polling. Pause dependent inputs
until the outcome is verified; an unknown effect must not cause a fresh send or
compression attempt.

Reasoning is an optional first-class per-turn setting, not a system-prompt hint
or global profile mutation. Require `turn_reasoning_v1`, preserve the frozen
node setting, and consume controller-owned native acknowledgements separately
from task results. See [Per-Turn Reasoning](TURN_REASONING.md).

DE-originated versioned plans can use the current-turn
[workflow delegation channel](NATIVE_WORKFLOWS.md). The control plane resolves
canonical workers onto real device workspaces. Child tasks have independent
durable runs and ordinary burner Sessions; they are not group members or new
ordinary human chats. Only the DE writes the final chat reply.

Deterministic coverage: `fn-native-chat.test.ts`, `fn-mid-turn-input.test.ts`,
and Python `test_session_options.py`. These tests do not call a paid model.
