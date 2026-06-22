import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PhononTestServer } from "@agent-phonon/test-server";
import { PhononDaemon } from "./daemon.js";

/**
 * Daemon 集成测试（B4，含真实 Gateway）：
 * config → PhononDaemon.start → 拨入 test-server → discovery → project.create
 * → daemon.stop。验证多 server 管理 + 共享 store + HookBridge。
 */
test("daemon: config-driven connect → discovery → project (real Gateway)", { timeout: 60000 }, async () => {
  const server = new PhononTestServer({ assignTenant: () => "tenant-D" });
  const port = await server.listen();

  const dbPath = join(mkdtempSync(join(tmpdir(), "daemon-db-")), "d.db");
  const wsRoot = mkdtempSync(join(tmpdir(), "daemon-proj-"));
  const daemon = new PhononDaemon({
    deviceId: "dev-daemon-test",
    dbPath,
    workspaceRoot: wsRoot,
    hookBridge: { port: 0 },
    adapters: [{ type: "openclaw-gateway", gatewayUrl: "ws://127.0.0.1:18789", defaultAgent: "phonon" }],
    servers: [{ url: `ws://127.0.0.1:${port}`, trustLocal: true }],
  });
  await daemon.start();

  const device = await server.firstDevice(5000);
  assert.equal(device.tenantId, "tenant-D");

  const disco = (await device.peer.requestRaw("discovery.list", {})) as { agents: Array<{ agentId: string }> };
  assert.ok(disco.agents.some((a) => a.agentId === "openclaw:phonon"));

  const proj = (await device.peer.requestRaw("project.create", { name: "daemon-demo", git: false })) as { project: { projectId: string } };
  assert.ok(proj.project.projectId);

  await daemon.stop();
  await server.close();
});
