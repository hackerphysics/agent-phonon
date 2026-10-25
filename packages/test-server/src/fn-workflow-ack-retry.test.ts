import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { WebSocket, WebSocketServer } from "ws";
import { AdapterRegistry, PhononClient, PhononConnection, PhononStore } from "@agent-phonon/core";
import { PhononDevice } from "@agent-phonon/server-sdk";
import type { WorkflowEvent } from "@agent-phonon/protocol";
import { RpcPeer } from "../../sdk-server-ts/dist/rpc.js";
import { withPeerFixture, type PeerFixture } from "../../core/dist/testing/peer-fixture.js";
import { ObsBus } from "../../core/dist/observability.js";
import { MockAdapter } from "./harness.js";

const RETRY_MS = 5_000;
const BATCH = 32;
const BUFFER_LIMIT = 256 * 1024;
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
async function drain() {
  for (let i = 0; i < 20; i++) await new Promise<void>(resolve => setImmediate(resolve));
}
async function until(check: () => boolean, label: string) {
  for (let i = 0; i < 200; i++) { if (check()) return; await drain(); }
  assert.ok(check(), label);
}
function clock(t: TestContext) {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const set = globalThis.setTimeout, clear = globalThis.clearTimeout;
  const active = new Set<ReturnType<typeof setTimeout>>();
  t.mock.method(globalThis, "setTimeout", (callback: (...args: any[]) => void, delay: number, ...args: any[]) => {
    const handle = set(() => { active.delete(handle); callback(...args); }, delay);
    active.add(handle);
    return handle;
  });
  t.mock.method(globalThis, "clearTimeout", (handle: ReturnType<typeof setTimeout> | undefined) => {
    if (handle !== undefined) active.delete(handle);
    clear(handle);
  });
  return { active, tick: (ms: number) => t.mock.timers.tick(ms) };
}

async function fixture(scope: PeerFixture, options: {
  handler?: (event: WorkflowEvent) => Promise<unknown> | unknown;
  dropAck?: (ack: { workflowId: string; lastSeq: number }, index: number) => boolean;
} = {}) {
  const store = new PhononStore(join(scope.root, "device.sqlite"));
  scope.defer(() => store.close());
  const journal = new DatabaseSync(join(scope.root, "server.sqlite"));
  scope.defer(() => journal.close());
  journal.exec("CREATE TABLE receipts (workflow_id TEXT,seq INTEGER,payload TEXT,hash TEXT,PRIMARY KEY(workflow_id,seq))");
  const sockets: WebSocket[] = [], devices: PhononDevice[] = [];
  const events: Array<{ socket: number; event: WorkflowEvent; raw: string }> = [];
  const acks: Array<{ socket: number; workflowId: string; lastSeq: number; dropped: boolean }> = [];
  const inputs: string[] = [];
  let creates = 0, recoveries = 0;
  const registry = new AdapterRegistry(), adapter = new MockAdapter({ reply: () => "original native completion" });
  const create = adapter.createSession.bind(adapter), recover = adapter.recoverSession.bind(adapter);
  adapter.createSession = async params => {
    creates++;
    const session = await create(params), send = session.send.bind(session);
    session.send = async (input, opts) => { inputs.push(input); return send(input, opts); };
    return session;
  };
  adapter.recoverSession = async (params, checkpoint) => { recoveries++; return recover(params, checkpoint); };
  registry.register(adapter);
  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  scope.defer(async () => {
    await Promise.all(sockets.map(socket => new Promise<void>(resolve => {
      if (socket.readyState === WebSocket.CLOSED) { resolve(); return; }
      socket.once("close", () => resolve()); socket.terminate();
    })));
    await drain();
    await new Promise<void>((resolve, reject) => wss.close(error => error && (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING" ? reject(error) : resolve()));
    assert.equal(wss.clients.size, 0);
  });
  wss.on("connection", socket => {
    const index = sockets.push(socket) - 1;
    let device: PhononDevice | undefined;
    const peer = new RpcPeer({
      send(data) {
        const frame = JSON.parse(data);
        if (frame.method === "workflow.ack") {
          const dropped = options.dropAck?.(frame.params, index) ?? false;
          acks.push({ socket: index, ...frame.params, dropped });
          if (dropped) return;
        }
        socket.send(data);
      },
      close: () => socket.close(),
    }, async (method, params) => {
      if (method === "connect.hello") {
        const hello = params as { deviceId: string; auth?: { deviceKey?: string } };
        assert.equal(hello.auth?.deviceKey, "synthetic-key");
        device = new PhononDevice(hello.deviceId, "owner", peer);
        device.setWorkflowEventHandler(async event => {
          await options.handler?.(event);
          const payload = JSON.stringify(event);
          const previous = journal.prepare("SELECT payload FROM receipts WHERE workflow_id=? AND seq=?").get(event.workflowId, event.seq);
          if (previous) assert.equal(previous.payload, payload, "duplicate must have identical bytes");
          journal.prepare("INSERT OR IGNORE INTO receipts VALUES(?,?,?,?)").run(event.workflowId, event.seq, payload, hash(payload));
        });
        devices.push(device);
        return { tenantId: "owner" };
      }
      assert.ok(device);
      return device._handleInbound(method, params);
    });
    socket.on("error", () => {});
    socket.on("close", () => peer.rejectAll("owned synthetic socket closed"));
    socket.on("message", raw => {
      const data = raw.toString(), frame = JSON.parse(data);
      if (frame.method === "workflow.event") events.push({ socket: index, event: frame.params, raw: data });
      void peer.handle(data);
    });
  });
  await new Promise<void>((resolve, reject) => {
    wss.once("error", reject);
    wss.once("listening", () => { wss.off("error", reject); resolve(); });
  });
  const address = wss.address(); assert.ok(address && typeof address !== "string");
  const client = new PhononClient({
    serverUrl: `ws://127.0.0.1:${address.port}`, deviceId: "ack-retry", deviceKey: "synthetic-key", expectedTenantId: "owner",
    registry, store, workspaceRoot: scope.root, trustLocal: true,
    connectionTiming: { pingIntervalMs: 60_000, stableConnectionMs: 60_000 },
  });
  scope.defer(() => client.close());
  return { store, journal, sockets, devices, events, acks, inputs, client, get creates() { return creates; }, get recoveries() { return recoveries; } };
}

function seed(store: PhononStore, workflowId: string, tenantId = "owner", count = 1, text = "synthetic paused metadata") {
  const timestamp = "2026-10-25T00:00:00.000Z";
  for (let seq = 0; seq < count; seq++) {
    const payload = JSON.stringify({ workflowId, seq, timestamp, type: "workflow.status", status: "paused", payload: { text } });
    assert.equal(store.appendWorkflowEvent({
      workflowId, tenantId, mode: "dag", planJson: '{"mode":"dag","nodes":[]}', status: "paused", nodesJson: "[]",
      seq: seq + 1, ackedSeq: -1, createdAt: timestamp, updatedAt: timestamp, ownerId: "synthetic-fixture", ownerEpoch: 0,
    }, { seq, payload, createdAt: timestamp }), true);
  }
}

test("lost terminal ACK converges on the same authenticated socket without another execution", async t => withPeerFixture("workflow-ack-retry", async scope => {
  const time = clock(t);
  let dropped = false;
  const f = await fixture(scope, { dropAck(ack) {
    const row = f.store.workflowEvents(ack.workflowId, "owner", ack.lastSeq - 1, 1)[0];
    if (!dropped && row && JSON.parse(row.payload).status === "completed" && JSON.parse(row.payload).type === "workflow.status") {
      assert.equal(f.journal.prepare("SELECT hash FROM receipts WHERE workflow_id=? AND seq=?").get(ack.workflowId, ack.lastSeq)?.hash, hash(row.payload));
      dropped = true; return true;
    }
    return false;
  } });
  await f.client.connect();
  const device = f.devices[0]!;
  const project = (await device.call("project.create", { name: "original", git: false }) as any).project.projectId;
  const run = await device.workflow.run({ project, metadata: { native_run_id: "11111111-1111-4111-8111-111111111111" },
    plan: { mode: "dag", nodes: [{ nodeId: "reply", agent: "mock:default", model: "m1", input: "exact original input" }], finalNodeId: "reply" } });
  await until(() => dropped && f.store.delivery.snapshot().channels.workflow.count === 1, "only terminal ACK should remain pending");
  const before = f.store.getWorkflow(run.workflowId, "owner")!, seq = Number(before.seq) - 1;
  const payload = f.store.workflowEvents(run.workflowId, "owner", seq - 1, 1)[0]!.payload;
  assert.equal(before.status, "completed"); assert.equal(before.acked_seq, seq - 1);
  const connection = f.client.connection, attempts = f.events.length;
  time.tick(RETRY_MS - 1); await drain(); assert.equal(f.events.length, attempts);
  time.tick(1); await drain();
  await until(() => f.store.delivery.snapshot().channels.workflow.count === 0, "same connected socket must retry persisted terminal event and receive a real ACK");
  const copies = f.events.filter(value => value.event.workflowId === run.workflowId && value.event.seq === seq);
  assert.equal(copies.length, 2); assert.equal(copies[0]!.raw, copies[1]!.raw);
  for (const copy of copies) { assert.equal(hash(JSON.stringify(copy.event)), hash(payload)); assert.equal(copy.socket, 0); }
  assert.equal(f.client.connection, connection); assert.equal(f.sockets.length, 1); assert.equal(f.sockets[0]!.readyState, WebSocket.OPEN);
  assert.equal(f.acks.filter(value => value.dropped).length, 1);
  assert.deepEqual(f.inputs, ["exact original input"]); assert.equal(f.creates, 1); assert.equal(f.recoveries, 0);
  const after = f.store.getWorkflow(run.workflowId, "owner")!;
  assert.equal(after.seq, before.seq); assert.equal(after.completed_at, before.completed_at); assert.equal(after.nodes_json, before.nodes_json);
  assert.equal(after.acked_seq, seq); assert.equal(f.store.workflowEvents(run.workflowId, "owner", seq - 1, 1)[0]!.payload, payload);
  time.tick(RETRY_MS); await drain(); assert.equal(f.events.length, attempts + 1, "ACKed terminal event must not be sent again");
  await f.client.close(); time.tick(60_000); await drain(); assert.equal(time.active.size, 0);
}));

test("rejected reliable handler never ACKs; disposal stops retries and leaves durable metadata pending", async t => withPeerFixture("workflow-ack-rejection", async scope => {
  const time = clock(t);
  let calls = 0;
  const f = await fixture(scope, { handler() { calls++; throw new Error("synthetic durable handler rejected"); } });
  seed(f.store, "rejected");
  await f.client.connect(); await until(() => calls === 1, "initial reliable handler call");
  for (let attempt = 2; attempt <= 3; attempt++) {
    time.tick(RETRY_MS); await until(() => calls === attempt, "rejected event must remain retryable");
    assert.equal(f.acks.length, 0); assert.equal(f.store.getWorkflow("rejected", "owner")!.acked_seq, -1);
    assert.equal(f.journal.prepare("SELECT count(*) AS n FROM receipts").get()!.n, 0);
  }
  await f.client.connection!.dispose();
  time.tick(RETRY_MS * 3); await drain(); assert.equal(calls, 3);
  assert.equal(f.store.delivery.snapshot().channels.workflow.count, 1);
  assert.equal(f.store.getWorkflow("rejected", "owner")!.status, "paused");
  assert.equal(f.inputs.length, 0); assert.equal(f.recoveries, 0);
  await f.client.close(); time.tick(60_000); await drain(); assert.equal(time.active.size, 0);
}));

test("transport replacement retires old retry ownership and only the successor can drain", async t => withPeerFixture("workflow-ack-replacement", async scope => {
  const time = clock(t);
  const f = await fixture(scope, { dropAck: (_ack, socket) => socket === 0 });
  seed(f.store, "replacement");
  await f.client.connect(); await until(() => f.acks.length === 1, "first dropped ACK");
  const previous = f.client.connection!;
  time.tick(1_000);
  await f.client.connect();
  await until(() => f.store.delivery.snapshot().channels.workflow.count === 0, "successor ACK");
  assert.equal(previous.isDisposed, true); assert.notEqual(f.client.connection, previous);
  assert.equal(f.sockets.length, 2);
  const oldCount = f.events.filter(value => value.socket === 0).length;
  seed(f.store, "successor-only");
  time.tick(RETRY_MS - 1); await drain(); assert.equal(f.events.filter(value => value.event.workflowId === "successor-only").length, 0);
  time.tick(1); await until(() => f.store.delivery.snapshot().channels.workflow.count === 0, "successor timer retries new pending metadata");
  assert.equal(f.events.filter(value => value.socket === 0).length, oldCount);
  assert.ok(f.events.filter(value => value.event.workflowId === "successor-only").every(value => value.socket === 1));
  assert.equal(f.inputs.length, 0); assert.equal(f.recoveries, 0);
  await f.client.close(); const sent = f.events.length;
  time.tick(60_000); await drain(); assert.equal(f.events.length, sent); assert.equal(time.active.size, 0);
}));

test("retries bound batch/rate, rotate past a stuck backlog, isolate tenants and yield to active RPCs", async t => withPeerFixture("workflow-ack-bounds", async scope => {
  const time = clock(t), f = await fixture(scope, { handler() { throw new Error("retain synthetic backlog"); } });
  seed(f.store, "a-backlog", "owner", BATCH + 8);
  seed(f.store, "z-later"); seed(f.store, "other-tenant", "other");
  await f.client.connect(); await drain();
  assert.equal(f.events.length, BATCH, "startup replay also has a bounded batch");
  time.tick(RETRY_MS - 1); await drain(); assert.equal(f.events.length, BATCH);
  time.tick(1); await drain();
  assert.equal(f.events.length, BATCH + 1); assert.equal(f.events.at(-1)!.event.workflowId, "z-later", "one stuck workflow must not starve another");
  const status = await f.devices[0]!.workflow.status("a-backlog"); assert.equal(status.status, "paused");
  time.tick(RETRY_MS); await drain(); assert.equal(f.events.length, 2 * BATCH + 1);
  assert.ok(f.events.every(value => value.event.workflowId !== "other-tenant"));
  assert.equal(f.acks.length, 0);
  await f.devices[0]!.workflow.ack("other-tenant", 999_999); await drain();
  assert.equal(f.store.getWorkflow("other-tenant", "other")!.acked_seq, -1);
  assert.equal(f.acks.length, 1); assert.equal(f.inputs.length, 0);
  await f.client.close(); time.tick(60_000); await drain(); assert.equal(time.active.size, 0);
}));

test("retry checks socket backpressure before each persisted event and bounds payload bytes", async t => withPeerFixture("workflow-ack-pressure", async scope => {
  const time = clock(t), f = await fixture(scope, { dropAck: () => true });
  await f.client.connect();
  seed(f.store, "pressure", "owner", 3, "x".repeat(150 * 1024));
  const socket = (f.client as unknown as { ws: WebSocket }).ws!;
  let blocked = true, reads = 0;
  Object.defineProperty(socket, "bufferedAmount", { configurable: true, get() { reads++; return blocked ? BUFFER_LIMIT : 0; } });
  time.tick(RETRY_MS); await drain(); assert.equal(f.events.length, 0); assert.ok(reads > 0);
  blocked = false;
  time.tick(RETRY_MS); await drain(); assert.equal(f.events.length, 1, "byte budget must yield before a second large event");
  const before = f.events.length;
  let checks = 0;
  Object.defineProperty(socket, "bufferedAmount", { configurable: true, get() { return ++checks > 2 ? BUFFER_LIMIT : 0; } });
  time.tick(RETRY_MS); await drain(); assert.equal(f.events.length, before + 1); assert.ok(checks >= 3);
  delete (socket as unknown as { bufferedAmount?: number }).bufferedAmount;
  assert.equal(f.store.getWorkflow("pressure", "owner")!.acked_seq, -1);
  assert.equal(f.store.getWorkflow("pressure", "owner")!.seq, 3); assert.equal(f.inputs.length, 0);
  await f.client.close(); time.tick(60_000); await drain(); assert.equal(time.active.size, 0);
}));

test("core-local: bounded metadata pages rotate fairly without scheduler effects or cross-tenant delivery", async t => withPeerFixture("workflow-ack-page-unit", async scope => {
  const time = clock(t), store = new PhononStore(join(scope.root, "device.sqlite"));
  scope.defer(() => store.close());
  seed(store, "a-backlog", "owner", BATCH + 8); seed(store, "z-later"); seed(store, "other", "other");
  const sent: string[] = [];
  const conn = new PhononConnection({ tenantId: "owner", store, registry: new AdapterRegistry(), workspaceRoot: scope.root,
    transport: { send: data => sent.push(data), close() {} } });
  scope.defer(() => conn.dispose());
  const scheduler = (conn as unknown as { scheduler: { onWorkflowEvent(event: WorkflowEvent): void } }).scheduler;
  const onWorkflowEvent = t.mock.method(scheduler, "onWorkflowEvent");
  const workflowFrames = () => sent.map(raw => JSON.parse(raw)).filter(frame => frame.method === "workflow.event");
  assert.equal(workflowFrames().length, BATCH);
  conn.startWorkflowEventRetry(() => true);
  conn.startWorkflowEventRetry(() => true);
  time.tick(RETRY_MS - 1); await drain(); assert.equal(workflowFrames().length, BATCH);
  time.tick(1); await drain(); assert.equal(workflowFrames().length, BATCH + 1);
  assert.equal(workflowFrames().at(-1)!.params.workflowId, "z-later");
  time.tick(RETRY_MS); await drain(); assert.equal(workflowFrames().length, BATCH * 2 + 1);
  assert.ok(workflowFrames().every(frame => frame.params.workflowId !== "other"));
  assert.equal(onWorkflowEvent.mock.callCount(), 0);
  assert.equal(store.getWorkflow("a-backlog", "owner")!.seq, BATCH + 8);
  assert.equal(store.getWorkflow("a-backlog", "owner")!.acked_seq, -1);
  assert.deepEqual(conn.sessionsSnapshot(), []);
  await conn.dispose(); assert.equal(time.active.size, 0, "disposal synchronously clears retry timers");
  const count = sent.length; time.tick(RETRY_MS * 3); await drain(); assert.equal(sent.length, count);
}));

test("core-local: backpressure avoids payload reads; byte pacing preserves exact stored JSON including oversized events", async t => withPeerFixture("workflow-ack-bytes-unit", async scope => {
  const time = clock(t), store = new PhononStore(join(scope.root, "device.sqlite"));
  scope.defer(() => store.close());
  const sent: string[] = [];
  const conn = new PhononConnection({ tenantId: "owner", store, registry: new AdapterRegistry(), workspaceRoot: scope.root,
    transport: { send: data => sent.push(data), close() {} } });
  scope.defer(() => conn.dispose());
  seed(store, "large", "owner", 3, "x".repeat(300 * 1024));
  const reads = t.mock.method(store, "workflowEvents");
  let ready = false;
  conn.startWorkflowEventRetry(() => ready);
  time.tick(RETRY_MS); await drain(); assert.equal(reads.mock.callCount(), 0); assert.equal(sent.length, 0);
  ready = true;
  time.tick(RETRY_MS); await drain(); assert.equal(reads.mock.callCount(), 1); assert.equal(sent.length, 1);
  const original = store.workflowEvents("large", "owner", -1, 1)[0]!.payload;
  assert.equal(sent[0], `{"jsonrpc":"2.0","method":"workflow.event","params":${original}}`);
  assert.equal(store.getWorkflow("large", "owner")!.acked_seq, -1);
  assert.equal(store.delivery.snapshot().channels.workflow.count, 3);
  await conn.dispose(); assert.equal(time.active.size, 0);
  time.tick(RETRY_MS * 2); await drain(); assert.equal(sent.length, 1);
}));

test("corrupt durable payload cannot change the replay RPC envelope or workflow identity", async t => withPeerFixture("workflow-ack-integrity", async scope => {
  const time = clock(t), file = join(scope.root, "device.sqlite"), store = new PhononStore(file);
  scope.defer(() => store.close());
  const sent: string[] = [];
  const conn = new PhononConnection({ tenantId: "owner", store, registry: new AdapterRegistry(), workspaceRoot: scope.root,
    transport: { send: data => sent.push(data), close() {} } });
  scope.defer(() => conn.dispose());
  seed(store, "original");
  const damaged = new DatabaseSync(file); scope.defer(() => damaged.close());
  conn.startWorkflowEventRetry(() => true);
  for (const payload of [
    '{},"method":"interaction.request","params":{}',
    JSON.stringify({ workflowId: "foreign-workflow", seq: 0, type: "workflow.status" }),
    JSON.stringify({ workflowId: "original", seq: 9, type: "workflow.status" }),
  ]) {
    damaged.prepare("UPDATE workflow_events SET payload=? WHERE workflow_id=? AND seq=0").run(payload, "original");
    time.tick(RETRY_MS); await drain();
    assert.deepEqual(sent, [], "invalid persisted JSON must not become an RPC frame");
    assert.equal(store.getWorkflow("original", "owner")!.acked_seq, -1);
    assert.equal(store.delivery.snapshot().channels.workflow.count, 1);
  }
  await conn.dispose(); assert.equal(time.active.size, 0);
}));

test("corrupt workflow head retains its gap while unrelated valid metadata drains", async t => withPeerFixture("workflow-ack-corrupt-fair", async scope => {
  const time = clock(t), f = await fixture(scope), bus = new ObsBus(), diagnostics: string[] = [];
  bus.onEvent(event => diagnostics.push(event.event)); f.store.delivery.configure(undefined, bus);
  seed(f.store, "a-corrupt", "owner", 2); seed(f.store, "z-valid");
  const damaged = new DatabaseSync(join(scope.root, "device.sqlite")); scope.defer(() => damaged.close());
  const payload = '{},"method":"interaction.request","params":{}';
  damaged.prepare("UPDATE workflow_events SET payload=? WHERE workflow_id=? AND seq=0").run(payload, "a-corrupt");
  await f.client.connect();
  time.tick(RETRY_MS); await drain();
  await until(() => f.store.getWorkflow("z-valid", "owner")!.acked_seq === 0, "valid workflow must drain past a corrupt unrelated head");
  assert.ok(f.events.every(value => value.event.workflowId === "z-valid"), "never send a corrupt workflow's later sequence across its gap");
  assert.equal(f.store.getWorkflow("a-corrupt", "owner")!.acked_seq, -1);
  assert.equal(f.store.workflowEvents("a-corrupt", "owner", -1, 1)[0]!.payload, payload);
  assert.equal(f.store.delivery.snapshot().channels.workflow.count, 2);
  assert.equal(f.store.delivery.snapshot().persistenceHealthy, false);
  time.tick(RETRY_MS * 2); await drain();
  assert.equal(diagnostics.filter(event => event === "delivery.background_failed").length, 1, "corruption reporting must remain bounded");
  assert.equal(f.inputs.length, 0); assert.equal(f.creates, 0); assert.equal(f.recoveries, 0);
  await f.client.close(); time.tick(60_000); await drain(); assert.equal(time.active.size, 0);
}));
