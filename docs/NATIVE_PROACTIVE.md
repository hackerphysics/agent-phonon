# Native Proactive Observations

This channel delivers actual native-harness assistant updates into an existing DE
private/group Session. It is not a fake human turn, a new worker dispatch, task
success, approval, or a capability to reuse an ended turn's tools. Rich off-turn
workflow/interaction/board/document control remains separate work.

## Producer And Identity

- A retained Session must already belong to a real employee profile and native
  conversation run. Ordinary Agents and burner workers do not become DE senders.
- Device capability `native_proactive_output_v1` and actual adapter subscription
  readiness are distinct. Session metadata exposes `streamNextSeq` and
  `proactive:{supported,ready,errorCode?}`. An old/unsupported device never becomes
  listening just because its preference was enabled.
- OpenClaw Gateway preserves the native `runId` as `sourceEventId`, reports a
  subscription ready only after acknowledgement on its current connection epoch,
  and can resubscribe on a later normal send. One-shot OpenClaw CLI and current
  Hermes adapters do not claim independent output support. Wider reconnect/
  reattachment validation remains necessary; no personal plugin is activated.
- Controllers remember their own upstream run IDs durably. Repeated/late finals
  of a requested, stopped or failed turn cannot masquerade as independent output.
  Only bounded, non-delta assistant text with a native event ID is admitted.
- Core overwrites producer-selected identities. A native observation has
  `origin=unsolicited`, `sourceEventId`, and controller-stamped `nativeProactive`
  containing `anchorRunId`, `employeeId`, `employeeRevision`, `upstreamId`,
  `project`, `agent`, and `model`. It does not inherit top-level `nativeRunId`,
  `workflowId` or old task/node attribution. The anchor locates the existing
  Session; it does not reactivate that run or its callbacks.

## Durability And Authority

SQLite commits observation deduplication, outbox bytes and Session sequence in
one transaction. Native IDs remain deduplicated after ACK/replay; conflicting
contents produce a source error rather than replacing an earlier observation.
All Session streams share one sequence, including ordinary requested output.

The control plane checks the authenticated device/owner, retained Session,
current DE membership/profile, immutable workspace and current native grant.
Registry admission requires current read access. Existing native callbacks keep
their stronger active-turn checks. The observation itself cannot select another
chat, sender, method, approval target or mention recipient.

Proactive and requested frames share one committed contiguous ACK cursor. A
later update or task frame never ACKs over an unknown lower sequence. Pending
observations recheck local grant/member/preference/profile/binding facts when
the gap drains. Scope-rejected observations retain hashes/provenance but no
publishable body; historical reads, artifacts and notification dispatch still
check current project access.

Both SDKs accept reliable stream consumers returning `True`/`true` or
`{ackSeq: proven_cursor}` and await persistence before ACK. Invalid, unsafe or
below-frame cursors fail without ACK. Reserved proactive frames never fall back
to ordinary Session auto-ACK; an absent consumer is not success. Existing method
count remains 100.

## Mobile Controls

Each DE context reports its desired preference, revision, actual listener state
and last update. Disabling does not stop the native employee or undo old work.
Enabling/reauthorizing samples the actual next stream sequence, so older held
output cannot become new authorized mail after the switch changes. Removing a
DE fences its old source even if it is later re-added; explicit authorization or
a new legitimate human turn establishes a fresh observation boundary.

Chat renders an update with the actual DE and native observation time, without a
fake task or tool log. The service limits a body to 64 KiB and keeps a short chat
excerpt plus owner/project-authorized full-text artifact. Mentions in prose do
not route other DEs or create relay work. Long-lived native login renewal stays
owned by Auth/Agents, not this device protocol.

Local deterministic adapter/HTTP/PostgreSQL/daemon tests are not proof of a real
provider's native cron, personal Gateway/plugin configuration, physical-phone
delivery or arbitrary device-restart recovery.
