import test from "node:test";
import assert from "node:assert/strict";
import { RpcPeer } from "@agent-phonon/core";

test("D04: async application response resolves original RPC exactly once and clears timer", async () => {
  const sent: any[] = [];
  const peer = new RpcPeer({ send: (data) => { sent.push(JSON.parse(data)); }, close() {} }, () => null);
  const waiting = peer.requestRaw("interaction.request", { requestId: "review-1" }, 60000);
  assert.equal(peer.resolveRequest("interaction.request", "wrong", {}), false);
  assert.equal(peer.resolveRequest("interaction.request", "review-1", { action: "submit", values: { approved: true } }), true);
  assert.deepEqual(await waiting, { action: "submit", values: { approved: true } });
  assert.equal(peer.resolveRequest("interaction.request", "review-1", { action: "cancel" }), false);
  await peer.handle(JSON.stringify({ jsonrpc: "2.0", id: sent[0].id, result: { action: "cancel" } }));
  peer.dispose();
});

test("D02/D07: Gateway abort settles send, inject reaches input, controls surface failure and item tools map once", async () => {
  const { OpenClawGatewayAdapter } = await import("@agent-phonon/core");
  const adapter = new OpenClawGatewayAdapter({ gateway: { baseUrl: "ws://unit-test.invalid", token: "unit-test" } });
  const calls: Array<{ method: string; params: any }> = [];
  const fake = {
    async connect() {},
    async rpc(method: string, params: any) { calls.push({ method, params }); return method === "sessions.compact" ? { ok: true, compacted: false, reason: "nothing to compact" } : {}; },
    async patchSessionModel() { throw new Error("native model rejected"); },
  };
  (adapter as any).gw = fake;
  const session = await adapter.createSession({ sessionId: "s-unit", agentId: "openclaw:main", model: "m1", cwd: "/tmp" });
  await session.inject!([{ role: "user", content: "INJECTED" }]);
  const events: any[] = [];
  const controller = new AbortController();
  const sending = session.send("input", { turnId: "t1", verbosity: "tools", emit: (e) => events.push(e), signal: controller.signal });
  const request = calls.find((c) => c.method === "chat.send")!;
  assert.match(request.params.message, /INJECTED/);
  for (const phase of ["start", "end", "end"]) (session as any).handleEvent("agent", { stream: "item", runId: request.params.idempotencyKey, data: { kind: "tool", phase, name: "read", toolCallId: "tool-1", status: phase === "start" ? "running" : "completed" } });
  assert.equal(events.filter((e) => e.type === "tool_call").length, 1);
  assert.equal(events.filter((e) => e.type === "tool_result").length, 1);
  controller.abort();
  await sending;
  assert.equal(events.at(-1).status, "interrupted");
  await assert.rejects(session.switchModel!("m2"), /native model rejected/);
  assert.equal(session.model, "m1");
  await assert.rejects(session.compressNative!(), /did not compact/);
  await session.terminate();
});

test("OpenClaw discovery uses allowed catalog and preserves provider-qualified identity", async () => {
  const { OpenClawGatewayAdapter } = await import("@agent-phonon/core");
  const adapter = new OpenClawGatewayAdapter({ gateway: { baseUrl: "ws://unit-test.invalid", token: "unit-test" } });
  (adapter as any).gw = {
    async connect() {}, isConnected: () => true,
    async rpc(method: string, params: any) {
      if (method === "agents.list") return { agents: [{ id: "main" }] };
      assert.equal(params.view, "default");
      return { models: [{ id: "same", provider: "one" }, { id: "same", provider: "two" }, { id: "one/already", provider: "one" }] };
    },
  };
  const [agent] = await adapter.discoverAgents();
  assert.deepEqual(agent!.models.map((m) => m.id), ["one/same", "two/same", "one/already"]);
});
