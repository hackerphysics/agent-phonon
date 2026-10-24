# Verified Session Compression

`session_compression_receipts_v1` advertises durable compression receipts. Require
it before treating `session.compress` as a reconciliable operation. Discovery's
`nativeCompression` / `customCompression` describes the adapter; check the live
Session's `compression.native/custom/blocked` for actual availability.

## Requests And Receipts

`session.compress` accepts `{sessionId, mode, clientRequestId?, background?,
strategy?, keepRecentToolCalls?}`. Use a stable unique request ID. Repeating the
same normalized request returns its receipt without another compression; changing
its effect under that ID is rejected. Native mode ignores custom options; custom
defaults to `dropToolIO` and keeps the most recent three tool calls.

Prefer `background: true`: persist the intent and return a `running` receipt,
then call `session.compression.status` with `{sessionId, operationId}`. The default
remains synchronous for compatibility, but waiting on a long inbound RPC can
hold up other requests on that connection. Background acknowledgement is not
completion. Changing only `background` does not change the effect hash.

Receipts are tenant/Session-scoped and include operation/request identities,
agent/model/project, timestamps and a state:

| State | Meaning |
|---|---|
| `running` | Accepted and still owned by an active compression worker |
| `succeeded` | The adapter positively confirmed a change |
| `noop` | The adapter positively confirmed no change was needed |
| `failed` | A recorded failure, not evidence of successful compression |
| `unknown` | The effect cannot be confirmed; do not retry as a new operation |

Optional token observations and file/record/block/byte counts are returned only
when available. Missing usage does not mean zero. A smaller token count is not
required for success, and unavailable usage must not be synthesized. Local backup
paths are never returned in these receipts. Older devices' short result shape is
still parsable but is not sufficient proof for this capability.

## Safety And Recovery

Compression requires a live, settled idle Session, with no queued/settling turn or
overlapping control. Persist intent before invoking the adapter. Sends,
injections, model changes, interruption and termination cannot overlap it; DE
profile updates also cannot race its use of the employee runtime. An unowned
persisted `running` receipt is exposed as `unknown`, including after a restart.
Unknown effects pause the Session and block reuse. There is deliberately no
automatic rerun, clear-unknown button or fabricated reattachment success.

OpenClaw Gateway native compression requires `sessions.compact` to return
`compacted: true`; `false` is `noop`, and absent/ambiguous confirmation is unknown.
Custom compression is available only when an adapter can safely locate its own
Session storage. Current Gateway SQLite transcripts are not edited through an
unsupported private-DB fallback. Hermes uses an observed native Session ID and
its verified profile home (or the trusted isolated DE home), never the default
profile DB or a title lookup. Custom `dropToolIO` preserves user/assistant text,
reasoning and separate memory/persona files; it is not a summary or a reset.

## SDKs

```ts
const receipt = await session.compress("native", {
  clientRequestId: operationId, background: true,
});
const current = await session.compressionStatus(operationId);
```

```python
receipt = await session.compress(
    "custom", clientRequestId=operation_id, background=True,
    strategy="dropToolIO", keepRecentToolCalls=3,
)
current = await session.compression_status(operation_id)
```

The caller owns polling/backoff and must observe a verified terminal receipt
before reporting completion or releasing dependent work. Status reads do not
start a model or another compression. Deterministic tests are in
`fn-session-compression.test.ts` and Python `test_session_options.py` /
`test_e2e.py`; they do not establish live provider or Gateway behavior.
