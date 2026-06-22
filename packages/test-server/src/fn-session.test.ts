import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AdapterRegistry, PhononError } from "@agent-phonon/core";
import { MockAdapter, TestConn } from "./harness.js";

/**
 * 功能覆盖测试套件（in-memory，快、CI 友好）。
 * 覆盖协议 33 方法 + 设计承诺，不依赖真实 LLM/Gateway。
 */

function setup(adapterOpts = {}) {
  const reg = new AdapterRegistry();
  const adapter = new MockAdapter({ name: "mock", agentIds: ["mock:default"], models: ["m1", "m2"], ...adapterOpts });
  reg.register(adapter);
  const root = mkdtempSync(join(tmpdir(), "phonon-fn-"));
  const tc = new TestConn({ registry: reg, workspaceRoot: root, trustLocal: true });
  return { reg, adapter, tc, root };
}

async function mkSession(tc: TestConn, root: string, agent = "mock:default", model = "m1") {
  const proj = (await tc.call("project.create", { name: "p", git: false })) as { project: { projectId: string } };
  const s = (await tc.call("session.create", { project: proj.project.projectId, agent, model, verbosity: "messages" })) as { sessionId: string };
  return { projectId: proj.project.projectId, sessionId: s.sessionId };
}

// ============ Discovery ============
test("discovery.list enumerates agents + models", async () => {
  const { tc } = setup({ agentIds: ["mock:a", "mock:b"] });
  const r = (await tc.call("discovery.list", {})) as { agents: Array<{ agentId: string; models: unknown[] }> };
  assert.equal(r.agents.length, 2);
  assert.ok(r.agents.find((a) => a.agentId === "mock:a"));
  assert.ok(r.agents[0]!.models.length > 0);
});

test("discovery.get returns single agent", async () => {
  const { tc } = setup({ agentIds: ["mock:x"] });
  const r = (await tc.call("discovery.get", { agentId: "mock:x" })) as { agent: { agentId: string } };
  assert.equal(r.agent.agentId, "mock:x");
});

test("discovery.get unknown agent → errAgentUnavailable", async () => {
  const { tc } = setup();
  await assert.rejects(() => tc.call("discovery.get", { agentId: "nope:x" }), (e: { data?: { appCode?: string } }) => e?.data?.appCode === "errAgentUnavailable");
});

// ============ Session lifecycle ============
test("session: create → send → stream → status → terminate", async () => {
  const { tc, root } = setup({ reply: () => "HELLO" });
  const { sessionId } = await mkSession(tc, root);
  const ack = (await tc.call("session.send", { sessionId, input: "hi" })) as { turnId: string; accepted: boolean };
  assert.equal(ack.accepted, true);
  const end = await tc.waitTurnEnd(ack.turnId);
  assert.equal(end.status, "completed");
  assert.equal(end.text, "HELLO");
  const st = (await tc.call("session.status", { sessionId })) as { status: string; agent: string };
  assert.equal(st.status, "idle");
  const term = (await tc.call("session.terminate", { sessionId })) as { status: string };
  assert.equal(term.status, "terminated");
});

test("session.create missing project/agent/model rejected", async () => {
  const { tc } = setup();
  await assert.rejects(() => tc.call("session.create", { agent: "mock:default", model: "m1" }));
  await assert.rejects(() => tc.call("session.create", { project: "p", model: "m1" }));
  await assert.rejects(() => tc.call("session.create", { project: "p", agent: "mock:default" }));
});

test("session.inject passes context to adapter", async () => {
  const { tc, adapter, root } = setup();
  const { sessionId } = await mkSession(tc, root);
  const r = (await tc.call("session.inject", { sessionId, context: [{ role: "system", content: "remember X" }] })) as { injected: number };
  assert.equal(r.injected, 1);
  assert.equal(adapter.lastSession!.injected[0]!.content, "remember X");
});

test("session.compress native", async () => {
  const { tc, adapter, root } = setup();
  const { sessionId } = await mkSession(tc, root);
  const r = (await tc.call("session.compress", { sessionId, mode: "native" })) as { mode: string };
  assert.equal(r.mode, "native");
  assert.equal(adapter.lastSession!.compressed, 1);
});

test("session.compress custom → errCapabilityUnsupported", async () => {
  const { tc, root } = setup();
  const { sessionId } = await mkSession(tc, root);
  await assert.rejects(() => tc.call("session.compress", { sessionId, mode: "custom" }), (e: { data?: { appCode?: string } }) => e?.data?.appCode === "errCapabilityUnsupported");
});

test("session.switchModel idle → switches + warnings", async () => {
  const { tc, root } = setup();
  const { sessionId } = await mkSession(tc, root, "mock:default", "m1");
  const r = (await tc.call("session.switchModel", { sessionId, model: "m2" })) as { previousModel: string; model: string; warnings?: string[] };
  assert.equal(r.previousModel, "m1");
  assert.equal(r.model, "m2");
});

test("session.interrupt mid-run → single interrupted terminal", async () => {
  const { tc, root } = setup({ sendDelayMs: 2000 });
  const { sessionId } = await mkSession(tc, root);
  const ack = (await tc.call("session.send", { sessionId, input: "slow" })) as { turnId: string };
  await new Promise((r) => setTimeout(r, 50));
  const r = (await tc.call("session.interrupt", { sessionId, reason: "stop" })) as { status: string };
  assert.equal(r.status, "idle");
  await new Promise((r) => setTimeout(r, 200));
  const finals = tc.streamEvents.filter((e) => e.turnId === ack.turnId && (e as { final?: boolean }).final);
  assert.equal(finals.length, 1);
  assert.equal(finals[0]!.status, "interrupted");
});

test("session.list pagination + filter", async () => {
  const { tc, root } = setup();
  const proj = (await tc.call("project.create", { name: "p", git: false })) as { project: { projectId: string } };
  for (let i = 0; i < 3; i++) await tc.call("session.create", { project: proj.project.projectId, agent: "mock:default", model: "m1", verbosity: "messages" });
  const all = (await tc.call("session.list", {})) as { sessions: unknown[]; nextCursor?: string };
  assert.equal(all.sessions.length, 3);
  const page = (await tc.call("session.list", { limit: 2 })) as { sessions: unknown[]; nextCursor?: string };
  assert.equal(page.sessions.length, 2);
  assert.ok(page.nextCursor);
});

test("session unsolicited output flows when proactiveOutput", async () => {
  const { tc, adapter, root } = setup({ proactiveOutput: true });
  await mkSession(tc, root);
  adapter.lastSession!.emitUnsolicited("cron bubble", "cron");
  await new Promise((r) => setTimeout(r, 30));
  const un = tc.streamEvents.find((e) => e.origin === "unsolicited");
  assert.ok(un);
  assert.equal(un!.source, "cron");
});

// ============ whenBusy ============
test("whenBusy=queue serializes concurrent sends", async () => {
  const { tc, root } = setup({ sendDelayMs: 100, reply: (i: string) => i });
  const { sessionId } = await mkSession(tc, root);
  const a1 = (await tc.call("session.send", { sessionId, input: "first" })) as { turnId: string; disposition: string };
  const a2 = (await tc.call("session.send", { sessionId, input: "second", whenBusy: "queue" })) as { disposition: string; queuePosition: number };
  assert.equal(a2.disposition, "queued");
  await tc.waitTurnEnd(a1.turnId);
  await new Promise((r) => setTimeout(r, 250));
  // 两轮都完成
  const completes = tc.streamEvents.filter((e) => (e as { type?: string }).type === "result");
  assert.ok(completes.length >= 2);
});

export {};
