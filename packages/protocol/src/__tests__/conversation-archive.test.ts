import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { ConversationArchiveAppendParams, ConversationArchiveReadParams, ConversationArchiveStatusParams, ConversationArchiveBlobWriteParams, ConversationArchiveBlobReadParams } from "../schemas/conversation-archive.js";

const scope = {conversationId: randomUUID(), archiveEpoch: randomUUID(), projectId: null};
const entry = {sequence: "1", recordId: randomUUID(), kind: "message", entityId: randomUUID(), revision: "1", payloadJSON: '{"text":"original"}'};
const batch = { ...scope, afterSequence: "0", afterHash: "a".repeat(64), entries: [entry] };

test("binary archive bounds sizes/base64 and rejects caller-controlled paths and scope", () => {
  const blob = {...scope, blobId: randomUUID(), sha256: "a".repeat(64), sizeBytes: 1, offset: 0, data: "YQ=="};
  assert.equal(ConversationArchiveBlobWriteParams.safeParse(blob).success, true);
  assert.equal(ConversationArchiveBlobWriteParams.safeParse({...blob, sizeBytes: 20*1024*1024}).success, true);
  for (const changed of [{...blob, file: "/tmp/data"}, {...blob, tenantId: "foreign"}, {...blob, data: "Y Q=="}, {...blob, data: "YQ"}, {...blob, offset: -1}, {...blob, sizeBytes: 20*1024*1024+1}, {...blob, data: "a".repeat(400000)}]) assert.equal(ConversationArchiveBlobWriteParams.safeParse(changed).success, false);
  const {offset: _, data: __, ...manifest} = blob;
  assert.equal(ConversationArchiveBlobReadParams.parse(manifest).offset, 0);
});

test("archive schema rejects gaps, reused IDs, unsafe sequences and caller-controlled identity", () => {
  assert.equal(ConversationArchiveAppendParams.safeParse(batch).success, true);
  for (const changed of [{...batch, tenantId: "another"}, {...batch, authority: "https://other.test"}, {...batch, entries: [{...entry, sequence: "2"}]},
    {...batch, entries: [entry, {...entry, sequence: "2"}]}, {...batch, afterSequence: "01"}, {...batch, afterSequence: "9223372036854775808"}]) assert.equal(ConversationArchiveAppendParams.safeParse(changed).success, false);
  assert.equal(ConversationArchiveStatusParams.safeParse({...scope, file: "/tmp/history"}).success, false);
  assert.equal(ConversationArchiveReadParams.parse(scope).limit, 50);
  assert.equal(ConversationArchiveReadParams.safeParse({...scope, limit: 101}).success, false);
});

test("archive schema bounds actual UTF-8, JSON depth and complete batch size", () => {
  for (const payloadJSON of ["null", "[]", '{"broken":', JSON.stringify({text: "\u4e2d".repeat(400000)}), '{"x":'.repeat(34) + "0" + "}".repeat(34)]) {
    assert.equal(ConversationArchiveAppendParams.safeParse({...batch, entries: [{...entry, payloadJSON}]}).success, false);
  }
  const large = JSON.stringify({text: "x".repeat(800000)});
  const entries = Array.from({length: 6}, (_, n) => ({...entry, sequence: String(n + 1), recordId: randomUUID(), payloadJSON: large}));
  assert.equal(ConversationArchiveAppendParams.safeParse({...batch, entries}).success, false);
});

test("malformed archive decimals return validation errors without throwing during conversion", () => {
  for (const value of ["", "no", "-1", "+1", " 1", "1.2", "1e2", "Infinity", "01", "9".repeat(100)]) {
    assert.equal(ConversationArchiveAppendParams.safeParse({...batch, afterSequence: value}).success, false);
    assert.equal(ConversationArchiveAppendParams.safeParse({...batch, entries: [{...entry, sequence: value}]}).success, false);
    assert.equal(ConversationArchiveAppendParams.safeParse({...batch, entries: [{...entry, revision: value}]}).success, false);
    assert.equal(ConversationArchiveReadParams.safeParse({...scope, afterSequence: value}).success, false);
  }
});
