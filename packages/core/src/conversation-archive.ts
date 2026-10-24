import { createHash } from "node:crypto";
import { chmodSync, closeSync, constants, lstatSync, openSync, statfsSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import {
  CONVERSATION_ARCHIVE_LIMITS, ConversationArchiveAppendParams, ConversationArchiveReadParams,
  ConversationArchiveScope, ConversationArchiveEntry, ConversationArchiveStoredEntry,
  ConversationArchiveEntitiesParams, type ConversationArchiveEntitiesResult,
  ConversationArchiveBlob, ConversationArchiveBlobWriteParams, ConversationArchiveBlobReadParams,
  type ConversationArchiveBlobStatusResult, type ConversationArchiveBlobReadResult,
  conversationArchiveEntryHashInput,
  type ConversationArchiveAppendResult, type ConversationArchiveReadResult, type ConversationArchiveStatusResult,
} from "@agent-phonon/protocol";
import { PhononError } from "./rpc.js";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const fail = (code: string): never => { throw new PhononError(code); };
type Header = { archive_epoch: string; project_id: string | null; last_seq: bigint; head_hash: string; payload_bytes: bigint };
type BlobRow = { sha256: string; size_bytes: bigint; received_bytes: bigint; complete: bigint };

export function conversationArchiveAuthority(value?: string): string | undefined {
  try {
    const url = new URL(value!);
    if (url.username || url.password || url.search || url.hash || url.pathname !== "/") return;
    if (url.protocol === "wss:") url.protocol = "https:";
    if (url.protocol === "ws:") url.protocol = "http:";
    if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) return;
    return url.origin;
  } catch { return; }
}

/** Permanent normalized history, deliberately outside delivery/outbox pruning. */
export class ConversationArchive {
  private db: DatabaseSync;
  constructor(private path: string) {
    try {
      const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
      closeSync(fd);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || process.getuid && stat.uid !== process.getuid()) fail("errArchiveUnavailable");
    this.db = new DatabaseSync(path);
    try {
      const version = this.db.prepare("PRAGMA user_version").get()!.user_version;
      if (![0, 1, 2, 3, 4].includes(Number(version))) fail("errArchiveUnavailable");
      if (version === 0 && this.db.prepare("SELECT 1 FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' LIMIT 1").get()) fail("errArchiveUnavailable");
      chmodSync(path, 0o600);
      this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=3000;");
      if (version === 0) this.db.exec(`BEGIN IMMEDIATE;
    CREATE TABLE conversation_archives (
      authority TEXT NOT NULL, tenant_id TEXT NOT NULL, conversation_id TEXT NOT NULL,
      archive_epoch TEXT NOT NULL, project_id TEXT, last_seq INTEGER NOT NULL CHECK(last_seq>=0),
      head_hash TEXT NOT NULL, payload_bytes INTEGER NOT NULL CHECK(payload_bytes>=0),
      PRIMARY KEY(authority,tenant_id,conversation_id)
    );
    CREATE TABLE conversation_archive_entries (
      authority TEXT NOT NULL, tenant_id TEXT NOT NULL, conversation_id TEXT NOT NULL,
      seq INTEGER NOT NULL CHECK(seq>0), record_id TEXT NOT NULL, document TEXT NOT NULL,
      previous_hash TEXT NOT NULL, chain_hash TEXT NOT NULL,
      PRIMARY KEY(authority,tenant_id,conversation_id,seq), UNIQUE(authority,tenant_id,conversation_id,record_id),
      FOREIGN KEY(authority,tenant_id,conversation_id) REFERENCES conversation_archives(authority,tenant_id,conversation_id)
    );
    PRAGMA user_version=1; COMMIT;`);
      if (version === 0 || version === 1) this.db.exec(`BEGIN IMMEDIATE;
        ALTER TABLE conversation_archives ADD COLUMN indexed_parts INTEGER NOT NULL DEFAULT 0 CHECK(indexed_parts>=0);
        CREATE TABLE conversation_archive_parts(
          authority TEXT NOT NULL,tenant_id TEXT NOT NULL,conversation_id TEXT NOT NULL,collection TEXT NOT NULL,entity_key TEXT NOT NULL,
          version INTEGER NOT NULL,part INTEGER NOT NULL,parts INTEGER NOT NULL,sort_order INTEGER,deleted INTEGER NOT NULL,seq INTEGER NOT NULL,entry_bytes INTEGER NOT NULL,
          PRIMARY KEY(authority,tenant_id,conversation_id,collection,entity_key,version,part),UNIQUE(authority,tenant_id,conversation_id,seq),
          FOREIGN KEY(authority,tenant_id,conversation_id,seq) REFERENCES conversation_archive_entries(authority,tenant_id,conversation_id,seq)
        );
        CREATE INDEX conversation_archive_entity_order ON conversation_archive_parts(authority,tenant_id,conversation_id,collection,sort_order DESC,entity_key DESC,version DESC);
        PRAGMA user_version=2; COMMIT;`);
      if (Number(version) < 3) this.db.exec(`BEGIN IMMEDIATE;
        CREATE TABLE conversation_archive_blobs(
          authority TEXT NOT NULL,tenant_id TEXT NOT NULL,conversation_id TEXT NOT NULL,blob_id TEXT NOT NULL,
          sha256 TEXT NOT NULL,size_bytes INTEGER NOT NULL CHECK(size_bytes BETWEEN 0 AND 10485760),
          received_bytes INTEGER NOT NULL CHECK(received_bytes>=0 AND received_bytes<=size_bytes),
          complete INTEGER NOT NULL CHECK(complete IN(0,1)),storage_bytes INTEGER NOT NULL CHECK(storage_bytes=size_bytes+512),
          PRIMARY KEY(authority,tenant_id,conversation_id,blob_id),
          FOREIGN KEY(authority,tenant_id,conversation_id) REFERENCES conversation_archives(authority,tenant_id,conversation_id)
        );
        CREATE TABLE conversation_archive_blob_chunks(
          authority TEXT NOT NULL,tenant_id TEXT NOT NULL,conversation_id TEXT NOT NULL,blob_id TEXT NOT NULL,
          offset INTEGER NOT NULL CHECK(offset>=0),data BLOB NOT NULL,sha256 TEXT NOT NULL,
          PRIMARY KEY(authority,tenant_id,conversation_id,blob_id,offset),
          FOREIGN KEY(authority,tenant_id,conversation_id,blob_id) REFERENCES conversation_archive_blobs(authority,tenant_id,conversation_id,blob_id)
        );
        PRAGMA user_version=3; COMMIT;`);
      // Rebuild only the manifest table; existing blob chunks and hashes stay intact.
      if (Number(version) < 4) {
        this.db.exec("PRAGMA foreign_keys=OFF");
        try {
          this.db.exec(`BEGIN IMMEDIATE;
            CREATE TABLE conversation_archive_blobs_v4(
              authority TEXT NOT NULL,tenant_id TEXT NOT NULL,conversation_id TEXT NOT NULL,blob_id TEXT NOT NULL,
              sha256 TEXT NOT NULL,size_bytes INTEGER NOT NULL CHECK(size_bytes BETWEEN 0 AND 20971520),
              received_bytes INTEGER NOT NULL CHECK(received_bytes>=0 AND received_bytes<=size_bytes),
              complete INTEGER NOT NULL CHECK(complete IN(0,1)),storage_bytes INTEGER NOT NULL CHECK(storage_bytes=size_bytes+512),
              PRIMARY KEY(authority,tenant_id,conversation_id,blob_id),
              FOREIGN KEY(authority,tenant_id,conversation_id) REFERENCES conversation_archives(authority,tenant_id,conversation_id)
            );
            INSERT INTO conversation_archive_blobs_v4 SELECT * FROM conversation_archive_blobs;
            DROP TABLE conversation_archive_blobs;
            ALTER TABLE conversation_archive_blobs_v4 RENAME TO conversation_archive_blobs;
            PRAGMA user_version=4;`);
          if (this.db.prepare("PRAGMA foreign_key_check").get()) fail("errArchiveIntegrity");
          this.db.exec("COMMIT");
        } catch (error) { this.db.exec("ROLLBACK"); throw error; }
        finally { this.db.exec("PRAGMA foreign_keys=ON"); }
      }
    } catch (error) { this.db.close(); throw error; }
  }
  close(): void { this.db.close(); }
  private statement(sql: string): StatementSync { const value = this.db.prepare(sql); value.setReadBigInts(true); return value; }
  private key(authority: string, tenant: string, scope: ConversationArchiveScope): [string, string, string] {
    if (conversationArchiveAuthority(authority) !== authority || !tenant || tenant.length > 255) fail("errArchiveUnavailable");
    return [authority, tenant, scope.conversationId];
  }
  private genesis(authority: string, tenant: string, scope: ConversationArchiveScope): string {
    return hash(JSON.stringify(["phonon-conversation-archive-v1", authority, tenant, scope.conversationId, scope.archiveEpoch, scope.projectId]));
  }
  private header(authority: string, tenant: string, scope: ConversationArchiveScope): Header | undefined {
    const row = this.statement("SELECT * FROM conversation_archives WHERE authority=? AND tenant_id=? AND conversation_id=?").get(...this.key(authority, tenant, scope)) as Header | undefined;
    if (row && (row.archive_epoch !== scope.archiveEpoch || row.project_id !== scope.projectId)) fail("errArchiveIdentityChanged");
    return row;
  }
  private stored(authority: string, tenant: string, scope: ConversationArchiveScope, seq: bigint) {
    const row = this.statement("SELECT * FROM conversation_archive_entries WHERE authority=? AND tenant_id=? AND conversation_id=? AND seq=?").get(...this.key(authority, tenant, scope), seq);
    if (!row) throw new PhononError("errArchiveIntegrity");
    try {
      const entry = ConversationArchiveEntry.parse(JSON.parse(row.document as string));
      if (BigInt(entry.sequence) !== seq || entry.recordId !== row.record_id || hash(conversationArchiveEntryHashInput(row.previous_hash as string, entry)) !== row.chain_hash) fail("errArchiveIntegrity");
      return ConversationArchiveStoredEntry.parse({...entry, previousHash: row.previous_hash, hash: row.chain_hash});
    } catch { return fail("errArchiveIntegrity"); }
  }
  private anchor(authority: string, tenant: string, scope: ConversationArchiveScope, seq: bigint): string {
    return seq === 0n ? this.genesis(authority, tenant, scope) : this.stored(authority, tenant, scope, seq).hash;
  }
  private state(authority: string, tenant: string, scope: ConversationArchiveScope): ConversationArchiveStatusResult {
    const row = this.header(authority, tenant, scope);
    if (row && (row.last_seq < 1n || row.payload_bytes < 0n || row.payload_bytes > BigInt(Number.MAX_SAFE_INTEGER) || this.anchor(authority, tenant, scope, row.last_seq) !== row.head_hash)) fail("errArchiveIntegrity");
    return {...scope, found: !!row, persistent: true, throughSequence: String(row?.last_seq ?? 0n), headHash: row?.head_hash ?? this.genesis(authority, tenant, scope), payloadBytes: Number(row?.payload_bytes ?? 0n)};
  }
  private transaction<T>(write: boolean, operation: () => T): T {
    let opened = false;
    try { this.db.exec(write ? "BEGIN IMMEDIATE" : "BEGIN"); opened = true; const value = operation(); this.db.exec("COMMIT"); return value; }
    catch (error) {
      if (opened) try { this.db.exec("ROLLBACK"); } catch { /* Preserve the original failure. */ }
      if (error instanceof PhononError) throw error;
      throw new PhononError("errArchiveUnavailable");
    }
  }
  private capacity(authority: string, tenant: string, added: number, maxBytes: number): void {
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) fail("errArchiveCapacity");
    const documents = this.statement("SELECT COALESCE(sum(payload_bytes),0) bytes FROM conversation_archives WHERE authority=? AND tenant_id=?").get(authority, tenant)!;
    const blobs = this.statement("SELECT COALESCE(sum(storage_bytes),0) bytes FROM conversation_archive_blobs WHERE authority=? AND tenant_id=?").get(authority, tenant)!;
    const space = statfsSync(dirname(this.path));
    if ((documents.bytes as bigint) + (blobs.bytes as bigint) + BigInt(added) > BigInt(maxBytes) || space.bavail * space.bsize < 64 * 1024 * 1024 + added * 4) fail("errArchiveCapacity");
  }
  private blobRow(authority: string, tenant: string, input: ConversationArchiveBlob): BlobRow | undefined {
    this.header(authority, tenant, input);
    const row = this.statement("SELECT * FROM conversation_archive_blobs WHERE authority=? AND tenant_id=? AND conversation_id=? AND blob_id=?").get(...this.key(authority, tenant, input), input.blobId) as BlobRow | undefined;
    if (row && (row.sha256 !== input.sha256 || row.size_bytes !== BigInt(input.sizeBytes))) fail("errArchiveConflict");
    if (row && (row.received_bytes < 0n || row.received_bytes > row.size_bytes || ![0n, 1n].includes(row.complete) || (row.complete === 1n) !== (row.received_bytes === row.size_bytes))) fail("errArchiveIntegrity");
    return row;
  }
  private checkedChunk(row: Record<string, unknown>, size: number, offset: number): Buffer {
    const data = Buffer.from(row.data as Uint8Array);
    if (Number(row.offset) !== offset || data.length !== Math.min(CONVERSATION_ARCHIVE_LIMITS.blobChunkBytes, size - offset) || createHash("sha256").update(data).digest("hex") !== row.sha256) fail("errArchiveIntegrity");
    return data;
  }
  private verifyBlob(authority: string, tenant: string, input: ConversationArchiveBlob, row: BlobRow): void {
    const digest = createHash("sha256"); let offset = 0;
    for (const chunk of this.statement("SELECT offset,data,sha256 FROM conversation_archive_blob_chunks WHERE authority=? AND tenant_id=? AND conversation_id=? AND blob_id=? ORDER BY offset").iterate(...this.key(authority, tenant, input), input.blobId)) {
      const data = this.checkedChunk(chunk, input.sizeBytes, offset);
      if (!data.length) fail("errArchiveIntegrity");
      digest.update(data); offset += data.length;
    }
    if (BigInt(offset) !== row.received_bytes || row.complete === 1n && digest.digest("hex") !== input.sha256) fail("errArchiveIntegrity");
  }
  private blobReceipt(input: ConversationArchiveBlob, row?: BlobRow): ConversationArchiveBlobStatusResult {
    return {...input, persistent: true, found: !!row, complete: row?.complete === 1n, receivedBytes: Number(row?.received_bytes ?? 0n)};
  }
  blobStatus(authority: string, tenant: string, raw: unknown): ConversationArchiveBlobStatusResult {
    const input = ConversationArchiveBlob.parse(raw);
    return this.transaction(false, () => {
      const row = this.blobRow(authority, tenant, input);
      if (row) this.verifyBlob(authority, tenant, input, row);
      return this.blobReceipt(input, row);
    });
  }
  writeBlob(authority: string, tenant: string, raw: unknown, maxBytes: number): ConversationArchiveBlobStatusResult {
    const value = ConversationArchiveBlobWriteParams.parse(raw);
    const input = ConversationArchiveBlob.parse({conversationId: value.conversationId, archiveEpoch: value.archiveEpoch, projectId: value.projectId, blobId: value.blobId, sha256: value.sha256, sizeBytes: value.sizeBytes});
    const data = Buffer.from(value.data, "base64"), {offset} = value;
    if (data.toString("base64") !== value.data || offset % CONVERSATION_ARCHIVE_LIMITS.blobChunkBytes !== 0 || offset > input.sizeBytes || data.length !== Math.min(CONVERSATION_ARCHIVE_LIMITS.blobChunkBytes, input.sizeBytes - offset) || input.sizeBytes > 0 && !data.length) fail("errInvalidParams");
    return this.transaction(true, () => {
      if (!this.state(authority, tenant, input).found) fail("errArchiveNotFound");
      let row = this.blobRow(authority, tenant, input);
      const key = [...this.key(authority, tenant, input), input.blobId];
      if (!row) {
        if (offset !== 0) fail("errArchiveGap");
        this.capacity(authority, tenant, input.sizeBytes + 512, maxBytes);
        this.db.prepare("INSERT INTO conversation_archive_blobs VALUES(?,?,?,?,?,?,0,0,?)").run(...key, input.sha256, input.sizeBytes, input.sizeBytes + 512);
      } else if (offset < Number(row.received_bytes) || row.complete === 1n) {
        this.verifyBlob(authority, tenant, input, row);
        if (input.sizeBytes) {
          const chunk = this.statement("SELECT offset,data,sha256 FROM conversation_archive_blob_chunks WHERE authority=? AND tenant_id=? AND conversation_id=? AND blob_id=? AND offset=?").get(...key, offset);
          if (!chunk || !this.checkedChunk(chunk, input.sizeBytes, offset).equals(data)) fail("errArchiveConflict");
        }
        return this.blobReceipt(input, row);
      }
      if (offset !== Number(row?.received_bytes ?? 0n)) fail("errArchiveGap");
      // Reservation covers the entire file; each resumed write still checks disk headroom.
      const space = statfsSync(dirname(this.path));
      if (space.bavail * space.bsize < 64 * 1024 * 1024 + data.length * 4) fail("errArchiveCapacity");
      if (data.length) this.db.prepare("INSERT INTO conversation_archive_blob_chunks VALUES(?,?,?,?,?,?,?)").run(...key, offset, data, createHash("sha256").update(data).digest("hex"));
      const received = offset + data.length;
      this.db.prepare("UPDATE conversation_archive_blobs SET received_bytes=?,complete=? WHERE authority=? AND tenant_id=? AND conversation_id=? AND blob_id=?").run(received, received === input.sizeBytes ? 1 : 0, ...key);
      row = this.blobRow(authority, tenant, input)!;
      this.verifyBlob(authority, tenant, input, row);
      return this.blobReceipt(input, row);
    });
  }
  readBlob(authority: string, tenant: string, raw: unknown): ConversationArchiveBlobReadResult {
    const value = ConversationArchiveBlobReadParams.parse(raw);
    const input = ConversationArchiveBlob.parse({conversationId: value.conversationId, archiveEpoch: value.archiveEpoch, projectId: value.projectId, blobId: value.blobId, sha256: value.sha256, sizeBytes: value.sizeBytes});
    return this.transaction(false, () => {
      const row = this.blobRow(authority, tenant, input), {offset} = value;
      if (!row) fail("errArchiveNotFound");
      if (row!.complete !== 1n) fail("errArchiveGap");
      if (offset % CONVERSATION_ARCHIVE_LIMITS.blobChunkBytes || offset >= input.sizeBytes && (offset !== 0 || input.sizeBytes !== 0)) fail("errInvalidParams");
      let data: Buffer = Buffer.alloc(0);
      if (input.sizeBytes) {
        const chunk = this.statement("SELECT offset,data,sha256 FROM conversation_archive_blob_chunks WHERE authority=? AND tenant_id=? AND conversation_id=? AND blob_id=? AND offset=?").get(...this.key(authority, tenant, input), input.blobId, offset);
        if (!chunk) fail("errArchiveIntegrity");
        data = this.checkedChunk(chunk!, input.sizeBytes, offset);
      } else this.verifyBlob(authority, tenant, input, row!);
      const next = offset + data.length;
      return {...input, persistent: true, offset, data: data.toString("base64"), ...(next < input.sizeBytes ? {nextOffset: next} : {})};
    });
  }
  status(authority: string, tenant: string, raw: unknown): ConversationArchiveStatusResult {
    const scope = ConversationArchiveScope.parse(raw);
    return this.transaction(false, () => this.state(authority, tenant, scope));
  }
  append(authority: string, tenant: string, raw: unknown, maxBytes: number): ConversationArchiveAppendResult {
    const input = ConversationArchiveAppendParams.parse(raw), scope = ConversationArchiveScope.parse({conversationId: input.conversationId, archiveEpoch: input.archiveEpoch, projectId: input.projectId});
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) fail("errArchiveCapacity");
    return this.transaction(true, () => {
      const current = this.state(authority, tenant, scope), key = this.key(authority, tenant, scope), after = BigInt(input.afterSequence);
      if (after > BigInt(current.throughSequence) || this.anchor(authority, tenant, scope, after) !== input.afterHash) fail("errArchiveGap");
      if (!current.found) this.db.prepare("INSERT INTO conversation_archives(authority,tenant_id,conversation_id,archive_epoch,project_id,last_seq,head_hash,payload_bytes) VALUES(?,?,?,?,?,0,?,0)").run(...key, scope.archiveEpoch, scope.projectId, current.headHash);
      let sequence = BigInt(current.throughSequence), previous = input.afterHash, added = 0;
      for (const entry of input.entries) {
        const seq = BigInt(entry.sequence), digest = hash(conversationArchiveEntryHashInput(previous, entry));
        if (seq <= sequence) {
          const prior = this.stored(authority, tenant, scope, seq);
          if (prior.hash !== digest || prior.previousHash !== previous || prior.recordId !== entry.recordId) fail("errArchiveConflict");
        } else {
          if (seq !== sequence + 1n) fail("errArchiveGap");
          const last = sequence > 0n ? this.stored(authority, tenant, scope, sequence).catalog : undefined;
          const index = entry.catalog;
          if (last && last.part < last.parts && (!index || index.collection !== last.collection || index.key !== last.key || index.version !== last.version || index.order !== last.order || index.parts !== last.parts || index.deleted !== last.deleted || index.part !== last.part + 1)) fail("errArchiveGap");
          if (index && (BigInt(index.version) + BigInt(index.part) - 1n !== seq || index.part > 1 && (!last || last.part !== index.part - 1 || last.collection !== index.collection || last.key !== index.key || last.version !== index.version))) fail("errArchiveGap");
          if (this.db.prepare("SELECT 1 FROM conversation_archive_entries WHERE authority=? AND tenant_id=? AND conversation_id=? AND record_id=?").get(...key, entry.recordId)) fail("errArchiveConflict");
          const document = JSON.stringify(entry); added += Buffer.byteLength(document);
          this.db.prepare("INSERT INTO conversation_archive_entries VALUES(?,?,?,?,?,?,?,?)").run(...key, seq, entry.recordId, document, previous, digest);
          if (index) {
            const prior = this.statement("SELECT sort_order FROM conversation_archive_parts WHERE authority=? AND tenant_id=? AND conversation_id=? AND collection=? AND entity_key=? AND sort_order IS NOT NULL LIMIT 1").get(...key, index.collection, index.key);
            if (prior && index.order !== null && prior.sort_order !== BigInt(index.order)) fail("errArchiveConflict");
            this.db.prepare("INSERT INTO conversation_archive_parts VALUES(?,?,?,?,?,?,?,?,?,?,?,?)").run(...key, index.collection, index.key, BigInt(index.version), index.part, index.parts, index.order === null ? prior?.sort_order as bigint ?? null : BigInt(index.order), index.deleted ? 1 : 0, seq, Buffer.byteLength(document));
            this.db.prepare("UPDATE conversation_archives SET indexed_parts=indexed_parts+1 WHERE authority=? AND tenant_id=? AND conversation_id=?").run(...key);
          }
          sequence = seq;
        }
        previous = digest;
      }
      if (added) {
        this.capacity(authority, tenant, added, maxBytes);
        this.db.prepare("UPDATE conversation_archives SET last_seq=?,head_hash=?,payload_bytes=payload_bytes+? WHERE authority=? AND tenant_id=? AND conversation_id=?").run(sequence, previous, added, ...key);
      }
      return {...this.state(authority, tenant, scope), committedThrough: input.entries.at(-1)!.sequence, committedHash: previous, replayed: added === 0};
    });
  }
  read(authority: string, tenant: string, raw: unknown): ConversationArchiveReadResult {
    const input = ConversationArchiveReadParams.parse(raw), scope = ConversationArchiveScope.parse({conversationId: input.conversationId, archiveEpoch: input.archiveEpoch, projectId: input.projectId});
    return this.transaction(false, () => {
      const current = this.state(authority, tenant, scope);
      if (!current.found) fail("errArchiveNotFound");
      const after = BigInt(input.afterSequence), upper = BigInt(input.throughSequence ?? current.throughSequence);
      if (after > upper || upper > BigInt(current.throughSequence)) fail("errArchiveGap");
      const initialHash = this.anchor(authority, tenant, scope, after);
      if (input.afterHash && input.afterHash !== initialHash) fail("errArchiveConflict");
      const result: ConversationArchiveReadResult = {...scope, persistent: true, afterSequence: input.afterSequence, afterHash: initialHash, throughSequence: String(upper), headHash: this.anchor(authority, tenant, scope, upper), entries: []};
      // Reserve enough for a decimal cursor without repeatedly serializing the
      // entire growing page for every record.
      let pageBytes = Buffer.byteLength(JSON.stringify(result)) + 128;
      let previous = initialHash, position = after;
      while (position < upper && result.entries.length < input.limit) {
        const entry = this.stored(authority, tenant, scope, position + 1n);
        if (entry.previousHash !== previous) fail("errArchiveIntegrity");
        const recordBytes = Buffer.byteLength(JSON.stringify(entry)) + (result.entries.length ? 1 : 0);
        if (pageBytes + recordBytes > CONVERSATION_ARCHIVE_LIMITS.wireBytes) break;
        result.entries.push(entry); previous = entry.hash; position += 1n; pageBytes += recordBytes;
      }
      if (position < upper) {
        if (!result.entries.length) fail("errArchiveCapacity");
        result.nextAfterSequence = String(position);
      }
      return result;
    });
  }
  entities(authority: string, tenant: string, raw: unknown): ConversationArchiveEntitiesResult {
    const input = ConversationArchiveEntitiesParams.parse(raw), scope = ConversationArchiveScope.parse({conversationId: input.conversationId, archiveEpoch: input.archiveEpoch, projectId: input.projectId});
    return this.transaction(false, () => {
      const current = this.state(authority, tenant, scope), key = this.key(authority, tenant, scope);
      if (!current.found) fail("errArchiveNotFound");
      const upper = BigInt(input.throughSequence ?? current.throughSequence);
      if (upper > BigInt(current.throughSequence)) fail("errArchiveGap");
      const expected = this.statement("SELECT indexed_parts FROM conversation_archives WHERE authority=? AND tenant_id=? AND conversation_id=?").get(...key)!;
      const actual = this.statement("SELECT count(*) n FROM conversation_archive_parts WHERE authority=? AND tenant_id=? AND conversation_id=?").get(...key)!;
      if (expected.indexed_parts !== actual.n) fail("errArchiveIntegrity");
      const groups = `SELECT entity_key,version,min(seq) first_seq,max(seq) last_seq,min(sort_order) first_order,max(sort_order) last_order,
        min(parts) min_parts,max(parts) max_parts,min(deleted) min_deleted,max(deleted) max_deleted,count(*) n,sum(entry_bytes) stored_bytes
        FROM conversation_archive_parts WHERE authority=? AND tenant_id=? AND conversation_id=? AND collection=? AND seq<=? GROUP BY entity_key,version`;
      const args = [...key, input.collection, upper];
      const invalid = this.statement(`SELECT 1 FROM (${groups}) WHERE first_order IS NOT last_order OR min_parts<>max_parts OR min_deleted<>max_deleted OR first_seq<>version OR last_seq<>version+n-1 LIMIT 1`).get(...args);
      if (invalid) fail("errArchiveIntegrity");
      const partial = !!this.statement(`SELECT 1 FROM (${groups}) WHERE n<max_parts LIMIT 1`).get(...args);
      const rows = this.statement(`WITH groups AS (${groups}), complete AS(SELECT * FROM groups WHERE n=max_parts), latest AS(
        SELECT g.* FROM complete g WHERE NOT EXISTS(SELECT 1 FROM complete newer WHERE newer.entity_key=g.entity_key AND newer.version>g.version))
        SELECT * FROM latest WHERE max_deleted=0 AND (? IS NULL OR entity_key=?) AND (? IS NULL OR last_order<? OR(last_order=? AND entity_key<?))
        ORDER BY last_order DESC,entity_key DESC LIMIT ?`).all(...args, input.key ?? null, input.key ?? null,
          input.before ? BigInt(input.before.order) : null, input.before ? BigInt(input.before.order) : null, input.before ? BigInt(input.before.order) : null, input.before?.key ?? null, input.limit + 1);
      const entities = rows.slice(0, input.limit).map(row => {
        const first = this.stored(authority, tenant, scope, row.first_seq as bigint), last = this.stored(authority, tenant, scope, row.last_seq as bigint);
        const index = first.catalog;
        if (!index || index.order === null) throw new PhononError("errArchiveIntegrity");
        if (index.collection !== input.collection || index.key !== row.entity_key || BigInt(index.version) !== row.version || BigInt(index.order) !== row.last_order || BigInt(index.parts) !== row.max_parts || index.deleted || last.catalog?.part !== index.parts || last.catalog?.key !== index.key || last.catalog?.version !== index.version) fail("errArchiveIntegrity");
        return {key: index.key, order: index.order, version: index.version, parts: index.parts, storedBytes: Number(row.stored_bytes), fromSequence: first.sequence, throughSequence: last.sequence, previousHash: first.previousHash, hash: last.hash};
      });
      return {...scope, persistent: true, collection: input.collection, throughSequence: String(upper), headHash: this.anchor(authority, tenant, scope, upper), incomplete: partial, entities,
        ...(rows.length > entities.length && entities.length ? {before: {order: entities.at(-1)!.order, key: entities.at(-1)!.key}} : {})};
    });
  }
}
