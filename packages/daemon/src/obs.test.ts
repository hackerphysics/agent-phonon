import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PhononTestServer } from "@agent-phonon/test-server";
import { PhononDaemon } from "./daemon.js";

/**
 * 可观测性集成测试（B5）：daemon 起 obs server，验证
 * /health /sessions /metrics /events 反映真实状态（含真实 Gateway）。
 */
test("obs: health/sessions/metrics/events reflect real state", { timeout: 90000 }, async () => {
  const server = new PhononTestServer({ assignTenant: () => "tenant-O" });
  const port = await server.listen();
  const dbPath = join(mkdtempSync(join(tmpdir(), "obs-db-")), "o.db");
  const wsRoot = mkdtempSync(join(tmpdir(), "obs-proj-"));
  const daemon = new PhononDaemon({
    deviceId: "dev-obs",
    dbPath,
    workspaceRoot: wsRoot,
    hookBridge: { port: 0 },
    obs: { enabled: true, port: 0 },
    logLevel: "warn",
    adapters: [{ type: "openclaw-gateway", gatewayUrl: "ws://127.0.0.1:18789", defaultAgent: "phonon" }],
    servers: [{ url: `ws://127.0.0.1:${port}`, trustLocal: true }],
  });
  await daemon.start();
  const device = await server.firstDevice(5000);
  const base = `http://127.0.0.1:${daemon.obsPort}`;

  // /health
  const health = (await (await fetch(`${base}/health`)).json()) as { ok: boolean; adapters: string[]; connections: unknown[] };
  assert.equal(health.ok, true);
  assert.ok(health.adapters.includes("openclaw"));
  assert.equal(health.connections.length, 1);

  // create + send
  const proj = (await device.peer.requestRaw("project.create", { name: "obs-demo", git: false })) as { project: { projectId: string } };
  const c = (await device.peer.requestRaw("session.create", { project: proj.project.projectId, agent: "openclaw:phonon", model: "github-copilot/claude-opus-4.8", verbosity: "messages" })) as { sessionId: string };

  // /sessions snapshot
  const sessions = (await (await fetch(`${base}/sessions`)).json()) as Array<{ sessionId: string; agent: string; status: string }>;
  assert.ok(sessions.some((s) => s.sessionId === c.sessionId && s.agent === "openclaw:phonon"));

  const ack = (await device.peer.requestRaw("session.send", { sessionId: c.sessionId, input: "say OBS_OK" })) as { turnId: string };
  await device.waitForTurnEnd(ack.turnId, 60000);

  // /metrics
  const metrics = (await (await fetch(`${base}/metrics.json`)).json()) as { counters: Record<string, number> };
  assert.equal(metrics.counters.sessions_created_total, 1);
  assert.equal(metrics.counters.turns_started_total, 1);

  // /events timeline
  const events = (await (await fetch(`${base}/events?limit=20`)).json()) as Array<{ event: string }>;
  assert.ok(events.some((e) => e.event === "session.create"));
  assert.ok(events.some((e) => e.event === "turn.start"));

  await daemon.stop();
  await server.close();
});
