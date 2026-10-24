# Durable Phonon Conversation Archives

The `conversation_archive_v1` device capability provides normalized Phonon
history storage independent of Agent Sessions and the delivery outbox. The
server calls `conversation.archive.append`, `.read`, `.status` and, when
`conversation_archive_entities_v1` is advertised, `.entities` over its
existing authenticated connection. None of these methods invokes an Agent,
starts a Session, sends a prompt or resumes pending work.

This is a device/SDK foundation, not an automatic replication or cloud-retention
service. Native Agent transcripts do not contain every Phonon group message,
board revision, workflow, approval or delivery receipt. The control plane must
produce and persist those normalized records separately.

## Explicit Local Authorization

The device requires all of the following:

- A persistent `dbPath`; an in-memory store cannot acknowledge durable history.
- Local `policy.allowConversationArchives: true` (default false, including
  `trustLocal` configurations).
- Access to the requested method through the existing `allowedMethods` policy.
- A bound service authority derived from the configured WebSocket origin, not
  from RPC parameters. Remote authorities require TLS; HTTP is loopback-only.

For a server entry's local policy, for example:

```json
{
  "policy": {
    "allowConversationArchives": true,
    "maxConversationArchiveBytes": 10737418240
  }
}
```

The capability advertises configured support, not a disk health certificate.
The server must still handle failed operations. The quota defaults to 10 GiB of
serialized entry documents plus reserved binary bytes (and 512 bytes per blob)
per authority/tenant, across its conversations. Incomplete blobs reserve their
whole declared size, so interrupted uploads cannot exceed the same quota.
Indexes, SQLite pages and WAL consume additional space; this is not an exact
filesystem-size limit. Writes also check free-disk headroom. At capacity the
device refuses new writes atomically, without evicting old history. Exact
replays that add no bytes remain possible.

The lazy SQLite sidecar is `<device-db-path>.conversations.sqlite`, with WAL,
`synchronous=FULL`, private file permissions and transactional updates. It rejects
symlinks, foreign file ownership and unsupported/nonempty foreign formats. It
does not replace an unrecognized database. Delivery ACKs and Session transcript
pruning do not delete this sidecar. Disk loss or corruption still requires the
owner's backup; "permanent" means no automatic TTL, not indestructible storage.

## Scope And Immutable Records

All requests carry `conversationId`, `archiveEpoch` and nullable `projectId`.
UUIDs normalize to lowercase. A private DE conversation uses `projectId: null`;
it must not invent a project merely for storage. Keys additionally include the
configured service authority and authenticated tenant. RPC callers cannot
supply tenant, authority or filesystem paths. The control plane remains
responsible for current conversation/project/member authorization before
exposing these APIs to users.

Once created, an archive's epoch and project cannot change through these
methods. A changed binding returns `errArchiveIdentityChanged`. Archive-device
migration needs a separately verified copy/switch protocol; there is no migration
or force-reset RPC in this version.

Each record contains:

| Field | Contract |
| --- | --- |
| `sequence` | Contiguous per-conversation decimal string, starting at `"1"` |
| `recordId` | Immutable UUID, unique within that conversation archive |
| `kind` | `conversation`, `message`, `board`, `run`, `runEvent`, `request`, `workflow`, `attachment` or `tombstone` |
| `entityId` | Stable control-plane entity ID, not a local path |
| `revision` | Positive decimal string for the entity revision |
| `payloadJSON` | Frozen JSON-object text, at most 1 MiB UTF-8, with bounded depth/node count |
| `catalog` | Optional immutable collection/key/order/version/fragment/tombstone index, described below |

Sequence/cursor values are canonical int64 decimal strings, never JavaScript
numbers. Changed content or revisions append new records with new record IDs;
they do not rewrite prior records. Attachment records describe metadata only;
binary content uses the separate scoped blob capability below.

## Durable Binary Attachments

`conversation_archive_blobs_v1` adds `conversation.archive.blob.write`, `.status`
and `.read`, exposed as `device.conversationArchive.blob` in TypeScript and
`conversation_archive_blob_write/status/read` in Python. The same policy,
method allowlist, configured authority and tenant checks apply. Schema 3 adds
BLOB chunk tables to the private SQLite sidecar; base64 is only a wire encoding,
not the permanent format. Existing normalized records and hashes are unchanged.

Every call includes the archive scope and immutable `blobId` (UUID), `sha256`
and `sizeBytes` (0 through 20 MiB). An archive must already contain a committed
record before its first binary write. A changed manifest conflicts; changed
epoch/project fails the same identity checks as document reads. Callers cannot
choose a path or access another authority/tenant's blob.

`write` takes `offset` and canonical base64 `data`: contiguous fixed 256 KiB
chunks, except the final shorter chunk. A zero-byte file is written with offset
0 and empty data. Identical retries return the current receipt; changed bytes
and gaps fail atomically. Receipts include `persistent`, `found`, `complete`
and `receivedBytes`. On the final chunk the device rechecks the entire byte
count, chunk order and SHA-256 in the committing transaction. A failed checksum
does not commit that final chunk or claim completion. Partial state survives
restart; `status` verifies stored chunks before reporting the resume offset.

`read` accepts a chunk-aligned `offset` (default 0), returns canonical base64
and optional `nextOffset`. It refuses incomplete blobs and checks the selected
chunk's stored digest. Zero-byte files have no chunk rows. The reader must
verify the full downloaded length and SHA-256, not treat an individual page or
status receipt as a full readback proof. There is no overwrite, automatic
expiry, eviction, source deletion or force-reset method. A control plane must
retain a recovery copy for unfinished transfers and handle capacity errors.

## Checkpoints And Hashes

Hashes are lowercase SHA-256 hex over UTF-8 ECMAScript `JSON.stringify` output.
The genesis input is the exact array:

```text
["phonon-conversation-archive-v1", authority, tenantId, conversationId, archiveEpoch, projectId]
```

Each subsequent hash uses:

```text
["phonon-conversation-archive-entry-v1", previousHash, sequence, recordId, kind, entityId, revision, payloadJSON]
```

Legacy entries keep this exact eight-element array. An entry with `catalog`
appends a ninth element, itself this exact array:

```text
["phonon-conversation-entity-index-v1", collection, key, order, version, part, parts, deleted]
```

`order` is a positive decimal string, or null for a deletion; `version` is a
positive decimal string. Fragment `part`/`parts` are bounded one-based integers.
A tombstone uses `deleted: true`, `part: 1`, `parts: 1`. Changing a catalog changes
the entry hash just like changing payload text. Do not add a null ninth element
to an unindexed legacy entry or convert decimal strings to JavaScript numbers.

`conversationArchiveEntryHashInput(previousHash, entry)` is exported from the
protocol package. Cross-language implementations must reproduce that exact
serialization, including escaping. Do not parse/re-serialize `payloadJSON`, sort
its keys or substitute another canonical-JSON format. Hashes bind content/order
to the configured scope; they are not signatures or protection against a
compromised host/control plane.

`status` returns `found`, `throughSequence`, `headHash` and `payloadBytes`.
A missing archive returns `found: false`, sequence `"0"` and its genesis hash,
without creating an empty archive. It is not equivalent to unavailable storage.

`append` accepts `afterSequence`, `afterHash` and 1-32 consecutive entries, at
most 4 MiB serialized parameters. It verifies the anchor and commits the whole
batch or nothing. Identical retries and contiguous overlapping batches are
supported; a gap, conflicting record or reused ID fails without partial writes.

The append receipt has **two distinct checkpoints**:

- `committedThrough` / `committedHash`: the last record in this exact request.
- `throughSequence` / `headHash`: the archive's current head, possibly newer
  when an older batch is retried. `replayed` means no new entries were inserted.

`status` checks the current head; append checks its anchor, overlaps and new
records. Neither walks/reverifies every historical row or referenced file. A
successful RPC or append receipt alone is **not authorization to delete the
server's only copy**. Before retention cleanup, the control plane must verify
its normalized range, hash chain and separately archived file bytes, persist
those proofs and protect unfinished dependencies. No cleanup is implemented
or enabled by this capability.

## Pinned Range Reads

`read` defaults to `afterSequence: "0"` and `limit: 50` (maximum 100). It returns
whole stored entries with `previousHash` / `hash`, subject to a 4 MiB serialized
result budget. It never truncates a record or skips a missing/corrupt one.

The first result pins `throughSequence` / `headHash`. Continue using that same
upper checkpoint, `nextAfterSequence`, and the last returned entry's `hash` as
`afterHash`. Omission of `nextAfterSequence` means that pinned range is complete,
not that no newer records exist. Persist each validated page and its cursor
atomically; a missing archive is `errArchiveNotFound`, not successful empty
history. Reads verify the selected entries/links, not rows outside that range.

```ts
const scope = { conversationId, archiveEpoch, projectId: null };
const before = await device.conversationArchive.status(scope);
const receipt = await device.conversationArchive.append({
  ...scope, afterSequence: before.throughSequence, afterHash: before.headHash,
  entries: frozenContiguousBatch,
});
let page = await device.conversationArchive.read(scope);
await persistVerifiedPageAndCursor(page);
while (page.nextAfterSequence) {
  page = await device.conversationArchive.read({
    ...scope, afterSequence: page.nextAfterSequence,
    afterHash: page.entries.at(-1)!.hash, throughSequence: page.throughSequence,
  });
  await persistVerifiedPageAndCursor(page);
}
```

Python exposes the equivalent dictionary-based calls without changing decimal
strings or the frozen payload:

```python
before = await device.conversation_archive_status(scope)
receipt = await device.conversation_archive_append({
    **scope, "afterSequence": before["throughSequence"],
    "afterHash": before["headHash"], "entries": frozen_contiguous_batch,
})
page = await device.conversation_archive_read(scope)
```

The example persistence/verification functions are control-plane responsibilities,
not SDK-provided storage or a completed server backfill implementation.

## Indexed Entity Reads

`entities` accepts scope, `collection`, optional fixed `throughSequence`, optional
`before: {order, key}`, optional exact `key`, and `limit` (default 50, maximum
100). It selects the latest indexed version of each entity at that checkpoint,
excludes tombstones and orders by logical `order`/`key` descending, independently
of archive transport sequence. It returns `throughSequence`, `headHash`,
`incomplete`, `entities` and an optional next `before` position.

Each entity reference includes key/order/version, fragment count, stored byte
count and its `fromSequence`/`throughSequence`/`previousHash`/`hash` range. Fetch
that range through `read`, verify every hash, scope and catalog fragment, then
assemble and parse the application snapshot. This index is not a parsed message
API and cannot replace payload verification. `incomplete: true` is not permission
to skip a missing fragment or declare the selected history complete.

The sidecar upgrades schema 1 to 2 transactionally without changing old payloads,
record IDs or hashes. Old entries are not inferred into the index; the control
plane must append an explicit indexed backfill before claiming complete coverage.
Lost index rows, conflicting orders and malformed part groups fail integrity
checks. Neither schema upgrade nor index reads delete old history.

```ts
const page = await device.conversationArchive.entities({
  ...scope, collection: "messages", throughSequence: checkpoint.throughSequence,
});
```

```python
page = await device.conversation_archive_entities({
    **scope, "collection": "messages", "throughSequence": checkpoint["throughSequence"],
})
```

## Errors And Remaining Integration

Application codes include `errPolicyDenied`, `errInvalidParams`,
`errArchiveUnavailable`, `errArchiveNotFound`, `errArchiveIdentityChanged`,
`errArchiveGap`, `errArchiveConflict`, `errArchiveIntegrity` and
`errArchiveCapacity`. Do not convert these to an empty chat, advance a cursor on
failure or recreate a Session to repair missing history.

Still required in Phonon Work: durable normalized replication/backfill, archive
device/epoch routing, current authorization on history requests/results, verified
receipts, attachment copies, iOS SQLite/Web IndexedDB local-first range sync,
bounded quotas/deduplication and recovery-tested retention. An offline archive
computer may leave uncached history temporarily unavailable. Existing local and
server-hot copies can still be read. There is no permanent cloud-backup promise.
