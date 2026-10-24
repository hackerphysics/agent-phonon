import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, realpathSync, rmSync, linkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { Header, Pax, type HeaderData } from "tar";
import { PhononConnection } from "./index.js";
import { PhononStore } from "./store.js";
import { AdapterRegistry } from "./session-engine.js";
import { prepareSkillArchive, SKILL_ARCHIVE_LIMITS } from "./skill-archive.js";
import { SkillManager } from "./skill-manager.js";

function tarEntry(path: string, data: string | Buffer = "", extra: HeaderData = {}): Buffer {
  const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const header = new Header({ path, type: "File", mode: 0o644, size: bytes.length, ...extra });
  header.encode(); assert.ok(header.block);
  return Buffer.concat([header.block, bytes, Buffer.alloc((512 - bytes.length % 512) % 512)]);
}
function archive(entries: Buffer[]) {
  return compressedSource(Buffer.concat([...entries, Buffer.alloc(1024)]));
}
function compressedSource(tar: Buffer) {
  const bytes = gzipSync(tar);
  return { kind: "archive" as const, format: "tar.gz" as const, contentBase64: bytes.toString("base64"),
    sha256: createHash("sha256").update(bytes).digest("hex"), sizeBytes: bytes.length };
}
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "phonon-skill-archive-security-"))), path = join(root, "project");
  mkdirSync(path);
  const store = new PhononStore(join(root, "native.db"));
  store.upsertProject({ projectId: "owned", name: "Owned", path, namespace: "account-a", git: false, createdAt: new Date().toISOString() });
  const replies: Array<Record<string, any>> = [], connection = new PhononConnection({ tenantId: "account-a", store,
    workspaceRoot: root, registry: new AdapterRegistry(), policy: { allowedAgents: ["mock:default" as never] },
    transport: { send: value => replies.push(JSON.parse(value)), close: () => {} } });
  let sequence = 0;
  const call = async (source: unknown, name = "existing") => {
    const id = ++sequence;
    await connection.handle(JSON.stringify({ jsonrpc: "2.0", id, method: "skill.install", params: {
      clientRequestId: "install-" + id, agent: "mock:default", name, scope: "project", projectId: "owned", source,
    } }));
    const response = replies.find(value => value.id === id); assert.ok(response); return response;
  };
  return { root, path, store, call, target: join(path, ".agent/skills/existing"),
    async seed() { const installed = await call({ kind: "inline", files: { "SKILL.md": "Original instructions" } }); assert.ok(installed.result); return installed.result.skill; },
    async close() { await connection.dispose(); store.close(); rmSync(root, { recursive: true, force: true }); } };
}

test("an unsafe late archive destination cannot overwrite an earlier existing skill file before rejection", async () => {
  const f = fixture(); try {
    const before = await f.seed();
    const response = await f.call(archive([tarEntry("SKILL.md", "Must not replace original"), tarEntry("z:alternate-stream", "Unsafe")]));
    assert.ok(response.error); assert.equal(readFileSync(join(f.target, "SKILL.md"), "utf8"), "Original instructions");
    assert.equal(f.store.loadSkills("account-a")[0]!.hash, before.hash);
  } finally { await f.close(); }
});

test("duplicate archive paths cannot silently choose the last instructions or replace an earlier confirmed receipt", async () => {
  const f = fixture(); try {
    const before = await f.seed(), response = await f.call(archive([tarEntry("SKILL.md", "First"), tarEntry("./SKILL.md", "Last")]));
    assert.ok(response.error); assert.equal(readFileSync(join(f.target, "SKILL.md"), "utf8"), "Original instructions");
    assert.equal(f.store.loadSkills("account-a")[0]!.hash, before.hash);
  } finally { await f.close(); }
});

test("archives reject portable device-name aliases before modifying any existing instructions", async () => {
  const f = fixture(); try {
    await f.seed();
    for (const path of ["NUL.txt", "nested/CON", "nested/file. ", "nested\\escape.txt"]) {
      const response = await f.call(archive([tarEntry("SKILL.md", "Must not replace"), tarEntry(path, "Unsafe")]));
      assert.ok(response.error, path); assert.equal(readFileSync(join(f.target, "SKILL.md"), "utf8"), "Original instructions");
    }
  } finally { await f.close(); }
});

test("archive size declarations are checked against actual decoded bytes before writing", async () => {
  const f = fixture(); try {
    await f.seed(); const source = archive([tarEntry("SKILL.md", "Different")]);
    const response = await f.call({ ...source, sizeBytes: source.sizeBytes + 1 });
    assert.ok(response.error); assert.equal(readFileSync(join(f.target, "SKILL.md"), "utf8"), "Original instructions");
  } finally { await f.close(); }
});

test("archive base64 must be canonical, not silently decoded after discarding invalid characters", async () => {
  const f = fixture(); try {
    await f.seed(); const source = archive([tarEntry("SKILL.md", "Different")]);
    const response = await f.call({ ...source, contentBase64: "!" + source.contentBase64 });
    assert.ok(response.error); assert.equal(readFileSync(join(f.target, "SKILL.md"), "utf8"), "Original instructions");
  } finally { await f.close(); }
});

test("invalid compressed archives leave no newly created skill directory or metadata", async () => {
  const f = fixture(); try {
    const response = await f.call({ kind: "archive", format: "tar.gz", contentBase64: Buffer.from("not gzip").toString("base64") }, "invalid");
    assert.ok(response.error); assert.equal(existsSync(join(f.path, ".agent/skills/invalid")), false);
    assert.deepEqual(f.store.loadSkills("account-a"), []);
  } finally { await f.close(); }
});

test("portable PAX archives install exact nested bytes and confirm the actual compressed archive hash", async () => {
  const f = fixture(); try {
    const path = ["a".repeat(90), "b".repeat(90), "c".repeat(90), "\u6587\u6863.md"].join("/");
    const source = archive([tarEntry("./", "", { type: "Directory" }), tarEntry("SKILL.md", "Instructions"),
      new Pax({ path }).encode()!, tarEntry("placeholder", "Exact nested content")]);
    const response = await f.call(source, "pax"); assert.ok(response.result, JSON.stringify(response));
    assert.equal(response.result.skill.hash, source.sha256);
    assert.equal(readFileSync(join(f.path, ".agent/skills/pax", path), "utf8"), "Exact nested content");
    assert.equal(existsSync(join(f.path, ".agent/skills/pax/placeholder")), false);
  } finally { await f.close(); }
});

test("GNU long-path metadata uses the same bounded path plan as regular and PAX entries", async () => {
  const path = ["a".repeat(90), "b".repeat(90), "c".repeat(90), "SKILL.md"].join("/");
  const result = await prepareSkillArchive(archive([tarEntry("././@LongLink", path + "\0", { type: "NextFileHasLongPath" }), tarEntry("placeholder", "Instructions")]));
  assert.equal(result.files[0]!.path, path); assert.equal(result.files[0]!.data.toString(), "Instructions");
});

test("case, Unicode-normalization and file/directory aliases fail before any destination mutation", async () => {
  const f = fixture(); try {
    await f.seed();
    for (const entries of [
      [tarEntry("SKILL.md", "First"), tarEntry("skill.md", "Second")],
      [new Pax({ path: "\u00e9.md" }).encode()!, tarEntry("placeholder", "A"), new Pax({ path: "e\u0301.md" }).encode()!, tarEntry("placeholder", "B")],
      [tarEntry("path", "File"), tarEntry("path/child", "Child")],
      [tarEntry("path/child", "Child"), tarEntry("path", "File")],
    ]) {
      const result = await f.call(archive(entries)); assert.ok(result.error);
      assert.equal(readFileSync(join(f.target, "SKILL.md"), "utf8"), "Original instructions");
    }
  } finally { await f.close(); }
});

test("links, device nodes, FIFOs and sparse entries are never extracted into a staging or destination directory", async () => {
  const f = fixture(); try {
    await f.seed();
    for (const type of ["SymbolicLink", "Link", "CharacterDevice", "BlockDevice", "FIFO", "SparseFile", "TapeVolumeHeader"] as const) {
      const entry = tarEntry("unsafe", "", { type, ...(["Link", "SymbolicLink"].includes(type) ? { linkpath: "../outside" } : {}) });
      const response = await f.call(archive([tarEntry("SKILL.md", "Must not replace"), entry]));
      assert.ok(response.error, type); assert.equal(readFileSync(join(f.target, "SKILL.md"), "utf8"), "Original instructions");
      assert.equal(existsSync(join(f.target, "unsafe")), false);
    }
  } finally { await f.close(); }
});

test("PAX and GNU metadata cannot smuggle traversal, drive paths or oversized metadata", async () => {
  for (const path of ["../escape", "/absolute", "C:/device", "nested\\escape", "x/../escape"]) {
    await assert.rejects(prepareSkillArchive(archive([new Pax({ path }).encode()!, tarEntry("placeholder", "Unsafe")])), /unsafe path/);
    await assert.rejects(prepareSkillArchive(archive([tarEntry("././@LongLink", path + "\0", { type: "NextFileHasLongPath" }), tarEntry("placeholder", "Unsafe")])), /unsafe path/);
  }
  await assert.rejects(prepareSkillArchive(archive([tarEntry("meta", Buffer.alloc(SKILL_ARCHIVE_LIMITS.metadataBytes + 1), { type: "ExtendedHeader" }), tarEntry("SKILL.md", "Not applied")])), /unsupported entry/);
  await assert.rejects(prepareSkillArchive(archive([tarEntry("meta", "24 GNU.sparse.major=1\n", { type: "ExtendedHeader" }), tarEntry("SKILL.md", "Not applied")])), /unsupported or oversized metadata/);
});

test("malformed checksums, missing end markers, truncated gzip and appended archives are refused", async () => {
  const entry = tarEntry("SKILL.md", "Instructions"), bad = Buffer.from(entry); bad[0] = bad[0]! ^ 1;
  await assert.rejects(prepareSkillArchive(archive([bad])), /malformed/);
  await assert.rejects(prepareSkillArchive(compressedSource(entry)), /complete file archive/);
  await assert.rejects(prepareSkillArchive(compressedSource(Buffer.concat([entry, Buffer.alloc(1024), entry, Buffer.alloc(1024)]))), /after its end marker/);
  const valid = archive([entry]), bytes = Buffer.from(valid.contentBase64, "base64").subarray(0, -4);
  await assert.rejects(prepareSkillArchive({ format: "tar.gz", contentBase64: bytes.toString("base64") }), /invalid gzip/);
});

test("compressed, expanded, individual-file and metadata limits are enforced independently of caller hints", async () => {
  await assert.rejects(prepareSkillArchive({ format: "tar.gz", contentBase64: "A".repeat(Math.ceil(SKILL_ARCHIVE_LIMITS.compressedBytes / 3) * 4 + 4) }), /oversized base64/);
  await assert.rejects(prepareSkillArchive(archive([tarEntry("SKILL.md", "", { size: SKILL_ARCHIVE_LIMITS.fileBytes + 1 })])), /file or total byte limit/);
  await assert.rejects(prepareSkillArchive(archive([new Pax({ size: 0.5 }).encode()!, tarEntry("SKILL.md", "A")])), /ordinary files/);
  await assert.rejects(prepareSkillArchive(compressedSource(Buffer.alloc(SKILL_ARCHIVE_LIMITS.expandedBytes + 512))), /expanded byte limit/);
});

test("entry counts, implicit parent directories, nesting and filesystem component lengths are bounded", async () => {
  const dirs = Array.from({ length: SKILL_ARCHIVE_LIMITS.entries + 1 }, (_, index) => tarEntry("d" + index, "", { type: "Directory" }));
  await assert.rejects(prepareSkillArchive(archive(dirs)), /too many entries/);
  const paths = Array.from({ length: 70 }, (_, index) => tarEntry(["p" + index, ...Array(62).fill("d"), "file"].join("/"), "A"));
  await assert.rejects(prepareSkillArchive(archive(paths)), /too many paths/);
  await assert.rejects(prepareSkillArchive(archive([tarEntry([...Array(64).fill("d"), "file"].join("/"), "A")])), /unsafe path/);
  await assert.rejects(prepareSkillArchive(archive([new Pax({ path: "a".repeat(256) }).encode()!, tarEntry("placeholder", "A")])), /unsafe path/);
});

test("a late existing destination hardlink is preflighted before an earlier valid file is written", async () => {
  const f = fixture(); try {
    const before = await f.seed(), other = join(f.root, "other-owner.txt"); writeFileSync(other, "Private other bytes");
    linkSync(other, join(f.target, "z-hardlink"));
    const response = await f.call(archive([tarEntry("SKILL.md", "Must not replace"), tarEntry("z-hardlink", "Must not overwrite")]));
    assert.equal(response.error?.data?.appCode, "errPolicyDenied");
    assert.equal(readFileSync(join(f.target, "SKILL.md"), "utf8"), "Original instructions");
    assert.equal(readFileSync(other, "utf8"), "Private other bytes"); assert.equal(f.store.loadSkills("account-a")[0]!.hash, before.hash);
  } finally { await f.close(); }
});

test("archive preparation rechecks a withdrawn Project before creating a target or recording metadata", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "phonon-archive-project-recheck-"))); let calls = 0;
  const manager = new SkillManager(new AdapterRegistry(), () => ++calls <= 2 ? root : undefined);
  try {
    await assert.rejects(manager.install({ agent: "mock:default", name: "withdrawn", scope: "project", projectId: "owned", source: archive([tarEntry("SKILL.md", "Must not apply")]) }), /project .* not found/);
    assert.equal(existsSync(join(root, ".agent")), false); assert.deepEqual(manager.list(), []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("parallel archive preparation is bounded and a refused or malformed request does not leak a capacity slot", async () => {
  const source = archive([tarEntry("SKILL.md", "A".repeat(4096))]);
  const first = prepareSkillArchive(source), second = prepareSkillArchive(source);
  await assert.rejects(prepareSkillArchive(source), /preparation is busy/);
  await Promise.all([first, second]);
  await assert.rejects(prepareSkillArchive({ format: "tar.gz", contentBase64: "!!!!" }));
  assert.equal((await prepareSkillArchive(source)).files[0]!.data.length, 4096);
});
