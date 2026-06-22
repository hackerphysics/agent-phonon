import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AdapterRegistry } from "@agent-phonon/core";
import { MockAdapter, TestConn } from "./harness.js";

/**
 * 平面③（document/interaction）+ stream.event + interaction lifecycle 功能覆盖。
 * 这些是 phonon→server 主动发起的能力（通过 PhononConnection 的 emitter 方法）。
 */

function mk() {
  const r = new AdapterRegistry();
  r.register(new MockAdapter({ name: "mock", agentIds: ["mock:default"] }));
  const root = mkdtempSync(join(tmpdir(), "phonon-p3-"));
  const tc = new TestConn({ registry: r, tenantId: "p3", workspaceRoot: root, trustLocal: true });
  return tc;
}

// ============ 平面③: document ============
test("document.send: phonon → server (p2s emitter)", async () => {
  const tc = mk();
  // 让 server 侧响应 document.send
  let received: Record<string, unknown> | undefined;
  // 重新 hook server inbound: 用 conn.sendDocument 触发，server 端收 document.send 请求
  // TestConn 默认对未知 p2s 请求回 {applied:true}，这里验证调用能完成
  const p = tc.conn.sendDocument({ documents: [{ name: "report.md", kind: "document", content: { encoding: "utf8", data: "# hi" } }], at: new Date().toISOString() });
  const r = await p;
  assert.ok(r !== undefined);
});

// ============ 平面③: interaction ============
test("interaction.request: phonon → server blocking form (p2s emitter)", async () => {
  const tc = mk();
  const r = await tc.conn.requestInteraction({
    requestId: "r1",
    form: { title: "选风格", fields: [{ key: "style", label: "风格", type: "select", options: [{ label: "A", value: "a" }], required: true }], submitLabel: "确认" },
    blocking: true,
    at: new Date().toISOString(),
  });
  assert.ok(r !== undefined);
});

// ============ interaction.response / cancel（server → phonon）============
test("interaction.response + cancel accepted via dispatch", async () => {
  const tc = mk();
  // server 下发 interaction.response（异步回填）
  const resp = await tc.call("interaction.response", { requestId: "r1", action: "submit", values: { style: "a" }, at: new Date().toISOString() });
  assert.equal(resp, null);
  // server 下发 interaction.cancel
  const cancel = (await tc.call("interaction.cancel", { requestId: "r1", reason: "superseded" })) as { cancelled: boolean };
  assert.equal(cancel.cancelled, true);
});

// ============ document.prepare_upload (p2s) — 真测试 ============
test("document.prepare_upload: phonon requests upload credential from server", async () => {
  const tc = mk();
  // server 侧响应 prepare_upload：返回上传地址
  tc.setRequestResponder("document.prepare_upload", (params) => {
    const p = params as { filename: string; sizeBytes: number };
    return { uploadRef: "u-" + p.filename, uploadUrl: "https://s3.example/upload/" + p.filename, method: "PUT", expiresAt: new Date(Date.now() + 60000).toISOString() };
  });
  const r = (await tc.conn.prepareUpload({ filename: "big.pdf", sizeBytes: 52428800, mimeType: "application/pdf", at: new Date().toISOString() })) as { uploadRef: string; uploadUrl: string };
  assert.equal(r.uploadRef, "u-big.pdf");
  assert.ok(r.uploadUrl.includes("big.pdf"));
});

// ============ stream.event 通道（每个 send 都产生）============
test("stream.event channel: message delta + result final", async () => {
  const tc = mk();
  const proj = (await tc.call("project.create", { name: "p", git: false })) as { project: { projectId: string } };
  const s = (await tc.call("session.create", { project: proj.project.projectId, agent: "mock:default", model: "m1", verbosity: "messages" })) as { sessionId: string };
  const ack = (await tc.call("session.send", { sessionId: s.sessionId, input: "hello" })) as { turnId: string };
  await tc.waitTurnEnd(ack.turnId);
  const evs = tc.streamEvents.filter((e) => e.turnId === ack.turnId);
  assert.ok(evs.some((e) => (e as { type?: string }).type === "message"));
  assert.ok(evs.some((e) => (e as { type?: string }).type === "result" && (e as { final?: boolean }).final));
  // seq 单调递增
  const seqs = evs.map((e) => e.seq as number);
  for (let i = 1; i < seqs.length; i++) assert.ok(seqs[i]! > seqs[i - 1]!, "seq monotonic");
});

export {};

// ============ discovery.changed (phonon → server notify) ============
test("discovery.changed: phonon notifies server of availability change", async () => {
  const tc = mk();
  tc.conn.notifyDiscoveryChanged({ kind: "agent_updated", agentId: "mock:default", at: new Date().toISOString() });
  await new Promise((r) => setTimeout(r, 20));
  const n = tc.notifications.find((x) => x.kind === "agent_updated");
  assert.ok(n, "server should receive discovery.changed");
  assert.equal(n!.agentId, "mock:default");
});

// ============ hook.resolve (server → phonon async path) ============
test("hook.resolve: server async decision accepted via dispatch", async () => {
  const tc = mk();
  const r = (await tc.call("hook.resolve", { sessionId: "s1", hookId: "h1", action: "continue" })) as { applied: boolean };
  assert.equal(r.applied, true);
  // abort action 也接受
  const r2 = (await tc.call("hook.resolve", { sessionId: "s1", hookId: "h2", action: "abort", reason: "blocked" })) as { applied: boolean };
  assert.equal(r2.applied, true);
});
