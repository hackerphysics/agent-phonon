import { test } from "node:test";
import assert from "node:assert/strict";
import { RescueAdapter } from "@agent-phonon/core";

const stubMaintenance = {
  targets: async () => ({ permissions: { read: true, configWrite: false, packageUpdate: false, serviceRestart: false }, targets: [] }),
  diagnose: async () => ({ diagnostics: [], at: new Date().toISOString() }),
  configGet: async () => ({ targetId: "x", configId: "y", exists: false }),
  configPatch: async () => { throw new Error("denied"); },
  rollback: async () => { throw new Error("denied"); },
  packageUpdate: async () => { throw new Error("denied"); },
  serviceStatus: async () => ({ targetId: "x", serviceId: "s", status: "not_configured" as const }),
  serviceRestart: async () => ({ targetId: "x", serviceId: "s", restarted: false, status: "not_configured" as const }),
};

test("phonon-rescue honestly declares no blocking HITL hooks", () => {
  assert.deepEqual(new RescueAdapter().capabilities.hooks, []);
});

test("phonon-rescue is always discoverable but unavailable without endpoint config", async () => {
  const adapter = new RescueAdapter();
  const [agent] = await adapter.discoverAgents();
  assert.equal(agent?.agentId, "phonon-rescue");
  assert.equal(agent?.available, false);
  assert.match(agent?.unavailableReason ?? "", /baseUrl/);
});

test("phonon-rescue discovery exposes configured model", async () => {
  const adapter = new RescueAdapter({ baseUrl: "https://example.test/v1", apiKey: "secret", defaultModel: "rescue-model" });
  const [agent] = await adapter.discoverAgents();
  assert.equal(agent?.available, true);
  assert.deepEqual(agent?.models.map((m) => m.id), ["rescue-model"]);
});

test("phonon-rescue requires tenant-bound maintenance runtime", async () => {
  const adapter = new RescueAdapter({ baseUrl: "https://example.test/v1", apiKey: "secret", defaultModel: "rescue-model" });
  await assert.rejects(() => adapter.createSession({ sessionId: "s1", agentId: "phonon-rescue", model: "rescue-model", cwd: "." }), /maintenance runtime/);
  await assert.rejects(() => adapter.createSession({
    sessionId: "s-wrong", agentId: "phonon-rescue", model: "server-selected-model", cwd: ".",
    runtimeContext: { maintenance: stubMaintenance },
  }), /only allows the locally configured model/);
  const session = await adapter.createSession({
    sessionId: "s1", agentId: "phonon-rescue", model: "rescue-model", cwd: ".",
    runtimeContext: { maintenance: stubMaintenance },
  });
  assert.equal(session.sessionId, "s1");
});
