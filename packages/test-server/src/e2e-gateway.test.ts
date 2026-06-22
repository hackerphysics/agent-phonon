import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { AdapterRegistry, OpenClawGatewayAdapter, PhononClient } from "@agent-phonon/core";
import { PhononTestServer } from "@agent-phonon/test-server";

/**
 * 端到端（Gateway WS 版）：phonon 用 OpenClawGatewayAdapter 连本机 Gateway，
 * 经 test-server 驱动 discovery → create → send → **流式 delta** → terminate。
 * 验证真实流式输出（chat delta 事件）。
 */
test("e2e-gateway: streaming via OpenClaw Gateway WS", { timeout: 240000 }, async () => {
  const token = JSON.parse(readFileSync(join(homedir(), ".openclaw", "openclaw.json"), "utf8")).gateway.auth.token;

  const server = new PhononTestServer({ assignTenant: () => "tenant-GW" });
  const port = await server.listen();

  const registry = new AdapterRegistry();
  const gwAdapter = new OpenClawGatewayAdapter({
    gateway: { baseUrl: "ws://127.0.0.1:18789", token },
    defaultAgent: "phonon",
  });
  registry.register(gwAdapter);
  const cwd = mkdtempSync(join(tmpdir(), "phonon-gw-"));
  const client = new PhononClient({
    serverUrl: `ws://127.0.0.1:${port}`,
    deviceId: "dev-gw",
    registry,
    trustLocal: true,
    resolveProjectCwd: () => cwd,
  });
  await client.connect();
  const device = await server.firstDevice();

  // discovery（连 Gateway 成功即 available）
  const disco = (await device.peer.requestRaw("discovery.list", {})) as { agents: Array<{ agentId: string; available: boolean }> };
  assert.equal(disco.agents.find((a) => a.agentId === "openclaw:phonon")?.available, true);

  // create
  const created = (await device.peer.requestRaw("session.create", {
    project: cwd, agent: "openclaw:phonon", model: "github-copilot/claude-opus-4.8", verbosity: "messages",
  })) as { sessionId: string };

  // send
  const ack = (await device.peer.requestRaw("session.send", {
    sessionId: created.sessionId, input: "Reply with exactly: GW_STREAM_OK",
  })) as { turnId: string };

  // 等终态 + 校验收到了流式 delta 事件
  const result = await device.waitForTurnEnd(ack.turnId);
  assert.equal((result as { type: string }).type, "result");

  const deltas = device.streamEvents.filter(
    (e) => e.turnId === ack.turnId && (e as { type?: string }).type === "message",
  );
  assert.ok(deltas.length > 0, "should have received streaming delta message events");

  // terminate
  await device.peer.requestRaw("session.terminate", { sessionId: created.sessionId });

  client.close();
  gwAdapter.close();
  await server.close();
});
