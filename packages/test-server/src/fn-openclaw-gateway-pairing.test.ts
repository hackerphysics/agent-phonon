import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createHash, createPublicKey, randomUUID, verify } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocketServer } from "ws";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getEventListeners } from "node:events";
import { discoverOpenClawGateway, GatewayClient, GatewayConnectionError, isLoopbackGateway, OpenClawGatewayAdapter } from "@agent-phonon/core";
import { approveLocalGatewayPairing } from "../../core/dist/openclaw-pairing.js";

const scopes = ["operator.read", "operator.write", "operator.admin"];
const shared = "synthetic-bootstrap-secret", deviceToken = "synthetic-device-secret";
function temp(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "phonon-gateway-pairing-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

async function within<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Gateway cancellation did not settle promptly")), 1000);
    })]);
  } finally { clearTimeout(timer); }
}

async function fixture(t: TestContext, options: { remote?: boolean; mutatePending?: (row: any) => void; approveFail?: boolean; error?: string; challenge?: unknown; reason?: string; receiptScopes?: string[];
  onList?: () => void; stallList?: boolean; onConnect?: () => void; stallConnect?: boolean; onConnection?: () => void; stallChallenge?: boolean;
  onHelperConnect?: () => void; stallHelperConnect?: boolean; onApprove?: () => void } = {}) {
  const root = temp(t), requestId = randomUUID(), frames: any[] = [], deviceIds: string[] = [], errors: unknown[] = [];
  let paired = false, pending: any, connectCount = 0;
  let onHelperClosed!: () => void, onSocketClosed!: () => void;
  const helperClosed = new Promise<void>(resolve => { onHelperClosed = resolve; });
  const socketClosed = new Promise<void>(resolve => { onSocketClosed = resolve; });
  const host = options.remote ? "127.0.0.2" : "127.0.0.1";
  const server = new WebSocketServer({ host, port: 0 });
  await new Promise<void>((resolve, reject) => { server.once("listening", resolve); server.once("error", reject); });
  const baseUrl = `ws://${host}:${(server.address() as { port: number }).port}`;
  const config = { baseUrl, token: shared, deviceStateDir: join(root, "devices") };
  const clients: GatewayClient[] = [];
  t.after(async () => {
    for (const client of clients) client.close();
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>(resolve => server.close(() => resolve()));
    assert.deepEqual(errors, [], "mock protocol assertions");
  });
  server.on("connection", socket => {
    const challenge = options.challenge ?? { nonce: randomUUID(), ts: Date.now() - 2500 };
    let helper = false;
    socket.once("close", () => { onSocketClosed(); if (helper) onHelperClosed(); });
    options.onConnection?.();
    if (!options.stallChallenge) socket.send(JSON.stringify({ type: "event", event: "connect.challenge", payload: challenge }));
    socket.on("message", raw => {
      try {
        const frame = JSON.parse(raw.toString()), p = frame.params;
        frames.push(frame);
        const respond = (payload: unknown) => socket.send(JSON.stringify({ type: "res", id: frame.id, ok: true, payload }));
        const fail = (code: string, details?: unknown) => socket.send(JSON.stringify({ type: "res", id: frame.id, ok: false,
          error: { code, message: `Never echo ${shared} or ${deviceToken}`, details } }));
        if (frame.method === "connect") {
          connectCount++;
          assert.equal(p.client.id, "gateway-client");
          assert.equal(p.client.mode, p.device ? "cli" : "backend");
          if (!p.device) {
            helper = true; assert.equal(p.auth.token, shared); assert.deepEqual(p.scopes, scopes);
            options.onHelperConnect?.();
            if (options.stallHelperConnect) return;
            respond({ type: "hello-ok" }); return;
          }
          const d = p.device, c = challenge as { nonce: string; ts: number };
          assert.equal(d.signedAt, c.ts); assert.equal(d.nonce, c.nonce);
          assert.equal(d.id, createHash("sha256").update(Buffer.from(d.publicKey, "base64url")).digest("hex"));
          const payload = ["v3", d.id, "gateway-client", "cli", "operator", p.scopes.join(","), String(c.ts), p.auth.token ?? p.auth.deviceToken, c.nonce, p.client.platform, ""].join("|");
          assert.ok(verify(null, Buffer.from(payload), createPublicKey({ format: "jwk", key: { kty: "OKP", crv: "Ed25519", x: d.publicKey } }), Buffer.from(d.signature, "base64url")));
          deviceIds.push(d.id);
          options.onConnect?.();
          if (options.stallConnect) return;
          if (options.error) { fail("INVALID_REQUEST", { code: options.error }); return; }
          if (!paired) {
            assert.deepEqual(p.auth, { token: shared });
            pending = { requestId, deviceId: d.id, publicKey: d.publicKey, clientId: p.client.id, clientMode: p.client.mode,
              role: p.role, roles: [p.role], scopes: p.scopes };
            options.mutatePending?.(pending);
            fail("NOT_PAIRED", { code: "PAIRING_REQUIRED", requestId, reason: options.reason ?? "not-paired", recommendedNextStep: "wait_then_retry" }); return;
          }
          assert.ok(p.auth.token === shared || p.auth.deviceToken === deviceToken);
          respond({ type: "hello-ok", auth: { deviceToken, role: "operator", scopes: options.receiptScopes ?? p.scopes }, features: { capabilities: ["fixture"] } }); return;
        }
        if (frame.method === "device.pair.list") {
          assert.ok(helper); options.onList?.();
          if (!options.stallList) respond({ pending: [pending], paired: [] });
          return;
        }
        if (frame.method === "device.pair.approve") {
          assert.ok(helper); assert.deepEqual(p, { requestId });
          if (options.approveFail) { fail("INVALID_REQUEST"); return; }
          paired = true; options.onApprove?.(); respond({ requestId, device: { deviceId: pending.deviceId } }); return;
        }
        if (frame.method === "chat.send") { assert.ok(paired); respond({ runId: "fixture-chat", status: "started" }); return; }
        if (frame.method === "sessions.patch") { assert.deepEqual(p, { key: "session", model: "local/model" }); respond({ key: p.key }); return; }
        throw new Error(`Unexpected mock method: ${frame.method}`);
      } catch (error) { errors.push(error); socket.terminate(); }
    });
  });
  return { root, config, frames, deviceIds, requestId, helperClosed, socketClosed, get paired() { return paired; }, get connectCount() { return connectCount; },
    client(extra: Partial<ConstructorParameters<typeof GatewayClient>[0]> = {}) { const client = new GatewayClient({ ...config, ...extra }); clients.push(client); return client; } };
}

test("Gateway pairing: signed challenge -> exact local approval -> reconnect -> chat.send; device token survives a new client", async t => {
  const f = await fixture(t), client = f.client(), events: Array<{ event: string; payload: any }> = [];
  client.onEvent((event, payload) => events.push({ event, payload }));
  const [a, b] = await Promise.all([client.connect(), client.connect()]);
  assert.equal(a, undefined); assert.equal(b, undefined); assert.equal(client.connectionEpoch(), 1);
  assert.equal((await client.rpc("chat.send", { sessionKey: "fixture", message: "hello", idempotencyKey: randomUUID() })).status, "started");
  assert.equal(f.connectCount, 3);
  assert.equal(f.frames.filter(frame => frame.method === "device.pair.approve").length, 1);
  assert.equal(events.find(row => row.event === "phonon.pairing.required")?.payload.requestId, f.requestId);
  assert.deepEqual(events.filter(row => row.event === "phonon.pairing.audit").map(row => row.payload.decision), ["requested", "approved"]);
  const eventJson = JSON.stringify(events); assert.ok(!eventJson.includes(shared)); assert.ok(!eventJson.includes(deviceToken));
  client.close();
  const next = f.client({ token: "" }); await next.connect();
  const last = f.frames.filter(row => row.method === "connect").at(-1);
  assert.deepEqual(last.params.auth, { deviceToken }); assert.equal(new Set(f.deviceIds).size, 1);
  await next.patchSessionModel("session", "local/model");
  assert.deepEqual(f.frames.filter(row => row.method === "connect").at(-1).params.scopes, ["operator.read", "operator.write"]);
  const endpoint = join(f.config.deviceStateDir, readdirSync(f.config.deviceStateDir)[0]!);
  assert.deepEqual(JSON.parse(readFileSync(join(endpoint, "operator-token.json"), "utf8")).scopes, scopes, "narrower socket does not collapse stored grant");
  if (process.platform !== "win32") {
    assert.equal(statSync(f.config.deviceStateDir).mode & 0o777, 0o700);
    assert.equal(statSync(endpoint).mode & 0o777, 0o700);
    for (const name of readdirSync(endpoint)) assert.equal(statSync(join(endpoint, name)).mode & 0o777, 0o600);
  }
});

test("Gateway device token: default reconnect respects a narrower approved grant instead of requesting admin", async t => {
  const f = await fixture(t, { receiptScopes: ["operator.read", "operator.write"] });
  const first = f.client(); await first.connect(); first.close();
  await f.client().connect();
  assert.deepEqual(f.frames.filter(row => row.method === "connect").at(-1).params.scopes, ["operator.read", "operator.write"]);
});

test("Gateway pairing: remote host surfaces request and next step without a helper/approval", async t => {
  const f = await fixture(t, { remote: true }), client = f.client(), events: any[] = [];
  client.onEvent((event, payload) => events.push({ event, payload }));
  await assert.rejects(client.connect(), error => error instanceof GatewayConnectionError && error.code === "PAIRING_REQUIRED"
    && error.requestId === f.requestId && error.recommendedNextStep === "wait_then_retry" && /on the Gateway host/.test(error.message));
  assert.equal(f.connectCount, 1); assert.equal(events[0].event, "phonon.pairing.required");
  await assert.rejects(approveLocalGatewayPairing({ ...f.config, requestId: f.requestId, deviceId: "other", publicKey: "other", scopes, assertCurrent() { throw new Error("must not execute"); } }), { code: "REMOTE_APPROVAL_REFUSED" });
});

test("Gateway pairing: opt-out and scope/role upgrades stay manual", async t => {
  for (const reason of ["scope-upgrade", "role-upgrade", "metadata-upgrade"]) {
    const f = await fixture(t, { reason });
    await assert.rejects(f.client().connect(), { code: "PAIRING_REQUIRED" }); assert.equal(f.connectCount, 1);
  }
  const f = await fixture(t);
  await assert.rejects(f.client({ autoPair: false }).connect(), { code: "PAIRING_REQUIRED" }); assert.equal(f.connectCount, 1);
});

test("Gateway pairing: different device/key/client/role/scopes and repair requests cannot be approved", async t => {
  for (const mutatePending of [
    (row: any) => { row.deviceId = "other"; }, (row: any) => { row.publicKey = "other"; },
    (row: any) => { row.requestId = "superseded"; }, (row: any) => { row.clientId = "other"; },
    (row: any) => { row.role = "node"; }, (row: any) => { row.roles.push("node"); },
    (row: any) => { row.scopes.push("operator.pairing"); }, (row: any) => { row.isRepair = true; },
  ]) {
    const f = await fixture(t, { mutatePending });
    await assert.rejects(f.client().connect(), { code: "PAIRING_APPROVAL_FAILED" });
    assert.equal(f.frames.filter(row => row.method === "device.pair.approve").length, 0);
  }
});

test("Gateway pairing: approval failure is bounded, actionable and redacted", async t => {
  const f = await fixture(t, { approveFail: true }), client = f.client();
  await assert.rejects(client.connect(), error => error instanceof GatewayConnectionError && error.code === "PAIRING_APPROVAL_FAILED"
    && error.requestId === f.requestId && error.message.includes(`openclaw devices approve ${f.requestId}`)
    && !error.message.includes(shared) && !error.message.includes(deviceToken));
  assert.equal(f.connectCount, 2); assert.equal(client.isConnected(), false);
});

test("Gateway pairing: cancellation during optional request lookup prevents approval/reconnect", async t => {
  let client: GatewayClient;
  const f = await fixture(t, { onList: () => client.close() }); client = f.client();
  await assert.rejects(client.connect(), { code: "CONNECTION_CANCELLED" });
  assert.equal(f.frames.filter(row => row.method === "device.pair.approve").length, 0); assert.equal(f.connectCount, 2);
});

test("Gateway pairing: AbortSignal during optional request lookup prevents approval/reconnect", async t => {
  const abort = new AbortController(), f = await fixture(t, { onList: () => abort.abort() }), client = f.client(), decisions: unknown[] = [];
  client.onEvent((event, payload) => { if (event === "phonon.pairing.audit") decisions.push(payload.decision); });
  await assert.rejects(within(client.connect(abort.signal)), { code: "CONNECTION_CANCELLED" });
  await within(f.helperClosed);
  assert.equal(f.frames.filter(row => row.method === "device.pair.approve").length, 0);
  assert.equal(f.paired, false); assert.equal(f.connectCount, 2); assert.equal(client.isConnected(), false);
  assert.equal(client.connectionEpoch(), 0); assert.ok(!decisions.includes("approved"));
  assert.equal(getEventListeners(abort.signal, "abort").length, 0);
});

test("Gateway pairing: abort promptly terminates a helper with a stalled list response", async t => {
  const abort = new AbortController(), f = await fixture(t, { onList: () => abort.abort(), stallList: true }), client = f.client();
  await assert.rejects(within(client.connect(abort.signal)), { code: "CONNECTION_CANCELLED" });
  await within(f.helperClosed);
  assert.equal(f.paired, false); assert.equal(f.connectCount, 2); assert.equal(client.isConnected(), false);
  assert.equal(f.frames.filter(row => row.method === "device.pair.approve").length, 0);
  assert.equal(getEventListeners(abort.signal, "abort").length, 0);
});

test("Gateway pairing: close promptly terminates a helper with a stalled list response", async t => {
  let client: GatewayClient;
  const f = await fixture(t, { onList: () => client.close(), stallList: true }); client = f.client();
  await assert.rejects(within(client.connect()), { code: "CONNECTION_CANCELLED" });
  await within(f.helperClosed);
  assert.equal(f.paired, false); assert.equal(f.connectCount, 2);
  assert.equal(f.frames.filter(row => row.method === "device.pair.approve").length, 0);
});

test("Gateway pairing: abort promptly cancels a stalled helper handshake before list/approve", async t => {
  const abort = new AbortController(), f = await fixture(t, { onHelperConnect: () => abort.abort(), stallHelperConnect: true }), client = f.client();
  await assert.rejects(within(client.connect(abort.signal)), { code: "CONNECTION_CANCELLED" });
  await within(f.helperClosed);
  assert.equal(f.paired, false); assert.equal(f.connectCount, 2);
  assert.equal(f.frames.filter(row => row.method.startsWith("device.pair.")).length, 0);
  assert.equal(getEventListeners(abort.signal, "abort").length, 0);
});

test("Gateway pairing: cancellation before an approval receipt never audits success or reconnects", async t => {
  const abort = new AbortController(), f = await fixture(t, { onApprove: () => abort.abort() }), client = f.client(), decisions: unknown[] = [];
  client.onEvent((event, payload) => { if (event === "phonon.pairing.audit") decisions.push(payload.decision); });
  await assert.rejects(within(client.connect(abort.signal)), { code: "CONNECTION_CANCELLED" });
  await within(f.helperClosed);
  assert.equal(f.paired, true, "approval already dispatched before cancellation cannot be undone");
  assert.equal(f.connectCount, 2); assert.equal(client.isConnected(), false); assert.deepEqual(decisions, ["requested"]);
});

test("Gateway pairing helper: generation cancellation remains typed instead of becoming a verification failure", async t => {
  let cancelled = false;
  const f = await fixture(t, { onList: () => { cancelled = true; } });
  await assert.rejects(f.client({ autoPair: false }).connect(), { code: "PAIRING_REQUIRED" });
  const device = f.frames[0].params.device;
  await assert.rejects(within(approveLocalGatewayPairing({ ...f.config, requestId: f.requestId, deviceId: device.id, publicKey: device.publicKey, scopes,
    assertCurrent() { if (cancelled) throw new GatewayConnectionError("Fixture cancelled", "CONNECTION_CANCELLED"); } })), { code: "CONNECTION_CANCELLED" });
  await within(f.helperClosed);
  assert.equal(f.paired, false); assert.equal(f.connectCount, 2);
  assert.equal(f.frames.filter(row => row.method === "device.pair.approve").length, 0);
});

test("OpenClaw Gateway discovery: abort mid-pairing prevents approval/reconnect even if lookup stalls", async t => {
  for (const stallList of [false, true]) {
    const abort = new AbortController(), f = await fixture(t, { onList: () => abort.abort(), stallList });
    const adapter = new OpenClawGatewayAdapter({ gateway: f.config }); t.after(() => adapter.close());
    await assert.rejects(within(adapter.discoverAgents(abort.signal)), { name: "AbortError" });
    await within(f.helperClosed);
    assert.equal(f.paired, false); assert.equal(f.connectCount, 2);
    assert.equal(f.frames.filter(row => row.method === "device.pair.approve").length, 0);
    assert.equal(getEventListeners(abort.signal, "abort").length, 0);
  }
});

test("OpenClaw Gateway discovery: joining an unsignalled connection lets abort cancel pairing for all waiters", async t => {
  for (const stallList of [false, true]) {
    const abort = new AbortController(), f = await fixture(t, { onList: () => abort.abort(), stallList });
    const adapter = new OpenClawGatewayAdapter({ gateway: f.config }); t.after(() => adapter.close());
    const gateway = (adapter as unknown as { gw: GatewayClient }).gw, decisions: unknown[] = [];
    gateway.onEvent((event, payload) => { if (event === "phonon.pairing.audit") decisions.push(payload.decision); });
    const connecting = gateway.connect();
    assert.equal(gateway.connect(), connecting, "signal-less callers share the pending attempt");
    await Promise.all([assert.rejects(within(connecting), { code: "CONNECTION_CANCELLED" }),
      assert.rejects(within(adapter.discoverAgents(abort.signal)), { name: "AbortError" })]);
    await within(f.helperClosed);
    assert.equal(f.paired, false); assert.equal(f.connectCount, 2); assert.equal(gateway.isConnected(), false);
    assert.equal(f.frames.filter(row => row.method === "device.pair.approve").length, 0);
    assert.ok(!decisions.includes("approved")); assert.equal(gateway.connectionEpoch(), 0);
    assert.equal(getEventListeners(abort.signal, "abort").length, 0);
  }
});

test("Gateway device auth: abort promptly cancels stalled challenge and handshake responses", async t => {
  for (const stallChallenge of [true, false]) {
    const abort = new AbortController(), f = await fixture(t, { stallChallenge, stallConnect: true,
      ...(stallChallenge ? { onConnection: () => abort.abort() } : { onConnect: () => abort.abort() }) }), client = f.client();
    await assert.rejects(within(client.connect(abort.signal)), { code: "CONNECTION_CANCELLED" });
    await within(f.socketClosed);
    assert.equal(f.connectCount, stallChallenge ? 0 : 1); assert.equal(f.paired, false); assert.equal(client.isConnected(), false);
    assert.equal(getEventListeners(abort.signal, "abort").length, 0);
  }
});

test("Gateway connection: pre-aborted signals never start a connection", async t => {
  const f = await fixture(t), client = f.client(), abort = new AbortController(); abort.abort();
  await assert.rejects(client.connect(abort.signal), { code: "CONNECTION_CANCELLED" });
  assert.equal(f.connectCount, 0); assert.equal(f.frames.length, 0); assert.equal(client.isConnected(), false);
});

test("Gateway connection: a joining caller aborts the shared pending attempt and all waiters", async t => {
  for (const stallList of [false, true]) {
    const owner = new AbortController(), joiner = new AbortController(), observer = new AbortController();
    const f = await fixture(t, { onList: () => joiner.abort(), stallList }), client = f.client();
    const attempts = [client.connect(owner.signal), client.connect(), client.connect(joiner.signal), client.connect(observer.signal)];
    await Promise.all(attempts.map(attempt => assert.rejects(within(attempt), { code: "CONNECTION_CANCELLED" })));
    await within(f.helperClosed);
    assert.equal(client.isConnected(), false); assert.equal(f.connectCount, 2); assert.equal(f.paired, false);
    assert.equal(f.frames.filter(row => row.method === "device.pair.approve").length, 0);
    for (const controller of [owner, joiner, observer]) assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  }
});

test("Gateway connection: a pre-aborted joining signal cancels the shared pending attempt", async t => {
  const f = await fixture(t), client = f.client(), abort = new AbortController();
  const connecting = client.connect(); abort.abort();
  await Promise.all([assert.rejects(within(connecting), { code: "CONNECTION_CANCELLED" }),
    assert.rejects(within(client.connect(abort.signal)), { code: "CONNECTION_CANCELLED" })]);
  assert.equal(f.connectCount, 0); assert.equal(f.paired, false); assert.equal(client.isConnected(), false);
  assert.equal(getEventListeners(abort.signal, "abort").length, 0);
});

test("Gateway connection: owner abort cancels all shared waiters without approval/reconnect", async t => {
  const abort = new AbortController(), f = await fixture(t, { onList: () => abort.abort() }), client = f.client();
  const connecting = client.connect(abort.signal);
  await Promise.all([assert.rejects(within(connecting), { code: "CONNECTION_CANCELLED" }),
    assert.rejects(within(client.connect()), { code: "CONNECTION_CANCELLED" })]);
  assert.equal(f.paired, false); assert.equal(f.connectCount, 2); assert.equal(client.isConnected(), false);
});

test("Gateway connection: abort before shared success settles rejects all waiters and closes the transport", async t => {
  const abort = new AbortController(), f = await fixture(t), client = f.client();
  const internals = client as unknown as { connectWithPairing(generation: number, signal?: AbortSignal): Promise<void> };
  const connectWithPairing = internals.connectWithPairing.bind(client);
  t.mock.method(internals, "connectWithPairing", async (generation: number, signal?: AbortSignal) => {
    await connectWithPairing(generation, signal);
    queueMicrotask(() => abort.abort());
  });
  const connecting = client.connect();
  await Promise.all([assert.rejects(within(connecting), { code: "CONNECTION_CANCELLED" }),
    assert.rejects(within(client.connect(abort.signal)), { code: "CONNECTION_CANCELLED" })]);
  assert.equal(client.isConnected(), false); assert.equal(f.connectCount, 3);
  assert.equal(getEventListeners(abort.signal, "abort").length, 0);
});

test("Gateway connection: abort after success does not disconnect or poison later connections", async t => {
  const abort = new AbortController(), joiner = new AbortController(), f = await fixture(t), client = f.client();
  await Promise.all([client.connect(abort.signal), client.connect(joiner.signal)]);
  assert.equal(getEventListeners(abort.signal, "abort").length, 0);
  assert.equal(getEventListeners(joiner.signal, "abort").length, 0);
  abort.abort(); joiner.abort(); assert.equal(client.isConnected(), true);
  await client.connect(); assert.equal(f.connectCount, 3);
  assert.equal((await client.rpc("chat.send", { message: "still connected" })).status, "started");
  client.close(); await client.connect(); assert.equal(f.connectCount, 4);
});

test("Gateway connection: signals from a cancelled attempt cannot abort a later pending attempt", async t => {
  const owner = new AbortController(), joiner = new AbortController();
  let retry = false;
  const f = await fixture(t, { onList: () => { if (retry) owner.abort(); else joiner.abort(); } }), client = f.client();
  await Promise.all([assert.rejects(within(client.connect(owner.signal)), { code: "CONNECTION_CANCELLED" }),
    assert.rejects(within(client.connect(joiner.signal)), { code: "CONNECTION_CANCELLED" })]);
  assert.equal(getEventListeners(owner.signal, "abort").length, 0); assert.equal(getEventListeners(joiner.signal, "abort").length, 0);
  assert.equal(f.connectCount, 2); assert.equal(f.paired, false);
  retry = true;
  await client.connect();
  assert.equal(owner.signal.aborted, true); assert.equal(client.isConnected(), true); assert.equal(f.connectCount, 5);
});

test("Gateway device auth: invalid challenges are rejected without sending connect", async t => {
  for (const challenge of [{ nonce: "x" }, { ts: 1 }, { nonce: "x", ts: -1 }, { nonce: "x", ts: 1.5 }]) {
    const f = await fixture(t, { challenge }); await assert.rejects(f.client().connect(), { code: "DEVICE_AUTH_CHALLENGE_INVALID" });
    assert.equal(f.connectCount, 0);
  }
});

test("Gateway device auth: native DEVICE_AUTH failures stay typed and never echo credentials", async t => {
  const f = await fixture(t, { error: "DEVICE_AUTH_SIGNATURE_INVALID" });
  const client = f.client();
  for (let i = 0; i < 2; i++) await assert.rejects(client.connect(), error => error instanceof GatewayConnectionError
    && error.code === "DEVICE_AUTH_SIGNATURE_INVALID" && /fresh challenge/.test(error.message) && !error.message.includes(shared));
  assert.equal(f.connectCount, 2, "failed handshakes are cleaned up and may be explicitly retried");
});

test("Gateway device auth: missing token and unavailable listener have actionable errors", async t => {
  const f = await fixture(t), missing = f.client({ token: "" });
  await assert.rejects(missing.connect(), { code: "AUTH_TOKEN_MISSING" }); assert.equal(f.connectCount, 0);
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>(resolve => server.once("listening", resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>(resolve => server.close(() => resolve()));
  const down = f.client({ baseUrl: `ws://127.0.0.1:${port}` });
  await assert.rejects(down.connect(), error => error instanceof GatewayConnectionError && error.code === "GATEWAY_UNREACHABLE" && /gateway.port/.test(error.message));
});

test("Gateway device auth: missing, corrupt, symlinked and public identity files fail closed without replacement", async t => {
  for (const mode of ["missing", "corrupt", "symlink", "public"]) {
    if (mode === "public" && process.platform === "win32") continue;
    const f = await fixture(t); await f.client().connect();
    const endpoint = join(f.config.deviceStateDir, readdirSync(f.config.deviceStateDir)[0]!), file = join(endpoint, "identity.json");
    if (mode === "missing") rmSync(file);
    if (mode === "corrupt") writeFileSync(file, "corrupt");
    if (mode === "public") chmodSync(file, 0o644);
    if (mode === "symlink") { const target = join(f.root, "identity-target"); writeFileSync(target, readFileSync(file), { mode: 0o600 }); rmSync(file); symlinkSync(target, file); }
    await assert.rejects(f.client().connect(), { code: "DEVICE_AUTH_LOCAL_IDENTITY" });
    assert.equal(f.connectCount, 3, "invalid storage does not create another device identity");
  }
});

test("Gateway device identity: concurrent processes publish exactly one stable complete private key", async t => {
  const root = join(temp(t), "devices"), moduleUrl = new URL("../../core/dist/openclaw-device-identity.js", import.meta.url).href;
  const code = `import {OpenClawDeviceStore} from ${JSON.stringify(moduleUrl)}; const store=new OpenClawDeviceStore('ws://127.0.0.1:23456',process.argv[1]); console.log(store.identity().deviceId);`;
  const results = await Promise.all(Array.from({ length: 8 }, () => promisify(execFile)(process.execPath, ["--input-type=module", "-e", code, root])));
  assert.equal(new Set(results.map(row => row.stdout.trim())).size, 1);
  assert.equal(readdirSync(root).length, 1, "no temporary key directories remain");
});

test("Gateway discovery: environment precedence, local port/bind, password/none modes and no remote credentials", t => {
  const root = temp(t), file = join(root, "openclaw.json"), explicit = join(root, "explicit.json");
  const write = (target: string, gateway: unknown) => writeFileSync(target, JSON.stringify({ gateway }));
  write(file, { port: 23456, bind: "lan", remote: { url: "wss://remote.invalid" }, auth: { token: shared } });
  let discovered = discoverOpenClawGateway({ env: { OPENCLAW_STATE_DIR: root } });
  assert.equal(discovered.baseUrl, "ws://127.0.0.1:23456"); assert.equal(discovered.token, shared); assert.equal(discovered.loopback, true);
  write(explicit, { port: 23457, bind: "custom", customBindHost: "::1", auth: { mode: "password", password: shared } });
  discovered = discoverOpenClawGateway({ env: { OPENCLAW_STATE_DIR: root, OPENCLAW_CONFIG_PATH: explicit } });
  assert.equal(discovered.baseUrl, "ws://[::1]:23457"); assert.equal(discovered.source, explicit); assert.equal(discovered.authMode, "password");
  write(explicit, { auth: { mode: "none" } }); assert.equal(discoverOpenClawGateway({ env: { OPENCLAW_CONFIG_PATH: explicit } }).authMode, "none");
  for (const url of ["ws://127.0.0.1:1", "ws://[::1]:1", "http://localhost:1"]) assert.equal(isLoopbackGateway(url), true);
  for (const url of ["ws://127.0.0.2:1", "wss://remote.invalid", "ws://localhost.evil", "ws://secret@localhost", "file://localhost/x"]) assert.equal(isLoopbackGateway(url), false);
});

test("Gateway discovery: missing config/token, unsupported auth, invalid config are redacted and actionable", t => {
  const root = temp(t), file = join(root, "openclaw.json"), env = { OPENCLAW_CONFIG_PATH: file };
  assert.throws(() => discoverOpenClawGateway({ env }), /config unavailable.*OPENCLAW_CONFIG_PATH/);
  writeFileSync(file, JSON.stringify({ gateway: { auth: { mode: "token" } } }));
  assert.throws(() => discoverOpenClawGateway({ env }), /token missing.*configure/);
  writeFileSync(file, JSON.stringify({ gateway: { auth: { mode: "trusted-proxy", token: shared } } }));
  assert.throws(() => discoverOpenClawGateway({ env }), /explicit Gateway credentials/);
  writeFileSync(file, JSON.stringify({ gateway: { port: shared } }));
  assert.throws(() => discoverOpenClawGateway({ env }), error => error instanceof Error && /Invalid OpenClaw Gateway config/.test(error.message) && !error.message.includes(shared));
});
