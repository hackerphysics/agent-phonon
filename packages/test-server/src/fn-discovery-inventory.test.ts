import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AdapterRegistry, DiscoveryInventory, ObsBus, OpenCodeAdapter, PhononStore } from "@agent-phonon/core";
import { type AgentDescriptor, DiscoveryChangedParams } from "@agent-phonon/protocol";
import { MockAdapter, TestConn } from "./harness.js";

const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
class InventoryAdapter extends MockAdapter {
  rows?: AgentDescriptor[];
  calls = 0;
  fail = false;
  gate?: Promise<void>;
  signal?: AbortSignal;
  override async discoverAgents(signal?: AbortSignal) {
    this.calls++;
    this.signal = signal;
    await this.gate;
    if (this.fail) throw new Error("sensitive native diagnostic must not be logged");
    return structuredClone(this.rows ?? await super.discoverAgents()) as Awaited<ReturnType<MockAdapter["discoverAgents"]>>;
  }
}
function adapter() { return new InventoryAdapter({ name: "mock", agentIds: ["mock:a", "mock:b"], models: ["m1", "m2"] }); }

test("inventory: startup quiet, semantic add/remove/availability/models/capabilities; cloned stable snapshots", async () => {
  const a = adapter(); const inventory = new DiscoveryInventory(() => [a]); const events: any[] = [];
  const release = inventory.acquire(e => events.push(e));
  try {
    a.rows = await inventory.list(); assert.equal(events.length, 0);
    a.rows.forEach(r => { r.scannedAt = new Date().toISOString(); r.models.reverse(); });
    await inventory.refresh(); assert.equal(events.length, 0, "timestamp and ordering cannot jitter");
    a.rows![0]!.available = false; await inventory.refresh(); assert.equal(events.at(-1).kind, "agent_updated");
    a.rows![0]!.models[0]!.contextWindow = 100; await inventory.refresh(); assert.equal(events.at(-1).kind, "models_changed");
    a.rows![0]!.capabilities.streaming = !a.rows![0]!.capabilities.streaming; await inventory.refresh(); assert.equal(events.at(-1).kind, "agent_updated");
    const row = a.rows.pop()!; await inventory.refresh(); assert.equal(events.at(-1).kind, "agent_removed");
    a.rows.push(row); await inventory.refresh(); assert.equal(events.at(-1).kind, "agent_added");
    for (const e of events) DiscoveryChangedParams.parse(e);
    const cloned = await inventory.list(); cloned[0]!.models.length = 0;
    assert.ok((await inventory.list())[0]!.models.length);
    assert.equal(events.length, 5);
  } finally { release(); await inventory.dispose(); }
});

test("inventory: shared TTL/coalescing and removed registry runtime", async () => {
  const a = adapter(); const registry = new AdapterRegistry(); registry.register(a);
  const events: any[] = []; const r1 = registry.inventory.acquire(e => events.push(e)); const r2 = registry.inventory.acquire();
  try {
    await Promise.all(Array.from({ length: 20 }, () => registry.inventory.list())); assert.equal(a.calls, 1);
    await Promise.all(Array.from({ length: 20 }, () => registry.inventory.refresh())); assert.equal(a.calls, 2);
    registry.unregister("mock"); await registry.inventory.refresh(); assert.equal(events.filter(e => e.kind === "agent_removed").length, 2);
    assert.deepEqual(await registry.inventory.list(), []);
  } finally { r1(); r2(); await registry.inventory.dispose(); }
});

test("inventory: errors/timeouts preserve last-good, no overlap or late result, observers cannot crash scanner", async () => {
  const a = adapter(); const bus = new ObsBus(); const logs: string[] = [];
  bus.onEvent(e => { logs.push(e.event); if (e.event === "discovery.delivery_failed") throw Error("observer failed"); });
  const inventory = new DiscoveryInventory(() => [a], { scanTimeoutMs: 50 }, bus);
  const events: any[] = [];
  const release = inventory.acquire(e => events.push(e)); const badSink = inventory.acquire(() => { throw Error("transport closed"); });
  try {
    a.rows = await inventory.list(); const initial = await inventory.list();
    a.fail = true; await inventory.refresh(); assert.deepEqual(await inventory.list(), initial); assert.ok(logs.includes("discovery.scan_failed"));
    a.fail = false; let finish!: () => void; a.gate = new Promise(r => { finish = r; });
    await inventory.refresh(); assert.equal(a.signal?.aborted, true); assert.ok(logs.includes("discovery.scan_timeout"));
    const calls = a.calls; await inventory.refresh(); assert.equal(a.calls, calls); assert.deepEqual(await inventory.list(), initial);
    a.rows = []; finish(); await delay(1); assert.deepEqual(await inventory.list(), initial, "late successful timeout result ignored");
    a.gate = undefined; await inventory.refresh(); assert.equal(events.length, 2); assert.ok(logs.includes("discovery.delivery_failed"));
  } finally { release(); badSink(); await inventory.dispose(); }
});

test("inventory: stop while pending then reacquire does not revive old generation or lose new timer", async () => {
  const a = adapter(); const inventory = new DiscoveryInventory(() => [a], { pollIntervalMs: 100 });
  const events: any[] = []; const release = inventory.acquire(e => events.push(e)); a.rows = await inventory.list();
  let finish!: () => void; a.gate = new Promise(r => { finish = r; }); const pending = inventory.refresh();
  await delay(1); release(); assert.equal(a.signal?.aborted, true);
  const second = inventory.acquire(e => events.push(e)); await pending;
  a.rows![0]!.available = false; a.gate = undefined; finish();
  await delay(250); assert.equal(events.length, 1); second();
  const calls = a.calls; await delay(150); assert.equal(a.calls, calls, "last lease clears polling");
  await inventory.dispose(); await inventory.refresh(); assert.equal(a.calls, calls);
});

test("discovery API: allowedAgents filters list/get/change, availableOnly and exact get; reconnect snapshot", async () => {
  const a = adapter(); const registry = new AdapterRegistry(); registry.register(a);
  const storeA = new PhononStore(":memory:"); const storeB = new PhononStore(":memory:");
  const one = new TestConn({ registry, store: storeA, policy: { allowedAgents: ["mock:a" as never] } });
  const two = new TestConn({ registry, store: storeB, policy: { allowedAgents: ["mock:b" as never] } });
  let replacement: TestConn | undefined;
  try {
    a.rows = (await one.call("discovery.list", {}) as any).agents.concat((await two.call("discovery.list", {}) as any).agents);
    assert.equal(a.rows!.length, 2); assert.equal(a.calls, 1);
    await assert.rejects(one.call("discovery.get", { agentId: "mock:b" }), (e: any) => e.data?.appCode === "errPolicyDenied");
    a.rows![0]!.available = false; await registry.inventory.refresh();
    assert.equal(one.notifications.length, 1); assert.equal(two.notifications.length, 0);
    assert.deepEqual((await one.call("discovery.list", { availableOnly: true }) as any).agents, []);
    assert.equal((await one.call("discovery.get", { agentId: "mock:a" }) as any).agent.available, false);
    await one.conn.dispose(); replacement = new TestConn({ registry, store: storeA, policy: { allowedAgents: ["mock:a" as never, "mock:no-such-agent" as never] } });
    assert.equal((await replacement.call("discovery.list", {}) as any).agents[0].available, false);
    await assert.rejects(replacement.call("discovery.get", { agentId: "mock:no-such-agent" }), (e: any) => e.data?.appCode === "errAgentUnavailable");
    a.rows![0]!.available = true; await registry.inventory.refresh();
    assert.equal(one.notifications.length, 1); assert.equal(replacement.notifications.length, 1); assert.equal(two.notifications.length, 0);
  } finally { await one.conn.dispose(); await two.conn.dispose(); await replacement?.conn.dispose(); await registry.inventory.dispose(); storeA.close(); storeB.close(); }
});

test("inventory: native supervised probe is aborted at timeout/dispose, no false removal", async () => {
  const root = mkdtempSync(join(tmpdir(), "phonon-discovery-probe-"));
  const bin = join(root, "probe"); writeFileSync(bin, '#!/usr/bin/env node\nsetInterval(() => {}, 1000);\n', { mode: 0o700 });
  const inventory = new DiscoveryInventory(() => [new OpenCodeAdapter({ env: { binPath: bin } })], { scanTimeoutMs: 100 });
  const release = inventory.acquire();
  await inventory.list(); release(); await inventory.dispose(); await delay(350);
  assert.equal((process.getActiveResourcesInfo()).includes("ProcessWrap"), false);
});

test("optional native catalog failure retains last-good models and native-config availability", async () => {
  const { createServer } = await import("node:http");
  const { CodexAdapter } = await import("@agent-phonon/core");
  let status = 200;
  const server = createServer((_req, res) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(status === 200 ? { data: [{ id: "native-model" }] } : { error: "unavailable" }));
  });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const a = new CodexAdapter({ env: { binPath: process.execPath, baseUrl, defaultModel: "native-model" } });
  const inventory = new DiscoveryInventory(() => [a]); const events: unknown[] = [];
  const release = inventory.acquire(e => events.push(e));
  try {
    const first = await inventory.list(); assert.equal(first[0]?.available, true);
    assert.deepEqual(first[0]?.models.map(m => m.id), ["native-model"]);
    status = 503; await inventory.refresh();
    assert.deepEqual((await inventory.list())[0]?.models, first[0]?.models);
    assert.equal(events.length, 0, "optional failure must not fabricate models_changed");
    const fresh = new CodexAdapter({ env: { binPath: process.execPath, baseUrl, defaultModel: "native-model" } });
    const initialFailure = await fresh.discoverAgents();
    assert.equal(initialFailure[0]?.available, true);
    assert.equal(initialFailure[0]?.models[0]?.id, "native-model");
  } finally { release(); await inventory.dispose(); await new Promise<void>(r => server.close(() => r())); }
});
