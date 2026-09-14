import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AdapterRegistry, PhononStore, SchedulerEngine } from "@agent-phonon/core";
import type { SessionEngine } from "@agent-phonon/core";
import { MockAdapter, TestConn } from "./harness.js";

/**
 * L4 scheduling 功能测试（通过 TestConn 走真实 dispatch 链路）。
 * 覆盖：schedule CRUD、manual trigger → run 终态、consent push 粒度、
 * webhook token 脱敏、workflow、queue/retry/catch-up/cancel、restart/dispose。
 */

function setup() {
  const dbPath = join(mkdtempSync(join(tmpdir(), "phonon-l4-")), "db.sqlite");
  const reg = new AdapterRegistry();
  reg.register(new MockAdapter({ name: "mock", agentIds: ["mock:default"], models: ["m1"], reply: (i) => `done:${i}` }));
  const store = new PhononStore(dbPath);
  const tc = new TestConn({ registry: reg, trustLocal: true, store });
  return { tc, store, dbPath, reg };
}

async function mkProject(tc: TestConn): Promise<string> {
  const p = (await tc.call("project.create", { name: "p", git: false })) as { project: { projectId: string } };
  return p.project.projectId;
}

/** 轮询等待某 run 进入终态。 */
async function waitRunFinished(tc: TestConn, runId: string, timeoutMs = 5000): Promise<Record<string, unknown>> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const r = (await tc.call("run.get", { runId })) as { run: Record<string, unknown> };
    const st = r.run.status as string;
    if (["success", "failed", "timeout", "cancelled", "skipped"].includes(st)) return r.run;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`run ${runId} did not finish`);
}

test("L4: create manual schedule + trigger → run reaches success", async () => {
  const { tc, store } = setup();
  const project = await mkProject(tc);

  const created = (await tc.call("schedule.create", {
    name: "smoke",
    trigger: { kind: "manual" },
    target: { runKind: "session", project, agent: "mock:default", model: "m1", prompt: "hello" },
    consent: { push: "summary" },
  })) as { schedule: { id: string }; webhookToken?: string };
  assert.ok(created.schedule.id);
  assert.equal(created.webhookToken, undefined, "manual schedule has no webhook token");

  const trig = (await tc.call("schedule.trigger", { scheduleId: created.schedule.id })) as { runId: string; status: string };
  assert.ok(trig.runId);

  const run = await waitRunFinished(tc, trig.runId);
  assert.equal(run.status, "success");
  assert.equal(run.triggerSource, "manual");
  assert.equal(run.resultText, "done:hello");
  assert.ok(run.sessionId, "run bound to a session");

  // runs.list 能看到这次执行
  const runs = (await tc.call("schedule.runs.list", { scheduleId: created.schedule.id })) as { runs: Array<{ id: string; status: string }> };
  assert.equal(runs.runs.length, 1);
  assert.equal(runs.runs[0]!.status, "success");

  store.close();
});

test("L4: schedule.create rejects an unregistered absolute project path", async () => {
  const { tc, store } = setup();
  await assert.rejects(
    () => tc.call("schedule.create", {
      name: "unsafe",
      trigger: { kind: "manual" },
      target: { runKind: "session", project: "/etc", agent: "mock:default", model: "m1", prompt: "no" },
      consent: { push: "summary" },
    }),
    (e: { data?: { appCode?: string } }) => e?.data?.appCode === "errProjectNotFound",
  );
  store.close();
});

test("L4: run.finished pushed with consent=summary (no transcriptPath leak)", async () => {
  const { tc, store } = setup();
  const project = await mkProject(tc);
  const created = (await tc.call("schedule.create", {
    name: "s", trigger: { kind: "manual" },
    target: { runKind: "session", project, agent: "mock:default", model: "m1", prompt: "x" },
    consent: { push: "summary" },
  })) as { schedule: { id: string } };
  const trig = (await tc.call("schedule.trigger", { scheduleId: created.schedule.id })) as { runId: string };
  await waitRunFinished(tc, trig.runId);

  const finished = tc.notifications.filter((n) => n.__method === "run.finished");
  assert.equal(finished.length, 1, "exactly one run.finished pushed");
  assert.equal(finished[0]!.push, "summary");
  const run = finished[0]!.run as Record<string, unknown>;
  assert.equal(run.status, "success");
  assert.equal(run.resultText, "done:x", "summary keeps resultText");
  assert.equal(run.transcriptPath, undefined, "summary strips transcriptPath");

  // run.started 也推过
  assert.ok(tc.notifications.some((n) => n.__method === "run.started"));
  store.close();
});

test("L4: consent=status-only emits zero content", async () => {
  const { tc, store } = setup();
  const project = await mkProject(tc);
  const created = (await tc.call("schedule.create", {
    name: "s", trigger: { kind: "manual" },
    target: { runKind: "session", project, agent: "mock:default", model: "m1", prompt: "secret-data" },
    consent: { push: "status-only" },
  })) as { schedule: { id: string } };
  const trig = (await tc.call("schedule.trigger", { scheduleId: created.schedule.id })) as { runId: string };
  await waitRunFinished(tc, trig.runId);

  const finished = tc.notifications.filter((n) => n.__method === "run.finished");
  const run = finished[0]!.run as Record<string, unknown>;
  assert.equal(run.status, "success");
  assert.equal(run.resultText, undefined, "status-only must not leak resultText");
  assert.equal(run.transcriptPath, undefined);
  assert.equal(run.sessionId, undefined, "status-only must not leak sessionId");
  // 但确实带了状态与时间
  assert.ok(run.finishedAt);
  store.close();
});

test("L4: webhook schedule returns token once, masked afterwards, triggerByWebhook works", async () => {
  const { tc, store } = setup();
  const project = await mkProject(tc);
  const created = (await tc.call("schedule.create", {
    name: "hook", trigger: { kind: "webhook" },
    target: { runKind: "session", project, agent: "mock:default", model: "m1", prompt: "from-hook" },
  })) as { schedule: { id: string; trigger: { webhookToken?: string } }; webhookToken?: string };
  assert.ok(created.webhookToken, "webhook token returned once on create");
  assert.match(created.webhookToken!, /^whk_/);
  // 返回的 schedule 里 token 已脱敏
  assert.equal(created.schedule.trigger.webhookToken, "***");

  // schedule.get 默认脱敏，reveal=true 才给明文
  const masked = (await tc.call("schedule.get", { scheduleId: created.schedule.id })) as { schedule: { trigger: { webhookToken?: string } } };
  assert.equal(masked.schedule.trigger.webhookToken, "***");
  const revealed = (await tc.call("schedule.get", { scheduleId: created.schedule.id, reveal: true })) as { schedule: { trigger: { webhookToken?: string } } };
  assert.equal(revealed.schedule.trigger.webhookToken, created.webhookToken);

  store.close();
});

test("L4: disabled schedule still listable; enable/disable toggles", async () => {
  const { tc, store } = setup();
  const project = await mkProject(tc);
  const created = (await tc.call("schedule.create", {
    name: "s", trigger: { kind: "manual" }, enabled: false,
    target: { runKind: "session", project, agent: "mock:default", model: "m1", prompt: "x" },
  })) as { schedule: { id: string; enabled: boolean } };
  assert.equal(created.schedule.enabled, false);

  const en = (await tc.call("schedule.enable", { scheduleId: created.schedule.id })) as { schedule: { enabled: boolean } };
  assert.equal(en.schedule.enabled, true);
  const dis = (await tc.call("schedule.disable", { scheduleId: created.schedule.id })) as { schedule: { enabled: boolean } };
  assert.equal(dis.schedule.enabled, false);
  store.close();
});

test("L4: schedules persist across store restart", async () => {
  const { tc, store, dbPath, reg } = setup();
  const project = await mkProject(tc);
  const created = (await tc.call("schedule.create", {
    name: "persisted", trigger: { kind: "manual" },
    target: { runKind: "session", project, agent: "mock:default", model: "m1", prompt: "x" },
  })) as { schedule: { id: string } };
  store.close();

  // 新 store + 新连接：schedule 应被装载
  const store2 = new PhononStore(dbPath);
  const tc2 = new TestConn({ registry: reg, trustLocal: true, store: store2 });
  const list = (await tc2.call("schedule.list", {})) as { schedules: Array<{ id: string; name: string }> };
  assert.ok(list.schedules.find((s) => s.id === created.schedule.id && s.name === "persisted"));
  store2.close();
});

test("L4: delete schedule removes it and its runs", async () => {
  const { tc, store } = setup();
  const project = await mkProject(tc);
  const created = (await tc.call("schedule.create", {
    name: "s", trigger: { kind: "manual" },
    target: { runKind: "session", project, agent: "mock:default", model: "m1", prompt: "x" },
  })) as { schedule: { id: string } };
  const trig = (await tc.call("schedule.trigger", { scheduleId: created.schedule.id })) as { runId: string };
  await waitRunFinished(tc, trig.runId);

  const del = (await tc.call("schedule.delete", { scheduleId: created.schedule.id })) as { deleted: boolean };
  assert.equal(del.deleted, true);
  const list = (await tc.call("schedule.list", {})) as { schedules: unknown[] };
  assert.equal(list.schedules.length, 0);
  store.close();
});

test("L4: workflow schedule persists workflowId and maps terminal result", async () => {
  const { tc, store } = setup();
  const project = await mkProject(tc);
  const created = (await tc.call("schedule.create", {
    name: "wf", trigger: { kind: "manual" }, consent: { push: "full" },
    target: { runKind: "workflow", project, plan: { mode: "dag", finalNodeId: "a", nodes: [{ nodeId: "a", agent: "mock:default", model: "m1" }] } },
  })) as { schedule: { id: string } };
  const trig = (await tc.call("schedule.trigger", { scheduleId: created.schedule.id, input: "workflow-input" })) as { runId: string };
  const run = await waitRunFinished(tc, trig.runId);
  assert.equal(run.status, "success");
  assert.ok(run.workflowId, "run bound to workflow");
  assert.match(String(run.resultText), /workflow-input/);
  assert.equal(run.sessionId, undefined);
  const wf = (await tc.call("workflow.status", { workflowId: run.workflowId })) as { status: string; finalText?: string };
  assert.equal(wf.status, "completed");
  assert.equal(wf.finalText, run.resultText);
  store.close();
});

test("L4: full-consent workflow run.events forwards workflow.event", async () => {
  const dbPath = join(mkdtempSync(join(tmpdir(), "phonon-l4-wf-events-")), "db.sqlite");
  const reg = new AdapterRegistry();
  reg.register(new MockAdapter({ name: "mock", agentIds: ["mock:default"], models: ["m1"], sendDelayMs: 80, reply: () => "wf-result" }));
  const store = new PhononStore(dbPath);
  const tc = new TestConn({ registry: reg, trustLocal: true, store });
  const project = await mkProject(tc);
  const created = (await tc.call("schedule.create", {
    name: "wf-events", trigger: { kind: "manual" }, consent: { push: "full" },
    target: { runKind: "workflow", project, plan: { mode: "dag", finalNodeId: "a", nodes: [{ nodeId: "a", agent: "mock:default", model: "m1" }] } },
  })) as { schedule: { id: string } };
  const trig = (await tc.call("schedule.trigger", { scheduleId: created.schedule.id })) as { runId: string };
  const subscribed = (await tc.call("run.events.subscribe", { runId: trig.runId })) as { subscribed: boolean };
  assert.equal(subscribed.subscribed, true);
  await waitRunFinished(tc, trig.runId);
  const forwarded = tc.notifications.filter((n) => n.__method === "run.event" && n.runId === trig.runId);
  assert.ok(forwarded.length > 0);
  assert.ok(forwarded.some((n) => (n.event as { type?: string }).type === "workflow.status"));
  store.close();
});

test("L4: overlap=queue launches FIFO exactly once and disable cancels queued items", async () => {
  const dbPath = join(mkdtempSync(join(tmpdir(), "phonon-l4-queue-")), "db.sqlite");
  const seen: string[] = [];
  const reg = new AdapterRegistry();
  reg.register(new MockAdapter({
    name: "mock", agentIds: ["mock:default"], models: ["m1"], sendDelayMs: 80,
    reply: (input) => { seen.push(input); return `done:${input}`; },
  }));
  const store = new PhononStore(dbPath);
  const tc = new TestConn({ registry: reg, trustLocal: true, store });
  const project = await mkProject(tc);
  const created = (await tc.call("schedule.create", {
    name: "queue", trigger: { kind: "manual" }, policy: { overlap: "queue", maxRetries: 0, catchUp: false },
    target: { runKind: "session", project, agent: "mock:default", model: "m1", prompt: "base" },
  })) as { schedule: { id: string } };

  const first = (await tc.call("schedule.trigger", { scheduleId: created.schedule.id, input: "one" })) as { runId: string };
  const second = (await tc.call("schedule.trigger", { scheduleId: created.schedule.id, input: "two" })) as { runId: string; status: string };
  assert.equal(second.status, "pending");
  assert.equal(((await tc.call("run.get", { runId: second.runId })) as { run: { startedAt?: string } }).run.startedAt, undefined);
  const firstDone = await waitRunFinished(tc, first.runId);
  const secondDone = await waitRunFinished(tc, second.runId);
  assert.equal(firstDone.status, "success");
  assert.equal(secondDone.status, "success");
  assert.deepEqual(seen, ["base\n\none", "base\n\ntwo"]);

  const third = (await tc.call("schedule.trigger", { scheduleId: created.schedule.id, input: "three" })) as { runId: string };
  const fourth = (await tc.call("schedule.trigger", { scheduleId: created.schedule.id, input: "four" })) as { runId: string };
  await tc.call("schedule.disable", { scheduleId: created.schedule.id });
  assert.equal((await waitRunFinished(tc, fourth.runId)).status, "cancelled");
  assert.equal((await waitRunFinished(tc, third.runId)).status, "success", "disable does not kill already running work");
  assert.equal(seen.filter((value) => value.endsWith("four")).length, 0);

  await tc.call("schedule.enable", { scheduleId: created.schedule.id });
  const fifth = (await tc.call("schedule.trigger", { scheduleId: created.schedule.id, input: "five" })) as { runId: string };
  const sixth = (await tc.call("schedule.trigger", { scheduleId: created.schedule.id, input: "six" })) as { runId: string };
  await tc.call("schedule.update", {
    scheduleId: created.schedule.id,
    policy: { overlap: "skip", maxRetries: 0, catchUp: false },
  });
  assert.equal((await waitRunFinished(tc, sixth.runId)).status, "cancelled", "policy update drains queued work to an audit terminal");
  assert.equal((await waitRunFinished(tc, fifth.runId)).status, "success");

  await tc.call("schedule.update", {
    scheduleId: created.schedule.id,
    policy: { overlap: "queue", maxRetries: 0, catchUp: false },
  });
  const seventh = (await tc.call("schedule.trigger", { scheduleId: created.schedule.id, input: "seven" })) as { runId: string };
  const eighth = (await tc.call("schedule.trigger", { scheduleId: created.schedule.id, input: "eight" })) as { runId: string };
  await tc.call("schedule.delete", { scheduleId: created.schedule.id });
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(store.getRun(seventh.runId, "tenant-test"), undefined);
  assert.equal(store.getRun(eighth.runId, "tenant-test"), undefined);
  store.close();
});

test("L4: overlap=skip and allow retain their existing semantics", async () => {
  const dbPath = join(mkdtempSync(join(tmpdir(), "phonon-l4-overlap-")), "db.sqlite");
  let calls = 0;
  const reg = new AdapterRegistry();
  reg.register(new MockAdapter({
    name: "mock", agentIds: ["mock:default"], models: ["m1"], sendDelayMs: 70,
    reply: (input) => { calls++; return input; },
  }));
  const store = new PhononStore(dbPath);
  const tc = new TestConn({ registry: reg, trustLocal: true, store });
  const project = await mkProject(tc);
  const created = (await tc.call("schedule.create", {
    name: "overlap", trigger: { kind: "manual" }, policy: { overlap: "skip", maxRetries: 0, catchUp: false },
    target: { runKind: "session", project, agent: "mock:default", model: "m1", prompt: "x" },
  })) as { schedule: { id: string } };
  const first = (await tc.call("schedule.trigger", { scheduleId: created.schedule.id })) as { runId: string };
  const skipped = (await tc.call("schedule.trigger", { scheduleId: created.schedule.id })) as { runId: string; status: string };
  assert.equal(skipped.status, "skipped");
  await waitRunFinished(tc, first.runId);
  assert.equal(calls, 1);

  await tc.call("schedule.update", {
    scheduleId: created.schedule.id,
    policy: { overlap: "allow", maxRetries: 0, catchUp: false },
  });
  const a = (await tc.call("schedule.trigger", { scheduleId: created.schedule.id })) as { runId: string };
  const b = (await tc.call("schedule.trigger", { scheduleId: created.schedule.id })) as { runId: string };
  await Promise.all([waitRunFinished(tc, a.runId), waitRunFinished(tc, b.runId)]);
  assert.equal(calls, 3);
  store.close();
});

test("L4: runtime and launch failures retry exactly 1 + maxRetries with audit", async () => {
  const dbPath = join(mkdtempSync(join(tmpdir(), "phonon-l4-retry-")), "db.sqlite");
  let attempts = 0;
  const reg = new AdapterRegistry();
  reg.register(new MockAdapter({
    name: "mock", agentIds: ["mock:default"], models: ["m1"],
    reply: (input) => { attempts++; if (attempts === 1) throw new Error("first runtime failure"); return `ok:${input}`; },
  }));
  const store = new PhononStore(dbPath);
  const tc = new TestConn({ registry: reg, trustLocal: true, store });
  const project = await mkProject(tc);
  const created = (await tc.call("schedule.create", {
    name: "retry", trigger: { kind: "manual" }, policy: { overlap: "skip", maxRetries: 1, catchUp: false },
    target: { runKind: "session", project, agent: "mock:default", model: "m1", prompt: "x" },
  })) as { schedule: { id: string } };
  const trig = (await tc.call("schedule.trigger", { scheduleId: created.schedule.id })) as { runId: string };
  const run = await waitRunFinished(tc, trig.runId) as { status: string; attempt: number; maxAttempts: number; retryHistory: Array<{ attempt: number; phase: string; error: string }>; resultText: string };
  assert.equal(run.status, "success");
  assert.equal(attempts, 2);
  assert.equal(run.attempt, 2);
  assert.equal(run.maxAttempts, 2);
  assert.equal(run.retryHistory.length, 1);
  assert.deepEqual({ attempt: run.retryHistory[0]!.attempt, phase: run.retryHistory[0]!.phase }, { attempt: 1, phase: "runtime" });
  assert.match(run.retryHistory[0]!.error, /runtime failure/);

  const bad = (await tc.call("schedule.create", {
    name: "launch-retry", trigger: { kind: "manual" }, policy: { overlap: "skip", maxRetries: 2, catchUp: false },
    target: { runKind: "session", project, agent: "missing:agent", model: "m1", prompt: "x" },
  })) as { schedule: { id: string } };
  const badTrig = (await tc.call("schedule.trigger", { scheduleId: bad.schedule.id })) as { runId: string };
  const failed = await waitRunFinished(tc, badTrig.runId) as { status: string; attempt: number; maxAttempts: number; retryHistory: unknown[] };
  assert.equal(failed.status, "failed");
  assert.equal(failed.attempt, 3);
  assert.equal(failed.maxAttempts, 3);
  assert.equal(failed.retryHistory.length, 3);
  store.close();
});

test("L4: workflow cancel fences late completion and cancels underlying workflow", async () => {
  const dbPath = join(mkdtempSync(join(tmpdir(), "phonon-l4-cancel-")), "db.sqlite");
  const reg = new AdapterRegistry();
  reg.register(new MockAdapter({ name: "mock", agentIds: ["mock:default"], models: ["m1"], sendDelayMs: 150 }));
  const store = new PhononStore(dbPath);
  const tc = new TestConn({ registry: reg, trustLocal: true, store });
  const project = await mkProject(tc);
  const created = (await tc.call("schedule.create", {
    name: "wf-cancel", trigger: { kind: "manual" },
    target: { runKind: "workflow", project, plan: { mode: "dag", nodes: [{ nodeId: "a", agent: "mock:default", model: "m1" }] } },
  })) as { schedule: { id: string } };
  const trig = (await tc.call("schedule.trigger", { scheduleId: created.schedule.id, input: "slow" })) as { runId: string };
  const live = ((await tc.call("run.get", { runId: trig.runId })) as { run: { workflowId: string } }).run;
  assert.ok(live.workflowId);
  const cancelled = (await tc.call("run.cancel", { runId: trig.runId, reason: "test cancel" })) as { status: string };
  assert.equal(cancelled.status, "cancelled");
  await new Promise((resolve) => setTimeout(resolve, 220));
  assert.equal(((await tc.call("run.get", { runId: trig.runId })) as { run: { status: string } }).run.status, "cancelled");
  assert.equal(((await tc.call("workflow.status", { workflowId: live.workflowId })) as { status: string }).status, "cancelled");
  store.close();
});

test("L4: startup catchUp advances first and launches only one; false only advances", async () => {
  const now = Date.parse("2026-08-16T12:00:30.000Z");
  const store = new PhononStore(":memory:");
  const createCounts = new Map<string, number>();
  const fakeEngine = {
    create: async (params: { project: string }) => {
      createCounts.set(params.project, (createCounts.get(params.project) ?? 0) + 1);
      const row = store.getSchedule(params.project === "p-catch" ? "catch" : "no-catch", "tenant-test");
      assert.ok(row?.next_run_at && Date.parse(row.next_run_at as string) > now, "nextRunAt persisted before launch");
      return { sessionId: `s-${params.project}-${createCounts.get(params.project)}` };
    },
    send: async () => ({ turnId: "t", disposition: "started" }),
    terminate: async () => {},
    interrupt: async () => {},
  } as unknown as SessionEngine;
  const put = (id: string, project: string, catchUp: boolean) => store.upsertSchedule({
    id, tenantId: "tenant-test", name: id, enabled: true,
    triggerJson: JSON.stringify({ kind: "cron", expr: "* * * * *", tz: "UTC" }),
    targetJson: JSON.stringify({ runKind: "session", project, agent: "mock:default", model: "m1", prompt: "x" }),
    consentJson: JSON.stringify({ push: "summary" }),
    policyJson: JSON.stringify({ overlap: "skip", maxRetries: 0, catchUp }),
    createdAt: "2026-08-16T10:00:00.000Z", updatedAt: "2026-08-16T10:00:00.000Z",
    nextRunAt: "2026-08-16T10:01:00.000Z",
  });
  put("catch", "p-catch", true);
  put("no-catch", "p-no-catch", false);
  store.upsertRun({
    id: "orphan-pending", scheduleId: "catch", tenantId: "tenant-test", triggerSource: "cron",
    status: "pending", createdAt: "2026-08-16T11:00:00.000Z",
  });
  const scheduler = new SchedulerEngine({
    tenantId: "tenant-test", engine: fakeEngine, store, now: () => now,
    resolveCwd: () => "/tmp", emit: () => {},
  });
  scheduler.start();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(createCounts.get("p-catch"), 1);
  assert.equal(createCounts.get("p-no-catch") ?? 0, 0);
  assert.equal(store.getRun("orphan-pending", "tenant-test")?.status, "cancelled", "restart audits orphaned pending work");
  scheduler.start();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(createCounts.get("p-catch"), 1, "same startup cannot replay catch-up twice");
  scheduler.dispose("test done");
  assert.equal(store.listActiveRuns("tenant-test").length, 0);
  store.close();
});

test("L4: dispose audits queued/running runs and late events cannot revive them", async () => {
  const dbPath = join(mkdtempSync(join(tmpdir(), "phonon-l4-dispose-")), "db.sqlite");
  const reg = new AdapterRegistry();
  reg.register(new MockAdapter({ name: "mock", agentIds: ["mock:default"], models: ["m1"], sendDelayMs: 120 }));
  const store = new PhononStore(dbPath);
  const tc = new TestConn({ registry: reg, trustLocal: true, store });
  const project = await mkProject(tc);
  const created = (await tc.call("schedule.create", {
    name: "dispose", trigger: { kind: "manual" }, policy: { overlap: "queue", maxRetries: 0, catchUp: false },
    target: { runKind: "session", project, agent: "mock:default", model: "m1", prompt: "x" },
  })) as { schedule: { id: string } };
  const first = (await tc.call("schedule.trigger", { scheduleId: created.schedule.id })) as { runId: string };
  const second = (await tc.call("schedule.trigger", { scheduleId: created.schedule.id })) as { runId: string };
  await tc.conn.dispose("test disconnect");
  await new Promise((resolve) => setTimeout(resolve, 170));
  assert.equal(store.getRun(first.runId, "tenant-test")?.status, "failed");
  assert.equal(store.getRun(second.runId, "tenant-test")?.status, "cancelled");
  assert.equal(store.listActiveRuns("tenant-test").length, 0);
  store.close();
});
