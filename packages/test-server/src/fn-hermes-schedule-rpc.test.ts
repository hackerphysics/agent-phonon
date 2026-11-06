import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AdapterRegistry, HermesAdapter, HermesScheduleDiscoveryError, PhononStore } from "@agent-phonon/core";
import { METHODS } from "@agent-phonon/protocol";
import { PhononDevice } from "@agent-phonon/server-sdk";
import { TestConn } from "./harness.js";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "phonon-hermes-rpc-"));
  const store = new PhononStore(join(root, "state.db")), adapter = new HermesAdapter();
  adapter.discoverAgents = async () => [];
  const calls: unknown[] = [];
  let failure: Error | undefined;
  let jobs = [{ id: "opaque", name: 'Report token="PRIVATE TOKEN"', enabled: false, state: "paused", lastError: "Bearer PRIVATE_BEARER" }];
  adapter.discoverNativeSchedules = async (scope = {}) => {
    calls.push(["list", scope]); if (failure) throw failure;
    const profile = scope.profile ?? "default";
    return { runtime: "hermes", source: "cron/jobs.json", profile, agentId: `hermes:${profile}`, home: "/PRIVATE_HOME", jobs };
  };
  adapter.getNativeSchedule = async (id, scope = {}) => {
    calls.push(["get", id, scope]); if (failure) throw failure;
    const job = jobs.find(job => job.id === id);
    if (!job) throw new HermesScheduleDiscoveryError("job_not_found");
    const profile = scope.profile ?? "default";
    return { ...job, trigger: { kind: "cron", expr: "0 9 * * *" },
      context: { profile, agentId: `hermes:${profile}`, home: "/PRIVATE_HOME" },
      delivery: { mode: "https://user:PRIVATE_PASSWORD@example.test", lastDeliveryError: "password=PRIVATE_ERROR" } };
  };
  const registry = new AdapterRegistry(); registry.register(adapter);
  const connections: TestConn[] = [];
  return { calls, adapter, registry,
    actor(policy?: ConstructorParameters<typeof TestConn>[0]["policy"]) {
      const conn = new TestConn({ registry, store, workspaceRoot: root, tenantId: "owner", policy });
      connections.push(conn); return conn;
    },
    empty() { jobs = []; }, fail(error: Error) { failure = error; },
    async close() { for (const conn of connections) await conn.conn.dispose(); store.close(); rmSync(root, { recursive: true, force: true }); },
  };
}
const rejects = (code: string) => (error: unknown) => {
  assert.equal((error as {data?: {appCode: string}}).data?.appCode, code);
  assert.doesNotMatch(JSON.stringify(error), /PRIVATE/); return true;
};

test("Hermes RPC projects fresh profile-scoped native metadata, redacts credentials, and never creates L4 jobs", async () => {
  const f = fixture();
  try {
    const conn = f.actor();
    const list = await conn.call("hermes.schedule.list", { profile: "team" }) as {profile: string; jobs: Array<{id: string}>};
    assert.equal(list.profile, "team"); assert.equal(list.jobs[0]?.id, "opaque");
    const detail = await conn.call("hermes.schedule.get", { id: "opaque", profile: "team" });
    assert.doesNotMatch(JSON.stringify([list, detail]), /PRIVATE/);
    assert.deepEqual(f.calls, [["list", {profile: "team"}], ["get", "opaque", {profile: "team"}]]);
    assert.deepEqual(await conn.call("schedule.list", {}), {schedules: []});
    assert.ok((await conn.call("device.info", {}) as {capabilities: string[]}).capabilities.includes("hermes_schedule_discover_v1"));
    f.empty();
    assert.deepEqual((await conn.call("hermes.schedule.list", {}) as {jobs: unknown[]}).jobs, []);
    await assert.rejects(() => conn.call("hermes.schedule.get", {id: "missing"}), rejects("errInvalidParams"));
    assert.deepEqual(Object.keys(METHODS).filter(method => method.startsWith("hermes.schedule.")), ["hermes.schedule.list", "hermes.schedule.get"]);
  } finally { await f.close(); }
});

test("Hermes RPC rejects mutations, path injection and unauthorized profiles with no adapter calls", async () => {
  const f = fixture();
  try {
    const conn = f.actor({allowedAgents: ["hermes:team" as never]});
    await assert.rejects(() => conn.call("hermes.schedule.list", {profile: "foreign"}), rejects("errPolicyDenied"));
    for (const params of [{run: true}, {profile: "../private"}, {home: "/tmp/private"}]) {
      await assert.rejects(() => conn.call("hermes.schedule.list", params), rejects("errInvalidParams"));
    }
    assert.equal(f.calls.length, 0);
    const denied = f.actor({allowedMethods: ["device.info"]});
    await assert.rejects(() => denied.call("hermes.schedule.list", {}), rejects("errPolicyDenied"));
    assert.ok(!(await denied.call("device.info", {}) as {capabilities: string[]}).capabilities.includes("hermes_schedule_discover_v1"));
  } finally { await f.close(); }
});

test("Hermes capability and reads fail closed for absent adapter, corrupt stores and transient failures", async () => {
  const f = fixture();
  try {
    const conn = f.actor();
    for (const [failure, code] of [["store_invalid", "errCapabilityUnsupported"], ["store_unreadable", "errAgentUnavailable"],
      ["cron_unsupported", "errCapabilityUnsupported"], ["probe_failed", "errAgentUnavailable"]] as const) {
      f.fail(new HermesScheduleDiscoveryError(failure));
      await assert.rejects(() => conn.call("hermes.schedule.list", {}), rejects(code));
      await assert.rejects(() => conn.call("hermes.schedule.get", {id: "opaque"}), rejects(code));
      assert.ok(!(await conn.call("device.info", {}) as {capabilities: string[]}).capabilities.includes("hermes_schedule_discover_v1"));
    }
    f.fail(new Error("PRIVATE diagnostics"));
    await assert.rejects(() => conn.call("hermes.schedule.list", {}), rejects("errAgentUnavailable"));
    f.adapter.getNativeSchedule = undefined as never;
    await assert.rejects(() => conn.call("hermes.schedule.list", {}), rejects("errCapabilityUnsupported"));
  } finally { await f.close(); }
});

test("Hermes TypeScript SDK exposes only native list/get and preserves errors", async () => {
  const calls: unknown[] = [], peer = { request: async (method: string, params: unknown) => { calls.push([method, params]); return {native: true}; } };
  const device = new PhononDevice("device", "owner", peer as never);
  await device.hermes.schedule.list(); await device.hermes.schedule.get("opaque", {profile: "team"});
  assert.deepEqual(calls, [["hermes.schedule.list", {}], ["hermes.schedule.get", {profile: "team", id: "opaque"}]]);
  assert.deepEqual(Object.keys(device.hermes.schedule), ["list", "get"]);
  peer.request = async () => { throw new Error("unavailable"); };
  await assert.rejects(() => device.hermes.schedule.list(), /unavailable/);
});
