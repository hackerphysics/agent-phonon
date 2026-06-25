import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { AdapterRegistry } from "@agent-phonon/core";
import { MockAdapter, TestConn } from "./harness.js";

/** project + worktree + git + skill 功能覆盖。 */

function setup(trustLocal = true) {
  const reg = new AdapterRegistry();
  const skillRoot = mkdtempSync(join(tmpdir(), "phonon-gskill-"));
  reg.register(new MockAdapter({ name: "mock", agentIds: ["mock:default"], globalSkillDir: (a) => join(skillRoot, a.replace(":", "-"), "skills") }));
  const root = mkdtempSync(join(tmpdir(), "phonon-pj-"));
  const tc = new TestConn({ registry: reg, workspaceRoot: root, trustLocal });
  return { tc, root, reg };
}

// ============ project ============
test("project: create → list → get → remove", async () => {
  const { tc } = setup();
  const c = (await tc.call("project.create", { name: "demo", git: false })) as { project: { projectId: string; path: string } };
  assert.ok(c.project.projectId);
  assert.ok(existsSync(c.project.path));
  const list = (await tc.call("project.list", {})) as { projects: unknown[] };
  assert.equal(list.projects.length, 1);
  const get = (await tc.call("project.get", { projectId: c.project.projectId })) as { project: { name: string } };
  assert.equal(get.project.name, "demo");
  const rm = (await tc.call("project.remove", { projectId: c.project.projectId, deleteFiles: true })) as { removed: boolean; filesDeleted: boolean };
  assert.equal(rm.removed, true);
  assert.equal(rm.filesDeleted, true);
  assert.equal(existsSync(c.project.path), false);
});

test("project.create path outside workspace rejected by policy", async () => {
  const { tc } = setup(false); // strict policy
  await assert.rejects(() => tc.call("project.create", { name: "evil", path: "/etc/evil", git: false }), (e: { data?: { appCode?: string } }) => e?.data?.appCode === "errPolicyDenied");
});

test("project.remove deleteFiles denied without policy", async () => {
  const { tc } = setup(false);
  // strict policy 下 project.create 会被拒（path 不在白名单），换 trustLocal 建再切？这里直接测 deleteFiles 拒
  // strict 默认 allowedProjectRoots 含 workspaceRoot，create 应可（缺省 path 在 root 下）
  const c = (await tc.call("project.create", { name: "p", git: false })) as { project: { projectId: string } };
  await assert.rejects(() => tc.call("project.remove", { projectId: c.project.projectId, deleteFiles: true }), (e: { data?: { appCode?: string } }) => e?.data?.appCode === "errPolicyDenied");
});

test("project.exec runs command in project sandbox and returns structured output", async () => {
  const { tc } = setup();
  const c = (await tc.call("project.create", { name: "exec-demo", git: false })) as { project: { projectId: string; path: string } };
  const r = (await tc.call("project.exec", { projectId: c.project.projectId, command: process.execPath, args: ["-e", "console.log(process.cwd()); console.error('ERRLINE')"], maxOutputBytes: 10000 })) as { exitCode: number; stdout: string; stderr: string; durationMs: number; truncated: boolean };
  assert.equal(r.exitCode, 0);
  assert.equal(r.stdout.trim(), c.project.path);
  assert.match(r.stderr, /ERRLINE/);
  assert.equal(r.truncated, false);
  assert.ok(r.durationMs >= 0);
});

test("project.exec rejects cwd escaping project root", async () => {
  const { tc } = setup();
  const c = (await tc.call("project.create", { name: "exec-escape", git: false })) as { project: { projectId: string } };
  await assert.rejects(() => tc.call("project.exec", { projectId: c.project.projectId, command: process.execPath, cwd: "..", args: ["-e", "console.log('no')"] }), (e: { data?: { appCode?: string } }) => e?.data?.appCode === "errPolicyDenied");
});

test("project.remove with active session → errProjectHasActiveSessions", async () => {
  const { tc } = setup();
  const c = (await tc.call("project.create", { name: "p", git: false })) as { project: { projectId: string } };
  await tc.call("session.create", { project: c.project.projectId, agent: "mock:default", model: "m1", verbosity: "messages" });
  await assert.rejects(() => tc.call("project.remove", { projectId: c.project.projectId }), (e: { data?: { appCode?: string } }) => e?.data?.appCode === "errProjectHasActiveSessions");
});

test("project.remove cascade terminates sessions", async () => {
  const { tc } = setup();
  const c = (await tc.call("project.create", { name: "p", git: false })) as { project: { projectId: string } };
  const s = (await tc.call("session.create", { project: c.project.projectId, agent: "mock:default", model: "m1", verbosity: "messages" })) as { sessionId: string };
  const rm = (await tc.call("project.remove", { projectId: c.project.projectId, whenActiveSessions: "cascade" })) as { terminatedSessions: string[] };
  assert.ok(rm.terminatedSessions.includes(s.sessionId));
});

// ============ worktree + git ============
function hasGit(): boolean {
  return spawnSync("git", ["--version"]).status === 0;
}

test("worktree: create → list → remove + branch delete", { skip: !hasGit() ? "git not available" : false }, async () => {
  const { tc } = setup();
  const c = (await tc.call("project.create", { name: "wt-demo", git: true })) as { project: { projectId: string; path: string } };
  // 需要一个初始提交才能建 worktree
  const cwd = c.project.path;
  spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-m", "init"], { cwd });
  const branch = spawnSync("git", ["branch", "--show-current"], { cwd }).stdout.toString().trim() || "main";

  const wt = (await tc.call("project.worktree.create", { projectId: c.project.projectId, baseBranch: branch, newBranch: "feat/x" })) as { worktree: { worktreeId: string; path: string } };
  assert.ok(existsSync(wt.worktree.path));
  const list = (await tc.call("project.worktree.list", { projectId: c.project.projectId })) as { worktrees: unknown[] };
  assert.equal(list.worktrees.length, 1);
  const rm = (await tc.call("project.worktree.remove", { projectId: c.project.projectId, worktreeId: wt.worktree.worktreeId, force: true })) as { removed: boolean };
  assert.equal(rm.removed, true);
  const del = (await tc.call("project.git.deleteBranch", { projectId: c.project.projectId, branch: "feat/x", force: true })) as { deleted: boolean };
  assert.equal(del.deleted, true);
});

// ============ skill ============
function makeTarGz(dir: string): { contentBase64: string; sha256: string } {
  const archive = join(dir, "skill.tar.gz");
  execFileSync("tar", ["-czf", archive, "-C", join(dir, "src"), "."]);
  const buf = readFileSync(archive);
  return { contentBase64: buf.toString("base64"), sha256: createHash("sha256").update(buf).digest("hex") };
}

test("skill: install project scope → list → uninstall", async () => {
  const { tc } = setup();
  const c = (await tc.call("project.create", { name: "p", git: false })) as { project: { projectId: string; path: string } };
  const inst = (await tc.call("skill.install", {
    agent: "mock:default", name: "my-skill", scope: "project", projectId: c.project.projectId,
    source: { kind: "inline", files: { "SKILL.md": "# My Skill" } },
  })) as { skill: { installedPath: string } };
  assert.ok(inst.skill.installedPath.startsWith(join(c.project.path, ".agent", "skills")));
  assert.ok(existsSync(join(inst.skill.installedPath, "SKILL.md")));
  const list = (await tc.call("skill.list", { projectId: c.project.projectId })) as { skills: unknown[] };
  assert.equal(list.skills.length, 1);
  const dirs = (await tc.call("skill.dirs", { projectId: c.project.projectId, scope: "project" })) as { directories: Array<{ name: string; path: string; rootPath: string; scope: string; exists: boolean }> };
  assert.deepEqual(dirs.directories.map((d) => [d.name, d.scope, d.exists]), [["my-skill", "project", true]]);
  assert.equal(dirs.directories[0]!.path, inst.skill.installedPath);
  await tc.call("skill.uninstall", { agent: "mock:default", name: "my-skill", scope: "project", projectId: c.project.projectId });
  const list2 = (await tc.call("skill.list", {})) as { skills: unknown[] };
  assert.equal(list2.skills.length, 0);
  assert.equal(existsSync(join(inst.skill.installedPath, "SKILL.md")), false);
});

test("skill: install archive tar.gz package", async () => {
  const { tc } = setup();
  const c = (await tc.call("project.create", { name: "p", git: false })) as { project: { projectId: string; path: string } };
  const tmp = mkdtempSync(join(tmpdir(), "phonon-skill-archive-"));
  mkdirSync(join(tmp, "src", "scripts"), { recursive: true });
  writeFileSync(join(tmp, "src", "SKILL.md"), "# Archive Skill");
  writeFileSync(join(tmp, "src", "scripts", "run.sh"), "echo ok\n");
  const pkg = makeTarGz(tmp);
  const inst = (await tc.call("skill.install", {
    agent: "mock:default", name: "archive-skill", scope: "project", projectId: c.project.projectId,
    source: { kind: "archive", format: "tar.gz", ...pkg },
  })) as { skill: { installedPath: string; hash: string } };
  assert.equal(inst.skill.hash, pkg.sha256);
  assert.ok(existsSync(join(inst.skill.installedPath, "SKILL.md")));
  assert.ok(existsSync(join(inst.skill.installedPath, "scripts", "run.sh")));
});

test("skill: archive sha256 mismatch rejected", async () => {
  const { tc } = setup();
  const c = (await tc.call("project.create", { name: "p", git: false })) as { project: { projectId: string } };
  const tmp = mkdtempSync(join(tmpdir(), "phonon-skill-archive-"));
  mkdirSync(join(tmp, "src"), { recursive: true });
  writeFileSync(join(tmp, "src", "SKILL.md"), "# Bad");
  const pkg = makeTarGz(tmp);
  await assert.rejects(() => tc.call("skill.install", {
    agent: "mock:default", name: "bad-archive", scope: "project", projectId: c.project.projectId,
    source: { kind: "archive", format: "tar.gz", contentBase64: pkg.contentBase64, sha256: "0".repeat(64) },
  }), (e: { data?: { appCode?: string } }) => e?.data?.appCode === "errSkillInstallFailed");
});

test("skill: global scope → adapter runtime dir", async () => {
  const { tc } = setup();
  const inst = (await tc.call("skill.install", {
    agent: "mock:default", name: "g-skill", scope: "global",
    source: { kind: "inline", files: { "SKILL.md": "# G" } },
  })) as { skill: { installedPath: string } };
  assert.ok(inst.skill.installedPath.includes("mock-default"));
  const dirs = (await tc.call("skill.dirs", { agent: "mock:default", scope: "global" })) as { directories: Array<{ name: string; path: string; rootPath: string; scope: string; exists: boolean }> };
  assert.deepEqual(dirs.directories.map((d) => [d.name, d.scope, d.exists]), [["g-skill", "global", true]]);
  assert.equal(dirs.directories[0]!.path, inst.skill.installedPath);
});

test("skill: url install denied by policy", async () => {
  const { tc } = setup();
  await assert.rejects(() => tc.call("skill.install", { agent: "mock:default", name: "u", scope: "global", source: { kind: "url", url: "https://x/s.zip" } }), (e: { data?: { appCode?: string } }) => e?.data?.appCode === "errPolicyDenied");
});

export {};
