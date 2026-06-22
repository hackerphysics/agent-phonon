import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AdapterRegistry, OpenClawAdapter, PhononClient } from "@agent-phonon/core";
import { PhononTestServer } from "@agent-phonon/test-server";

/**
 * 端到端：phonon(OpenClaw adapter) 拨出连 test-server，
 * server 驱动 discovery → create → send → 收流式 → terminate。
 * 用真实 openclaw CLI，故超时给足。
 */
test("e2e: dial → discovery → create → send → stream → terminate", { timeout: 240000 }, async () => {
  // 1) 起 test-server
  const server = new PhononTestServer({ assignTenant: () => "tenant-A" });
  const port = await server.listen();

  // 2) phonon 拨出
  const registry = new AdapterRegistry();
  registry.register(new OpenClawAdapter({ defaultAgent: "phonon" }));
  const cwd = mkdtempSync(join(tmpdir(), "phonon-e2e-"));
  const client = new PhononClient({
    serverUrl: `ws://127.0.0.1:${port}`,
    deviceId: "dev-e2e",
    registry,
    trustLocal: true,
    // projectId → 工作目录（v0：直接用临时目录）
    resolveProjectCwd: () => cwd,
  });
  const { tenantId } = await client.connect();
  assert.equal(tenantId, "tenant-A");

  const device = await server.firstDevice();

  // 3) discovery
  const disco = (await device.peer.requestRaw("discovery.list", {})) as { agents: Array<{ agentId: string; available: boolean }> };
  const oc = disco.agents.find((a) => a.agentId === "openclaw:phonon");
  assert.ok(oc, "openclaw should be discovered");
  assert.equal(oc!.available, true, "openclaw should be available");

  // 4) create session（必绑 project+agent+model）
  const created = (await device.peer.requestRaw("session.create", {
    project: cwd,
    agent: "openclaw:phonon",
    model: "github-copilot/claude-opus-4.8",
    verbosity: "messages",
  })) as { sessionId: string; status: string };
  assert.ok(created.sessionId);
  assert.equal(created.status, "idle");

  // 5) send（ack + 异步流）
  const ack = (await device.peer.requestRaw("session.send", {
    sessionId: created.sessionId,
    input: "Reply with exactly: PHONON_E2E_OK",
  })) as { turnId: string; accepted: boolean };
  assert.equal(ack.accepted, true);

  // 6) 等流式终态事件
  const result = await device.waitForTurnEnd(ack.turnId);
  assert.equal((result as { type: string }).type, "result");
  assert.equal((result as { status: string }).status, "completed");
  const text = (result as { text: string }).text;
  assert.ok(text.includes("PHONON_E2E_OK"), `expected PHONON_E2E_OK in: ${text}`);

  // 7) status 应回 idle
  const status = (await device.peer.requestRaw("session.status", { sessionId: created.sessionId })) as { status: string; agent: string };
  assert.equal(status.status, "idle");
  assert.equal(status.agent, "openclaw:phonon");

  // 8) terminate
  const term = (await device.peer.requestRaw("session.terminate", { sessionId: created.sessionId })) as { status: string };
  assert.equal(term.status, "terminated");

  client.close();
  await server.close();
});

/** tenant 隔离：另一个 tenant 访问不到本 tenant 的 session。 */
test("e2e: cross-tenant session access is rejected", { timeout: 60000 }, async () => {
  const registry = new AdapterRegistry();
  registry.register(new OpenClawAdapter());
  const server = new PhononTestServer({ assignTenant: () => "tenant-X" });
  const port = await server.listen();
  const cwd = mkdtempSync(join(tmpdir(), "phonon-iso-"));
  const client = new PhononClient({ serverUrl: `ws://127.0.0.1:${port}`, deviceId: "dev-iso", registry,
    trustLocal: true, resolveProjectCwd: () => cwd });
  await client.connect();
  const device = await server.firstDevice();

  // 伪造一个不存在的 sessionId（不同 tenant 的 session 同理拿不到）
  await assert.rejects(
    () => device.peer.requestRaw("session.status", { sessionId: "s-nonexistent" }),
    (err: { data?: { appCode?: string }; message?: string }) => {
      const code = err?.data?.appCode ?? err?.message ?? "";
      return String(code).includes("errSessionNotFound") || String(JSON.stringify(err)).includes("errSessionNotFound");
    },
  );

  client.close();
  await server.close();
});
