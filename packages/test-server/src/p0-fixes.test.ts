import { test } from "node:test";
import assert from "node:assert/strict";
import { SessionEngine, AdapterRegistry, IdempotencyStore, PolicyEnforcer } from "@agent-phonon/core";
import type { AgentAdapter, AdapterSession } from "@agent-phonon/core";

/** 假 adapter：send 立即 emit 一个 result，可控延迟模拟并发。 */
function fakeAdapter(opts?: { sendDelayMs?: number }): AgentAdapter {
  const cap = {
    nativeSession: true, nativeCompression: true, contextInjection: true,
    proactiveOutput: true, modelSwitch: true, interrupt: true, injectMidTurn: false,
    skillManagement: true, hooks: [], streaming: true,
  };
  return {
    name: "fake",
    capabilities: cap as never,
    async discoverAgents() {
      return [{ agentId: "fake:a" as never, displayName: "Fake", adapter: "fake", available: true, models: [{ id: "m", available: true }], capabilities: cap as never }];
    },
    async createSession(p): Promise<AdapterSession> {
      let unsolicited: ((e: never) => void) | undefined;
      return {
        sessionId: p.sessionId,
        model: p.model,
        async send(_input, o) {
          if (opts?.sendDelayMs) await new Promise((r) => setTimeout(r, opts.sendDelayMs));
          o.emit({ type: "result", sessionId: p.sessionId, turnId: o.turnId, seq: 0, at: new Date().toISOString(), text: "ok", status: "completed", final: true } as never);
        },
        async interrupt() {},
        async terminate() {},
        setUnsolicitedSink(s) { unsolicited = s as never; },
        // 暴露给测试触发自发输出
        _emitUnsolicited: () => unsolicited?.({ type: "message", sessionId: p.sessionId, turnId: "u-1", origin: "unsolicited", source: "cron", seq: 0, at: new Date().toISOString(), role: "assistant", text: "cron bubble", delta: false } as never),
      } as AdapterSession & { _emitUnsolicited: () => void };
    },
  };
}

test("P0#3 whenBusy=queue: concurrent sends serialize via FIFO", async () => {
  const reg = new AdapterRegistry();
  reg.register(fakeAdapter({ sendDelayMs: 50 }));
  const events: string[] = [];
  const engine = new SessionEngine(reg, (e) => events.push((e as { turnId: string }).turnId));
  const c = await engine.create({ tenantId: "t", project: "p", cwd: "/tmp", agent: "fake:a", model: "m", verbosity: "messages" });

  const a1 = await engine.send("t", c.sessionId, "first", { turnId: "T1" });
  assert.equal(a1.disposition, "started");
  // 第二条在 running 时进来 → 默认 queue
  const a2 = await engine.send("t", c.sessionId, "second", { turnId: "T2", whenBusy: "queue" });
  assert.equal(a2.disposition, "queued");
  assert.equal(a2.queuePosition, 1);

  await new Promise((r) => setTimeout(r, 200));
  // 两轮都最终 emit 了 result（FIFO 顺序）
  assert.ok(events.includes("T1") && events.includes("T2"));
  assert.ok(events.indexOf("T1") < events.indexOf("T2"), "T1 before T2");
});

test("P0#3 fallback: interrupt unsupported → downgrade to queue", async () => {
  const reg = new AdapterRegistry();
  const ad = fakeAdapter({ sendDelayMs: 50 });
  (ad.capabilities as { interrupt: boolean }).interrupt = false;
  reg.register(ad);
  const engine = new SessionEngine(reg, () => {});
  const c = await engine.create({ tenantId: "t", project: "p", cwd: "/tmp", agent: "fake:a", model: "m", verbosity: "messages" });
  await engine.send("t", c.sessionId, "first", { turnId: "T1" });
  const a2 = await engine.send("t", c.sessionId, "second", { turnId: "T2", whenBusy: "interrupt", fallback: "queue" });
  assert.equal(a2.disposition, "queued"); // 降级
});

test("P0#7 unsolicited output flows to sink with origin", async () => {
  const reg = new AdapterRegistry();
  reg.register(fakeAdapter());
  const got: Array<{ origin?: string; source?: string }> = [];
  const engine = new SessionEngine(reg, (e) => got.push(e as never));
  const c = await engine.create({ tenantId: "t", project: "p", cwd: "/tmp", agent: "fake:a", model: "m", verbosity: "messages" });
  const rec = (engine as unknown as { sessions: Map<string, { adapterSession: { _emitUnsolicited: () => void } }> }).sessions.get(c.sessionId);
  rec!.adapterSession._emitUnsolicited();
  assert.equal(got.length, 1);
  assert.equal(got[0]!.origin, "unsolicited");
  assert.equal(got[0]!.source, "cron");
});

test("P0#8 activeSessionsForProject reflects real sessions", async () => {
  const reg = new AdapterRegistry();
  reg.register(fakeAdapter());
  const engine = new SessionEngine(reg, () => {});
  const c = await engine.create({ tenantId: "t", project: "projX", cwd: "/tmp", agent: "fake:a", model: "m", verbosity: "messages" });
  assert.deepEqual(engine.activeSessionsForProject("projX"), [c.sessionId]);
  await engine.terminate("t", c.sessionId);
  assert.deepEqual(engine.activeSessionsForProject("projX"), []); // terminated 不算
});

test("P0#2 idempotency: same clientRequestId runs once", async () => {
  const store = new IdempotencyStore();
  let n = 0;
  const fn = async () => ++n;
  const a = await store.run("t", "m", "req1", fn);
  const b = await store.run("t", "m", "req1", fn);
  assert.equal(a, b);
  assert.equal(n, 1);
  await store.run("t", "m", "req2", fn);
  assert.equal(n, 2);
  // 无 clientRequestId → 不去重
  await store.run("t", "m", undefined, fn);
  await store.run("t", "m", undefined, fn);
  assert.equal(n, 4);
});

test("P0#1 policy: strict default rejects; trustLocal allows workspace", () => {
  const strict = new PolicyEnforcer();
  assert.throws(() => strict.assertProjectPath("/etc/x"), (e: { appCode?: string }) => e.appCode === "errPolicyDenied");
  assert.throws(() => strict.assertDeleteFiles(), (e: { appCode?: string }) => e.appCode === "errPolicyDenied");
  const local = new PolicyEnforcer({ trustLocal: true, workspaceRoot: "/work" });
  local.assertProjectPath("/work/proj"); // ok
  local.assertDeleteFiles(); // ok
  assert.throws(() => local.assertUrlSkillInstall(), (e: { appCode?: string }) => e.appCode === "errPolicyDenied"); // url 仍拒
});

// ============ P1: Outbox 可靠投递 ============
import { Outbox } from "@agent-phonon/core";

test("P1 outbox: enqueue, ack prunes <= lastSeq, pending replays unacked", () => {
  const ob = new Outbox();
  const ev = (sessionId: string, seq: number) => ({ type: "message", sessionId, seq, turnId: "t", at: "now", text: "x" } as never);
  ob.enqueue(ev("s1", 0));
  ob.enqueue(ev("s1", 1));
  ob.enqueue(ev("s1", 2));
  ob.enqueue(ev("s2", 0));
  assert.equal(ob.size, 4);
  // ack s1 <= 1 → 清掉 s1:0,1
  ob.ack("s1", 1);
  assert.equal(ob.size, 2); // 剩 s1:2, s2:0
  // pending 返回未 ack 的，按 seq 排序
  const pend = ob.pending();
  assert.equal(pend.length, 2);
  // resumeFrom: server 说 s1 收到 1，s2 收到 -1 → 只补 s1:2 + s2:0
  const pend2 = ob.pending([{ sessionId: "s1", fromSeq: 1 }]);
  assert.ok(pend2.every((e: unknown) => (e as { sessionId: string; seq: number }).seq > 1 || (e as { sessionId: string }).sessionId === "s2"));
});

test("P1 outbox: maxEvents drops oldest", () => {
  const ob = new Outbox({ maxEvents: 3 });
  for (let i = 0; i < 5; i++) ob.enqueue({ type: "message", sessionId: "s", seq: i, turnId: "t", at: "now", text: "x" } as never);
  assert.equal(ob.size, 3);
  assert.equal(ob.dropped, 2);
});

test("P2 session.list pagination (limit + cursor)", async () => {
  const reg = new AdapterRegistry();
  reg.register(fakeAdapter());
  const engine = new SessionEngine(reg, () => {});
  const ids = [];
  for (let i = 0; i < 5; i++) {
    const c = await engine.create({ tenantId: "t", project: "p", cwd: "/tmp", agent: "fake:a", model: "m", verbosity: "messages" });
    ids.push(c.sessionId);
    await new Promise((r) => setTimeout(r, 2));
  }
  const page1 = engine.list("t", { limit: 2 });
  assert.equal(page1.sessions.length, 2);
  assert.ok(page1.nextCursor);
  const page2 = engine.list("t", { limit: 2, cursor: page1.nextCursor });
  assert.equal(page2.sessions.length, 2);
  // 不重叠
  assert.notEqual(page1.sessions[0].sessionId, page2.sessions[0].sessionId);
});

// ============ B3: sqlite 持久化 ============
import { PhononStore, ProjectManager, SkillManager } from "@agent-phonon/core";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("B3 persistence: projects + skills survive restart", async () => {
  const dbPath = join(mkdtempSync(join(tmpdir(), "phonon-db-")), "p.db");
  const projRoot = mkdtempSync(join(tmpdir(), "phonon-proot-"));
  process.env.PHONON_PROJECTS_ROOT = projRoot;
  let projectId = "";

  // 第一次：写入
  {
    const store = new PhononStore(dbPath);
    const pm = new ProjectManager(() => [], { store });
    const p = await pm.create({ name: "persisted", git: false });
    projectId = p.projectId;
    const reg = new AdapterRegistry();
    reg.register(fakeAdapter());
    const sm = new SkillManager(reg, (pid) => (pid === p.projectId ? p.path : undefined), store);
    await sm.install({ agent: "fake:a", name: "sk", scope: "project", projectId: p.projectId, source: { kind: "inline", files: { "SKILL.md": "# x" } } });
    store.close();
  }
  // 第二次：重启恢复
  {
    const store = new PhononStore(dbPath);
    const pm = new ProjectManager(() => [], { store });
    assert.equal(pm.list().length, 1);
    assert.equal(pm.get(projectId).name, "persisted");
    const reg = new AdapterRegistry();
    const sm = new SkillManager(reg, () => undefined, store);
    assert.equal(sm.list().length, 1);
    assert.equal(sm.list()[0]!.name, "sk");
    store.close();
  }
});

test("B3 outbox persistence: unacked events survive restart", () => {
  const dbPath = join(mkdtempSync(join(tmpdir(), "phonon-ob-")), "ob.db");
  const ev = (seq: number) => ({ type: "message", sessionId: "s1", seq, turnId: "t", at: "now", text: "x" } as never);
  {
    const store = new PhononStore(dbPath);
    const ob = new Outbox({ store, tenantId: "tA" });
    ob.enqueue(ev(0)); ob.enqueue(ev(1)); ob.enqueue(ev(2));
    ob.ack("s1", 0); // 清 seq 0
    store.close();
  }
  {
    const store = new PhononStore(dbPath);
    const ob = new Outbox({ store, tenantId: "tA" });
    assert.equal(ob.size, 2); // seq 1,2 还在
    store.close();
  }
});

// ============ Bug-bash#2 B1: interrupt 竞态 + 单一终态 ============
test("B1 interrupt: single terminal event, no race override", async () => {
  const reg = new AdapterRegistry();
  // 慢 adapter：send 等信号或超时，emit 终态时若已被 interrupt 应被去重
  reg.register({
    name: "slow", capabilities: { interrupt: true } as never,
    async discoverAgents() { return []; },
    async createSession(p: { sessionId: string; model: string }) {
      return {
        sessionId: p.sessionId, model: p.model,
        async send(_i: unknown, o: { turnId: string; signal?: AbortSignal; emit: (e: unknown) => void }) {
          await new Promise((r) => { o.signal?.addEventListener("abort", r, { once: true }); setTimeout(r, 3000); });
          // adapter 在被 kill 后也 emit 一个终态（模拟 child close）
          o.emit({ type: "result", sessionId: p.sessionId, turnId: o.turnId, seq: 0, at: new Date().toISOString(), text: "late", status: "failed", final: true } as never);
        },
        async interrupt() {},
        async terminate() {},
      } as never;
    },
  } as never);
  const finals: string[] = [];
  const engine = new SessionEngine(reg, (e) => { if ((e as { final?: boolean }).final) finals.push((e as { status: string }).status); });
  const c = await engine.create({ tenantId: "t", project: "p", cwd: "/tmp", agent: "slow:a", model: "m", verbosity: "messages" });
  await engine.send("t", c.sessionId, "go", { turnId: "T1" });
  await new Promise((r) => setTimeout(r, 50));
  // interrupt 当前 turn
  const r = await engine.interrupt("t", c.sessionId);
  assert.equal(r.status, "idle");
  await new Promise((r) => setTimeout(r, 200));
  // 只能有一个终态（interrupted），adapter 的 late failed 被去重
  assert.equal(finals.length, 1, `expected 1 terminal, got ${finals.length}: ${finals}`);
  assert.equal(finals[0], "interrupted");
});

// ============ Bug-bash#2 B8: skill 路径穿越防护 ============
test("B8 skill path traversal blocked", async () => {
  const reg = new AdapterRegistry();
  reg.register(fakeAdapter());
  const projDir = mkdtempSync(join(tmpdir(), "skill-trav-"));
  const sm = new SkillManager(reg, () => projDir);
  // 恶意 name
  await assert.rejects(
    () => sm.install({ agent: "fake:a", name: "../../evil", scope: "project", projectId: "p", source: { kind: "inline", files: { "SKILL.md": "x" } } }),
    (e: { appCode?: string }) => e.appCode === "errSkillScopeInvalid",
  );
  // 恶意 inline 文件路径
  await assert.rejects(
    () => sm.install({ agent: "fake:a", name: "ok", scope: "project", projectId: "p", source: { kind: "inline", files: { "../../escape.sh": "evil" } } }),
    (e: { appCode?: string }) => e.appCode === "errSkillInstallFailed",
  );
});
