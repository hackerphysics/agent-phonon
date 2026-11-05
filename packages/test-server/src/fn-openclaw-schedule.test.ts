import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AdapterRegistry, OpenClawAdapter, OpenClawGatewayAdapter, PhononStore, GatewayClient } from "@agent-phonon/core";
import { METHODS, OpenClawScheduleListResult, OpenClawScheduleGetResult } from "@agent-phonon/protocol";
import { PhononDevice } from "@agent-phonon/server-sdk";
import { TestConn } from "./harness.js";

const nativeJob = {
  id: "vendor-job", displayName: "Native reminder", enabled: false, agentId: "main",
  effectiveAgentId: "main", declarationKey: "reminder",
  schedule: { kind: "cron", expr: "0 9 * * *", tz: "Asia/Shanghai", staggerMs: 200 },
  sessionTarget: "isolated", sessionKey: "agent:main:cron:vendor-job", wakeMode: "now",
  payload: { kind: "agentTurn", message: "PRIVATE_PROMPT", token: "PAYLOAD_SECRET" },
  delivery: { mode: "announce", channel: "feishu", to: "ou_opaque_target", password: "DELIVERY_SECRET" },
  state: { nextRunAtMs: 10000, lastRunAtMs: 9000, lastRunStatus: "error", lastDeliveryStatus: "not-delivered",
    lastDelivered: false, lastFailureNotificationDeliveryStatus: "delivered", consecutiveErrors: 2,
    lastError: "timeout token=NATIVE_SECRET", ignored: "STATE_SECRET" },
  gateway: { token: "GATEWAY_SECRET" },
};

function rpcError(code: string, message?: RegExp) {
  return (error: unknown) => {
    const response = error as { data?: { appCode: string }; message: string };
    assert.equal(response.data?.appCode, code);
    if (message) assert.match(response.message, message);
    assert.doesNotMatch(JSON.stringify(error), /TRANSPORT_SECRET/);
    return true;
  };
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "phonon-openclaw-schedules-"));
  const store = new PhononStore(join(root, "state.db"));
  const adapter = new OpenClawGatewayAdapter({ gateway: { baseUrl: "ws://127.0.0.1:1", token: "synthetic" } });
  adapter.discoverAgents = async () => []; // No inference, session, or unrelated native probing.
  const calls: Array<{ method: string; params: unknown }> = [];
  const gateway = (adapter as unknown as { gw: GatewayClient }).gw;
  let response: unknown = { jobs: [nativeJob] }, failure: Error | undefined, connectFailure = false;
  gateway.connect = async () => { if (connectFailure) throw new Error("password=TRANSPORT_SECRET"); };
  gateway.rpc = async (method, params) => {
    calls.push({ method, params });
    assert.equal(method, "cron.list", "Only the vendor list read is allowed");
    assert.deepEqual(params, { includeDisabled: true });
    if (failure) throw failure;
    return response as Record<string, unknown>;
  };
  const registry = new AdapterRegistry(); registry.register(adapter);
  const connections: TestConn[] = [];
  const actor = (policy?: ConstructorParameters<typeof TestConn>[0]["policy"]) => {
    const conn = new TestConn({ registry, store, workspaceRoot: root, tenantId: "owner", policy });
    connections.push(conn); return conn;
  };
  return { calls, registry, adapter, actor,
    respond(value: unknown) { response = value; }, fail(message: string) { failure = new Error(message); },
    disconnect() { connectFailure = true; },
    async close() {
      for (const conn of connections) await conn.conn.dispose();
      adapter.close(); store.close(); rmSync(root, { recursive: true, force: true });
    },
  };
}

test("OpenClaw list/get normalize trigger, binding and receipt without vendor writes or L4 jobs", async () => {
  const f = fixture();
  try {
    const conn = f.actor();
    const listed = OpenClawScheduleListResult.parse(await conn.call("openclaw.schedule.list", {}));
    assert.equal(listed.schedules.length, 1);
    const job = listed.schedules[0]!;
    assert.deepEqual(job.trigger, nativeJob.schedule);
    assert.equal(job.id, nativeJob.id); assert.equal(job.name, nativeJob.displayName); assert.equal(job.enabled, false);
    assert.equal(job.agentId, "main"); assert.equal(job.effectiveAgentId, "main");
    assert.deepEqual(job.session, { sessionTarget: "isolated", sessionKey: nativeJob.sessionKey, wakeMode: "now", payloadKind: "agentTurn" });
    assert.deepEqual(job.delivery, { mode: "announce", channel: "feishu", to: "ou_opaque_target",
      lastDeliveryStatus: "not-delivered", lastDelivered: false, lastFailureNotificationDeliveryStatus: "delivered" });
    assert.equal(job.state.lastError, "timeout token=[redacted]");
    assert.equal(job.state.nextRunAtMs, 10000); assert.equal(job.state.lastRunAtMs, 9000);
    assert.equal(job.state.lastRunStatus, "error"); assert.equal(job.state.consecutiveErrors, 2);
    assert.doesNotMatch(JSON.stringify(listed), /PRIVATE_PROMPT|SECRET|password|ignored/);
    const detail = OpenClawScheduleGetResult.parse(await conn.call("openclaw.schedule.get", { id: nativeJob.id }));
    assert.deepEqual(detail.schedule, job);
    const info = await conn.call("device.info", {}) as { capabilities: string[] };
    assert.ok(info.capabilities.includes("openclaw_schedule_discover_v1"));
    await assert.rejects(() => conn.call("openclaw.schedule.get", { id: "missing" }), rpcError("errInvalidParams", /not found or not permitted/));
    assert.deepEqual(await conn.call("schedule.list", {}), { schedules: [] });
    f.respond({ jobs: [] });
    assert.deepEqual(await conn.call("openclaw.schedule.list", {}), { schedules: [] });
    assert.ok((await conn.call("device.info", {}) as { capabilities: string[] }).capabilities.includes("openclaw_schedule_discover_v1"));
    assert.ok(f.calls.length >= 5); assert.ok(f.calls.every(call => call.method === "cron.list"));
    assert.deepEqual(Object.keys(METHODS).filter(method => method.startsWith("openclaw.schedule.")), ["openclaw.schedule.list", "openclaw.schedule.get"]);
  } finally { await f.close(); }
});

test("OpenClaw normalizes interval/at, unknown trigger kinds and nullable optional vendor fields", async () => {
  const f = fixture();
  try {
    const conn = f.actor();
    for (const trigger of [{ kind: "every", everyMs: 60000, anchorMs: 500 }, { kind: "at", at: "2026-11-06T00:00:00Z" }, { kind: "vendor-future" }]) {
      f.respond([{ id: "interval", enabled: true, schedule: trigger, state: { lastError: null }, delivery: null, agentId: null }]);
      const { schedules } = OpenClawScheduleListResult.parse(await conn.call("openclaw.schedule.list", {}));
      assert.deepEqual(schedules[0]!.trigger, trigger);
      assert.deepEqual(schedules[0]!.delivery, {}); assert.deepEqual(schedules[0]!.state, {});
      assert.deepEqual(schedules[0]!.session, {}); assert.equal(schedules[0]!.agentId, undefined);
    }
    f.respond({ jobs: [{ ...nativeJob, delivery: { mode: "webhook", to: "https://user:password@example.test/hook?token=target_secret" } }] });
    const result = await conn.call("openclaw.schedule.list", {});
    assert.doesNotMatch(JSON.stringify(result), /user:password|target_secret/);
    f.respond({ jobs: [{ ...nativeJob, id: "token=opaque-id", state: { lastError: '{"token":"private_credential"} Bearer bearer_credential' } }] });
    const detail = OpenClawScheduleGetResult.parse(await conn.call("openclaw.schedule.get", { id: "token=opaque-id" }));
    assert.equal(detail.schedule.id, "token=opaque-id");
    assert.doesNotMatch(JSON.stringify(detail), /private_credential|bearer_credential/);
  } finally { await f.close(); }
});

for (const reason of ["unknown method", "unauthorized token=TRANSPORT_SECRET", "Gateway disconnected"]) {
  test(`OpenClaw RPC failure is closed: ${reason.split(" ")[0]}`, async () => {
    const f = fixture();
    try {
      const conn = f.actor();
      assert.ok((await conn.call("device.info", {}) as { capabilities: string[] }).capabilities.includes("openclaw_schedule_discover_v1"));
      f.fail(reason);
      await assert.rejects(() => conn.call("openclaw.schedule.list", {}), rpcError("errAgentUnavailable"));
      await assert.rejects(() => conn.call("openclaw.schedule.get", { id: nativeJob.id }));
      assert.ok(!(await conn.call("device.info", {}) as { capabilities: string[] }).capabilities.includes("openclaw_schedule_discover_v1"));
    } finally { await f.close(); }
  });
}

test("OpenClaw unreachable/missing adapter and malformed/partial inventories never succeed empty", async () => {
  const f = fixture();
  try {
    const conn = f.actor();
    for (const response of [{}, null, { jobs: [], error: "denied" }, { jobs: [], ok: false }, { jobs: [], hasMore: true },
      { jobs: [], total: 1 }, { jobs: [nativeJob, nativeJob] }, { jobs: [{ id: "bad" }] }]) {
      f.respond(response);
      await assert.rejects(() => conn.call("openclaw.schedule.list", {}), rpcError("errCapabilityUnsupported"));
      assert.ok(!(await conn.call("device.info", {}) as { capabilities: string[] }).capabilities.includes("openclaw_schedule_discover_v1"));
    }
    f.disconnect();
    await assert.rejects(() => conn.call("openclaw.schedule.list", {}), rpcError("errAgentUnavailable"));
    f.registry.unregister("openclaw");
    await assert.rejects(() => conn.call("openclaw.schedule.list", {}), rpcError("errCapabilityUnsupported"));
    assert.ok(!(await conn.call("device.info", {}) as { capabilities: string[] }).capabilities.includes("openclaw_schedule_discover_v1"));
  } finally { await f.close(); }
});

test("OpenClaw discovery respects method/agent policies and strict read-only params", async () => {
  const f = fixture();
  try {
    const denied = f.actor({ allowedMethods: ["device.info"] });
    await assert.rejects(() => denied.call("openclaw.schedule.list", {}), rpcError("errPolicyDenied", /allowedMethods/));
    assert.ok(!(await denied.call("device.info", {}) as { capabilities: string[] }).capabilities.includes("openclaw_schedule_discover_v1"));
    assert.equal(f.calls.length, 0);
    const allowed = f.actor({ allowedAgents: ["openclaw:main" as never] });
    f.respond({ jobs: [nativeJob, { ...nativeJob, id: "foreign", effectiveAgentId: "other" },
      { id: "unknown-agent", enabled: true, schedule: { kind: "every", everyMs: 1000 } }] });
    assert.equal(OpenClawScheduleListResult.parse(await allowed.call("openclaw.schedule.list", {})).schedules.length, 1);
    await assert.rejects(() => allowed.call("openclaw.schedule.get", { id: "foreign" }), rpcError("errInvalidParams", /not found or not permitted/));
    const before = f.calls.length;
    for (const params of [{ run: true }, { enable: true }]) await assert.rejects(() => allowed.call("openclaw.schedule.list", params), rpcError("errInvalidParams", /invalid params/));
    assert.equal(f.calls.length, before);
  } finally { await f.close(); }
});

test("OpenClaw CLI reads only cron list --all --json and fails closed on missing binary/nonzero/invalid JSON", { skip: process.platform === "win32" }, async () => {
  const root = mkdtempSync(join(tmpdir(), "phonon-openclaw-cli-read-"));
  try {
    const executable = join(root, "openclaw-fixture"), calls = join(root, "calls.jsonl");
    const program = (body: string) => writeFileSync(executable, `#!${process.execPath}\nconst {appendFileSync} = require('node:fs');\nappendFileSync(${JSON.stringify(calls)},JSON.stringify(process.argv.slice(2))+'\\n');\n${body}`, { mode: 0o700 });
    const adapter = new OpenClawAdapter({ binPath: executable });
    program(`console.log(${JSON.stringify(JSON.stringify({ jobs: [nativeJob] }))});`);
    assert.equal((await adapter.openclawScheduleList())[0]!.id, nativeJob.id);
    for (const body of ["process.exit(1);", "console.log('not json');", "console.log('{}');"]) {
      program(body); await assert.rejects(() => adapter.openclawScheduleList());
    }
    const recorded = readFileSync(calls, "utf8").trim().split("\n").map(line => JSON.parse(line));
    assert.ok(recorded.every(args => JSON.stringify(args) === JSON.stringify(["cron", "list", "--all", "--json"])));
    await assert.rejects(() => new OpenClawAdapter({ binPath: join(root, "missing") }).openclawScheduleList(), error => (error as { appCode: string }).appCode === "errAgentUnavailable");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("TypeScript native discovery wrappers use vendor namespace only", async () => {
  const calls: Array<{ method: string; params: unknown }> = [];
  const device = new PhononDevice("device", "owner", { request: async (method: string, params: unknown) => { calls.push({ method, params }); return { native: true }; } } as never);
  await device.openclaw.schedule.list(); await device.openclaw.schedule.get("vendor-job");
  assert.deepEqual(calls, [{ method: "openclaw.schedule.list", params: {} }, { method: "openclaw.schedule.get", params: { id: "vendor-job" } }]);
  assert.deepEqual(Object.keys(device.openclaw.schedule), ["list", "get"]);
});
