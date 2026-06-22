import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AdapterRegistry, OpenClawAdapter, PhononClient, HookBridge, type PhononConnection } from "@agent-phonon/core";
import { PhononTestServer } from "@agent-phonon/test-server";

/**
 * B 阶段 HITL 闭环 e2e（不依赖真实 OpenClaw，纯协议链路）：
 *   模拟 plugin POST /hook/before_tool_call
 *     → HookBridge 找到 session 所属连接
 *       → fireHook → test-server 裁决
 *     ← decision 回到「plugin」
 *
 * 验证：危险命令被 server abort，放行命令 continue。
 */
test("hitl: before_tool_call → server abort flows back to plugin", { timeout: 30000 }, async () => {
  // test-server：命中 rm -rf 就 abort
  const server = new PhononTestServer({
    assignTenant: () => "tenant-HITL",
    hookDecision: (fired) => {
      const cmd = String((fired.payload?.extra as { command?: string })?.command ?? fired.payload?.command ?? "");
      if (cmd.includes("rm -rf")) return { action: "abort", reason: "dangerous command blocked" };
      return { action: "continue" };
    },
  });
  const port = await server.listen();

  const registry = new AdapterRegistry();
  registry.register(new OpenClawAdapter({ defaultAgent: "phonon" }));
  const cwd = mkdtempSync(join(tmpdir(), "phonon-hitl-"));
  const client = new PhononClient({ serverUrl: `ws://127.0.0.1:${port}`, deviceId: "dev-hitl", registry,
    trustLocal: true, resolveProjectCwd: () => cwd });
  await client.connect();
  const device = await server.firstDevice();

  // 建一个 session（不真跑，只为有 sessionId）
  const created = (await device.peer.requestRaw("session.create", {
    project: cwd, agent: "openclaw:phonon", model: "github-copilot/claude-opus-4.8", verbosity: "messages",
  })) as { sessionId: string };

  // HookBridge：sessionKey 形如 agent:phonon:phonon-<sessionId> → 抽出 sessionId 路由
  const conn = client.connection;
  assert.ok(conn, "client should expose its connection");
  const bridge = new HookBridge((sessionKey: string) => {
    const m = sessionKey.match(/phonon-(s-\d+-\d+)$/);
    const sessionId = m?.[1];
    if (sessionId && conn!.ownsSession(sessionId)) return { conn: conn!, sessionId };
    return undefined;
  });
  const bridgePort = await bridge.listen(0);

  const sessionKey = `agent:phonon:phonon-${created.sessionId}`;

  // 模拟 plugin POST：危险命令 → 应 abort
  const r1 = await fetch(`http://127.0.0.1:${bridgePort}/hook/before_tool_call`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionKey, toolName: "exec", params: { command: "rm -rf /" } }),
  });
  const d1 = (await r1.json()) as { action: string; reason?: string };
  assert.equal(d1.action, "abort");
  assert.ok(d1.reason?.includes("dangerous"));

  // 安全命令 → continue
  const r2 = await fetch(`http://127.0.0.1:${bridgePort}/hook/before_tool_call`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionKey, toolName: "exec", params: { command: "ls -la" } }),
  });
  const d2 = (await r2.json()) as { action: string };
  assert.equal(d2.action, "continue");

  // 未知 session → fail-open continue
  const r3 = await fetch(`http://127.0.0.1:${bridgePort}/hook/before_tool_call`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionKey: "agent:phonon:phonon-s-nonexistent", toolName: "exec", params: {} }),
  });
  const d3 = (await r3.json()) as { action: string };
  assert.equal(d3.action, "continue");

  await bridge.close();
  client.close();
  await server.close();
});
