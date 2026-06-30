import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { AdapterRegistry, PhononStore, ProjectManager, nextCronAfter, assertSecureServerUrl } from "@agent-phonon/core";
import { MockAdapter, TestConn } from "./harness.js";

/**
 * 安全 review 修复回归测试（2026-06-30）。锁住：
 *  A1 git 参数注入被拒
 *  B1 tenant 越权被拒
 *  B2 skill localPath 默认禁
 *  B3 cron DoS 被拦 + 不可能日期快速返回 + 闰年不误杀
 *  B4 L4 consent 被 subscribe 绕过被拒
 */

function setup(opts?: { tenantId?: string; store?: PhononStore }) {
  const reg = new AdapterRegistry();
  reg.register(new MockAdapter({ name: "mock", agentIds: ["mock:default"], models: ["m1"], reply: (i) => `ok:${i}` }));
  const store = opts?.store ?? new PhononStore(join(mkdtempSync(join(tmpdir(), "phonon-sec-")), "db.sqlite"));
  const tc = new TestConn({ registry: reg, trustLocal: true, store, tenantId: opts?.tenantId });
  return { tc, store, reg };
}

function gitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "phonon-git-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  execFileSync("git", ["-c", "user.email=a@b.c", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"], { cwd: dir });
  return dir;
}

// ===========================================================================
// A1 — git argument injection
// ===========================================================================

test("A1: gitLog rejects '-'-prefixed branch (option injection), no file written", async () => {
  const dir = gitRepo();
  const pm = new ProjectManager(() => [], {});
  const proj = await pm.create({ name: "g", path: dir, git: true });

  const evil = "--output=" + join(dir, "PWNED.txt");
  await assert.rejects(
    () => pm.gitLog({ projectId: proj.projectId, branch: evil }),
    /must not start with '-'|option injection|disallowed/,
  );
  assert.ok(!existsSync(join(dir, "PWNED.txt")), "no file written outside sandbox via git --output");

  await assert.rejects(
    () => pm.gitPush({ projectId: proj.projectId, branch: "main", remote: "--receive-pack=touch /tmp/x" }),
    /must not start with '-'|option injection/,
  );
  await assert.rejects(
    () => pm.gitDiff({ projectId: proj.projectId, ref1: "--output=/tmp/y" }),
    /must not start with '-'|disallowed/,
  );
  rmSync(dir, { recursive: true, force: true });
});

test("A1: legitimate branch names still work", async () => {
  const dir = gitRepo();
  const pm = new ProjectManager(() => [], {});
  const proj = await pm.create({ name: "g2", path: dir, git: true });
  const r = await pm.gitLog({ projectId: proj.projectId, branch: "main" });
  assert.ok(Array.isArray(r.commits));
  rmSync(dir, { recursive: true, force: true });
});

// ===========================================================================
// B1 — tenant isolation on by-id paths
// ===========================================================================

test("B1: tenant B cannot read/trigger/delete tenant A's schedule by id", async () => {
  const store = new PhononStore(join(mkdtempSync(join(tmpdir(), "phonon-b1-")), "db.sqlite"));
  const a = setup({ tenantId: "tenant-A", store });
  const b = setup({ tenantId: "tenant-B", store }); // 共享 store，模拟 daemon 多 server

  const pA = (await a.tc.call("project.create", { name: "pa", git: false })) as { project: { projectId: string } };
  const created = (await a.tc.call("schedule.create", {
    name: "secret", trigger: { kind: "manual" },
    target: { runKind: "session", project: pA.project.projectId, agent: "mock:default", model: "m1", prompt: "x" },
  })) as { schedule: { id: string } };

  const notFound = (e: { data?: { appCode?: string } }) => e?.data?.appCode === "errInvalidParams";
  await assert.rejects(() => b.tc.call("schedule.get", { scheduleId: created.schedule.id }), notFound);
  await assert.rejects(() => b.tc.call("schedule.trigger", { scheduleId: created.schedule.id }), notFound);
  await assert.rejects(() => b.tc.call("schedule.runs.list", { scheduleId: created.schedule.id }), notFound);
  const del = (await b.tc.call("schedule.delete", { scheduleId: created.schedule.id })) as { deleted: boolean };
  assert.equal(del.deleted, false, "tenant B delete must be a no-op");

  const ok = (await a.tc.call("schedule.get", { scheduleId: created.schedule.id })) as { schedule: { id: string } };
  assert.equal(ok.schedule.id, created.schedule.id);
  store.close();
});

// ===========================================================================
// B2 — skill localPath default-deny
// ===========================================================================

test("B2: skill.install localPath denied by default policy", async () => {
  const reg = new AdapterRegistry();
  reg.register(new MockAdapter({ name: "mock", agentIds: ["mock:default"], models: ["m1"] }));
  const store = new PhononStore(join(mkdtempSync(join(tmpdir(), "phonon-b2-")), "db.sqlite"));
  const tc = new TestConn({ registry: reg, trustLocal: false, store });
  await assert.rejects(
    () => tc.call("skill.install", { agent: "mock:default", name: "x", scope: "project", projectId: "p", source: { kind: "localPath", path: "/etc" } }),
    (e: { data?: { appCode?: string } }) => e?.data?.appCode === "errPolicyDenied",
  );
  store.close();
});

// ===========================================================================
// B3 — cron DoS
// ===========================================================================

test("B3: impossible-date cron returns fast (no multi-second freeze)", () => {
  const t0 = Date.now();
  const r = nextCronAfter("0 0 30 2 *", new Date("2026-06-30T00:00:00Z"), "UTC");
  const dt = Date.now() - t0;
  assert.equal(r, undefined, "Feb 30 never fires");
  assert.ok(dt < 1000, `must return in <1s (was ${dt}ms)`);
});

test("B3: leap-year Feb 29 still computed correctly (not false-killed)", () => {
  const r = nextCronAfter("0 0 29 2 *", new Date("2026-06-30T00:00:00Z"), "UTC");
  assert.ok(r, "Feb 29 schedule must still fire");
  assert.equal(r!.toISOString(), "2028-02-29T00:00:00.000Z");
});

test("B3: schedule.create rejects impossible / malformed cron expr", async () => {
  const { tc, store } = setup();
  const p = (await tc.call("project.create", { name: "p", git: false })) as { project: { projectId: string } };
  const invalid = (e: { data?: { appCode?: string } }) => e?.data?.appCode === "errInvalidParams";
  await assert.rejects(
    () => tc.call("schedule.create", {
      name: "bad", trigger: { kind: "cron", expr: "0 0 30 2 *" },
      target: { runKind: "session", project: p.project.projectId, agent: "mock:default", model: "m1", prompt: "x" },
    }),
    invalid,
  );
  await assert.rejects(
    () => tc.call("schedule.create", {
      name: "bad2", trigger: { kind: "cron", expr: "* * *" },
      target: { runKind: "session", project: p.project.projectId, agent: "mock:default", model: "m1", prompt: "x" },
    }),
    invalid,
  );
  store.close();
});

// ===========================================================================
// B4 — L4 consent bypass via subscribe
// ===========================================================================

test("B4: run.events.subscribe denied for non-full consent (status-only)", async () => {
  const { tc, store } = setup();
  const p = (await tc.call("project.create", { name: "p", git: false })) as { project: { projectId: string } };
  const created = (await tc.call("schedule.create", {
    name: "sens", trigger: { kind: "manual" },
    target: { runKind: "session", project: p.project.projectId, agent: "mock:default", model: "m1", prompt: "secret" },
    consent: { push: "status-only" },
  })) as { schedule: { id: string } };
  const trig = (await tc.call("schedule.trigger", { scheduleId: created.schedule.id })) as { runId: string };
  await assert.rejects(
    () => tc.call("run.events.subscribe", { runId: trig.runId }),
    (e: { data?: { appCode?: string } }) => e?.data?.appCode === "errPolicyDenied",
    "status-only run must not be subscribable",
  );
  store.close();
});

// ===========================================================================
// A2/A3 — project.exec gating + env stripping
// ===========================================================================

test("A2/A3: project.exec denied when allowExec=false (strict policy)", async () => {
  const reg = new AdapterRegistry();
  reg.register(new MockAdapter({ name: "mock", agentIds: ["mock:default"], models: ["m1"] }));
  const store = new PhononStore(join(mkdtempSync(join(tmpdir(), "phonon-a2-")), "db.sqlite"));
  // 严格 policy（非 trustLocal）：exec 需显式 allowExec，默认拒
  const tc = new TestConn({ registry: reg, trustLocal: false, store, policy: { allowedProjectRoots: [tmpdir()] } });
  const proj = (await tc.call("project.create", { name: "e", path: join(mkdtempSync(join(tmpdir(), "phonon-a2p-"))), git: false })) as { project: { projectId: string } };
  await assert.rejects(
    () => tc.call("project.exec", { projectId: proj.project.projectId, command: "echo", args: ["hi"] }),
    (e: { data?: { appCode?: string } }) => e?.data?.appCode === "errPolicyDenied",
    "exec must be denied without allowExec",
  );
  store.close();
});

test("A2/A3: trustLocal allows exec; dangerous env stripped", async () => {
  const reg = new AdapterRegistry();
  reg.register(new MockAdapter({ name: "mock", agentIds: ["mock:default"], models: ["m1"] }));
  const store = new PhononStore(join(mkdtempSync(join(tmpdir(), "phonon-a3s-")), "db.sqlite"));
  // 显式 policy：allowExec=true + 允许 /tmp 项目根
  const tc = new TestConn({ registry: reg, store, policy: { allowExec: true, allowedProjectRoots: [tmpdir()] } });
  const dir = mkdtempSync(join(tmpdir(), "phonon-a3-"));
  const proj = (await tc.call("project.create", { name: "e3", path: dir, git: false })) as { project: { projectId: string } };
  // 注入 LD_PRELOAD/NODE_OPTIONS/PATH → 必须被剔除，不能出现在子进程 env
  const r = (await tc.call("project.exec", {
    projectId: proj.project.projectId,
    command: process.execPath,
    args: ["-e", "process.stdout.write(JSON.stringify({ld:process.env.LD_PRELOAD||null, no:process.env.NODE_OPTIONS||null, hasPath: !!process.env.PATH}))"],
    env: { LD_PRELOAD: "/tmp/evil.so", NODE_OPTIONS: "--require /tmp/evil.js", PATH: "/tmp/evil", SAFE_VAR: "ok" },
  })) as { exitCode: number; stdout: string };
  assert.equal(r.exitCode, 0);
  const out = JSON.parse(r.stdout) as { ld: string | null; no: string | null; hasPath: boolean };
  assert.equal(out.ld, null, "LD_PRELOAD must be stripped");
  assert.equal(out.no, null, "NODE_OPTIONS must be stripped");
  assert.ok(out.hasPath, "PATH still inherited from process.env (not overwritten by attacker)");
  rmSync(dir, { recursive: true, force: true });
  store.close();
});

// ===========================================================================
// A4 — device.fs browse gate
// ===========================================================================

test("A4: device.fs.list denied when allowDeviceFsBrowse=false", async () => {
  const reg = new AdapterRegistry();
  reg.register(new MockAdapter({ name: "mock", agentIds: ["mock:default"], models: ["m1"] }));
  const store = new PhononStore(join(mkdtempSync(join(tmpdir(), "phonon-a4-")), "db.sqlite"));
  const tc = new TestConn({ registry: reg, trustLocal: true, store, policy: { allowDeviceFsBrowse: false, allowedProjectRoots: [tmpdir()] } });
  await assert.rejects(
    () => tc.call("device.fs.list", { root: "home", path: "." }),
    (e: { data?: { appCode?: string } }) => e?.data?.appCode === "errPolicyDenied",
  );
  await assert.rejects(
    () => tc.call("device.fs.roots", {}),
    (e: { data?: { appCode?: string } }) => e?.data?.appCode === "errPolicyDenied",
  );
  store.close();
});

test("A4: device.fs.list allowed by default (capability preserved)", async () => {
  const { tc, store } = setup(); // 默认 allowDeviceFsBrowse=true
  const r = (await tc.call("device.fs.roots", {})) as { roots: unknown[] };
  assert.ok(Array.isArray(r.roots) && r.roots.length > 0, "browse still works by default");
  store.close();
});

// ===========================================================================
// A5 — server transport security + identity
// ===========================================================================

test("A5: assertSecureServerUrl rejects non-loopback ws://, allows loopback + wss", () => {
  // 非 loopback 明文 → 拒
  assert.throws(() => assertSecureServerUrl("ws://1.2.3.4:8080"), /insecure ws|non-loopback/);
  assert.throws(() => assertSecureServerUrl("ws://example.com"), /insecure ws|non-loopback/);
  // loopback 明文 → 放行
  assert.doesNotThrow(() => assertSecureServerUrl("ws://127.0.0.1:4000"));
  assert.doesNotThrow(() => assertSecureServerUrl("ws://localhost:4000"));
  // wss → 始终放行
  assert.doesNotThrow(() => assertSecureServerUrl("wss://example.com"));
  // 显式 allowInsecure → 绕过
  assert.doesNotThrow(() => assertSecureServerUrl("ws://1.2.3.4", true));
});
