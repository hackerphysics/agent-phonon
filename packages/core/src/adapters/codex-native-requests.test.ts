import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { CodexNativeRequests } from "./codex-native-requests.js";
import type { SendOptions } from "../adapter.js";
import type { CodexNativeFrame } from "./codex-app-server.js";

const frame = (method: string, extra: Record<string, unknown> = {}): CodexNativeFrame => ({ method,
  params: { threadId: "native-root", turnId: "native-turn", itemId: "item", ...extra } });
const started = (type = "commandExecution"): CodexNativeFrame => frame("item/started", { item: { id: "item", type } });

function fixture(reply: (request: any) => Promise<any>, beforeNativeEffect?: () => void) {
  const requests: any[] = [], applied: string[] = [];
  const options: SendOptions = { turnId: "phonon-turn", verbosity: "tools", emit() {}, beforeNativeEffect,
    requestInteraction: async input => { requests.push(input); return reply(input); },
    acknowledgeInteraction: id => { applied.push(id); } };
  const tools = new CodexNativeRequests(options);
  return { tools, requests, applied, signal: new AbortController().signal };
}

test("Codex native approvals wait for the real human and only acknowledge observed native application", async () => {
  const f = fixture(async input => ({ requestId: input.requestId, action: "submit", values: { decision: "accept" } }));
  f.tools.observe(started());
  const result = await f.tools.request(frame("item/commandExecution/requestApproval", { command: "printf original", availableDecisions: ["accept", "acceptForSession", "decline", "cancel"] }), f.signal);
  assert.deepEqual(result, { decision: "accept" });
  assert.equal(f.requests[0].presentation.kind, "approval");
  assert.deepEqual(f.requests[0].form.fields[0].options.map((option: any) => option.value), ["accept", "decline", "cancel"]);
  assert.deepEqual(f.applied, []);
  f.tools.observe(frame("item/completed", { item: { id: "item", type: "commandExecution", status: "completed" } }));
  assert.deepEqual(f.applied, [f.requests[0].requestId]);
});

test("Codex native permission requests cannot accept a delegated DE response as human assent", async () => {
  const f = fixture(async input => ({ requestId: input.requestId, action: "submit", values: { decision: "accept" },
    responder: { kind: "de", id: randomUUID(), runID: randomUUID() } }));
  f.tools.observe(started());
  await assert.rejects(f.tools.request(frame("item/commandExecution/requestApproval"), f.signal), /human responder/);
  assert.deepEqual(f.applied, []);
});

test("Codex native approvals never infer assent from missing or foreign item/request identity", async () => {
  const f = fixture(async () => ({ requestId: "foreign", action: "submit", values: { decision: "accept" } }));
  await assert.rejects(f.tools.request(frame("item/commandExecution/requestApproval"), f.signal));
  assert.equal(f.requests.length, 0);
  f.tools.observe(started());
  await assert.rejects(f.tools.request(frame("item/fileChange/requestApproval"), f.signal), /item mismatch/);
  await assert.rejects(f.tools.request(frame("item/commandExecution/requestApproval"), f.signal), /human responder/);
});

test("Codex native approvals revalidate authority after the human response", async () => {
  let allowed = true;
  const f = fixture(async input => { allowed = false; return { requestId: input.requestId, action: "submit", values: { decision: "accept" } }; },
    () => { if (!allowed) throw new Error("original source revoked"); });
  f.tools.observe(started());
  await assert.rejects(f.tools.request(frame("item/commandExecution/requestApproval"), f.signal), /original source revoked/);
  assert.deepEqual(f.applied, []);
});

test("Codex native cancellation cannot be turned into an approval", async () => {
  const f = fixture(async input => ({ requestId: input.requestId, action: "cancel" }));
  f.tools.observe(started());
  assert.deepEqual(await f.tools.request(frame("item/commandExecution/requestApproval"), f.signal), { decision: "cancel" });
  assert.deepEqual(f.applied, []);
});

test("Codex native permission grants return only the actual requested subset and remain turn-scoped", async () => {
  const f = fixture(async input => ({ requestId: input.requestId, action: "submit", values: { decision: "accept" } }));
  f.tools.observe(started("dynamicToolCall"));
  assert.deepEqual(await f.tools.request(frame("item/permissions/requestApproval", { permissions: { network: { enabled: true }, foreign: "ignored" } }), f.signal),
    { permissions: { network: { enabled: true } }, scope: "turn" });
});

test("Codex MCP elicited approvals keep their native questions human-only", async () => {
  const f = fixture(async input => ({ requestId: input.requestId, action: "submit", values: { permission: "Accept" },
    responder: { kind: "de", id: randomUUID(), runID: randomUUID() } }));
  f.tools.observe(started("mcpToolCall"));
  await assert.rejects(f.tools.request(frame("item/tool/requestUserInput", { questions: [{ id: "permission", question: "Allow tool?", options: [{ label: "Accept" }, { label: "Decline" }] }] }), f.signal));
  assert.equal(f.requests[0].presentation.kind, "approval");
});
