import { test } from "node:test";
import assert from "node:assert/strict";
import { WebSocketServer } from "ws";
import { AdapterRegistry, HookBridge, type PhononConnection } from "@agent-phonon/core";
import { PhononClient } from "@agent-phonon/core";
import { MockAdapter } from "./harness.js";

/**
 * 安全修复回归测试（bug-bash#2 B2/B4 + token 鉴权）。
 * 这些是之前真 bug 的回归防线，必须有测试，否则会回退。
 */

// ============ B2: deviceKey 握手 ============
test("security: deviceKey sent in connect.hello", async () => {
  let receivedAuth: { deviceKey?: string } | undefined;
  const wss = new WebSocketServer({ port: 0 });
  const port = await new Promise<number>((r) => wss.on("listening", () => r((wss.address() as { port: number }).port)));
  wss.on("connection", (ws) => {
    ws.on("message", (raw: Buffer) => {
      const m = JSON.parse(raw.toString());
      if (m.method === "connect.hello") {
        receivedAuth = m.params.auth;
        ws.send(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: "0.1.0", tenantId: "t", at: new Date().toISOString() } }));
      }
    });
  });
  const reg = new AdapterRegistry();
  reg.register(new MockAdapter());
  const client = new PhononClient({ serverUrl: `ws://127.0.0.1:${port}`, deviceId: "dev1", registry: reg, deviceKey: "secret-key-123" });
  await client.connect();
  assert.ok(receivedAuth, "server should receive auth");
  assert.equal(receivedAuth!.deviceKey, "secret-key-123");
  client.close();
  await new Promise<void>((r) => wss.close(() => r()));
});

test("security: no deviceKey → no auth field", async () => {
  let sawAuth: unknown = "unset";
  const wss = new WebSocketServer({ port: 0 });
  const port = await new Promise<number>((r) => wss.on("listening", () => r((wss.address() as { port: number }).port)));
  wss.on("connection", (ws) => {
    ws.on("message", (raw: Buffer) => {
      const m = JSON.parse(raw.toString());
      if (m.method === "connect.hello") {
        sawAuth = m.params.auth;
        ws.send(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: "0.1.0", tenantId: "t", at: new Date().toISOString() } }));
      }
    });
  });
  const reg = new AdapterRegistry();
  reg.register(new MockAdapter());
  const client = new PhononClient({ serverUrl: `ws://127.0.0.1:${port}`, deviceId: "dev1", registry: reg });
  await client.connect();
  assert.equal(sawAuth, undefined);
  client.close();
  await new Promise<void>((r) => wss.close(() => r()));
});

// ============ HookBridge token 鉴权 ============
test("security: HookBridge rejects without token when configured", async () => {
  const bridge = new HookBridge(() => undefined, { token: "bridge-secret" });
  const port = await bridge.listen(0);
  // 无 Authorization → 401（解析 action continue 但 401 状态）
  const noAuth = await fetch(`http://127.0.0.1:${port}/hook/before_tool_call`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionKey: "x", toolName: "t", params: {} }),
  });
  assert.equal(noAuth.status, 401);
  // 错 token → 401
  const wrong = await fetch(`http://127.0.0.1:${port}/hook/before_tool_call`, {
    method: "POST", headers: { "content-type": "application/json", authorization: "Bearer wrong" }, body: JSON.stringify({ sessionKey: "x", toolName: "t", params: {} }),
  });
  assert.equal(wrong.status, 401);
  // 对 token → 200（未知 session fail-open continue）
  const ok = await fetch(`http://127.0.0.1:${port}/hook/before_tool_call`, {
    method: "POST", headers: { "content-type": "application/json", authorization: "Bearer bridge-secret" }, body: JSON.stringify({ sessionKey: "x", toolName: "t", params: {} }),
  });
  assert.equal(ok.status, 200);
  await bridge.close();
});

export {};
