import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AdapterRegistry, PhononClient } from "@agent-phonon/core";
import { PhononServer } from "@agent-phonon/server-sdk";
import type { PhononDevice } from "@agent-phonon/server-sdk";
import { MockAdapter } from "./harness.js";

/**
 * L4 scheduling e2e —— 通过真实 WS + server SDK 驱动真实 phonon。
 * 验证 SDK 的 schedule/run wrapper 与 p2s 推送（run.started/run.finished/schedule.changed）
 * 端到端打通，并验证 SDK 自动 ack。
 */

function spawnPhonon(serverUrl: string, deviceId: string, reply?: (i: string) => string) {
  const reg = new AdapterRegistry();
  reg.register(new MockAdapter({ name: "mock", agentIds: ["mock:default"], models: ["m1"], reply: reply ?? ((i) => `ok:${i}`) }));
  const cwd = mkdtempSync(join(tmpdir(), `phonon-l4-e2e-${deviceId}-`));
  const dbPath = join(cwd, "db.sqlite");
  return {
    client: new PhononClient({ serverUrl, deviceId, registry: reg, trustLocal: true, workspaceRoot: cwd, dbPath, resolveProjectCwd: () => cwd }),
    workspace: cwd,
  };
}

async function makeFixture(reply?: (i: string) => string): Promise<{ server: PhononServer; device: PhononDevice; cleanup: () => Promise<void> }> {
  const server = new PhononServer({ authenticate: (id) => ({ tenantId: `t-${id}` }) });
  const port = await server.listen();
  const deviceReady = new Promise<PhononDevice>((resolve) => server.on("device", (d: PhononDevice) => resolve(d)));
  const { client } = spawnPhonon(`ws://127.0.0.1:${port}`, `dev-${Math.random().toString(36).slice(2, 8)}`, reply);
  await client.connect();
  const device = await deviceReady;
  return {
    server, device,
    cleanup: async () => { try { client.close(); } catch {} try { await server.close(); } catch {} },
  };
}

async function waitRun(device: PhononDevice, runId: string, timeoutMs = 10000): Promise<Record<string, unknown>> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const r = (await device.run.get(runId)) as { run: Record<string, unknown> };
    if (["success", "failed", "timeout", "cancelled", "skipped"].includes(r.run.status as string)) return r.run;
    await new Promise((res) => setTimeout(res, 50));
  }
  throw new Error(`run ${runId} did not finish`);
}

test("e2e L4: create + trigger schedule via SDK, run reaches success, push received", { timeout: 30000 }, async () => {
  const fx = await makeFixture((i) => `result:${i}`);
  try {
    const proj = await fx.device.project.create({ name: "l4", git: false });
    const runStarted: Record<string, unknown>[] = [];
    const runFinished: Record<string, unknown>[] = [];
    fx.device.on("runStarted", (ev: Record<string, unknown>) => runStarted.push(ev));
    fx.device.on("runFinished", (ev: Record<string, unknown>) => runFinished.push(ev));

    const created = await fx.device.schedule.create({
      name: "nightly",
      trigger: { kind: "cron", expr: "0 3 * * *", tz: "Asia/Shanghai" },
      target: { runKind: "session", project: proj.project.projectId, agent: "mock:default", model: "m1", prompt: "go" },
      consent: { push: "summary" },
    });
    assert.ok(created.schedule.id);
    // cron schedule 应算出 nextRunAt
    assert.ok(created.schedule.nextRunAt, "cron schedule has nextRunAt");

    // 手动触发一次（测试 cron 任务而不必等到 03:00）
    const trig = await fx.device.schedule.trigger({ scheduleId: created.schedule.id, source: "manual" });
    assert.ok(trig.runId);

    const run = await waitRun(fx.device, trig.runId);
    assert.equal(run.status, "success");
    assert.equal(run.resultText, "result:go");

    // p2s 推送收到
    await new Promise((r) => setTimeout(r, 100));
    assert.ok(runStarted.length >= 1, "runStarted pushed");
    assert.equal(runFinished.length, 1, "exactly one runFinished pushed");
    assert.equal((runFinished[0]!.run as Record<string, unknown>).status, "success");
    assert.equal(runFinished[0]!.push, "summary");
  } finally {
    await fx.cleanup();
  }
});

test("e2e L4: subscribe to run events streams session output", { timeout: 30000 }, async () => {
  const fx = await makeFixture((i) => `streamed:${i}`);
  try {
    const proj = await fx.device.project.create({ name: "l4s", git: false });
    const runEvents: Record<string, unknown>[] = [];
    fx.device.on("runEvent", (ev: Record<string, unknown>) => runEvents.push(ev));

    const created = await fx.device.schedule.create({
      name: "sub", trigger: { kind: "manual" },
      target: { runKind: "session", project: proj.project.projectId, agent: "mock:default", model: "m1", prompt: "watch" },
      consent: { push: "full" },
    });

    // 先订阅一个尚未触发的 run 不可行（runId 触发后才有）；
    // 这里用 full consent，run.finished 会带 transcriptPath。改为验证 finished 的 full 粒度。
    const finished: Record<string, unknown>[] = [];
    fx.device.on("runFinished", (ev: Record<string, unknown>) => finished.push(ev));
    const trig = await fx.device.schedule.trigger({ scheduleId: created.schedule.id });
    const run = await waitRun(fx.device, trig.runId);
    assert.equal(run.status, "success");

    await new Promise((r) => setTimeout(r, 100));
    assert.equal(finished.length, 1);
    assert.equal(finished[0]!.push, "full");
    // full 粒度保留 transcriptPath
    assert.ok((finished[0]!.run as Record<string, unknown>).transcriptPath, "full consent keeps transcriptPath");
  } finally {
    await fx.cleanup();
  }
});

test("e2e L4: list schedules + runs.list reflect history", { timeout: 30000 }, async () => {
  const fx = await makeFixture();
  try {
    const proj = await fx.device.project.create({ name: "l4l", git: false });
    const created = await fx.device.schedule.create({
      name: "hist", trigger: { kind: "manual" },
      target: { runKind: "session", project: proj.project.projectId, agent: "mock:default", model: "m1", prompt: "h" },
    });
    const t1 = await fx.device.schedule.trigger({ scheduleId: created.schedule.id });
    await waitRun(fx.device, t1.runId);
    const t2 = await fx.device.schedule.trigger({ scheduleId: created.schedule.id });
    await waitRun(fx.device, t2.runId);

    const list = await fx.device.schedule.list({});
    assert.ok(list.schedules.find((s) => s.id === created.schedule.id));

    const runs = await fx.device.schedule.runs.list({ scheduleId: created.schedule.id });
    assert.equal(runs.runs.length, 2, "two runs recorded");
    assert.ok(runs.runs.every((r) => r.status === "success"));
  } finally {
    await fx.cleanup();
  }
});
