import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AdapterRegistry, PhononConnection, PhononClient, PhononStore, Outbox, ObsBus, Metrics,
  deliveryOptions, DEFAULT_MAX_PENDING_BYTES, SchedulerEngine, WorkflowEngine,
} from "@agent-phonon/core";
import type { StreamEvent, WorkflowPlan } from "@agent-phonon/protocol";
import { MockAdapter, TestConn } from "./harness.js";

const now = new Date(0).toISOString();
const bytes = (payload: string) => Buffer.byteLength(payload, "utf8");
const path = () => join(mkdtempSync(join(tmpdir(), "phonon-delivery-")), "state.sqlite");
const event = (seq: number, text = "汉字🙂", sessionId = "s"): StreamEvent => ({
  type: "message", sessionId, seq, turnId: "t", at: now, role: "assistant", text, delta: true,
} as StreamEvent);
const workflow = (seq: number): Parameters<PhononStore["upsertWorkflow"]>[0] => ({
  workflowId: "w", tenantId: "offline", mode: "sequence", planJson: "{}", nodesJson: "[]",
  status: "running", seq, ackedSeq: -1, createdAt: now, updatedAt: now, ownerId: "owner",
});
const run = (seq: number): Parameters<PhononStore["upsertRun"]>[0] => ({
  id: "r", scheduleId: "sched", tenantId: "offline", status: "running", triggerSource: "manual",
  ackedSeq: -1, eventSeq: seq, createdAt: now, ownerId: "owner",
});
const plan: WorkflowPlan = { mode: "dag", nodes: [{ nodeId: "one", agent: "mock:default", model: "m1", input: "work" }] } as WorkflowPlan;
async function wait(predicate: () => boolean): Promise<void> {
  const end = Date.now() + 4000;
  while (!predicate()) {
    if (Date.now() > end) throw new Error("delivery condition not reached");
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
function rejects(promise: Promise<unknown>, pattern: RegExp): Promise<void> {
  return assert.rejects(promise, error => pattern.test((error as { message?: string }).message ?? String(error)));
}
function internal(tc: TestConn): { scheduler: SchedulerEngine; workflows: WorkflowEngine } {
  return tc.conn as unknown as { scheduler: SchedulerEngine; workflows: WorkflowEngine };
}

// Real triggers on a real database, not a mocked SUM or a synthetic memory counter.
test("delivery: all channels/tenants, UTF-8 bytes, duplicate, partial/full ACK, reopen and retained histories", () => {
  const dbPath = path();
  let store = new PhononStore(dbPath, { delivery: { maxPendingBytes: 1 } });
  let box = new Outbox({ store, tenantId: "online", maxEvents: 1 });
  box.enqueue(event(0)); box.enqueue(event(1)); box.enqueue(event(1));
  const wp0 = JSON.stringify({ text: "工作🙂", seq: 0 });
  const wp1 = JSON.stringify({ text: "结果", seq: 1 });
  const rp = JSON.stringify({ text: "运行", seq: 0 });
  store.appendWorkflowEvent(workflow(1), { seq: 0, payload: wp0, createdAt: now });
  store.appendWorkflowEvent(workflow(1), { seq: 0, payload: wp0, createdAt: now });
  store.appendWorkflowEvent(workflow(2), { seq: 1, payload: wp1, createdAt: now });
  store.appendRunEvent(run(1), { seq: 0, payload: rp, createdAt: now });
  const snapshot = store.delivery.snapshot();
  assert.deepEqual(snapshot.channels, {
    stream: { count: 2, bytes: bytes(JSON.stringify(event(0))) + bytes(JSON.stringify(event(1))) },
    workflow: { count: 2, bytes: bytes(wp0) + bytes(wp1) },
    run: { count: 1, bytes: bytes(rp) },
  });
  assert.equal(snapshot.pendingCount, 5);
  assert.equal(snapshot.state, "critical");
  assert.equal(box.dropped, 0);
  store.close();
  store = new PhononStore(dbPath, { delivery: { maxPendingBytes: 1 } });
  box = new Outbox({ store, tenantId: "online" });
  assert.equal(store.delivery.snapshot().pendingBytes, snapshot.pendingBytes);
  assert.equal(box.pending().length, 2, "over-limit writes replay after restart");
  assert.equal(store.unackedWorkflowEvents("offline").length, 2);
  assert.equal(store.unackedRunEvents("offline").length, 1);
  box.ack("s", 0); store.ackWorkflow("w", 0, "offline");
  assert.equal(store.delivery.snapshot().pendingCount, 3);
  store.ackRun("r", "other", { lastSeq: 0 });
  assert.equal(store.delivery.snapshot().channels.run.count, 1, "cross-tenant ACK cannot drain");
  store.ackRun("r", "offline", { finished: true });
  assert.equal(store.delivery.snapshot().channels.run.count, 1, "terminal receipt alone is not an event ACK");
  box.ack("s", 999); store.ackWorkflow("w", 999, "offline"); store.ackRun("r", "offline", { lastSeq: 999 });
  assert.equal(store.delivery.snapshot().pendingCount, 0);
  assert.equal(store.delivery.snapshot().state, "normal");
  assert.equal(store.workflowEvents("w", "offline").length, 2, "ACKed workflow history is retained, not pending");
  const db = new DatabaseSync(dbPath);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM run_events").get() as { n: number }).n, 1);
  db.close(); store.close();
  store = new PhononStore(dbPath, { delivery: { maxPendingBytes: 1 } });
  assert.equal(store.delivery.snapshot().pendingBytes, 0);
  store.close();
});

test("delivery: reconciliation repairs accounting without deleting legacy event rows", () => {
  const dbPath = path();
  let store = new PhononStore(dbPath);
  store.outboxAdd("offline", "s", 0, "汉", now);
  store.close();
  const db = new DatabaseSync(dbPath);
  db.exec("UPDATE delivery_totals SET pending_count=123,pending_bytes=999");
  db.close();
  store = new PhononStore(dbPath);
  assert.equal(store.delivery.snapshot().pendingCount, 1);
  assert.equal(store.delivery.snapshot().pendingBytes, 3);
  assert.equal(store.outboxLoad("offline").length, 1);
  store.close();
});

test("delivery: warning/critical/recovery transitions and metrics are payload-free and do not flood", () => {
  const store = new PhononStore(":memory:", { delivery: { maxPendingBytes: 100 } });
  const bus = new ObsBus(); const metrics = new Metrics(); const seen: Array<{ event: string; data?: unknown }> = [];
  bus.onEvent(e => { seen.push(e); });
  store.delivery.configure(undefined, bus, metrics);
  store.outboxAdd("offline", "s", 0, "x".repeat(80), now);
  for (let i = 0; i < 20; i++) store.delivery.snapshot();
  assert.equal(seen.filter(e => e.event === "delivery.warning").length, 1);
  store.outboxAdd("offline", "s", 1, "y".repeat(20), now);
  for (let i = 0; i < 20; i++) assert.doesNotThrow(() => store.delivery.assertNewWork());
  assert.equal(store.delivery.snapshot().admissionBlocked, false);
  assert.match(metrics.prometheus(), /phonon_delivery_pressure_critical 1/);
  assert.equal(seen.filter(e => e.event === "delivery.critical").length, 1);
  store.outboxAck("offline", "s", 0);
  assert.equal(seen.filter(e => e.event === "delivery.recovered").length, 1);
  assert.equal(store.delivery.snapshot().pendingBytes, 20);
  assert.match(metrics.prometheus(), /phonon_delivery_pending_bytes 20/);
  assert.match(metrics.prometheus(), /phonon_delivery_admission_blocked 0/);
  assert.ok(!JSON.stringify(seen).includes("x".repeat(80)));
  store.close();
});

test("delivery: strict validation for standalone store, connection, and client options", () => {
  assert.equal(deliveryOptions().maxPendingBytes, DEFAULT_MAX_PENDING_BYTES);
  for (const value of [0, -1, 1.1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "100", null]) {
    assert.throws(() => deliveryOptions({ maxPendingBytes: value } as never), /positive safe integer/);
  }
  for (const value of [null, [], "100"]) assert.throws(() => deliveryOptions(value as never), /must be an object/);
  assert.equal(deliveryOptions({ maxPendingBytes: 1 }).maxPendingBytes, 1);
  const registry = new AdapterRegistry();
  const connection = new PhononConnection({ tenantId: "a", registry, delivery: { maxPendingBytes: 9 }, transport: { send: () => {}, close: () => {} } });
  assert.equal(connection.deliveryStatus().maxPendingBytes, 9);
  void connection.dispose();
  const shared = new PhononStore(":memory:");
  new PhononClient({ serverUrl: "ws://127.0.0.1:1", deviceId: "d", registry, store: shared, delivery: { maxPendingBytes: 7 } });
  assert.equal(shared.delivery.snapshot().maxPendingBytes, 7);
  shared.close();
});

test("delivery: failed SQLite ACK/write never forgets replay, latches unhealthy, and rolls back counters", () => {
  const dbPath = path(); const store = new PhononStore(dbPath);
  const box = new Outbox({ store, tenantId: "a" }); box.enqueue(event(0));
  const before = store.delivery.snapshot();
  const db = new DatabaseSync(dbPath);
  db.exec("CREATE TRIGGER fail_ack BEFORE DELETE ON outbox_events BEGIN SELECT RAISE(ABORT,'injected ACK failure'); END");
  assert.throws(() => box.ack("s", 0), /injected ACK failure/);
  assert.equal(box.pending().length, 1);
  assert.equal(store.outboxLoadFinalized("a").length, 0, "watermark rollback is atomic with deletion");
  assert.equal(store.delivery.snapshot().pendingBytes, before.pendingBytes);
  assert.equal(store.delivery.snapshot().persistenceHealthy, false);
  assert.throws(() => store.delivery.assertNewWork(), /unhealthy/);
  db.exec("DROP TRIGGER fail_ack; CREATE TRIGGER fail_write BEFORE INSERT ON outbox_events BEGIN SELECT RAISE(ABORT,'injected write failure'); END");
  assert.throws(() => box.enqueue(event(1)), /injected write failure/);
  assert.equal(box.pending().length, 1);
  assert.equal(store.delivery.snapshot().pendingCount, 1);
  db.exec("DROP TRIGGER fail_write");
  box.ack("s", 0);
  assert.equal(store.delivery.snapshot().pendingCount, 0);
  assert.equal(store.delivery.snapshot().persistenceHealthy, false, "successful ACK does not hide a possible persistence gap");
  db.close(); store.close();
  const reopened = new PhononStore(dbPath);
  assert.equal(reopened.delivery.snapshot().persistenceHealthy, true);
  reopened.close();
});

test("delivery: critical pressure accepts all new work, retains events/history, and preserves idempotent retries after SQLite reopen", async () => {
  const root = mkdtempSync(join(tmpdir(), "phonon-cap-rpc-")); const dbPath = join(root, "state.sqlite");
  let store = new PhononStore(dbPath, { delivery: { maxPendingBytes: 1 } });
  let invoked = 0;
  const adapter = new MockAdapter({ reply: input => { invoked++; return input; } });
  const registry = new AdapterRegistry(); registry.register(adapter);
  let tc = new TestConn({ registry, store, workspaceRoot: root });
  const project = await tc.call("project.create", { name: "p", git: false }) as { project: { projectId: string } };
  const createdRequest = { project: project.project.projectId, agent: "mock:default", model: "m1", clientRequestId: "create" };
  const created = await tc.call("session.create", createdRequest) as { sessionId: string };
  const request = { sessionId: created.sessionId, input: "accepted", clientRequestId: "send" };
  const accepted = await tc.call("session.send", request);
  await wait(() => invoked === 1 && store.outboxLoad("tenant-test").length >= 2);
  store.outboxAdd("disconnected", "offline", 0, "z".repeat(500), now);
  assert.equal(store.delivery.snapshot().state, "critical");
  assert.equal(store.delivery.snapshot().admissionBlocked, false);
  assert.deepEqual(await tc.call("session.send", request), accepted);
  assert.deepEqual(await tc.call("session.create", createdRequest), created);
  await rejects(tc.call("session.send", { ...request, input: "different" }), /idempotency payload mismatch/);
  await tc.call("session.send", { ...request, clientRequestId: "new", input: "new input under pressure" });
  await wait(() => invoked === 2);
  const second = await tc.call("session.create", { ...createdRequest, clientRequestId: "second" }) as { sessionId: string };
  assert.notEqual(second.sessionId, created.sessionId);
  const workflow = await tc.call("workflow.run", { project: project.project.projectId, plan }) as { workflowId: string };
  await wait(() => store.getWorkflow(workflow.workflowId)?.status === "completed");
  assert.equal(invoked, 3, "new provider work was not rejected or hidden behind a queue");
  assert.ok(store.delivery.snapshot().pendingCount > 2);
  await tc.call("session.status", { sessionId: created.sessionId });
  await tc.call("session.interrupt", { sessionId: created.sessionId });
  const transcriptDir = store.transcriptDir()!;
  const history = readdirSync(transcriptDir).map(name => [name, readFileSync(join(transcriptDir, name), "utf8")]);
  await tc.call("stream.ack", { sessionId: created.sessionId, lastSeq: 999 });
  assert.deepEqual(readdirSync(transcriptDir).map(name => [name, readFileSync(join(transcriptDir, name), "utf8")]), history, "ACK never trims JSONL history");
  await tc.conn.dispose(); store.close();
  store = new PhononStore(dbPath, { delivery: { maxPendingBytes: 1 } });
  tc = new TestConn({ registry, store, workspaceRoot: root });
  assert.deepEqual(await tc.call("session.send", request), accepted, "persistent identical request returns the original result");
  await rejects(tc.call("session.send", { ...request, input: "expanded-after-reopen" }), /idempotency payload mismatch/);
  await tc.call("session.send", { ...request, clientRequestId: "after-reopen" });
  await wait(() => invoked === 4);
  for (const tenant of ["tenant-test", "disconnected"]) for (const row of store.outboxLoad(tenant)) store.outboxAck(tenant, row.sessionId, 999);
  for (const row of store.listWorkflows("tenant-test")) store.ackWorkflow(row.workflow_id as string, 999, "tenant-test");
  assert.equal(tc.conn.deliveryStatus().pendingBytes, 0);
  assert.equal(tc.conn.deliveryStatus().state, "normal");
  await tc.conn.dispose(); store.close();
});

test("delivery: workflow already accepted keeps emitting all terminal events over capacity and retry identity is unchanged", async () => {
  const root = mkdtempSync(join(tmpdir(), "phonon-cap-workflow-"));
  const store = new PhononStore(join(root, "state.sqlite"), { delivery: { maxPendingBytes: 1 } });
  const registry = new AdapterRegistry(); registry.register(new MockAdapter({ sendDelayMs: 30 }));
  const tc = new TestConn({ registry, store, workspaceRoot: root });
  const project = await tc.call("project.create", { name: "p", git: false }) as { project: { projectId: string } };
  const request = { project: project.project.projectId, plan, clientRequestId: "wf" };
  const result = await tc.call("workflow.run", request) as { workflowId: string };
  await wait(() => store.getWorkflow(result.workflowId)?.status === "completed");
  assert.equal(store.delivery.snapshot().state, "critical");
  assert.ok(store.unackedWorkflowEvents("tenant-test").some(e => JSON.parse(e.payload).status === "completed"));
  const duplicate = await tc.call("workflow.run", request) as { workflowId: string };
  assert.equal(duplicate.workflowId, result.workflowId);
  await rejects(tc.call("workflow.run", { ...request, input: "expanded" }), /idempotency mismatch/);
  await rejects(tc.call("workflow.resume", { workflowId: result.workflowId }), /not resumable/);
  const next = await tc.call("workflow.run", { project: project.project.projectId, plan }) as { workflowId: string };
  assert.notEqual(next.workflowId, result.workflowId);
  await wait(() => store.getWorkflow(next.workflowId)?.status === "completed");
  await tc.call("workflow.status", { workflowId: result.workflowId });
  await tc.call("workflow.cancel", { workflowId: result.workflowId });
  await tc.call("workflow.ack", { workflowId: result.workflowId, lastSeq: 999 });
  assert.ok(store.unackedWorkflowEvents("tenant-test").every(e => e.workflowId === next.workflowId));
  await tc.call("workflow.ack", { workflowId: next.workflowId, lastSeq: 999 });
  assert.equal(store.delivery.snapshot().channels.workflow.count, 0);
  await tc.conn.dispose(); store.close();
});

test("delivery: manual/webhook/automatic scheduler work runs normally at critical pressure without disabling or deferring", async () => {
  const root = mkdtempSync(join(tmpdir(), "phonon-cap-sched-")); const dbPath = join(root, "state.sqlite");
  const store = new PhononStore(dbPath, { delivery: { maxPendingBytes: 1 } });
  const registry = new AdapterRegistry(); registry.register(new MockAdapter());
  const tc = new TestConn({ registry, store, workspaceRoot: root });
  const project = await tc.call("project.create", { name: "p", git: false }) as { project: { projectId: string } };
  const manual = await tc.call("schedule.create", { name: "manual", trigger: { kind: "manual" }, target: { runKind: "workflow", project: project.project.projectId, plan }, consent: { push: "summary" } }) as { schedule: { id: string } };
  const accepted = await tc.call("schedule.trigger", { scheduleId: manual.schedule.id, clientRequestId: "run" }) as { runId: string };
  await wait(() => store.getRun(accepted.runId)?.status === "success");
  assert.equal(store.delivery.snapshot().state, "critical");
  assert.deepEqual(await tc.call("schedule.trigger", { scheduleId: manual.schedule.id, clientRequestId: "run" }), accepted);
  const another = await tc.call("schedule.trigger", { scheduleId: manual.schedule.id }) as { runId: string };
  await wait(() => store.getRun(another.runId)?.status === "success");
  assert.notEqual(another.runId, accepted.runId);
  const webhook = await tc.call("schedule.create", { name: "webhook", trigger: { kind: "webhook" }, target: { runKind: "session", project: project.project.projectId, agent: "mock:default", model: "m1", prompt: "hello" }, consent: { push: "summary" } }) as { webhookToken: string };
  const webRun = await internal(tc).scheduler.triggerByWebhook(webhook.webhookToken);
  await wait(() => store.getRun(webRun.runId)?.status === "success");
  const cron = await tc.call("schedule.create", { name: "cron", trigger: { kind: "cron", expr: "* * * * *" }, target: { runKind: "session", project: project.project.projectId, agent: "mock:default", model: "m1", prompt: "hello" }, consent: { push: "summary" } }) as { schedule: { id: string } };
  const db = new DatabaseSync(dbPath); const due = new Date(Date.now() - 60_000).toISOString();
  db.prepare("UPDATE schedules SET next_run_at=? WHERE id=?").run(due, cron.schedule.id);
  await (internal(tc).scheduler as unknown as { onCronFire: (id: string) => Promise<void> }).onCronFire(cron.schedule.id);
  await wait(() => store.listRunsForSchedule(cron.schedule.id)[0]?.status === "success");
  assert.equal(store.listRunsForSchedule(cron.schedule.id).length, 1);
  assert.equal(store.getSchedule(cron.schedule.id)?.enabled, 1);
  assert.notEqual(store.getSchedule(cron.schedule.id)?.next_run_at, due, "cron is actually accepted, not capacity deferred");
  assert.equal(store.delivery.snapshot().admissionBlocked, false);
  await tc.call("schedule.delete", { scheduleId: manual.schedule.id });
  assert.ok(store.getRun(accepted.runId));
  await tc.call("schedule.ack", { runId: accepted.runId, finished: true });
  db.close(); await tc.conn.dispose(); store.close();
});

test("delivery: workflow and scheduler ACK failures do not advance live runtime watermarks", async () => {
  const root = mkdtempSync(join(tmpdir(), "phonon-cap-acks-"));
  const dbPath = join(root, "state.sqlite"); const store = new PhononStore(dbPath);
  const registry = new AdapterRegistry(); const adapter = new MockAdapter({ sendDelayMs: 300, proactiveOutput: true }); registry.register(adapter);
  const tc = new TestConn({ registry, store, workspaceRoot: root });
  const project = await tc.call("project.create", { name: "p", git: false }) as { project: { projectId: string } };
  const result = await tc.call("workflow.run", { project: project.project.projectId, plan }) as { workflowId: string };
  await wait(() => store.getWorkflow(result.workflowId)?.status === "completed");
  const wf = internal(tc).workflows;
  const state = (wf as unknown as { runs: Map<string, { ackedSeq: number }> }).runs.get(result.workflowId)!;
  const db = new DatabaseSync(dbPath);
  db.exec("CREATE TRIGGER fail_workflow_ack BEFORE UPDATE OF acked_seq ON workflows WHEN NEW.acked_seq>OLD.acked_seq BEGIN SELECT RAISE(ABORT,'injected workflow ACK failure'); END");
  assert.throws(() => wf.ack(result.workflowId, 999), /injected workflow ACK failure/);
  assert.equal(state.ackedSeq, -1);
  assert.equal(store.getWorkflow(result.workflowId)?.acked_seq, -1);
  db.exec("DROP TRIGGER fail_workflow_ack");
  wf.ack(result.workflowId, 999);
  // Restore admission only for this test: reopening is the documented response to a persistence failure.
  await tc.conn.dispose(); store.close();
  const reopened = new PhononStore(dbPath);
  const tc2 = new TestConn({ registry, store: reopened, workspaceRoot: root });
  const schedule = await tc2.call("schedule.create", { name: "full", trigger: { kind: "manual" }, target: { runKind: "session", project: project.project.projectId, agent: "mock:default", model: "m1", prompt: "run" }, consent: { push: "full" } }) as { schedule: { id: string } };
  const launched = await tc2.call("schedule.trigger", { scheduleId: schedule.schedule.id }) as { runId: string };
  await tc2.call("run.events.subscribe", { runId: launched.runId });
  adapter.lastSession!.emitUnsolicited("pending event");
  const scheduler = internal(tc2).scheduler;
  const rt = (scheduler as unknown as { runtimes: Map<string, { ackedSeq: number }> }).runtimes.get(launched.runId)!;
  assert.ok(reopened.unackedRunEvents("tenant-test").length > 0);
  db.exec("CREATE TRIGGER fail_run_ack BEFORE UPDATE OF acked_seq ON runs WHEN NEW.acked_seq>OLD.acked_seq BEGIN SELECT RAISE(ABORT,'injected run ACK failure'); END");
  assert.throws(() => scheduler.ack(launched.runId, { lastSeq: 0 }), /injected run ACK failure/);
  assert.equal(rt.ackedSeq, -1);
  assert.equal(reopened.getRun(launched.runId)?.acked_seq, -1);
  db.exec("DROP TRIGGER fail_run_ack");
  await tc2.call("run.cancel", { runId: launched.runId });
  scheduler.ack(launched.runId, { lastSeq: 999, finished: true });
  assert.equal(reopened.delivery.snapshot().channels.run.count, 0);
  db.close(); await tc2.conn.dispose(); reopened.close();
});

test("delivery: cron automatic work remains accepted at critical pressure after SQLite reopening", async () => {
  const root = mkdtempSync(join(tmpdir(), "phonon-cap-cron-reopen-")); const dbPath = join(root, "state.sqlite");
  const registry = new AdapterRegistry(); let invoked = 0;
  registry.register(new MockAdapter({ reply: input => { invoked++; return input; } }));
  let store = new PhononStore(dbPath, { delivery: { maxPendingBytes: 1 } });
  let tc = new TestConn({ registry, store, workspaceRoot: root });
  const project = await tc.call("project.create", { name: "p", git: false }) as { project: { projectId: string } };
  store.outboxAdd("offline", "s", 0, "x", now);
  const created = await tc.call("schedule.create", { name: "cron", trigger: { kind: "cron", expr: "* * * * *" }, target: { runKind: "session", project: project.project.projectId, agent: "mock:default", model: "m1", prompt: "due" }, policy: { catchUp: true }, consent: { push: "summary" } }) as { schedule: { id: string } };
  const db = new DatabaseSync(dbPath); const due = new Date(Date.now() - 60_000).toISOString();
  db.prepare("UPDATE schedules SET next_run_at=? WHERE id=?").run(due, created.schedule.id);
  await (internal(tc).scheduler as unknown as { onCronFire: (id: string) => Promise<void> }).onCronFire(created.schedule.id);
  await wait(() => invoked === 1 && store.listRunsForSchedule(created.schedule.id)[0]?.status === "success");
  assert.equal(store.getSchedule(created.schedule.id)?.enabled, 1);
  await tc.conn.dispose(); store.close();
  db.prepare("UPDATE schedules SET next_run_at=? WHERE id=?").run(due, created.schedule.id);
  store = new PhononStore(dbPath, { delivery: { maxPendingBytes: 1 } });
  assert.equal(store.delivery.snapshot().state, "critical");
  tc = new TestConn({ registry, store, workspaceRoot: root });
  await wait(() => invoked === 2 && store.listRunsForSchedule(created.schedule.id).length === 2 && store.listRunsForSchedule(created.schedule.id)[0]?.status === "success");
  assert.notEqual(store.getSchedule(created.schedule.id)?.next_run_at, due);
  assert.equal(store.delivery.snapshot().admissionBlocked, false);
  db.close(); await tc.conn.dispose(); store.close();
});

test("delivery: cron acceptance transaction failure retains the due intent and never invokes a provider", async () => {
  const root = mkdtempSync(join(tmpdir(), "phonon-cap-cron-fail-")); const dbPath = join(root, "state.sqlite");
  const registry = new AdapterRegistry(); const adapter = new MockAdapter(); registry.register(adapter);
  const store = new PhononStore(dbPath); const tc = new TestConn({ registry, store, workspaceRoot: root });
  const project = await tc.call("project.create", { name: "p", git: false }) as { project: { projectId: string } };
  const created = await tc.call("schedule.create", { name: "cron", trigger: { kind: "cron", expr: "* * * * *" }, target: { runKind: "session", project: project.project.projectId, agent: "mock:default", model: "m1", prompt: "due" }, consent: { push: "summary" } }) as { schedule: { id: string } };
  const db = new DatabaseSync(dbPath); const due = new Date(Date.now() - 60_000).toISOString();
  db.prepare("UPDATE schedules SET next_run_at=? WHERE id=?").run(due, created.schedule.id);
  db.exec("CREATE TRIGGER fail_cron_accept BEFORE UPDATE OF next_run_at ON schedules BEGIN SELECT RAISE(ABORT,'injected cron acceptance failure'); END");
  await assert.rejects((internal(tc).scheduler as unknown as { onCronFire: (id: string) => Promise<void> }).onCronFire(created.schedule.id), /injected cron acceptance failure/);
  assert.equal(store.listRunsForSchedule(created.schedule.id).length, 0);
  assert.equal(store.getSchedule(created.schedule.id)?.next_run_at, due);
  assert.equal(adapter.lastSession, undefined);
  assert.equal(store.delivery.snapshot().persistenceHealthy, false);
  db.exec("DROP TRIGGER fail_cron_accept"); db.close(); await tc.conn.dispose(); store.close();
});

test("delivery: background initial event persistence failure is explicit unhealthy, not an unhandled rejection", async () => {
  const root = mkdtempSync(join(tmpdir(), "phonon-cap-turn-fail-")); const dbPath = join(root, "state.sqlite");
  const store = new PhononStore(dbPath); const bus = new ObsBus(); let failures = 0;
  bus.onEvent(e => { if (e.event === "delivery.persistence_failed") failures++; });
  store.delivery.configure(undefined, bus);
  const registry = new AdapterRegistry(); registry.register(new MockAdapter());
  const tc = new TestConn({ registry, store, workspaceRoot: root });
  const project = await tc.call("project.create", { name: "p", git: false }) as { project: { projectId: string } };
  const created = await tc.call("session.create", { project: project.project.projectId, agent: "mock:default", model: "m1" }) as { sessionId: string };
  const db = new DatabaseSync(dbPath);
  db.exec("CREATE TRIGGER fail_generated_event BEFORE INSERT ON outbox_events BEGIN SELECT RAISE(ABORT,'injected event persistence failure'); END");
  await tc.call("session.send", { sessionId: created.sessionId, input: "generate" });
  await wait(() => !store.delivery.snapshot().persistenceHealthy);
  assert.equal(failures, 1);
  assert.equal(tc.streamEvents.length, 0, "never claim transport delivery before persistence");
  await rejects(tc.call("session.send", { sessionId: created.sessionId, input: "new work" }), /unhealthy/);
  db.exec("DROP TRIGGER fail_generated_event");
  await tc.call("session.status", { sessionId: created.sessionId });
  db.close(); await tc.conn.dispose(); store.close();
});

test("delivery: workflow.run resume dispatch is a durable independent receipt under pressure and after SQLite reopening", async () => {
  const root = mkdtempSync(join(tmpdir(), "phonon-resume-dispatch-")); const dbPath = join(root, "state.sqlite");
  let store = new PhononStore(dbPath); const registry = new AdapterRegistry(); registry.register(new MockAdapter({ sendDelayMs: 100 }));
  let tc = new TestConn({ registry, store, workspaceRoot: root });
  const p = await tc.call("project.create", { name: "p", git: false }) as { project: { projectId: string } };
  const original = { project: p.project.projectId, plan, clientRequestId: "original-dispatch" };
  const started = await tc.call("workflow.run", original) as { workflowId: string };
  await tc.call("workflow.pause", { workflowId: started.workflowId });
  store.delivery.configure({ maxPendingBytes: 1 });
  assert.equal(store.delivery.snapshot().state, "critical");
  const request = { project: p.project.projectId, plan, clientRequestId: "resume-dispatch",
    resumeFrom: { workflowId: started.workflowId, strategy: "failed_node" } };
  const resumed = await tc.call("workflow.run", request);
  store.delivery.configure({ maxPendingBytes: 1 });
  const epoch = store.getWorkflow(started.workflowId)?.checkpoint_json;
  assert.deepEqual(await tc.call("workflow.run", request), resumed);
  assert.equal(store.getWorkflow(started.workflowId)?.checkpoint_json, epoch, "duplicate does not restore/execute again");
  await rejects(tc.call("workflow.run", { ...request, input: "changed" }), /idempotency mismatch/);
  assert.equal(JSON.parse(store.getWorkflow(started.workflowId)!.metadata_json as string)._phononDispatch.key, original.clientRequestId);
  assert.ok(store.workflowResumeDispatch("tenant-test", request.clientRequestId));
  assert.equal(store.workflowResumeDispatch("another-tenant", request.clientRequestId), undefined);
  await tc.call("workflow.pause", { workflowId: started.workflowId });
  await tc.conn.dispose(); store.close();
  store = new PhononStore(dbPath, { delivery: { maxPendingBytes: 1 } });
  tc = new TestConn({ registry, store, workspaceRoot: root });
  const restoredEpoch = store.getWorkflow(started.workflowId)?.checkpoint_json;
  assert.deepEqual(await tc.call("workflow.run", request), resumed);
  assert.equal(store.getWorkflow(started.workflowId)?.checkpoint_json, restoredEpoch);
  await rejects(tc.call("workflow.run", { ...request, input: "changed-after-reopen" }), /idempotency mismatch/);
  assert.equal((await tc.call("workflow.run", original) as { workflowId: string }).workflowId, started.workflowId);
  assert.equal(JSON.parse(store.getWorkflow(started.workflowId)!.metadata_json as string)._phononDispatch.key, original.clientRequestId);
  await tc.conn.dispose(); store.close();
});

test("delivery: resume dispatch/event/checkpoint acceptance rolls back together on SQLite event failure", async () => {
  const root = mkdtempSync(join(tmpdir(), "phonon-resume-rollback-")); const dbPath = join(root, "state.sqlite");
  const store = new PhononStore(dbPath); const registry = new AdapterRegistry(); registry.register(new MockAdapter({ sendDelayMs: 100 }));
  const tc = new TestConn({ registry, store, workspaceRoot: root });
  const p = await tc.call("project.create", { name: "p", git: false }) as { project: { projectId: string } };
  const started = await tc.call("workflow.run", { project: p.project.projectId, plan, clientRequestId: "original" }) as { workflowId: string };
  await tc.call("workflow.pause", { workflowId: started.workflowId });
  const before = store.getWorkflow(started.workflowId)!;
  const rows = store.unackedWorkflowEvents("tenant-test").length;
  const db = new DatabaseSync(dbPath);
  db.exec("CREATE TRIGGER fail_resume_accept BEFORE INSERT ON workflow_events BEGIN SELECT RAISE(ABORT,'resume acceptance failure'); END");
  await rejects(tc.call("workflow.run", { project: p.project.projectId, plan, clientRequestId: "resume",
    resumeFrom: { workflowId: started.workflowId, strategy: "failed_node" } }), /resume acceptance failure/);
  assert.equal(store.workflowResumeDispatch("tenant-test", "resume"), undefined);
  assert.equal(store.getWorkflow(started.workflowId)?.status, "paused");
  assert.equal(store.getWorkflow(started.workflowId)?.seq, before.seq);
  assert.equal(store.getWorkflow(started.workflowId)?.checkpoint_json, before.checkpoint_json);
  assert.equal(store.unackedWorkflowEvents("tenant-test").length, rows);
  assert.equal(store.delivery.snapshot().persistenceHealthy, false);
  db.exec("DROP TRIGGER fail_resume_accept"); db.close(); await tc.conn.dispose();
  assert.equal(store.getWorkflow(started.workflowId)?.status, "paused", "teardown cannot publish a phantom accepted resume after rollback");
  assert.equal(store.workflowResumeDispatch("tenant-test", "resume"), undefined);
  store.close();
});

test("delivery: legal NUL request IDs cannot collide with fingerprints, both acceptance orders survive SQLite reopening", async () => {
  const { IdempotencyStore } = await import("@agent-phonon/core");
  for (const order of [["x", "x\u0000request-sha256"], ["x\u0000request-sha256", "x"]]) {
    const dbPath = path(); let store = new PhononStore(dbPath); let cache = new IdempotencyStore({ store });
    let calls = 0;
    const expected = new Map<string, unknown>();
    for (const key of order) {
      const result = await cache.run("tenant", "session.create", key, async () => { calls++; return { id: key }; }, { input: key });
      expected.set(key, result);
    }
    assert.equal(calls, 2);
    store.close(); store = new PhononStore(dbPath); cache = new IdempotencyStore({ store });
    for (const key of order) {
      assert.deepEqual(await cache.run("tenant", "session.create", key, async () => { throw new Error("duplicate provider invocation"); }, { input: key }), expected.get(key));
      await assert.rejects(cache.run("tenant", "session.create", key, async () => ({}), { input: "changed" }), /idempotency payload mismatch/);
    }
    const db = new DatabaseSync(dbPath);
    const entries = db.prepare("SELECT k,result,request_hash FROM idempotency ORDER BY k").all() as Array<{ k: string; result: string; request_hash: string }>;
    assert.equal(entries.length, 2, "fingerprints do not insert fake request-key rows");
    assert.ok(entries.every(e => e.request_hash.length === 64 && JSON.parse(e.result).id !== undefined));
    db.close(); store.close();
  }
});

test("delivery: fingerprint migration retains legacy results and ambiguous sidecars without guessing request hashes", async () => {
  const { IdempotencyStore } = await import("@agent-phonon/core");
  const dbPath = path(); const db = new DatabaseSync(dbPath);
  db.exec("CREATE TABLE idempotency(k TEXT PRIMARY KEY,result TEXT NOT NULL,created_at INTEGER NOT NULL)");
  const key = "tenant\u0000session.create\u0000legacy";
  db.prepare("INSERT INTO idempotency VALUES(?,?,?)").run(key, JSON.stringify({ id: "original" }), 1);
  db.prepare("INSERT INTO idempotency VALUES(?,?,?)").run(key + "\u0000request-sha256", "ambiguous-old-value", 1);
  db.close(); const store = new PhononStore(dbPath);
  assert.equal(store.idempotencyGet(key), JSON.stringify({ id: "original" }));
  assert.equal(store.idempotencyGet(key + "\u0000request-sha256"), "ambiguous-old-value");
  assert.equal(store.idempotencyFingerprint(key), undefined);
  const cache = new IdempotencyStore({ store });
  await assert.rejects(cache.run("tenant", "session.create", "legacy", async () => { throw new Error("must not redispatch legacy"); }, { input: "unknown" }), /unverifiable legacy identity/);
  store.close();
});

for (const mode of ["workflow-events", "scheduler-queue", "scheduler-retry", "scheduler-recovery", "run-events", "scheduler-timeout"]) {
  test(`delivery: independent strict Node survives continuous SQLite ${mode} failure without unhandled rejection`, { timeout: 10000 }, async () => {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const { fileURLToPath } = await import("node:url");
    const script = fileURLToPath(new URL("./delivery-failure-child.js", import.meta.url));
    const { stdout, stderr } = await promisify(execFile)(process.execPath, ["--unhandled-rejections=strict", script, mode], { timeout: 8000 });
    assert.ok(!stderr.includes("private-generated-payload") && !stderr.includes("UnhandledPromiseRejection"));
    const proof = JSON.parse(stdout.trim().split("\n").at(-1)!) as { mode: string; survived: boolean; unhandledRejections: number; persistenceHealthy: boolean };
    assert.equal(proof.mode, mode); assert.equal(proof.survived, true);
    assert.equal(proof.unhandledRejections, 0); assert.equal(proof.persistenceHealthy, false);
  });
}

test("delivery: explicit workflow.resume accepts execution at critical pressure without inventing an inbound queue", async () => {
  const root = mkdtempSync(join(tmpdir(), "phonon-explicit-resume-critical-"));
  const store = new PhononStore(join(root, "state.sqlite"), { delivery: { maxPendingBytes: 1 } });
  const registry = new AdapterRegistry(); registry.register(new MockAdapter({ sendDelayMs: 60 }));
  const tc = new TestConn({ registry, store, workspaceRoot: root });
  const p = await tc.call("project.create", { name: "p", git: false }) as { project: { projectId: string } };
  const first = await tc.call("workflow.run", { project: p.project.projectId, plan }) as { workflowId: string };
  await tc.call("workflow.pause", { workflowId: first.workflowId });
  assert.equal(store.delivery.snapshot().state, "critical");
  const request = { workflowId: first.workflowId, strategy: "failed_node" };
  const resumed = await tc.call("workflow.resume", request) as { workflowId: string; resumed: boolean };
  assert.equal(resumed.workflowId, first.workflowId); assert.equal(resumed.resumed, true);
  await wait(() => store.getWorkflow(first.workflowId)?.status === "completed");
  assert.equal(store.delivery.snapshot().admissionBlocked, false);
  assert.ok(store.unackedWorkflowEvents("tenant-test").some(e => JSON.parse(e.payload).status === "completed"));
  await tc.conn.dispose(); store.close();
});
