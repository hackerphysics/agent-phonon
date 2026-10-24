import { z } from "zod";

export const CONVERSATION_ARCHIVE_LIMITS = {
  payloadBytes: 1024 * 1024,
  wireBytes: 4 * 1024 * 1024,
  appendRecords: 32,
  readRecords: 100,
  blobBytes: 20 * 1024 * 1024,
  blobChunkBytes: 256 * 1024,
} as const;

const bytes = (value: string) => new TextEncoder().encode(value).length;
const validSequence = (value: string) => /^(0|[1-9][0-9]{0,18})$/.test(value) && BigInt(value) <= 9223372036854775807n;
const decimal = z.string().refine(validSequence, "expected a canonical nonnegative int64 decimal string");
const positive = decimal.refine(value => value !== "0");
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const uuid = z.string().uuid().transform(value => value.toLowerCase());
const payload = z.string().min(2).max(CONVERSATION_ARCHIVE_LIMITS.payloadBytes).superRefine((value, ctx) => {
  if (bytes(value) > CONVERSATION_ARCHIVE_LIMITS.payloadBytes) { ctx.addIssue({code: z.ZodIssueCode.custom, message: "archive payload exceeds byte budget"}); return; }
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    const pending: Array<[unknown, number]> = [[parsed, 0]];
    let nodes = 0;
    while (pending.length) {
      const [entry, depth] = pending.pop()!;
      if (++nodes > 100000 || depth > 32) throw new Error();
      if (entry && typeof entry === "object") {
        const children = Object.values(entry);
        if (nodes + pending.length + children.length > 100000) throw new Error();
        for (const child of children) pending.push([child, depth + 1]);
      }
    }
  } catch { ctx.addIssue({code: z.ZodIssueCode.custom, message: "archive payload must be a bounded JSON object"}); }
});

export const ConversationArchiveScope = z.object({
  conversationId: uuid,
  archiveEpoch: uuid,
  projectId: uuid.nullable(),
}).strict();
export type ConversationArchiveScope = z.infer<typeof ConversationArchiveScope>;

const indexKey = z.string().min(1).max(192).regex(/^[A-Za-z0-9:._-]+$/);
export const ConversationArchiveEntityIndex = z.object({
  collection: z.string().min(1).max(64).regex(/^[a-z][a-z0-9_-]*$/),
  key: indexKey, order: positive.nullable(), version: positive,
  part: z.number().int().min(1).max(4096), parts: z.number().int().min(1).max(4096), deleted: z.boolean(),
}).strict().refine(value => value.part <= value.parts && (value.deleted ? value.part === 1 && value.parts === 1 : value.order !== null));

export const ConversationArchiveEntry = z.object({
  sequence: positive,
  recordId: uuid,
  kind: z.enum(["conversation", "message", "board", "run", "runEvent", "request", "workflow", "attachment", "tombstone"]),
  entityId: z.string().min(1).max(256).regex(/^[A-Za-z0-9:._-]+$/),
  revision: positive,
  payloadJSON: payload,
  catalog: ConversationArchiveEntityIndex.optional(),
}).strict();
export type ConversationArchiveEntry = z.infer<typeof ConversationArchiveEntry>;
export const ConversationArchiveStoredEntry = ConversationArchiveEntry.extend({previousHash: digest, hash: digest}).strict();

// This exact array serialization is the cross-language hash input. payloadJSON
// is frozen text, not a parsed object whose property order could change.
export function conversationArchiveEntryHashInput(previousHash: string, entry: ConversationArchiveEntry): string {
  const values: unknown[] = ["phonon-conversation-archive-entry-v1", previousHash, entry.sequence, entry.recordId, entry.kind, entry.entityId, entry.revision, entry.payloadJSON];
  if (entry.catalog) { const value = entry.catalog; values.push(["phonon-conversation-entity-index-v1", value.collection, value.key, value.order, value.version, value.part, value.parts, value.deleted]); }
  return JSON.stringify(values);
}

export const ConversationArchiveAppendParams = ConversationArchiveScope.extend({
  afterSequence: decimal,
  afterHash: digest,
  entries: z.array(ConversationArchiveEntry).min(1).max(CONVERSATION_ARCHIVE_LIMITS.appendRecords),
}).strict().superRefine((value, ctx) => {
  if (bytes(JSON.stringify(value)) > CONVERSATION_ARCHIVE_LIMITS.wireBytes) ctx.addIssue({code: z.ZodIssueCode.custom, message: "archive batch exceeds wire budget"});
  if (!validSequence(value.afterSequence) || value.entries.some(entry => !validSequence(entry.sequence))) return;
  const start = BigInt(value.afterSequence);
  if (value.entries.some((entry, n) => BigInt(entry.sequence) !== start + BigInt(n) + 1n)) ctx.addIssue({code: z.ZodIssueCode.custom, message: "archive batch must be contiguous"});
  if (new Set(value.entries.map(entry => entry.recordId)).size !== value.entries.length) ctx.addIssue({code: z.ZodIssueCode.custom, message: "duplicate archive record"});
});
export type ConversationArchiveAppendParams = z.infer<typeof ConversationArchiveAppendParams>;

export const ConversationArchiveStatusParams = ConversationArchiveScope;
export const ConversationArchiveStatusResult = ConversationArchiveScope.extend({
  found: z.boolean(),
  persistent: z.literal(true),
  throughSequence: decimal,
  headHash: digest,
  payloadBytes: z.number().int().nonnegative().safe(),
}).strict();
export type ConversationArchiveStatusResult = z.infer<typeof ConversationArchiveStatusResult>;
export const ConversationArchiveAppendResult = ConversationArchiveStatusResult.extend({
  committedThrough: positive,
  committedHash: digest,
  replayed: z.boolean(),
}).strict();
export type ConversationArchiveAppendResult = z.infer<typeof ConversationArchiveAppendResult>;

export const ConversationArchiveReadParams = ConversationArchiveScope.extend({
  afterSequence: decimal.default("0"),
  afterHash: digest.optional(),
  throughSequence: positive.optional(),
  limit: z.number().int().min(1).max(CONVERSATION_ARCHIVE_LIMITS.readRecords).default(50),
}).strict();
export type ConversationArchiveReadParams = z.infer<typeof ConversationArchiveReadParams>;
export const ConversationArchiveReadResult = ConversationArchiveScope.extend({
  persistent: z.literal(true),
  afterSequence: decimal,
  afterHash: digest,
  throughSequence: positive,
  headHash: digest,
  entries: z.array(ConversationArchiveStoredEntry).max(CONVERSATION_ARCHIVE_LIMITS.readRecords),
  nextAfterSequence: positive.optional(),
}).strict();
export type ConversationArchiveReadResult = z.infer<typeof ConversationArchiveReadResult>;

const entityPosition = z.object({order: positive, key: indexKey}).strict();
export const ConversationArchiveEntitiesParams = ConversationArchiveScope.extend({
  collection: z.string().min(1).max(64).regex(/^[a-z][a-z0-9_-]*$/),
  throughSequence: positive.optional(), before: entityPosition.optional(), key: indexKey.optional(),
  limit: z.number().int().min(1).max(100).default(50),
}).strict();
export type ConversationArchiveEntitiesParams = z.infer<typeof ConversationArchiveEntitiesParams>;
export const ConversationArchiveEntity = z.object({
  key: indexKey, order: positive, version: positive, parts: z.number().int().min(1).max(4096),
  storedBytes: z.number().int().positive().safe(),
  fromSequence: positive, throughSequence: positive, previousHash: digest, hash: digest,
}).strict();
export const ConversationArchiveEntitiesResult = ConversationArchiveScope.extend({
  persistent: z.literal(true), collection: z.string(), throughSequence: positive, headHash: digest,
  incomplete: z.boolean(), entities: z.array(ConversationArchiveEntity).max(100), before: entityPosition.optional(),
}).strict();
export type ConversationArchiveEntitiesResult = z.infer<typeof ConversationArchiveEntitiesResult>;

export const ConversationArchiveBlob = ConversationArchiveScope.extend({
  blobId: uuid, sha256: digest,
  sizeBytes: z.number().int().min(0).max(CONVERSATION_ARCHIVE_LIMITS.blobBytes),
}).strict();
export type ConversationArchiveBlob = z.infer<typeof ConversationArchiveBlob>;
const blobOffset = z.number().int().min(0).max(CONVERSATION_ARCHIVE_LIMITS.blobBytes);
const blobData = z.string().max(4 * Math.ceil(CONVERSATION_ARCHIVE_LIMITS.blobChunkBytes / 3))
  .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/);
export const ConversationArchiveBlobWriteParams = ConversationArchiveBlob.extend({offset: blobOffset, data: blobData}).strict();
export type ConversationArchiveBlobWriteParams = z.infer<typeof ConversationArchiveBlobWriteParams>;
export const ConversationArchiveBlobStatusResult = ConversationArchiveBlob.extend({
  persistent: z.literal(true), found: z.boolean(), complete: z.boolean(), receivedBytes: blobOffset,
}).strict();
export type ConversationArchiveBlobStatusResult = z.infer<typeof ConversationArchiveBlobStatusResult>;
export const ConversationArchiveBlobReadParams = ConversationArchiveBlob.extend({offset: blobOffset.default(0)}).strict();
export type ConversationArchiveBlobReadParams = z.infer<typeof ConversationArchiveBlobReadParams>;
export const ConversationArchiveBlobReadResult = ConversationArchiveBlob.extend({
  persistent: z.literal(true), offset: blobOffset, data: blobData, nextOffset: blobOffset.optional(),
}).strict();
export type ConversationArchiveBlobReadResult = z.infer<typeof ConversationArchiveBlobReadResult>;
