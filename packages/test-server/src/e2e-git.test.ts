import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { AdapterRegistry, PhononClient } from "@agent-phonon/core";
import { PhononServer } from "@agent-phonon/server-sdk";
import type { PhononDevice } from "@agent-phonon/server-sdk";
import { MockAdapter } from "./harness.js";

/**
 * v0.7: project.git.* 6 个底层 git RPC e2e
 * 不用 mock，真跑 git。
 */

async function setup(): Promise<{ device: PhononDevice; project: { projectId: string; path: string }; cleanup: () => Promise<void> }> {
  const server = new PhononServer({ authenticate: (id) => ({ tenantId: `t-${id}` }) });
  const port = await server.listen();
  const ready = new Promise<PhononDevice>((resolve) => server.on("device", (d: PhononDevice) => resolve(d)));
  const reg = new AdapterRegistry();
  reg.register(new MockAdapter({ name: "mock", agentIds: ["mock:a"], reply: (i) => `echo:${i}` }));
  const ws = mkdtempSync(join(tmpdir(), "phonon-git-e2e-"));
  const client = new PhononClient({ serverUrl: `ws://127.0.0.1:${port}`, deviceId: "git-dev", registry: reg, trustLocal: true, workspaceRoot: ws, resolveProjectCwd: () => ws });
  await client.connect();
  const device = await ready;
  const project = await device.project.create({ name: "git-test", git: true }) as { project: { projectId: string; path: string } };
  // 初始 commit（很多 git 操作都需要至少一个 commit）
  writeFileSync(join(project.project.path, "README.md"), "# init\n");
  execSync(`git -C ${project.project.path} -c user.email=t@x -c user.name=t add . && git -C ${project.project.path} -c user.email=t@x -c user.name=t commit -q -m init`);
  return {
    device, project: project.project,
    cleanup: async () => { try { client.close(); } catch {} try { await server.close(); } catch {} },
  };
}

test("git.status: 干净仓库 isClean=true; 改后变 dirty", { timeout: 15000 }, async () => {
  const ctx = await setup();
  try {
    const s1 = await ctx.device.project.git.status({ projectId: ctx.project.projectId }) as { branch: string; isClean: boolean; files: unknown[] };
    assert.equal(s1.isClean, true);
    assert.ok(["master", "main"].includes(s1.branch));
    writeFileSync(join(ctx.project.path, "new.txt"), "hello\n");
    const s2 = await ctx.device.project.git.status({ projectId: ctx.project.projectId }) as { isClean: boolean; files: Array<{ path: string; index: string }> };
    assert.equal(s2.isClean, false);
    assert.ok(s2.files.some(f => f.path === "new.txt"));
  } finally { await ctx.cleanup(); }
});

test("git.commit: 改文件后 commit; 返回 sha 和 filesChanged", { timeout: 15000 }, async () => {
  const ctx = await setup();
  try {
    writeFileSync(join(ctx.project.path, "a.txt"), "A\n");
    writeFileSync(join(ctx.project.path, "b.txt"), "B\n");
    const r = await ctx.device.project.git.commit({
      projectId: ctx.project.projectId,
      message: "add a/b",
      author: { name: "t", email: "t@x" },
    }) as { commitSha: string; filesChanged: number; insertions?: number };
    assert.match(r.commitSha, /^[0-9a-f]{40}$/);
    assert.equal(r.filesChanged, 2);
    assert.equal(r.insertions, 2);
  } finally { await ctx.cleanup(); }
});

test("git.log: 列出最近 N 个 commit", { timeout: 15000 }, async () => {
  const ctx = await setup();
  try {
    for (let i = 0; i < 3; i++) {
      writeFileSync(join(ctx.project.path, `f${i}.txt`), `${i}\n`);
      await ctx.device.project.git.commit({ projectId: ctx.project.projectId, message: `c${i}`, author: { name: "t", email: "t@x" } });
    }
    const r = await ctx.device.project.git.log({ projectId: ctx.project.projectId, limit: 10 }) as { commits: Array<{ sha: string; subject: string; author: string }> };
    assert.equal(r.commits.length, 4); // init + c0/c1/c2
    assert.equal(r.commits[0]?.subject, "c2"); // 最新在前
    assert.equal(r.commits[3]?.subject, "init");
  } finally { await ctx.cleanup(); }
});

test("git.diff: HEAD~1 vs HEAD 显示新文件", { timeout: 15000 }, async () => {
  const ctx = await setup();
  try {
    writeFileSync(join(ctx.project.path, "new.txt"), "hello world\n");
    await ctx.device.project.git.commit({ projectId: ctx.project.projectId, message: "add new", author: { name: "t", email: "t@x" } });
    const r = await ctx.device.project.git.diff({
      projectId: ctx.project.projectId,
      ref1: "HEAD~1", ref2: "HEAD",
    }) as { patch?: string; filesChanged: number; insertions: number };
    assert.equal(r.filesChanged, 1);
    assert.equal(r.insertions, 1);
    assert.match(r.patch ?? "", /\+hello world/);
  } finally { await ctx.cleanup(); }
});

test("git.diff statOnly: 只返回 stat，不返回 patch", { timeout: 15000 }, async () => {
  const ctx = await setup();
  try {
    writeFileSync(join(ctx.project.path, "x.txt"), "xxx\n");
    await ctx.device.project.git.commit({ projectId: ctx.project.projectId, message: "x", author: { name: "t", email: "t@x" } });
    const r = await ctx.device.project.git.diff({
      projectId: ctx.project.projectId, ref1: "HEAD~1", ref2: "HEAD", statOnly: true,
    }) as { patch?: string; filesChanged: number };
    assert.equal(r.filesChanged, 1);
    assert.equal(r.patch, undefined);
  } finally { await ctx.cleanup(); }
});

test("git.merge: 合并 feature branch 到 master (ff)", { timeout: 15000 }, async () => {
  const ctx = await setup();
  try {
    // 创 feature 分支并加 commit
    execSync(`git -C ${ctx.project.path} checkout -b feat`);
    writeFileSync(join(ctx.project.path, "feat.txt"), "feat\n");
    execSync(`git -C ${ctx.project.path} -c user.email=t@x -c user.name=t add . && git -C ${ctx.project.path} -c user.email=t@x -c user.name=t commit -q -m feat`);
    execSync(`git -C ${ctx.project.path} checkout master 2>/dev/null || git -C ${ctx.project.path} checkout main`);
    const r = await ctx.device.project.git.merge({
      projectId: ctx.project.projectId,
      sourceBranch: "feat",
      strategy: "merge",
      message: "merge feat",
    }) as { commitSha?: string; mergeCommitCreated: boolean; hasConflict: boolean };
    assert.equal(r.hasConflict, false);
    assert.equal(r.mergeCommitCreated, true);
    assert.match(r.commitSha ?? "", /^[0-9a-f]{40}$/);
    // 合并后 feat.txt 在主分支可见
    assert.equal(readFileSync(join(ctx.project.path, "feat.txt"), "utf8"), "feat\n");
  } finally { await ctx.cleanup(); }
});

test("git.merge: 冲突时 abortOnConflict=true 自动回滚", { timeout: 15000 }, async () => {
  const ctx = await setup();
  try {
    // 主分支改 README
    writeFileSync(join(ctx.project.path, "README.md"), "main\n");
    await ctx.device.project.git.commit({ projectId: ctx.project.projectId, message: "main edit", author: { name: "t", email: "t@x" } });
    // feature 分支也改同文件
    execSync(`git -C ${ctx.project.path} checkout -b feat HEAD~1`);
    writeFileSync(join(ctx.project.path, "README.md"), "feat\n");
    execSync(`git -C ${ctx.project.path} -c user.email=t@x -c user.name=t add . && git -C ${ctx.project.path} -c user.email=t@x -c user.name=t commit -q -m feat`);
    execSync(`git -C ${ctx.project.path} checkout master 2>/dev/null || git -C ${ctx.project.path} checkout main`);
    const r = await ctx.device.project.git.merge({
      projectId: ctx.project.projectId, sourceBranch: "feat", strategy: "merge",
    }) as { hasConflict: boolean; aborted?: boolean; conflictFiles?: string[] };
    assert.equal(r.hasConflict, true);
    assert.equal(r.aborted, true);
    assert.ok(r.conflictFiles?.includes("README.md"));
    // 回滚后主分支内容仍是 main
    assert.equal(readFileSync(join(ctx.project.path, "README.md"), "utf8"), "main\n");
  } finally { await ctx.cleanup(); }
});

test("git.status: ahead/behind 上游", { timeout: 15000 }, async () => {
  const ctx = await setup();
  try {
    // 没有 upstream → ahead/behind/upstream 都 undefined
    const r = await ctx.device.project.git.status({ projectId: ctx.project.projectId }) as { upstream?: string; ahead?: number };
    assert.equal(r.upstream, undefined);
    assert.equal(r.ahead, undefined);
  } finally { await ctx.cleanup(); }
});
