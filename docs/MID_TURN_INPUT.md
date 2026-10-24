# Current-Turn Input

`session.send(whenBusy="inject")` is not an interrupt, a restart, a transcript-only
update, or an implicit queue entry. An idle session starts normally. For a busy
session, the adapter must both advertise `injectMidTurn=true` and implement
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

Mobile waiting batches and FIFO input are separate scheduling requirements.
This contract does not claim that durable waiting batches, pending-input
cancellation, or employee profile provisioning have been added by this change.
