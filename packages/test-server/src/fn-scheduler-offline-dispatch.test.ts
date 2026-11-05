import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AdapterRegistry, PhononClient, PhononStore } from "@agent-phonon/core";
import { PhononDevice, PhononServer } from "@agent-phonon/server-sdk";
import { MockAdapter } from "./harness.js";

async function drain() {
  for (let i = 0; i < 10; i++) await new Promise<void>(resolve => setImmediate(resolve));
}

async function fixture(t: TestContext, catchUp = false) {
  const root = mkdtempSync(join(tmpdir(), "phonon-offline-dispatch-"));
  const store = new PhononStore(join(root, "state.sqlite"));
  let serverAvailable = true;
  const server = new PhononServer({ host: "127.0.0.1", authenticate: () => serverAvailable ? { tenantId: "offline-owner" } : null });
  const registry = new AdapterRegistry();
  const adapter = new MockAdapter({ name: "mock", agentIds: ["mock:default"], models: ["m1"] });
  let models = 0;
  const create = adapter.createSession.bind(adapter);
  adapter.createSession = async params => { models++; return create(params); };
  registry.register(adapter);
  let client: PhononClient | undefined;
  let currentDevice: PhononDevice;
  t.after(async () => {
    await client?.close(); await server.close(); store.close(); rmSync(root, { recursive: true, force: true });
  });
  const port = await server.listen();
  t.mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now: Date.parse("2026-11-05T00:00:00Z") });
  const connect = async () => {
    client ??= new PhononClient({ serverUrl: `ws://127.0.0.1:${port}`, deviceId: "offline-dispatch", expectedTenantId: "offline-owner",
      registry, workspaceRoot: root, trustLocal: true, store,
      connectionTiming: { pingIntervalMs: 3600000, stableConnectionMs: 3600000 } });
    let accept!: (device: PhononDevice) => void;
    const ready = new Promise<PhononDevice>(resolve => { accept = resolve; });
    server.once("device", accept);
    try { await client.connect(); currentDevice = await ready; return currentDevice; }
    finally { server.off("device", accept); }
  };
  const device = await connect();
  const { project } = await device.project.create({ name: "owned", git: false });
  const dispatch = { key: "offline-automation", revision: 1, contentHash: "a".repeat(64), expiresAt: new Date(Date.now() + 86400000).toISOString() };
  const { schedule } = await device.schedule.create({ name: "offline dispatch", trigger: { kind: "cron", expr: "* * * * *", tz: "UTC" },
    target: { runKind: "dispatch", project: String(project.projectId), dispatch },
    policy: { overlap: "allow", catchUp, maxRetries: 0 }, consent: { push: "full" } });
  return { store, device, dispatch, schedule, project, connect, get models() { return models; },
    set serverAvailable(available: boolean) { serverAvailable = available; },
    async disconnect() {
      currentDevice.disconnect();
      for (let i = 0; i < 2000 && client?.connection; i++) await drain();
      assert.equal(client?.connection === undefined, true, "transport close must retire the connected runtime");
    },
    async restart() { await client!.close(); client = undefined; },
    async tick(ms = 60000) { t.mock.timers.tick(ms); await drain(); },
    runs() { return store.listRunsForSchedule(schedule.id, { tenantId: "offline-owner", unackedOnly: true, limit: 100 }); } };
}

test("dispatch clock records every offline tick and reconnect drains the durable backlog without a model", async t => {
  const f = await fixture(t);
  await f.device.schedule.create({ name: "ordinary model clock", trigger: { kind: "cron", expr: "* * * * *", tz: "UTC" },
    target: { project: String(f.project.projectId), agent: "mock:default", model: "m1", prompt: "not offline" },
    policy: { overlap: "skip", catchUp: false, maxRetries: 0 } });
  await f.disconnect();
  for (let minute = 1; minute <= 3; minute++) {
    await f.tick();
    const runs = f.runs();
    assert.equal(runs.length, minute, "an up daemon must persist each tick while its server is disconnected");
    assert.equal(runs.at(-1)?.started_at, new Date(Date.parse("2026-11-05T00:00:00Z") + minute * 60000).toISOString());
    assert.ok(runs.every(run => run.status === "running" && !run.session_id && !run.workflow_id));
    assert.equal(f.models, 0);
  }
  const ids = f.runs().map(run => run.id);
  const device = await f.connect();
  const pending = await device.schedule.runs.list({ scheduleId: f.schedule.id, unackedOnly: true, limit: 100 });
  assert.deepEqual(pending.runs.map(run => run.id), ids);
  for (const run of pending.runs) {
    await device.run.resolve({ runId: run.id, dispatch: f.dispatch, status: "success" });
    device.schedule.ack(run.id, { finished: true });
  }
  assert.equal((await device.schedule.runs.list({ scheduleId: f.schedule.id, unackedOnly: true })).runs.length, 0);
  await device.schedule.disable(f.schedule.id);
  await f.disconnect(); await f.connect();
  await f.tick();
  assert.equal(f.runs().length, 0, "the retired offline clock must not survive reconnect");
});

for (const offline of [true, false]) {
  test(`warm ${offline ? "reconnect" : "connection replacement"} records a due dispatch before its timer fires`, async t => {
    const f = await fixture(t);
    if (offline) await f.disconnect();
    // Move wall time across the deadline without executing the pending callback.
    t.mock.timers.setTime(Date.now() + 60000);
    assert.equal(f.runs().length, 0);
    assert.equal(f.store.getSchedule(f.schedule.id, "offline-owner")?.next_run_at, "2026-11-05T00:01:00.000Z");
    const device = await f.connect();
    const pending = await device.schedule.runs.list({ scheduleId: f.schedule.id, unackedOnly: true });
    assert.equal(pending.runs.length, 1, "continuous uptime must not use process-down skipping");
    assert.equal(pending.runs[0]?.startedAt, "2026-11-05T00:01:00.000Z");
    assert.equal(f.store.getSchedule(f.schedule.id, "offline-owner")?.next_run_at, "2026-11-05T00:02:00.000Z");
    await f.tick();
    assert.equal(f.runs().length, 2, "only the replacement clock may record the next tick");
    assert.equal(f.models, 0);
  });

  test(`a delayed ${offline ? "offline" : "connected"} dispatch callback records every owed minute`, async t => {
    const f = await fixture(t);
    if (offline) await f.disconnect();
    await f.tick(3 * 60000);
    assert.equal(f.runs().length, 3, "a delayed callback must not fold three occurrences into one");
    assert.ok(f.runs().every(run => run.status === "running" && !run.session_id && !run.workflow_id));
    assert.equal(new Set(f.runs().map(run => run.id)).size, 3);
    assert.equal(f.store.getSchedule(f.schedule.id, "offline-owner")?.next_run_at, "2026-11-05T00:04:00.000Z");
    await f.tick();
    assert.equal(f.runs().length, 4);
    assert.equal(f.models, 0);
  });
}

test("warm reconnect transfers all overdue dispatch occurrences without arming two clocks", async t => {
  const f = await fixture(t);
  await f.disconnect();
  t.mock.timers.setTime(Date.now() + 3 * 60000);
  const device = await f.connect();
  assert.equal((await device.schedule.runs.list({ scheduleId: f.schedule.id, unackedOnly: true })).runs.length, 3);
  assert.equal(f.store.getSchedule(f.schedule.id, "offline-owner")?.next_run_at, "2026-11-05T00:04:00.000Z");
  await device.schedule.disable(f.schedule.id);
  await f.tick(3 * 60000);
  assert.equal(f.runs().length, 3, "neither a retired timer nor an in-flight drain may record a disabled schedule");
  assert.equal(f.models, 0);
});

test("warm reconnect revalidates expiry before accepting overdue dispatch occurrences", async t => {
  const f = await fixture(t);
  await f.device.schedule.update({ scheduleId: f.schedule.id, target: { runKind: "dispatch", project: String(f.project.projectId),
    dispatch: { ...f.dispatch, expiresAt: new Date(Date.now() + 30000).toISOString() } } });
  await f.disconnect();
  t.mock.timers.setTime(Date.now() + 3 * 60000);
  const device = await f.connect();
  assert.equal((await device.schedule.runs.list({ scheduleId: f.schedule.id, unackedOnly: true })).runs.length, 0);
  assert.equal(f.store.getSchedule(f.schedule.id, "offline-owner")?.enabled, 0);
  assert.equal(f.models, 0);
});

test("catchUp:true still folds process-down dispatch ticks into one startup receipt", async t => {
  const f = await fixture(t, true);
  await f.restart();
  await f.tick(3 * 60000);
  const device = await f.connect();
  assert.equal((await device.schedule.runs.list({ scheduleId: f.schedule.id, unackedOnly: true })).runs.length, 1);
  assert.equal(f.store.getSchedule(f.schedule.id, "offline-owner")?.next_run_at, "2026-11-05T00:04:00.000Z");
  await f.tick();
  assert.equal(f.runs().length, 2);
  assert.equal(f.models, 0);
});

test("catchUp:false skips process-down ticks but preserves earlier unacked dispatch receipts", async t => {
  const f = await fixture(t);
  await f.disconnect(); await f.tick();
  assert.equal(f.runs().length, 1);
  const original = f.runs()[0]!.id;
  await f.restart(); await f.tick(3 * 60000);
  assert.equal(f.runs().length, 1, "closing the daemon stops its clock");
  const device = await f.connect();
  const pending = await device.schedule.runs.list({ scheduleId: f.schedule.id, unackedOnly: true });
  assert.deepEqual(pending.runs.map(run => run.id), [original], "process restart must not burst catch up");
  await f.tick();
  assert.equal(f.runs().length, 2);
  assert.equal(f.models, 0);
});

test("offline dispatch retains every receipt beyond active capacity and still enforces expiry", async t => {
  const f = await fixture(t);
  await f.disconnect();
  await f.tick(75 * 60000);
  const runs = f.runs();
  assert.equal(runs.length, 75);
  assert.equal(runs.filter(run => run.status === "running").length, 32);
  assert.equal(runs.filter(run => run.status === "skipped").length, 43);
  assert.equal(f.models, 0);
  const device = await f.connect();
  await device.schedule.update({ scheduleId: f.schedule.id, target: { runKind: "dispatch", project: String(f.project.projectId),
    dispatch: { ...f.dispatch, expiresAt: new Date(Date.now() + 30000).toISOString() } } });
  await f.disconnect(); await f.tick();
  assert.equal(f.runs().length, 75, "an expired dispatch must not create another occurrence");
  assert.equal(f.store.getSchedule(f.schedule.id, "offline-owner")?.enabled, 0);
  assert.equal(f.models, 0);
});

test("a restarted daemon resumes only future dispatch ticks even before its server returns", async t => {
  const f = await fixture(t);
  await f.restart(); await f.tick(3 * 60000);
  f.serverAvailable = false;
  await assert.rejects(() => f.connect(), { message: "unauthorized" });
  assert.equal(f.runs().length, 0, "catchUp:false skips process-down ticks on offline startup too");
  await f.tick(); await f.tick();
  assert.equal(f.runs().length, 2, "the up daemon records new ticks without a successful reconnect");
  f.serverAvailable = true;
  const device = await f.connect();
  assert.equal((await device.schedule.runs.list({ scheduleId: f.schedule.id, unackedOnly: true })).runs.length, 2);
  assert.equal(f.models, 0);
});
