import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import { AdapterRegistry, PhononClient, PhononStore } from "@agent-phonon/core";
import { MockAdapter, TestConn } from "./harness.js";

class CountingAdapter extends MockAdapter {
  creates = 0;
  override async createSession(params: Parameters<MockAdapter["createSession"]>[0]) {
    this.creates++;
    return super.createSession(params);
  }
}

class DeferredCreateAdapter extends MockAdapter {
  readonly createStarted: Promise<void>;
  private markStarted!: () => void;
  private releaseCreate!: () => void;
  private readonly release: Promise<void>;

  constructor() {
    super({ name: "mock", agentIds: ["mock:default"], models: ["m1"] });
    this.createStarted = new Promise<void>((resolve) => { this.markStarted = resolve; });
    this.release = new Promise<void>((resolve) => { this.releaseCreate = resolve; });
  }

  releaseSessionCreate(): void { this.releaseCreate(); }

  override async createSession(params: Parameters<MockAdapter["createSession"]>[0]) {
    this.markStarted();
    await this.release;
    return super.createSession(params);
  }
}

async function flushAsync(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= until) throw new Error("condition not reached");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("connection replacement disposes old cron timer and unsolicited listener", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: new Date("2026-08-16T11:33:30.000Z") });
  const root = mkdtempSync(join(tmpdir(), "phonon-lifecycle-"));
  const store = new PhononStore(join(root, "state.sqlite"));
  const adapter = new CountingAdapter({ name: "mock", agentIds: ["mock:default"], models: ["m1"] });
  const registry = new AdapterRegistry();
  registry.register(adapter);
  const old = new TestConn({ registry, store, trustLocal: true, workspaceRoot: root });

  const project = (await old.call("project.create", { name: "p", git: false })) as { project: { projectId: string } };
  const idle = (await old.call("session.create", {
    project: project.project.projectId, agent: "mock:default", model: "m1", verbosity: "messages",
  })) as { sessionId: string };
  assert.ok(idle.sessionId);
  const oldSession = adapter.lastSession!;
  await old.call("schedule.create", {
    name: "once-per-minute",
    trigger: { kind: "cron", expr: "* * * * *" },
    target: { runKind: "session", project: project.project.projectId, agent: "mock:default", model: "m1", prompt: "tick" },
    consent: { push: "summary" },
  });

  await old.conn.dispose("test replacement");
  assert.equal(old.conn.isDisposed, true);
  const priorStreams = old.streamEvents.length;
  oldSession.emitUnsolicited("must not reach old connection");
  assert.equal(old.streamEvents.length, priorStreams, "disposed adapter listener is replaced with a no-op");

  const replacement = new TestConn({ registry, store, trustLocal: true, workspaceRoot: root });
  const beforeCron = adapter.creates;
  t.mock.timers.tick(30_000);
  await flushAsync();
  assert.equal(adapter.creates - beforeCron, 1, "one persisted cron is armed only by the replacement connection");

  await replacement.conn.dispose();
  store.close();
  t.mock.timers.reset();
});

test("disposing a connection interrupts an active scheduled run and persists a terminal failure", async () => {
  const root = mkdtempSync(join(tmpdir(), "phonon-active-dispose-"));
  const store = new PhononStore(join(root, "state.sqlite"));
  const registry = new AdapterRegistry();
  registry.register(new MockAdapter({ name: "mock", agentIds: ["mock:default"], sendDelayMs: 60_000 }));
  const tc = new TestConn({ registry, store, trustLocal: true, workspaceRoot: root });
  const project = (await tc.call("project.create", { name: "p", git: false })) as { project: { projectId: string } };
  const created = (await tc.call("schedule.create", {
    name: "active", trigger: { kind: "manual" },
    target: { runKind: "session", project: project.project.projectId, agent: "mock:default", model: "m1", prompt: "long" },
    consent: { push: "summary" },
  })) as { schedule: { id: string } };
  const triggered = (await tc.call("schedule.trigger", { scheduleId: created.schedule.id })) as { runId: string };

  await tc.conn.dispose("socket lost during run");
  const row = store.getRun(triggered.runId, "tenant-test");
  assert.equal(row?.status, "failed");
  assert.equal(row?.error, "socket lost during run");
  assert.equal(store.loadSessions().every((session) => session.status === "paused"), true);
  store.close();
});

test("dispose during scheduled session creation cannot resurrect a running run or idle session", async () => {
  const root = mkdtempSync(join(tmpdir(), "phonon-create-race-"));
  const store = new PhononStore(join(root, "state.sqlite"));
  const adapter = new DeferredCreateAdapter();
  const registry = new AdapterRegistry();
  registry.register(adapter);
  const tc = new TestConn({ registry, store, trustLocal: true, workspaceRoot: root });
  const project = (await tc.call("project.create", { name: "p", git: false })) as { project: { projectId: string } };
  const created = (await tc.call("schedule.create", {
    name: "create-race", trigger: { kind: "manual" },
    target: { runKind: "session", project: project.project.projectId, agent: "mock:default", model: "m1", prompt: "long" },
    consent: { push: "summary" },
  })) as { schedule: { id: string } };

  const dispatch = tc.conn.handle(JSON.stringify({
    jsonrpc: "2.0", method: "schedule.trigger", params: { scheduleId: created.schedule.id },
  }));
  await adapter.createStarted;
  const disposing = tc.conn.dispose("socket lost during create");
  adapter.releaseSessionCreate();
  await Promise.allSettled([dispatch, disposing]);

  const runs = store.listRunsForSchedule(created.schedule.id, { tenantId: "tenant-test" });
  assert.equal(runs.length, 1);
  assert.equal(runs[0]?.status, "failed");
  assert.equal(store.loadSessions().some((session) => session.status === "idle" || session.status === "running"), false);
  store.close();
});

test("PhononClient auto-reconnect disposes the replaced connection and close disposes the current one", async () => {
  const wss = new WebSocketServer({ port: 0 });
  await new Promise<void>((resolve) => wss.once("listening", resolve));
  const address = wss.address();
  if (!address || typeof address === "string") throw new Error("missing websocket port");
  const sockets: WebSocket[] = [];
  wss.on("connection", (socket) => {
    sockets.push(socket);
    socket.on("message", (raw) => {
      const msg = JSON.parse(raw.toString()) as { id?: number; method?: string };
      if (msg.method === "connect.hello") {
        socket.send(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { tenantId: "tenant-reconnect" } }));
      }
    });
  });

  const registry = new AdapterRegistry();
  registry.register(new MockAdapter({ name: "mock" }));
  const client = new PhononClient({ serverUrl: `ws://127.0.0.1:${address.port}`, deviceId: "dev-reconnect", registry });
  await client.start();
  // Keep the regression test fast without changing production backoff behavior.
  (client as unknown as { backoffMs: number }).backoffMs = 5;
  const first = client.connection;
  assert.ok(first);
  sockets[0]!.close();
  await waitFor(() => sockets.length >= 2 && !!client.connection && client.connection !== first);
  assert.equal(first.isDisposed, true, "socket close tears down the old runtime before reconnect");

  const current = client.connection!;
  await client.close();
  assert.equal(current.isDisposed, true, "client.close tears down the current runtime");
  await new Promise<void>((resolve) => wss.close(() => resolve()));
});

test("failed candidate dial preserves incumbent and incumbent close still reconnects", async () => {
  const wss = new WebSocketServer({ port: 0 });
  await new Promise<void>((resolve) => wss.once("listening", resolve));
  const address = wss.address();
  if (!address || typeof address === "string") throw new Error("missing websocket port");
  const sockets: WebSocket[] = [];
  wss.on("connection", (socket) => {
    const index = sockets.push(socket) - 1;
    socket.on("message", (raw) => {
      const msg = JSON.parse(raw.toString()) as { id?: number; method?: string };
      if (msg.method === "connect.hello") {
        socket.send(JSON.stringify({
          jsonrpc: "2.0", id: msg.id,
          result: { tenantId: index === 1 ? "wrong-tenant" : "tenant-stable" },
        }));
      }
    });
  });

  const registry = new AdapterRegistry();
  registry.register(new MockAdapter({ name: "mock" }));
  const client = new PhononClient({
    serverUrl: `ws://127.0.0.1:${address.port}`,
    deviceId: "dev-incumbent",
    registry,
    expectedTenantId: "tenant-stable",
  });
  await client.start();
  const incumbent = client.connection;
  assert.ok(incumbent);

  await assert.rejects(client.connect(), /expected/);
  assert.equal(client.connection, incumbent, "rejected candidate must not replace or dispose incumbent");
  assert.equal(incumbent.isDisposed, false);

  (client as unknown as { backoffMs: number }).backoffMs = 5;
  sockets[0]!.close();
  await waitFor(() => sockets.length >= 3 && !!client.connection && client.connection !== incumbent);
  assert.equal(incumbent.isDisposed, true);

  await client.close();
  await new Promise<void>((resolve) => wss.close(() => resolve()));
});

test("frames sent immediately after welcome are buffered for the formal connection", async () => {
  const wss = new WebSocketServer({ port: 0 });
  await new Promise<void>((resolve) => wss.once("listening", resolve));
  const address = wss.address();
  if (!address || typeof address === "string") throw new Error("missing websocket port");
  let discoveryResponse: unknown;
  wss.on("connection", (socket) => {
    socket.on("message", (raw) => {
      const msg = JSON.parse(raw.toString()) as { id?: number; method?: string; result?: unknown };
      if (msg.method === "connect.hello") {
        socket.send(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { tenantId: "tenant-buffer" } }));
        socket.send(JSON.stringify({ jsonrpc: "2.0", id: 99, method: "discovery.list", params: {} }));
      } else if (msg.id === 99 && "result" in msg) {
        discoveryResponse = msg.result;
      }
    });
  });

  const registry = new AdapterRegistry();
  registry.register(new MockAdapter({ name: "mock" }));
  const client = new PhononClient({ serverUrl: `ws://127.0.0.1:${address.port}`, deviceId: "dev-buffer", registry });
  await client.start();
  await waitFor(() => discoveryResponse !== undefined);
  assert.ok(discoveryResponse);
  await client.close();
  await new Promise<void>((resolve) => wss.close(() => resolve()));
});
