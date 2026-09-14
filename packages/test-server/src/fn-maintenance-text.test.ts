import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MaintenanceManager, PolicyEnforcer, type MaintenanceConfigTarget } from "@agent-phonon/core";
import { parseParams } from "@agent-phonon/protocol";

const fixtures = {
  json: '\uFEFF{ "model": "before", "locked": {"nested": 1} }\r\n',
  jsonc: '\uFEFF{ // keep comment\r\n "model": "before", "locked": {"nested": 1},\r\n}\r\n',
  yaml: '\uFEFF# keep comment\r\nmodel: before # keep inline\r\nlocked:\r\n  nested: 1\r\n',
  toml: '\uFEFF# keep comment\r\nmodel = "before"\r\ndate = 1979-05-27\r\nbig = 9223372036854775807\r\n[locked]\r\nnested = 1\r\n',
  text: '\uFEFFbefore\r\nDo not alter 中文 🐾\r\n',
};
function setup(format: keyof typeof fixtures, override: Partial<MaintenanceConfigTarget> = {}, raw: string | Buffer = fixtures[format]) {
  const dir = mkdtempSync(join(tmpdir(), "phonon-text-")); const path = join(dir, `config.${format}`);
  writeFileSync(path, raw, { mode: 0o600 });
  const config: MaintenanceConfigTarget = { configId: "main", path, format, writable: true, allowedRootKeys: ["model"], textVisibility: "public", ...(format === "text" ? { wholeFileWritable: true } : {}), ...override };
  const manager = new MaintenanceManager(new PolicyEnforcer({ policy: { allowMaintenanceRead: true, allowMaintenanceConfigWrite: true } }), { backupDir: join(dir, "backups"), targets: [{ targetId: "fixture", label: "Fixture", configs: [config] }] });
  return { dir, path, manager, config, get: () => manager.configGet("fixture", "main"), clean: () => rmSync(dir, { recursive: true, force: true }) };
}
for (const format of Object.keys(fixtures) as Array<keyof typeof fixtures>) {
  test(`text maintenance ${format}: exact edit preserves every other byte and rollback`, async () => {
    const h = setup(format); try {
      const before = await h.get(); assert.equal(before.format, format); assert.equal(before.text, fixtures[format]);
      const result = await h.manager.configEdit({ targetId: "fixture", configId: "main", expectedSha256: before.sha256!, edits: [{ oldText: "before", newText: "after" }] });
      assert.equal(result.changed, true); assert.equal(result.format, format);
      assert.equal(readFileSync(h.path, "utf8"), fixtures[format].replace("before", "after"));
      assert.equal(statSync(h.path).mode & 0o777, 0o600);
      const after = await h.get(); assert.equal(after.sha256, result.sha256);
      const restored = await h.manager.rollback(result.backupId!, after.sha256!);
      assert.equal(restored.sha256, before.sha256); assert.deepEqual(readFileSync(h.path), Buffer.from(fixtures[format]));
      assert.equal((await h.get()).sha256, before.sha256);
      if (format === "toml") {
        assert.deepEqual((before.value as any).date, { $tomlDate: "1979-05-27", local: true, date: true, time: false });
        assert.deepEqual((before.value as any).big, { $tomlInteger: "9223372036854775807" });
      }
    } finally { h.clean(); }
  });
  test(`text maintenance ${format}: noop, stale, zero/multiple matches, overlap, placeholder, readonly`, async () => {
    const h = setup(format); try {
      const b = await h.get(); const input = { targetId: "fixture", configId: "main", expectedSha256: b.sha256!, edits: [{ oldText: "before", newText: "before" }] };
      assert.equal((await h.manager.configEdit(input)).changed, false);
      for (const edits of [[{ oldText: "absent", newText: "x" }], [{ oldText: "\r\n", newText: "x" }], [{ oldText: "before", newText: "after" }, { oldText: "fore", newText: "x" }], [{ oldText: "before", newText: "***" }]]) {
        // The compact JSON fixture has one newline, so choose a repeated space instead.
        if (format === "json" && edits[0]!.oldText === "\r\n") edits[0]!.oldText = " ";
        await assert.rejects(() => h.manager.configEdit({ ...input, edits }));
      }
      await assert.rejects(() => h.manager.configEdit({ ...input, expectedSha256: "stale" }), /changed since read/);
      h.config.writable = false; await assert.rejects(() => h.manager.configEdit(input), /read-only/);
      assert.deepEqual(readFileSync(h.path), Buffer.from(fixtures[format]));
      assert.equal(readdirSync(h.dir).includes("backups"), false);
    } finally { h.clean(); }
  });
}
for (const format of ["json", "jsonc", "yaml"] as const) {
  test(`text maintenance ${format}: merge patch on server original, secrets, array replace, null deletion, comments`, async () => {
    const raw = format === "yaml" ? '# keep\r\nmodel:\r\n  name: before\r\n  token: test-secret\r\n  list: [1, 2]\r\n  remove: true\r\nlocked: 1\r\n' : '{' + (format === "jsonc" ? '// keep\r\n' : '') + '"model":{"name":"before","token":"test-secret","list":[1,2],"remove":true}, "locked":1}\r\n';
    const h = setup(format, {}, raw); try {
      const b = await h.get(); assert.equal((b.value as any).model.token, "***"); assert.equal(b.text, undefined);
      await assert.rejects(() => h.manager.configEdit({ targetId: "fixture", configId: "main", expectedSha256: b.sha256!, edits: [{ oldText: "before", newText: "after" }] }), /public text/);
      const input = { targetId: "fixture", configId: "main", expectedSha256: b.sha256!, patch: { model: { name: "after", list: [3], remove: null } } };
      const result = await h.manager.configPatch(input);
      const value: any = (await h.get()).value;
      assert.deepEqual(value.model, { name: "after", token: "***", list: [3] });
      assert.ok(readFileSync(h.path, "utf8").includes("test-secret"));
      if (format !== "json") assert.ok(readFileSync(h.path, "utf8").includes("keep"));
      await h.manager.rollback(result.backupId!, result.sha256); assert.deepEqual(readFileSync(h.path), Buffer.from(raw));
      await assert.rejects(() => h.manager.configPatch({ ...input, patch: { model: { token: "***" } } }), /redacted/);
    } finally { h.clean(); }
  });
}
for (const format of ["json", "jsonc", "yaml", "toml"] as const) {
  test(`text maintenance ${format}: syntax, nested root authorization and rollback reauthorization`, async () => {
    const h = setup(format); try {
      const b = await h.get(); const input = { targetId: "fixture", configId: "main", expectedSha256: b.sha256! };
      await assert.rejects(() => h.manager.configEdit({ ...input, edits: [{ oldText: 'nested', newText: 'changed' }] }), /non-allowlisted/);
      await assert.rejects(() => h.manager.configEdit({ ...input, edits: [{ oldText: format === "yaml" ? "model: before" : format === "toml" ? 'model = "before"' : '"model": "before"', newText: format === "yaml" ? "model: [" : "!INVALID[" }] }));
      const changed = await h.manager.configEdit({ ...input, edits: [{ oldText: "before", newText: "after" }] });
      h.config.allowedRootKeys = [];
      await assert.rejects(() => h.manager.rollback(changed.backupId!, changed.sha256), /non-allowlisted/);
      h.config.allowedRootKeys = ["model"];
      await h.manager.rollback(changed.backupId!, changed.sha256); assert.deepEqual(readFileSync(h.path), Buffer.from(fixtures[format]));
    } finally { h.clean(); }
  });
}
test("text maintenance: UTF-8/NUL/binary/size and parser diagnostics fail without source leakage", async () => {
  for (const raw of [Buffer.from([0xff]), Buffer.from("hello\0private-value"), Buffer.from([1, 2]), Buffer.alloc(1048577, 65)]) {
    const h = setup("text", {}, raw); try { await assert.rejects(h.get); assert.deepEqual(readFileSync(h.path), raw); } finally { h.clean(); }
  }
  for (const raw of ['model: !execute private-value', 'a: &a [1]\nb: *a', 'a: 1\n---\nb: 2', 'a: 1\na: 2', '1: x', 'model: [private-value']) {
    const h = setup("yaml", {}, raw); try { await assert.rejects(h.get, e => !String(e).includes("private-value")); } finally { h.clean(); }
  }
  for (const raw of ['{"model":1,"model":2}', '{"__proto__":{}}']) {
    const h = setup("json", {}, raw); try { await assert.rejects(h.get); } finally { h.clean(); }
  }
});
test("text maintenance: hidden/public-text consent and uncertain contents", async () => {
  const h = setup("text", { writable: false, textVisibility: "hidden", wholeFileWritable: false }); try { assert.equal((await h.get()).text, undefined); } finally { h.clean(); }
  const secret = setup("text", {}, 'Authorization: private-value'); try { const b = await secret.get(); assert.equal(b.text, undefined); await assert.rejects(() => secret.manager.configEdit({ targetId: "fixture", configId: "main", expectedSha256: b.sha256!, edits: [{ oldText: 'private-value', newText: 'x' }] })); } finally { secret.clean(); }
  assert.throws(() => new MaintenanceManager(new PolicyEnforcer(), { targets: [{ targetId: "t", label: "t", configs: [{ configId: "c", path: "/not-opened", format: "text", writable: true }] }] }), /explicit public/);
});
test("text maintenance: atomic preparation failure and concurrent SHA writes", async () => {
  const h = setup("yaml"); try {
    const before = await h.get(); const input = { targetId: "fixture", configId: "main", expectedSha256: before.sha256!, patch: { model: "after" } };
    // Induce a real filesystem failure before rename: backups parent is a file.
    writeFileSync(join(h.dir, "backups"), "not-a-directory");
    await assert.rejects(() => h.manager.configPatch(input)); assert.deepEqual(readFileSync(h.path), Buffer.from(fixtures.yaml));
    rmSync(join(h.dir, "backups"));
    const results = await Promise.allSettled([h.manager.configPatch(input), h.manager.configPatch(input)]);
    assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
    const r: any = results.find(r => r.status === "fulfilled"); await h.manager.rollback(r.value.backupId, r.value.sha256);
    assert.deepEqual(readFileSync(h.path), Buffer.from(fixtures.yaml));
  } finally { h.clean(); }
});
test("text maintenance: strict edit wire schema excludes arbitrary paths/shell/empty edits", () => {
  const p = { targetId: "fixture", configId: "main", expectedSha256: "x", edits: [{ oldText: "a", newText: "b" }] };
  assert.deepEqual(parseParams("maintenance.config.edit", p), p);
  for (const bad of [{ ...p, path: "/etc/passwd" }, { ...p, shell: "x" }, { ...p, edits: [] }, { ...p, edits: [{ oldText: "", newText: "x" }] }]) assert.throws(() => parseParams("maintenance.config.edit", bad));
});
for (const format of ["json", "jsonc", "yaml"] as const) test(`text maintenance ${format}: deeply nested new provider mapping and scalar-to-map merge`, async () => {
  const h = setup(format); try {
    const b = await h.get();
    const r = await h.manager.configPatch({ targetId: "fixture", configId: "main", expectedSha256: b.sha256!, patch: { model: { providers: { local: { api: "http://127.0.0.1:4000/v1", transport: "chat_completions" } }, nested: { remove: null, list: [1, 2] } } } });
    assert.deepEqual((await h.get()).value && ((await h.get()).value as any).model, { providers: { local: { api: "http://127.0.0.1:4000/v1", transport: "chat_completions" } }, nested: { list: [1, 2] } });
    await h.manager.rollback(r.backupId!, r.sha256); assert.deepEqual(readFileSync(h.path), Buffer.from(fixtures[format]));
  } finally { h.clean(); }
});
test("text maintenance: exact edits reject malformed Unicode and preserve no-final-newline", async () => {
  const h = setup("text", {}, '\uFEFFhello 🐾'); try {
    const b = await h.get(); const p = { targetId: "fixture", configId: "main", expectedSha256: b.sha256! };
    await assert.rejects(() => h.manager.configEdit({ ...p, edits: [{ oldText: "hello", newText: "\ud800" }] }), /Unicode/);
    await assert.rejects(() => h.manager.configEdit({ ...p, edits: [{ oldText: "\ud83d", newText: "x" }] }), /Unicode/);
    const r = await h.manager.configEdit({ ...p, edits: [{ oldText: "hello", newText: "你好" }] });
    assert.equal(readFileSync(h.path, "utf8"), '\uFEFF你好 🐾');
    await h.manager.rollback(r.backupId!, r.sha256); assert.equal(readFileSync(h.path, "utf8"), '\uFEFFhello 🐾');
  } finally { h.clean(); }
});
test("text maintenance: TOML date type cannot masquerade as diagnostic projection to bypass root permissions", async () => {
  const h = setup("toml", {}, 'model = "before"\ndate = 1979-05-27\n'); try {
    const b = await h.get();
    await assert.rejects(() => h.manager.configEdit({ targetId: "fixture", configId: "main", expectedSha256: b.sha256!, edits: [{ oldText: 'date = 1979-05-27', newText: 'date = { "$tomlDate" = "1979-05-27", local = true, date = true, time = false }' }] }), /non-allowlisted/);
    assert.equal(readFileSync(h.path, "utf8"), 'model = "before"\ndate = 1979-05-27\n');
  } finally { h.clean(); }
});
test("text maintenance: rename failure removes temporary bytes and never copy-over", async () => {
  const h = setup("text"); try {
    // Exercise the actual atomic helper against a directory: rename must fail.
    const { mkdirSync } = await import("node:fs");
    const target = join(h.dir, "directory"); mkdirSync(target); writeFileSync(join(target, "keep"), "original");
    await assert.rejects(() => (h.manager as any).atomicWrite(target, "replacement"));
    assert.equal(readFileSync(join(target, "keep"), "utf8"), "original");
    assert.equal(readdirSync(h.dir).some(x => x.includes(".phonon-")), false);
  } finally { h.clean(); }
});
