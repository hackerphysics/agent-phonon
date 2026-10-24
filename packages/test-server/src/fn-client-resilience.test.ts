import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Socket } from "node:net";
import { WebSocket, WebSocketServer } from "ws";
import { AdapterRegistry, PhononClient, PhononConnection } from "@agent-phonon/core";

const timing = {
  connectTimeoutMs: 200, handshakeTimeoutMs: 150, helloTimeoutMs: 70,
  pingIntervalMs: 30, pongTimeoutMs: 20, stableConnectionMs: 500,
  reconnectBaseMs: 40, reconnectMaxMs: 320, random: () => 0.5,
};
type ClientState = {
  ws?: WebSocket; dialing: Map<WebSocket, (reason: string) => void>;
  backoffMs: number; reconnectTimer?: ReturnType<typeof setTimeout>;
};
const state = (client: PhononClient) => client as unknown as ClientState;
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
};
async function drain() {
  for (let i = 0; i < 8; i++) await Promise.resolve();
  await new Promise<void>(resolve => setImmediate(resolve));
}
async function until(check: () => boolean) {
  for (let i = 0; i < 2_000; i++) { if (check()) return; await drain(); }
  throw new Error("client lifecycle condition not observed");
}

// Real loopback sockets, virtual lifecycle time: no sleeps or real timeout races.
function clock(t: TestContext) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const set = globalThis.setTimeout, clear = globalThis.clearTimeout;
  const active = new Map<ReturnType<typeof setTimeout>, number>();
  t.mock.method(globalThis, "setTimeout", (callback: (...args: any[]) => void, delay: number, ...args: any[]) => {
    const handle = set(() => { active.delete(handle); callback(...args); }, delay);
    active.set(handle, delay);
    return handle;
  });
  t.mock.method(globalThis, "clearTimeout", (handle: ReturnType<typeof setTimeout> | undefined) => {
    if (handle !== undefined) active.delete(handle);
    clear(handle);
  });
  return { active, tick: (ms: number) => t.mock.timers.tick(ms), async clean() { await drain(); assert.equal(active.size, 0, `remaining timers: ${[...active.values()]}`); } };
}

async function server(t: TestContext, options: { autoPong?: boolean; hello?: (socket: WebSocket, id: number, index: number) => void } = {}) {
  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0, autoPong: options.autoPong ?? true });
  await new Promise<void>(resolve => wss.once("listening", resolve));
  const address = wss.address(); assert.ok(address && typeof address !== "string");
  const sockets: WebSocket[] = [], hellos: number[] = [];
  let pings = 0;
  wss.on("connection", socket => {
    const index = sockets.push(socket) - 1;
    socket.on("error", () => {});
    socket.on("ping", () => { pings++; });
    socket.on("message", raw => {
      const frame = JSON.parse(raw.toString());
      if (frame.method !== "connect.hello") return;
      hellos.push(index);
      if (options.hello) options.hello(socket, frame.id, index);
      else welcome(socket, frame.id);
    });
  });
  t.after(async () => { for (const socket of sockets) socket.terminate(); await new Promise<void>(resolve => wss.close(() => resolve())); });
  return { url: `ws://127.0.0.1:${address.port}`, sockets, hellos, get pings() { return pings; } };
}
function welcome(socket: WebSocket, id: number, tenantId = "owner") {
  socket.send(JSON.stringify({ jsonrpc: "2.0", id, result: { tenantId } }));
}
function client(t: TestContext, url: string, overrides: Partial<typeof timing> = {}) {
  const c = new PhononClient({ serverUrl: url, deviceId: "resilience", expectedTenantId: "owner", registry: new AdapterRegistry(), connectionTiming: { ...timing, ...overrides } });
  t.after(() => c.close());
  return c;
}

test("client bounds blackholed TCP/WebSocket and TLS handshakes and releases dialing sockets", async t => {
  const sockets: Socket[] = [];
  const blackhole = createServer(socket => { sockets.push(socket); socket.on("error", () => {}); });
  await new Promise<void>(resolve => blackhole.listen(0, "127.0.0.1", resolve));
  const address = blackhole.address(); assert.ok(address && typeof address !== "string");
  const time = clock(t);
  try {
    for (const scheme of ["ws", "wss"]) {
      const c = client(t, `${scheme}://127.0.0.1:${address.port}`), before = sockets.length;
      const attempt = assert.rejects(c.connect(), /deadline/);
      await until(() => sockets.length > before);
      time.tick(timing.connectTimeoutMs - 1); await drain();
      assert.equal(state(c).dialing.size, 1);
      time.tick(1); await attempt;
      assert.equal(state(c).dialing.size, 0); assert.equal(c.connection, undefined);
      await c.close(); await time.clean();
    }
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => blackhole.close(() => resolve()));
  }
});

test("client bounds a blackholed hello independently of the overall connection deadline", async t => {
  const s = await server(t, { hello() {} }), time = clock(t), c = client(t, s.url);
  const attempt = assert.rejects(c.connect(), /RPC timeout: connect.hello/);
  await until(() => s.hellos.length === 1);
  time.tick(timing.helloTimeoutMs - 1); await drain(); assert.equal(state(c).dialing.size, 1);
  time.tick(1); await attempt;
  assert.equal(c.connection, undefined); assert.equal(state(c).dialing.size, 0);
  await c.close(); await time.clean();
});

test("client ping watchdog terminates a dead peer even if it sends data or unrelated pongs", async t => {
  const s = await server(t, { autoPong: false }), time = clock(t), c = client(t, s.url);
  await c.connect(); const conn = c.connection!, socket = state(c).ws!;
  time.tick(timing.pingIntervalMs); await until(() => s.pings === 1);
  s.sockets[0]!.pong("unsolicited-not-the-ping");
  s.sockets[0]!.send(JSON.stringify({ jsonrpc: "2.0", method: "discovery.list", params: {} }));
  await drain(); time.tick(timing.pongTimeoutMs - 1); assert.equal(c.connection, conn);
  time.tick(1); await until(() => c.connection === undefined && conn.isDisposed);
  assert.notEqual(socket.readyState, WebSocket.OPEN); assert.equal(socket.listenerCount("pong"), 0);
  await c.close(); await time.clean();
});

test("healthy autoPong sockets survive repeated watchdog cycles without reconnecting", async t => {
  const s = await server(t), time = clock(t), c = client(t, s.url);
  await c.start(); const conn = c.connection!;
  for (let i = 1; i <= 8; i++) {
    time.tick(timing.pingIntervalMs);
    await until(() => s.pings === i && ![...time.active.values()].includes(timing.pongTimeoutMs));
    assert.equal(c.connection, conn); assert.equal(conn.isDisposed, false);
  }
  assert.equal(s.sockets.length, 1);
  await c.close(); await time.clean(); time.tick(10_000); await drain(); assert.equal(s.sockets.length, 1);
});

test("flapping connections retain bounded exponential backoff until a stable healthy interval", async t => {
  const s = await server(t), time = clock(t), c = client(t, s.url);
  await c.start();
  for (const delay of [40, 80, 160, 320, 320]) {
    const count = s.sockets.length, previous = c.connection!;
    s.sockets.at(-1)!.terminate(); await until(() => !!state(c).reconnectTimer);
    assert.equal(previous.isDisposed, true);
    assert.equal(time.active.get(state(c).reconnectTimer!), delay);
    time.tick(delay - 1); await drain(); assert.equal(s.sockets.length, count);
    time.tick(1); await until(() => !!c.connection && c.connection !== previous);
    assert.equal(state(c).backoffMs, Math.min(delay * 2, timing.reconnectMaxMs), "welcome must not reset flapping backoff");
  }
  for (let i = 0; i < 16; i++) {
    const pings = s.pings; time.tick(timing.pingIntervalMs);
    await until(() => s.pings > pings && ![...time.active.values()].includes(timing.pongTimeoutMs));
  }
  assert.equal(state(c).backoffMs, timing.reconnectMaxMs);
  time.tick(20); await drain(); assert.equal(state(c).backoffMs, timing.reconnectBaseMs);
  s.sockets.at(-1)!.terminate(); await until(() => !!state(c).reconnectTimer);
  assert.equal(time.active.get(state(c).reconnectTimer!), timing.reconnectBaseMs);
  await c.close(); await time.clean();
});

test("reconnect jitter is bounded and repeated start does not overlap dials", async t => {
  const s = await server(t), time = clock(t);
  for (const [random, expected] of [[0, 32], [1, 48]] as const) {
    const c = client(t, s.url, { random: () => random });
    await c.start(); const active = c.connection!, before = s.sockets.length;
    await c.start(); assert.equal(s.sockets.length, before);
    s.sockets.at(-1)!.terminate(); await until(() => !!state(c).reconnectTimer);
    assert.equal(active.isDisposed, true); assert.equal(time.active.get(state(c).reconnectTimer!), expected);
    await c.close(); await time.clean();
  }
});

test("stable backoff reset requires a matching pong, not just an open socket", async t => {
  const s = await server(t, { autoPong: false }), time = clock(t), c = client(t, s.url, { stableConnectionMs: 10 });
  state(c).backoffMs = 160; await c.connect();
  time.tick(10); assert.equal(state(c).backoffMs, 160);
  s.sockets[0]!.pong("unsolicited"); await drain(); assert.equal(state(c).backoffMs, 160);
  s.sockets[0]!.on("ping", payload => s.sockets[0]!.pong(payload));
  time.tick(20); await until(() => state(c).backoffMs === timing.reconnectBaseMs);
  await c.close(); await time.clean();
});

test("manual close cancels an outstanding pong deadline without reconnecting", async t => {
  const s = await server(t, { autoPong: false }), time = clock(t), c = client(t, s.url);
  await c.start(); time.tick(timing.pingIntervalMs); await until(() => s.pings === 1);
  assert.ok([...time.active.values()].includes(timing.pongTimeoutMs));
  await c.close(); await time.clean(); time.tick(10_000); await drain();
  assert.equal(s.sockets.length, 1); assert.equal(c.connection, undefined);
});

test("a timed-out candidate preserves incumbent liveness and later incumbent failure still reconnects", async t => {
  const s = await server(t, { hello(socket, id, index) { if (index !== 1) welcome(socket, id); } });
  const time = clock(t), c = client(t, s.url);
  await c.start(); const incumbent = c.connection!;
  const candidate = assert.rejects(c.connect(), /RPC timeout: connect.hello/);
  await until(() => s.hellos.length === 2);
  for (let i = 1; i <= 2; i++) {
    time.tick(timing.pingIntervalMs);
    await until(() => s.pings === i && ![...time.active.values()].includes(timing.pongTimeoutMs));
  }
  time.tick(10); await candidate;
  assert.equal(c.connection, incumbent); assert.equal(incumbent.isDisposed, false);
  assert.equal(state(c).reconnectTimer, undefined);
  s.sockets[0]!.terminate(); await until(() => !!state(c).reconnectTimer);
  time.tick(timing.reconnectBaseMs); await until(() => s.sockets.length === 3 && !!c.connection);
  assert.notEqual(c.connection, incumbent); assert.equal(incumbent.isDisposed, true);
  await c.close(); await time.clean();
});

test("an initial hello timeout automatically retries once through the bounded reconnect path", async t => {
  const s = await server(t, { hello(socket, id, index) { if (index > 0) welcome(socket, id); } });
  const time = clock(t), c = client(t, s.url), starting = c.start();
  await until(() => s.hellos.length === 1); time.tick(timing.helloTimeoutMs); await starting;
  await until(() => !!state(c).reconnectTimer);
  assert.equal(time.active.get(state(c).reconnectTimer!), timing.reconnectBaseMs);
  assert.equal(state(c).dialing.size, 0);
  time.tick(timing.reconnectBaseMs); await until(() => !!c.connection);
  assert.equal(s.sockets.length, 2); assert.equal(state(c).dialing.size, 0);
  assert.equal(state(c).backoffMs, timing.reconnectBaseMs * 2);
  await c.close(); await time.clean();
});

test("supersession rejects a hanging hello immediately and stale socket callbacks cannot disturb its successor", async t => {
  const s = await server(t, { hello(socket, id, index) { if (index > 0) welcome(socket, id); } });
  const time = clock(t), c = client(t, s.url);
  const superseded = assert.rejects(c.connect(), /superseded/);
  await until(() => s.hellos.length === 1); const old = [...state(c).dialing.keys()][0]!;
  await c.connect(); await superseded; const current = c.connection!;
  assert.equal(state(c).dialing.size, 0); assert.equal(old.listenerCount("message"), 0); assert.equal(old.listenerCount("pong"), 0);
  old.emit("error", new Error("late stale error")); old.emit("close", 1006, Buffer.alloc(0));
  time.tick(timing.helloTimeoutMs); await drain();
  // Pump the expected pong before its deadline (only the new socket can send it).
  await until(() => ![...time.active.values()].includes(timing.pongTimeoutMs));
  assert.equal(c.connection, current); assert.equal(current.isDisposed, false);
  await c.close(); await time.clean(); await assert.rejects(c.connect(), /client closed/);
});

test("manual close cancels hello and all timers and cannot be undone by a late welcome", async t => {
  const s = await server(t, { hello() {} }), time = clock(t), c = client(t, s.url);
  const attempt = assert.rejects(c.connect(), /client closed/);
  await until(() => s.hellos.length === 1); const old = [...state(c).dialing.keys()][0]!;
  await c.close(); await attempt;
  old.emit("message", Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { tenantId: "owner" } })));
  await time.clean(); time.tick(10_000); await drain();
  assert.equal(c.connection, undefined); assert.equal(state(c).dialing.size, 0); assert.equal(s.sockets.length, 1);
});

test("socket errors clean watchdogs and dispose ownership once without harming a manual replacement", async t => {
  const s = await server(t), time = clock(t), c = client(t, s.url);
  await c.connect(); const old = state(c).ws!, previous = c.connection!;
  const dispose = t.mock.method(previous, "dispose");
  old.emit("error", new Error("synthetic transport failure")); await until(() => previous.isDisposed);
  assert.equal(c.connection, undefined); assert.equal(dispose.mock.callCount(), 1);
  await time.clean(); await c.connect(); const next = c.connection!;
  old.emit("error", new Error("stale duplicate failure")); old.emit("close", 1006, Buffer.alloc(0));
  assert.equal(c.connection, next); assert.equal(dispose.mock.callCount(), 1);
  await c.close(); await time.clean();
});

test("replacement and newer supersession wait for incumbent runtime teardown before publishing", async t => {
  const gate = deferred(); t.after(gate.resolve);
  const s = await server(t), time = clock(t), c = client(t, s.url);
  await c.connect(); const incumbent = c.connection!, original = incumbent.dispose.bind(incumbent);
  t.mock.method(incumbent, "dispose", async (reason: string) => { await original(reason); await gate.promise; });
  const first = assert.rejects(c.connect(), /superseded/);
  await until(() => s.hellos.length === 2 && incumbent.isDisposed);
  assert.equal(c.connection, undefined);
  const newest = c.connect(); await first;
  await until(() => s.hellos.length === 3); await drain(); assert.equal(c.connection, undefined);
  gate.resolve(); await newest; assert.ok(c.connection); assert.notEqual(c.connection, incumbent);
  await c.close(); await time.clean();
});

test("a deadline during runtime replacement cannot publish late or create overlapping runtimes", async t => {
  const gate = deferred(); t.after(gate.resolve);
  const s = await server(t), time = clock(t), c = client(t, s.url);
  await c.connect(); const incumbent = c.connection!, original = incumbent.dispose.bind(incumbent);
  t.mock.method(incumbent, "dispose", async (reason: string) => { await original(reason); await gate.promise; });
  const attempt = assert.rejects(c.connect(), /deadline/);
  await until(() => s.hellos.length === 2 && incumbent.isDisposed);
  time.tick(timing.connectTimeoutMs); await attempt;
  assert.equal(c.connection, undefined); assert.equal(state(c).dialing.size, 0);
  gate.resolve(); await drain(); assert.equal(c.connection, undefined);
  await c.close(); await time.clean();
});

test("an unpublished candidate runtime is retired before its successor can start", async t => {
  const hold = deferred(), disposeGate = deferred();
  t.after(() => { hold.resolve(); disposeGate.resolve(); });
  let candidate: PhononConnection | undefined;
  const originalHandle = PhononConnection.prototype.handle, originalDispose = PhononConnection.prototype.dispose;
  t.mock.method(PhononConnection.prototype, "handle", function(this: PhononConnection, data: string) {
    if (JSON.parse(data).method === "test.hold") { candidate = this; return hold.promise; }
    return originalHandle.call(this, data);
  });
  t.mock.method(PhononConnection.prototype, "dispose", async function(this: PhononConnection, reason: string) {
    await originalDispose.call(this, reason); if (this === candidate) await disposeGate.promise;
  });
  const s = await server(t, { hello(socket, id, index) { welcome(socket, id); if (index === 0) socket.send(JSON.stringify({ jsonrpc: "2.0", method: "test.hold", params: {} })); } });
  const time = clock(t), c = client(t, s.url), first = assert.rejects(c.connect(), /superseded/);
  await until(() => !!candidate); assert.equal(c.connection, undefined);
  const replacement = c.connect(); await first; await until(() => s.hellos.length === 2);
  assert.equal(candidate!.isDisposed, true); assert.equal(c.connection, undefined);
  disposeGate.resolve(); hold.resolve(); await replacement;
  assert.notEqual(c.connection, candidate);
  await c.close(); await time.clean();
});
