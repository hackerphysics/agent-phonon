import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocketServer } from "ws";
import {
  AdapterRegistry,
  Outbox,
  PhononClient,
  PhononConnection,
  PhononStore,
  type RpcTransport,
} from "@agent-phonon/core";
import type { StreamEvent } from "@agent-phonon/protocol";
import { MockAdapter, TestConn } from "./harness.js";

function event(sessionId: string, seq: number): StreamEvent {
  return {
    type: "message", sessionId, seq, turnId: "t", at: new Date(0).toISOString(),
    role: "assistant", text: `${sessionId}:${seq}`, delta: false,
  } as StreamEvent;
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= until) throw new Error("condition not reached");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("outbox sqlite is idempotent, never silently evicts unacked data, and pending order is stable", () => {
  const dbPath = join(mkdtempSync(join(tmpdir(), "phonon-outbox-cap-")), "state.sqlite");
  {
    const store = new PhononStore(dbPath);
    const outbox = new Outbox({ store, tenantId: "tenant", maxEvents: 3 });
    outbox.enqueue(event("s2", 0));
    outbox.enqueue(event("s1", 0));
    outbox.enqueue(event("s1", 0)); // duplicate must not consume capacity or create a row
    outbox.enqueue(event("s1", 1));
    outbox.enqueue(event("s2", 1)); // soft maxEvents must not create a protocol gap
    assert.equal(outbox.size, 4);
    assert.equal(outbox.dropped, 0);
    assert.deepEqual(
      outbox.pending().map((e) => [(e as { sessionId: string }).sessionId, (e as { seq: number }).seq]),
      [["s1", 0], ["s1", 1], ["s2", 0], ["s2", 1]],
    );
    assert.deepEqual(store.outboxLoad("tenant").map((r) => [r.sessionId, r.seq]), [["s2", 0], ["s1", 0], ["s1", 1], ["s2", 1]]);
    store.close();
  }
  {
    const store = new PhononStore(dbPath);
    const outbox = new Outbox({ store, tenantId: "tenant", maxEvents: 3 });
    assert.equal(outbox.size, 4, "all unacknowledged rows must survive restart");
    outbox.enqueue(event("s1", 0));
    assert.equal(outbox.size, 4, "duplicate enqueue remains idempotent after restart");
    assert.deepEqual(outbox.resumeFrom(), [
      { sessionId: "s1", fromSeq: 0 },
      { sessionId: "s2", fromSeq: 0 },
    ]);
    store.close();
  }
});

test("outbox ACK is monotonic and an out-of-range ACK cannot poison future sequence numbers", () => {
  const dbPath = join(mkdtempSync(join(tmpdir(), "phonon-outbox-ack-")), "state.sqlite");
  {
    const store = new PhononStore(dbPath);
    const outbox = new Outbox({ store, tenantId: "tenant" });
    outbox.enqueue(event("s", 0));
    outbox.enqueue(event("s", 1));
    outbox.ack("s", 9999); // clamped to the locally known boundary (1)
    assert.equal(outbox.size, 0);
    outbox.enqueue(event("s", 1)); // finalized duplicate cannot reappear
    outbox.enqueue(event("s", 2)); // future sequence remains valid
    outbox.ack("s", 0); // stale ACK cannot move the watermark backwards
    assert.deepEqual(outbox.pending().map((e) => (e as { seq: number }).seq), [2]);
    store.close();
  }
  {
    const store = new PhononStore(dbPath);
    // Simulate a crash after the finalized watermark commit but before row deletion.
    store.outboxAdd("tenant", "s", 1, JSON.stringify(event("s", 1)), new Date(0).toISOString());
    const outbox = new Outbox({ store, tenantId: "tenant" });
    outbox.enqueue(event("s", 1));
    assert.deepEqual(outbox.pending().map((e) => (e as { seq: number }).seq), [2]);
    assert.deepEqual(store.outboxLoad("tenant").map((r) => r.seq), [2]);
    store.close();
  }
});

test("session stream sequence continues after all prior events are ACKed and the process restarts", async () => {
  const root = mkdtempSync(join(tmpdir(), "phonon-seq-restart-"));
  const dbPath = join(root, "state.sqlite");
  let sessionId: string;
  {
    const store = new PhononStore(dbPath);
    const registry = new AdapterRegistry();
    registry.register(new MockAdapter({ name: "mock", agentIds: ["mock:default"] }));
    const tc = new TestConn({ registry, store, workspaceRoot: root, trustLocal: true });
    const project = (await tc.call("project.create", { name: "p", git: false })) as { project: { projectId: string } };
    const created = (await tc.call("session.create", {
      project: project.project.projectId, agent: "mock:default", model: "m1", verbosity: "messages",
    })) as { sessionId: string };
    sessionId = created.sessionId;
    const sent = (await tc.call("session.send", { sessionId, input: "first" })) as { turnId: string };
    await tc.waitTurnEnd(sent.turnId);
    assert.deepEqual(tc.streamEvents.map((e) => e.seq), [0, 1]);
    await tc.call("stream.ack", { sessionId, lastSeq: 9999 });
    assert.equal(tc.conn.outboxSize, 0, "test must cover session metadata recovery, not only outbox MAX(seq)");
    await tc.conn.dispose("restart");
    store.close();
  }
  {
    const store = new PhononStore(dbPath);
    const registry = new AdapterRegistry();
    registry.register(new MockAdapter({ name: "mock", agentIds: ["mock:default"] }));
    const tc = new TestConn({ registry, store, workspaceRoot: root, trustLocal: true });
    const sent = (await tc.call("session.send", { sessionId: sessionId!, input: "second" })) as { turnId: string };
    await tc.waitTurnEnd(sent.turnId);
    assert.deepEqual(tc.streamEvents.map((e) => e.seq), [2, 3]);
    await tc.conn.dispose();
    store.close();
  }
});

test("connect.hello advertises local resumeFrom and welcome ACK is persisted before replay", async () => {
  const wss = new WebSocketServer({ port: 0 });
  await new Promise<void>((resolve) => wss.once("listening", resolve));
  const address = wss.address();
  if (!address || typeof address === "string") throw new Error("missing websocket port");
  const serverUrl = `ws://127.0.0.1:${address.port}`;
  const dbPath = join(mkdtempSync(join(tmpdir(), "phonon-welcome-ack-")), "state.sqlite");
  const store = new PhononStore(dbPath);
  const seed = new Outbox({ store, tenantId: "tenant-welcome" });
  seed.enqueue(event("s-resume", 0));
  seed.enqueue(event("s-resume", 1));

  let hello: Record<string, unknown> | undefined;
  const replayed: number[] = [];
  wss.on("connection", (socket) => {
    socket.on("message", (raw) => {
      const msg = JSON.parse(raw.toString()) as { id?: number; method?: string; params?: Record<string, unknown> };
      if (msg.method === "connect.hello") {
        hello = msg.params;
        socket.send(JSON.stringify({
          jsonrpc: "2.0", id: msg.id,
          result: { tenantId: "tenant-welcome", ackedSeqs: [{ sessionId: "s-resume", lastSeq: 0 }] },
        }));
      } else if (msg.method === "stream.event") {
        replayed.push((msg.params as { seq: number }).seq);
      }
    });
  });

  const registry = new AdapterRegistry();
  registry.register(new MockAdapter({ name: "mock" }));
  const client = new PhononClient({
    serverUrl, deviceId: "dev-resume", registry, store, expectedTenantId: "tenant-welcome",
  });
  await client.connect();
  await waitFor(() => replayed.length === 1);
  assert.deepEqual(hello?.resumeFrom, [{ sessionId: "s-resume", fromSeq: 0 }]);
  assert.deepEqual(replayed, [1], "server-ACKed seq 0 must be removed before replay");
  assert.deepEqual(store.outboxLoad("tenant-welcome").map((r) => r.seq), [1], "welcome ACK must be durable");

  await client.close();
  store.close();
  await new Promise<void>((resolve) => wss.close(() => resolve()));
});

test("stream transport send failure leaves events in outbox for a later replay", async () => {
  const root = mkdtempSync(join(tmpdir(), "phonon-send-fail-"));
  const store = new PhononStore(join(root, "state.sqlite"));
  const registry = new AdapterRegistry();
  registry.register(new MockAdapter({ name: "mock", agentIds: ["mock:default"], sendDelayMs: 80 }));

  let failSend = false;
  const streams: Array<Record<string, unknown>> = [];
  const pending = new Map<number, (result: unknown) => void>();
  let id = 1;
  const transport: RpcTransport = {
    send(data) {
      if (failSend) throw new Error("simulated transport failure");
      const msg = JSON.parse(data) as { id?: number; method?: string; params?: Record<string, unknown>; result?: unknown; error?: unknown };
      if (msg.method === "stream.event") streams.push(msg.params!);
      if (msg.id !== undefined && ("result" in msg || "error" in msg)) {
        const resolve = pending.get(msg.id);
        pending.delete(msg.id);
        resolve?.(msg.result);
      }
    },
    close() {},
  };
  const conn = new PhononConnection({
    tenantId: "tenant", transport, registry, store, workspaceRoot: root, trustLocal: true,
  });
  const call = (method: string, params: unknown): Promise<unknown> => {
    const requestId = id++;
    return new Promise((resolve) => {
      pending.set(requestId, resolve);
      void conn.handle(JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params }));
    });
  };

  const project = (await call("project.create", { name: "p", git: false })) as { project: { projectId: string } };
  const created = (await call("session.create", {
    project: project.project.projectId, agent: "mock:default", model: "m1", verbosity: "messages",
  })) as { sessionId: string };
  await call("session.send", { sessionId: created.sessionId, input: "defer me" });
  failSend = true;
  await waitFor(() => conn.outboxSize === 2);
  assert.equal(streams.length, 0);

  failSend = false;
  assert.equal(conn.replayPending(), 2);
  assert.deepEqual(streams.map((e) => e.seq), [0, 1]);
  assert.equal(conn.outboxSize, 2, "replay is at-least-once; only ACK removes rows");

  await conn.dispose();
  store.close();
});
