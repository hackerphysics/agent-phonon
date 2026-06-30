import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AdapterRegistry, PhononStore } from "@agent-phonon/core";
import { MockAdapter, TestConn } from "./harness.js";

/**
 * L4 scheduling 功能测试（通过 TestConn 走真实 dispatch 链路）。
 * 覆盖：schedule CRUD、manual trigger → run 终态、consent push 粒度、
 * webhook token 脱敏、runs.list/run.get、持久化、overlap=skip。
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

test("L4: workflow runKind rejected in v1", async () => {
  const { tc, store } = setup();
  const project = await mkProject(tc);
  const created = (await tc.call("schedule.create", {
    name: "wf", trigger: { kind: "manual" },
    target: { runKind: "workflow", project, plan: { mode: "dag", nodes: [{ nodeId: "a", agent: "mock:default", model: "m1" }] } },
  })) as { schedule: { id: string } };
  const trig = (await tc.call("schedule.trigger", { scheduleId: created.schedule.id })) as { runId: string };
  const run = await waitRunFinished(tc, trig.runId);
  assert.equal(run.status, "failed");
  assert.match(String(run.error), /workflow/);
  store.close();
});
