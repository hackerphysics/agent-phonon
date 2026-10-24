import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { AdapterRegistry, PhononStore, PhononClient, conversationArchiveAuthority } from "@agent-phonon/core";
import { PhononServer, type PhononDevice } from "@agent-phonon/server-sdk";
import { CONVERSATION_ARCHIVE_LIMITS, ConversationArchiveBlobStatusResult, ConversationArchiveBlobReadResult, ConversationArchiveAppendResult, ConversationArchiveReadResult, ConversationArchiveStatusResult, ConversationArchiveEntitiesResult, type ConversationArchiveEntry, type ConversationArchiveScope } from "@agent-phonon/protocol";
import { TestConn } from "./harness.js";

const authority = "https://agents.example.test";
const scope = (): ConversationArchiveScope => ({conversationId: randomUUID(), archiveEpoch: randomUUID(), projectId: randomUUID()});
const entry = (sequence: number, text = "message"): ConversationArchiveEntry => ({sequence: String(sequence), recordId: randomUUID(), kind: "message", entityId: randomUUID(), revision: String(sequence), payloadJSON: JSON.stringify({text, author: "human", receipts: []})});
const denied = (code: string) => (error: any) => error?.data?.appCode === code;
function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "phonon-conversation-archive-")), path = join(root, "device.sqlite");
  const stores: PhononStore[] = [], connections: TestConn[] = [];
  const store = () => { const value = new PhononStore(path); stores.push(value); return value; };
  const connection = (value: PhononStore, options: Partial<ConstructorParameters<typeof TestConn>[0]> = {}) => {
    const tc = new TestConn({registry: new AdapterRegistry(), tenantId: "owner-a", archiveAuthority: authority, workspaceRoot: root, store: value, policy: {allowConversationArchives: true}, ...options});
    connections.push(tc); return tc;
  };
  t.after(async () => { for (const value of connections) await value.conn.dispose(); for (const value of stores) { try { value.close(); } catch {} } rmSync(root, {recursive: true, force: true}); });
  return {root, path, store, connection};
}
async function status(tc: TestConn, target: ConversationArchiveScope) { return ConversationArchiveStatusResult.parse(await tc.call("conversation.archive.status", target)); }
async function append(tc: TestConn, target: ConversationArchiveScope, entries: ConversationArchiveEntry[], previous?: {throughSequence: string; headHash: string}) {
  const before = previous ?? await status(tc, target);
  return ConversationArchiveAppendResult.parse(await tc.call("conversation.archive.append", {...target, afterSequence: before.throughSequence, afterHash: before.headHash, entries}));
}
const indexed = (seq: number, key: string, order: string | null, part = 1, parts = 1, deleted = false): ConversationArchiveEntry => ({...entry(seq), catalog: {collection: "messages", key, order, version: String(seq - part + 1), part, parts, deleted}});

test("indexed archive entities paginate at pinned checkpoints and keep revisions/deletions out of earlier pages", async t => {
  const f = fixture(t), tc = f.connection(f.store()), target = scope();
  await append(tc, target, [indexed(1, "a", "10"), indexed(2, "b", "20"), indexed(3, "c", "30")]);
  const query = async (options = {}) => ConversationArchiveEntitiesResult.parse(await tc.call("conversation.archive.entities", {...target, collection: "messages", ...options}));
  const first = await query({limit: 2}); assert.deepEqual(first.entities.map(value => value.key), ["c", "b"]); assert.deepEqual(first.before, {order: "20", key: "b"});
  await append(tc, target, [indexed(4, "a", "10"), indexed(5, "b", null, 1, 1, true)]);
  const pinned = await query({throughSequence: first.throughSequence}); assert.deepEqual(pinned.entities.map(value => [value.key, value.version]), [["c", "3"], ["b", "2"], ["a", "1"]]);
  assert.deepEqual((await query()).entities.map(value => [value.key, value.version]), [["c", "3"], ["a", "4"]]);
  assert.deepEqual((await query({before: first.before, throughSequence: first.throughSequence})).entities.map(value => value.key), ["a"]);
  assert.equal((await query({key: "a"})).entities[0]!.fromSequence, "4");
  await assert.rejects(append(tc, target, [indexed(6, "a", "11")]), denied("errArchiveConflict"));
  assert.equal((await status(tc, target)).throughSequence, "5");
});

test("indexed snapshot groups are incomplete until all parts commit and reject interleaved or missing parts", async t => {
  const f = fixture(t), value = f.store(), tc = f.connection(value), target = scope();
  await append(tc, target, [indexed(1, "large", "9007199254740993", 1, 3)]);
  const partial = ConversationArchiveEntitiesResult.parse(await tc.call("conversation.archive.entities", {...target, collection: "messages"}));
  assert.equal(partial.incomplete, true); assert.deepEqual(partial.entities, []);
  await assert.rejects(append(tc, target, [entry(2)]), denied("errArchiveGap"));
  await append(tc, target, [indexed(2, "large", "9007199254740993", 2, 3), indexed(3, "large", "9007199254740993", 3, 3)]);
  const complete = ConversationArchiveEntitiesResult.parse(await tc.call("conversation.archive.entities", {...target, collection: "messages"}));
  assert.equal(complete.incomplete, false); assert.equal(complete.entities[0]!.throughSequence, "3"); assert.equal(complete.entities[0]!.parts, 3);
  await tc.conn.dispose(); value.close();
  const db = new DatabaseSync(f.path + ".conversations.sqlite"); db.prepare("DELETE FROM conversation_archive_parts WHERE part=2").run(); db.close();
  await assert.rejects(f.connection(f.store()).call("conversation.archive.entities", {...target, collection: "messages"}), denied("errArchiveIntegrity"));
});

test("archive v1 migration retains every original record/hash and does not invent indexes for unindexed history", async t => {
  const f = fixture(t), value = f.store(), tc = f.connection(value), target = scope();
  const original = entry(1), before = await append(tc, target, [original]); await tc.conn.dispose(); value.close();
  const legacy = new DatabaseSync(f.path + ".conversations.sqlite");
  legacy.exec("DROP TABLE conversation_archive_blob_chunks; DROP TABLE conversation_archive_blobs; DROP TABLE conversation_archive_parts; ALTER TABLE conversation_archives DROP COLUMN indexed_parts; PRAGMA user_version=1"); legacy.close();
  const next = f.connection(f.store()); assert.equal((await status(next, target)).headHash, before.headHash);
  const empty = ConversationArchiveEntitiesResult.parse(await next.call("conversation.archive.entities", {...target, collection: "messages"})); assert.deepEqual(empty.entities, []);
  const page = ConversationArchiveReadResult.parse(await next.call("conversation.archive.read", target)); assert.equal(page.entries[0]!.recordId, original.recordId);
  await append(next, target, [indexed(2, "original", "1")]);
  assert.equal(ConversationArchiveEntitiesResult.parse(await next.call("conversation.archive.entities", {...target, collection: "messages"})).entities.length, 1);
});

test("archive survives store/controller restart and delivery ACKs without creating Agent Sessions", async t => {
  const f = fixture(t), target = scope(), firstStore = f.store(), tc = f.connection(firstStore);
  const first = entry(1, "human original"), second = {...entry(2, "DE reply"), payloadJSON: JSON.stringify({text: "DE reply", author: "assistant", senderID: "de-one", mentionIDs: ["de-two"]})};
  const receipt = await append(tc, target, [first, second]);
  assert.equal(receipt.persistent, true); assert.equal(receipt.committedThrough, "2");
  firstStore.outboxAdd("owner-a", "native-session", 0, '{"text":"transient"}', new Date().toISOString());
  firstStore.outboxAck("owner-a", "native-session", 0);
  assert.deepEqual(firstStore.outboxLoad("owner-a"), []);
  await tc.conn.dispose(); firstStore.close();
  const retained = f.store(), restarted = f.connection(retained), page = ConversationArchiveReadResult.parse(await restarted.call("conversation.archive.read", target));
  assert.deepEqual(page.entries.map(({previousHash, hash, ...value}) => value), [first, second]);
  assert.equal((await status(restarted, target)).headHash, receipt.headHash);
  assert.equal(statSync(f.path + ".conversations.sqlite").mode & 0o777, 0o600);
  assert.deepEqual(retained.listAllSessions(), []); assert.deepEqual(restarted.streamEvents, []);
  const info = await restarted.call("device.info", {}) as {capabilities: string[]}; assert.ok(info.capabilities.includes("conversation_archive_v1"));
});

test("archive replays only identical frozen records, accepts a contiguous overlap and rolls back conflicting batches", async t => {
  const f = fixture(t), tc = f.connection(f.store()), target = scope(), initial = await status(tc, target), entries = [entry(1), entry(2), entry(3), entry(4)];
  const first = await append(tc, target, entries.slice(0, 2)), second = await append(tc, target, entries.slice(2), first);
  const replay = await append(tc, target, entries.slice(0, 2), initial);
  assert.equal(replay.replayed, true); assert.equal(replay.throughSequence, "4"); assert.equal(replay.committedThrough, "2"); assert.equal(replay.committedHash, first.headHash);
  await assert.rejects(append(tc, target, [{...entries[0]!, payloadJSON: '{"text":"changed"}'}], initial), denied("errArchiveConflict"));
  const fifth = entry(5);
  await assert.rejects(append(tc, target, [fifth, {...entry(6), recordId: entries[0]!.recordId}], second), denied("errArchiveConflict"));
  assert.equal((await status(tc, target)).throughSequence, "4");
  const overlap = await append(tc, target, [...entries.slice(2), fifth], first);
  assert.equal(overlap.throughSequence, "5"); assert.equal(overlap.replayed, false);
  assert.equal((await append(tc, target, [fifth], second)).replayed, true);
});

test("archive rejects gaps, changed epochs/project scope, foreign identities and forged anchors", async t => {
  const f = fixture(t), tc = f.connection(f.store()), target = scope(), one = entry(1), initial = await status(tc, target);
  await assert.rejects(tc.call("conversation.archive.append", {...target, afterSequence: "1", afterHash: initial.headHash, entries: [entry(2)]}), denied("errArchiveGap"));
  assert.equal((await status(tc, target)).found, false);
  const head = await append(tc, target, [one]);
  for (const changed of [{...target, archiveEpoch: randomUUID()}, {...target, projectId: null}]) await assert.rejects(status(tc, changed), denied("errArchiveIdentityChanged"));
  await assert.rejects(append(tc, target, [entry(2)], {...head, headHash: "0".repeat(64)}), denied("errArchiveGap"));
  await assert.rejects(tc.call("conversation.archive.status", {...target, tenantId: "owner-b"}), denied("errInvalidParams"));
  await assert.rejects(tc.call("conversation.archive.read", {...target, afterSequence: "2"}), denied("errArchiveGap"));
});

test("archive isolates configured service authorities as well as tenants", async t => {
  const f = fixture(t), store = f.store(), a = f.connection(store), b = f.connection(store, {archiveAuthority: "https://other.example.test"}), otherUser = f.connection(store, {tenantId: "owner-b"}), target = scope();
  await append(a, target, [entry(1, "a private")]);
  for (const value of [b, otherUser]) {
    assert.equal((await status(value, target)).found, false);
    await assert.rejects(value.call("conversation.archive.read", target), denied("errArchiveNotFound"));
  }
  await append(b, target, [entry(1, "b private")]);
  assert.notEqual((await status(a, target)).headHash, (await status(b, target)).headHash);
  assert.equal(conversationArchiveAuthority("wss://AGENTS.example.test"), authority);
  for (const unsafe of ["http://remote.example.test", "https://a.test/path", "https://a.test?token=value", "https://user:password@a.test", "file:///tmp/history"]) assert.equal(conversationArchiveAuthority(unsafe), undefined);
});

test("archive requires explicit local policy, method access, persistent storage and configured connection identity", async t => {
  const f = fixture(t), value = f.store(), target = scope();
  const disabled = f.connection(value, {policy: {}});
  await assert.rejects(status(disabled, target), denied("errPolicyDenied"));
  const info = await disabled.call("device.info", {}) as {capabilities: string[]}; assert.ok(!info.capabilities.includes("conversation_archive_v1"));
  const readonly = f.connection(value, {policy: {allowConversationArchives: true, allowedMethods: ["conversation.archive.status"]}});
  const head = await status(readonly, target);
  await assert.rejects(append(readonly, target, [entry(1)], head), denied("errPolicyDenied"));
  const missingOrigin = f.connection(value, {archiveAuthority: undefined});
  await assert.rejects(status(missingOrigin, target), denied("errArchiveUnavailable"));
  const memory = new PhononStore(":memory:");
  const transient = f.connection(memory);
  try { await assert.rejects(status(transient, target), denied("errArchiveUnavailable")); } finally { await transient.conn.dispose(); memory.close(); }
});

test("archive capacity refuses new writes atomically but does not delete history or reject an exact replay", async t => {
  const f = fixture(t), value = f.store(), tc = f.connection(value), target = scope(), one = entry(1), before = await status(tc, target), first = await append(tc, target, [one]);
  const limited = f.connection(value, {policy: {allowConversationArchives: true, maxConversationArchiveBytes: first.payloadBytes}});
  await assert.rejects(append(limited, target, [entry(2)]), denied("errArchiveCapacity"));
  assert.equal((await status(tc, target)).headHash, first.headHash); assert.equal((await append(limited, target, [one], before)).replayed, true);
  assert.equal(ConversationArchiveReadResult.parse(await tc.call("conversation.archive.read", target)).entries.length, 1);
});

test("archive range pages pin their upper checkpoint and never silently skip a missing/corrupt record", async t => {
  const f = fixture(t), value = f.store(), tc = f.connection(value), target = scope(), entries = Array.from({length: 4}, (_, n) => entry(n + 1));
  const head = await append(tc, target, entries), first = ConversationArchiveReadResult.parse(await tc.call("conversation.archive.read", {...target, limit: 2}));
  await append(tc, target, [entry(5)], head);
  const second = ConversationArchiveReadResult.parse(await tc.call("conversation.archive.read", {...target, afterSequence: first.nextAfterSequence, afterHash: first.entries.at(-1)!.hash, throughSequence: first.throughSequence}));
  assert.deepEqual(second.entries.map(row => row.sequence), ["3", "4"]); assert.equal(second.nextAfterSequence, undefined); assert.equal(second.headHash, first.headHash);
  await tc.conn.dispose(); value.close();
  const corrupt = new DatabaseSync(f.path + ".conversations.sqlite");
  corrupt.prepare("UPDATE conversation_archive_entries SET document=? WHERE seq=2").run(JSON.stringify({...entries[1], payloadJSON: '{"text":"corrupt"}'})); corrupt.close();
  const reopened = f.connection(f.store());
  await assert.rejects(reopened.call("conversation.archive.read", target), denied("errArchiveIntegrity"));
});

test("archive limits response bytes without truncating records or losing the next cursor", async t => {
  const f = fixture(t), tc = f.connection(f.store()), target = scope();
  for (let n = 1; n <= 3; n++) await append(tc, target, [{...entry(n), payloadJSON: JSON.stringify({text: "\\".repeat(350000)})}]);
  const page = ConversationArchiveReadResult.parse(await tc.call("conversation.archive.read", {...target, limit: 100}));
  assert.equal(page.entries.length, 2); assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 4 * 1024 * 1024); assert.equal(page.nextAfterSequence, "2");
  const last = ConversationArchiveReadResult.parse(await tc.call("conversation.archive.read", {...target, afterSequence: page.nextAfterSequence, afterHash: page.entries.at(-1)!.hash, throughSequence: page.throughSequence}));
  assert.equal(last.entries.length, 1); assert.equal(last.entries[0]!.sequence, "3"); assert.equal(last.nextAfterSequence, undefined);
});

test("archive refuses a missing intermediate row and an unsupported on-disk format without replacing data", async t => {
  const f = fixture(t), value = f.store(), tc = f.connection(value), target = scope();
  await append(tc, target, [entry(1), entry(2), entry(3)]);
  await tc.conn.dispose(); value.close();
  const db = new DatabaseSync(f.path + ".conversations.sqlite");
  db.prepare("DELETE FROM conversation_archive_entries WHERE seq=2").run(); db.close();
  const nextStore = f.store(), next = f.connection(nextStore);
  await assert.rejects(next.call("conversation.archive.read", target), denied("errArchiveIntegrity"));
  await next.conn.dispose(); nextStore.close();
  const future = new DatabaseSync(f.path + ".conversations.sqlite"); future.exec("PRAGMA user_version=99"); future.close();
  const unsupported = f.connection(f.store());
  await assert.rejects(status(unsupported, target), denied("errArchiveUnavailable"));
  const preserved = new DatabaseSync(f.path + ".conversations.sqlite");
  assert.equal(preserved.prepare("PRAGMA user_version").get()!.user_version, 99);
  assert.equal(preserved.prepare("SELECT count(*) n FROM conversation_archive_entries").get()!.n, 2); preserved.close();
});

test("TypeScript SDK archives over the actual authenticated WebSocket without invoking an Agent", {timeout: 15000}, async t => {
  const root = mkdtempSync(join(tmpdir(), "phonon-archive-websocket-"));
  const server = new PhononServer({host: "127.0.0.1", port: 0, authenticate: (_id, key) => key === "synthetic-archive-key" ? {tenantId: "archive-owner"} : null});
  let device: PhononDevice | undefined;
  server.on("device", value => { device = value; });
  const port = await server.listen(), client = new PhononClient({serverUrl: `ws://127.0.0.1:${port}`, deviceId: "archive-device", deviceKey: "synthetic-archive-key", expectedTenantId: "archive-owner", registry: new AdapterRegistry(), workspaceRoot: root, dbPath: join(root, "device.sqlite"), policy: {allowConversationArchives: true}});
  t.after(async () => { client.close(); await server.close(); rmSync(root, {recursive: true, force: true}); });
  await client.connect(); assert.ok(device);
  const target = scope(), initial = await device.conversationArchive.status(target), original = entry(1, "SDK original");
  const committed = await device.conversationArchive.append({...target, afterSequence: "0", afterHash: initial.headHash, entries: [original]});
  const read = await device.conversationArchive.read(target);
  assert.equal(committed.committedThrough, "1"); assert.equal(read.entries[0]!.recordId, original.recordId); assert.deepEqual(await device.listSessions(), {sessions: []});
  await device.conversationArchive.append({...target, afterSequence: "1", afterHash: committed.headHash, entries: [indexed(2, "message", "1")]});
  const entities = await device.conversationArchive.entities({...target, collection: "messages"}); assert.equal(entities.entities[0]!.key, "message");
  const bytes = randomBytes(179), blob = {...target, blobId: randomUUID(), sha256: createHash("sha256").update(bytes).digest("hex"), sizeBytes: bytes.length};
  assert.equal((await device.conversationArchive.blob.status(blob)).found, false);
  assert.equal((await device.conversationArchive.blob.write({...blob, offset: 0, data: bytes.toString("base64")})).complete, true);
  assert.deepEqual(Buffer.from((await device.conversationArchive.blob.read(blob)).data, "base64"), bytes);
});

const chunkBytes = CONVERSATION_ARCHIVE_LIMITS.blobChunkBytes;
const blobManifest = (target: ConversationArchiveScope, bytes: Buffer) => ({...target, blobId: randomUUID(), sha256: createHash("sha256").update(bytes).digest("hex"), sizeBytes: bytes.length});
const putBlob = async (tc: TestConn, blob: ReturnType<typeof blobManifest>, bytes: Buffer, offset = 0) => ConversationArchiveBlobStatusResult.parse(await tc.call("conversation.archive.blob.write", {...blob, offset, data: bytes.subarray(offset, offset + chunkBytes).toString("base64")}));

test("binary archive persists raw BLOB chunks, resumes after restart and never exposes incomplete content", async t => {
  const f = fixture(t), value = f.store(), tc = f.connection(value), target = scope(), bytes = randomBytes(chunkBytes * 2 + 173), blob = blobManifest(target, bytes);
  await append(tc, target, [entry(1)]);
  assert.equal((await putBlob(tc, blob, bytes)).receivedBytes, chunkBytes);
  await assert.rejects(tc.call("conversation.archive.blob.read", blob), denied("errArchiveGap"));
  await tc.conn.dispose(); value.close();
  const retained = f.store(), next = f.connection(retained);
  assert.equal(ConversationArchiveBlobStatusResult.parse(await next.call("conversation.archive.blob.status", blob)).complete, false);
  assert.equal((await putBlob(next, blob, bytes)).receivedBytes, chunkBytes);
  assert.equal((await putBlob(next, blob, bytes, chunkBytes)).complete, false);
  assert.equal((await putBlob(next, blob, bytes, chunkBytes * 2)).complete, true);
  assert.equal((await putBlob(next, blob, bytes)).complete, true);
  const chunks: Buffer[] = []; let offset = 0;
  do {
    const page = ConversationArchiveBlobReadResult.parse(await next.call("conversation.archive.blob.read", {...blob, offset}));
    chunks.push(Buffer.from(page.data, "base64")); offset = page.nextOffset ?? -1;
  } while (offset !== -1);
  assert.deepEqual(Buffer.concat(chunks), bytes); assert.deepEqual(retained.listAllSessions(), []); assert.deepEqual(next.streamEvents, []);
  const db = new DatabaseSync(f.path + ".conversations.sqlite");
  assert.equal(db.prepare("SELECT sum(length(data)) n FROM conversation_archive_blob_chunks").get()!.n, bytes.length);
  assert.equal(db.prepare("SELECT typeof(data) t FROM conversation_archive_blob_chunks LIMIT 1").get()!.t, "blob"); db.close();
});

test("binary archive rejects changed manifests, gaps, conflicting retries and whole-file checksum mismatches atomically", async t => {
  const f = fixture(t), tc = f.connection(f.store()), target = scope(), bytes = randomBytes(chunkBytes + 7), blob = blobManifest(target, bytes);
  await assert.rejects(putBlob(tc, blob, bytes), denied("errArchiveNotFound"));
  await append(tc, target, [entry(1)]);
  await assert.rejects(putBlob(tc, blob, bytes, chunkBytes), denied("errArchiveGap"));
  await putBlob(tc, blob, bytes);
  await assert.rejects(putBlob(tc, {...blob, sha256: "a".repeat(64)}, bytes), denied("errArchiveConflict"));
  const bad = Buffer.from(bytes); bad[0] = bad[0]! ^ 255;
  await assert.rejects(putBlob(tc, blob, bad), denied("errArchiveConflict"));
  bad[chunkBytes] = bad[chunkBytes]! ^ 255;
  await assert.rejects(putBlob(tc, blob, bad, chunkBytes), denied("errArchiveIntegrity"));
  assert.equal(ConversationArchiveBlobStatusResult.parse(await tc.call("conversation.archive.blob.status", blob)).receivedBytes, chunkBytes);
  assert.equal((await putBlob(tc, blob, bytes, chunkBytes)).complete, true);
});

test("binary archive isolates authorities/tenants/epochs/projects and enforces method policy", async t => {
  const f = fixture(t), value = f.store(), tc = f.connection(value), target = scope(), bytes = Buffer.from("private"), blob = blobManifest(target, bytes);
  await append(tc, target, [entry(1)]); await putBlob(tc, blob, bytes);
  for (const other of [f.connection(value, {tenantId: "owner-b"}), f.connection(value, {archiveAuthority: "https://other.test"})]) {
    assert.equal(ConversationArchiveBlobStatusResult.parse(await other.call("conversation.archive.blob.status", blob)).found, false);
    await assert.rejects(other.call("conversation.archive.blob.read", blob), denied("errArchiveNotFound"));
  }
  for (const changed of [{...blob, archiveEpoch: randomUUID()}, {...blob, projectId: null}]) await assert.rejects(tc.call("conversation.archive.blob.read", changed), denied("errArchiveIdentityChanged"));
  const disabled = f.connection(value, {policy: {}}), readOnly = f.connection(value, {policy: {allowConversationArchives: true, allowedMethods: ["conversation.archive.blob.read"]}});
  await assert.rejects(disabled.call("conversation.archive.blob.read", blob), denied("errPolicyDenied"));
  await assert.rejects(putBlob(readOnly, blob, bytes), denied("errPolicyDenied"));
  assert.equal(ConversationArchiveBlobReadResult.parse(await readOnly.call("conversation.archive.blob.read", blob)).data, bytes.toString("base64"));
});

test("binary archive shares the document quota, reserves incomplete bytes and handles empty/max-size files", async t => {
  const f = fixture(t), value = f.store(), tc = f.connection(value), target = scope(), head = await append(tc, target, [entry(1)]), empty = blobManifest(target, Buffer.alloc(0));
  const limited = f.connection(value, {policy: {allowConversationArchives: true, maxConversationArchiveBytes: head.payloadBytes + 512}});
  assert.equal((await putBlob(limited, empty, Buffer.alloc(0))).complete, true);
  assert.equal((await putBlob(limited, empty, Buffer.alloc(0))).complete, true);
  assert.equal(ConversationArchiveBlobReadResult.parse(await limited.call("conversation.archive.blob.read", empty)).data, "");
  await assert.rejects(append(limited, target, [entry(2)]), denied("errArchiveCapacity"));
  const bytes = randomBytes(CONVERSATION_ARCHIVE_LIMITS.blobBytes), blob = blobManifest(target, bytes);
  await assert.rejects(putBlob(limited, blob, bytes), denied("errArchiveCapacity"));
  for (let offset = 0; offset < bytes.length; offset += chunkBytes) await putBlob(tc, blob, bytes, offset);
  assert.equal(ConversationArchiveBlobStatusResult.parse(await tc.call("conversation.archive.blob.status", blob)).complete, true);
  const page = ConversationArchiveBlobReadResult.parse(await tc.call("conversation.archive.blob.read", {...blob, offset: bytes.length - chunkBytes}));
  assert.deepEqual(Buffer.from(page.data, "base64"), bytes.subarray(-chunkBytes)); assert.equal(page.nextOffset, undefined);
});

test("binary archive reports damaged/missing chunks rather than returning a saved success", async t => {
  const f = fixture(t), value = f.store(), tc = f.connection(value), target = scope(), bytes = randomBytes(chunkBytes + 11), blob = blobManifest(target, bytes);
  await append(tc, target, [entry(1)]); await putBlob(tc, blob, bytes); await putBlob(tc, blob, bytes, chunkBytes);
  await tc.conn.dispose(); value.close();
  const db = new DatabaseSync(f.path + ".conversations.sqlite"); db.prepare("UPDATE conversation_archive_blob_chunks SET data=? WHERE offset=0").run(Buffer.alloc(chunkBytes)); db.close();
  const next = f.connection(f.store());
  await assert.rejects(next.call("conversation.archive.blob.read", blob), denied("errArchiveIntegrity"));
  await assert.rejects(next.call("conversation.archive.blob.status", blob), denied("errArchiveIntegrity"));
});
