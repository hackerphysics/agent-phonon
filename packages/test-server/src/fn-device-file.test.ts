import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync } from "node:fs";
import { readFile, symlink, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AdapterRegistry } from "@agent-phonon/core";
import { MockAdapter, TestConn } from "./harness.js";

function setup() {
  const r = new AdapterRegistry();
  r.register(new MockAdapter({ name: "mock", agentIds: ["mock:default"] }));
  const root = mkdtempSync(join(tmpdir(), "phonon-file-"));
  const tc = new TestConn({ registry: r, workspaceRoot: root, trustLocal: true });
  return { tc, root };
}

test("device.info: returns OS/machine scheduling metadata", async () => {
  const { tc } = setup();
  const res = await tc.call("device.info", {}) as Record<string, any>;
  assert.equal(typeof res.hostname, "string");
  assert.equal(typeof res.os.platform, "string");
  assert.equal(typeof res.os.arch, "string");
  assert.ok(Array.isArray(res.capabilities));
});

test("device.resources: returns basic CPU/memory/disk/process snapshot", async () => {
  const { tc } = setup();
  const res = await tc.call("device.resources", {}) as Record<string, any>;
  assert.equal(typeof res.at, "string");
  assert.ok(res.memory.totalBytes > 0);
  assert.ok(res.memory.usedBytes >= 0);
  assert.ok(res.process.pid > 0);
  assert.ok(res.cpu.cores > 0);
});

test("device.fs.list: browses workspaceRoot and rejects escaping root", async () => {
  const { tc, root } = setup();
  await mkdir(join(root, "visible"));
  await writeFile(join(root, "visible", "a.txt"), "hello");
  await writeFile(join(root, ".hidden"), "secret");

  const listed = await tc.call("device.fs.list", { root: "workspaceRoot", path: ".", includeHidden: false }) as { entries: Array<{ name: string; kind: string; path: string }> };
  assert.ok(listed.entries.some((e) => e.name === "visible" && e.kind === "directory"));
  assert.ok(!listed.entries.some((e) => e.name === ".hidden"));

  const nested = await tc.call("device.fs.list", { root: "workspaceRoot", path: "visible" }) as { entries: Array<{ name: string; kind: string; path: string }> };
  assert.deepEqual(nested.entries.map((e) => [e.name, e.kind]), [["a.txt", "file"]]);

  await assert.rejects(() => tc.call("device.fs.list", { root: "workspaceRoot", path: ".." }), (e: any) => e?.data?.appCode === "errPolicyDenied");
});

test("file.*: mkdir/write/read/stat/list within project", async () => {
  const { tc } = setup();
  const p = await tc.call("project.create", { name: "p", git: false }) as { project: { projectId: string; path: string } };
  const projectId = p.project.projectId;

  const mk = await tc.call("file.mkdir", { projectId, path: "notes" }) as { created: boolean };
  assert.equal(mk.created, true);
  const wr = await tc.call("file.write", { projectId, path: "notes/a.txt", data: "hello", encoding: "utf8" }) as { written: boolean; sizeBytes: number };
  assert.equal(wr.written, true);
  assert.equal(wr.sizeBytes, 5);
  assert.equal(await readFile(join(p.project.path, "notes/a.txt"), "utf8"), "hello");

  const rd = await tc.call("file.read", { projectId, path: "notes/a.txt", encoding: "utf8" }) as { data: string; sizeBytes: number };
  assert.equal(rd.data, "hello");
  assert.equal(rd.sizeBytes, 5);

  const st = await tc.call("file.stat", { projectId, path: "notes/a.txt" }) as { stat: { type: string; sizeBytes: number } };
  assert.equal(st.stat.type, "file");
  assert.equal(st.stat.sizeBytes, 5);

  const ls = await tc.call("file.list", { projectId, path: ".", recursive: true }) as { entries: Array<{ path: string }> };
  assert.ok(ls.entries.some((e) => e.path === "notes/a.txt"));
});

test("file.read/write rejects path traversal outside project", async () => {
  const { tc, root } = setup();
  const p = await tc.call("project.create", { name: "p", git: false }) as { project: { projectId: string } };
  const projectId = p.project.projectId;
  await assert.rejects(() => tc.call("file.write", { projectId, path: "../escape.txt", data: "bad" }), (e: any) => e?.data?.appCode === "errPolicyDenied");
  await assert.rejects(() => tc.call("file.read", { projectId, path: "../escape.txt" }), (e: any) => e?.data?.appCode === "errPolicyDenied");
  assert.equal(existsSync(join(root, "escape.txt")), false);
});

test("file.*: symlink escape is blocked (read/write/list does not follow)", async () => {
  const { tc } = setup();
  const p = await tc.call("project.create", { name: "p", git: false }) as { project: { projectId: string; path: string } };
  const projectId = p.project.projectId;

  // Plant a secret outside the project and a symlink to its dir inside the project.
  const outside = mkdtempSync(join(tmpdir(), "phonon-outside-"));
  await writeFile(join(outside, "secret.txt"), "TOP-SECRET");
  await symlink(outside, join(p.project.path, "evil"));

  // 1) read through the symlink must be denied (string prefix check alone would pass).
  await assert.rejects(
    () => tc.call("file.read", { projectId, path: "evil/secret.txt", encoding: "utf8" }),
    (e: any) => e?.data?.appCode === "errPolicyDenied",
  );

  // 2) write through the symlink must be denied — and must not create the file outside.
  await assert.rejects(
    () => tc.call("file.write", { projectId, path: "evil/pwned.txt", data: "x" }),
    (e: any) => e?.data?.appCode === "errPolicyDenied",
  );
  assert.equal(existsSync(join(outside, "pwned.txt")), false);

  // 3) a symlink to a file is reported as "symlink", never followed/escaped.
  await symlink(join(outside, "secret.txt"), join(p.project.path, "link.txt"));
  const st = await tc.call("file.stat", { projectId, path: "link.txt" }) as { stat: { type: string } };
  assert.equal(st.stat.type, "symlink");

  // 4) recursive list does not descend into symlinked dirs (no secret.txt leaks in).
  await mkdir(join(p.project.path, "real"));
  await writeFile(join(p.project.path, "real/ok.txt"), "ok");
  const ls = await tc.call("file.list", { projectId, path: ".", recursive: true }) as { entries: Array<{ path: string; type: string }> };
  assert.ok(ls.entries.some((e) => e.path === "real/ok.txt"));
  assert.ok(!ls.entries.some((e) => e.path.includes("secret.txt")));
  assert.ok(ls.entries.some((e) => e.path === "evil" && e.type === "symlink"));
});

test("file.read supports maxBytes truncation and base64", async () => {
  const { tc } = setup();
  const p = await tc.call("project.create", { name: "p", git: false }) as { project: { projectId: string } };
  const projectId = p.project.projectId;
  await tc.call("file.write", { projectId, path: "bin.dat", encoding: "base64", data: Buffer.from("abcdef").toString("base64") });
  const rd = await tc.call("file.read", { projectId, path: "bin.dat", encoding: "base64", maxBytes: 3 }) as { data: string; truncated: boolean; sizeBytes: number };
  assert.equal(Buffer.from(rd.data, "base64").toString(), "abc");
  assert.equal(rd.truncated, true);
  assert.equal(rd.sizeBytes, 6);
});
