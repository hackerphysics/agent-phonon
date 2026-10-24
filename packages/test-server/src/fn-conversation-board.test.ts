import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AdapterRegistry, PhononStore, type AgentAdapter, type SendOptions } from "@agent-phonon/core";
import { AgentBoardInput, ConversationBoardParams, ConversationBoardResult } from "@agent-phonon/protocol";
import { PhononDevice } from "@agent-phonon/server-sdk";
import { TestConn } from "./harness.js";

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
const emptyBoard = () => ({ conversationID: randomUUID(), goal: "", items: [], revision: 0, authorID: "human", updatedAt: new Date().toISOString() });

test("board schemas preserve graphemes and reject long, duplicate, forged or invalid writes", () => {
  const family = "\u{1f468}\u200d\u{1f469}\u200d\u{1f467}\u200d\u{1f466}";
  const write = { operation: "write", requestId: randomUUID(), baseRevision: 0, goal: family.repeat(70),
    items: [{ id: randomUUID(), kind: "todo", text: "e\u0301".repeat(60), completed: false }] };
  assert.equal(AgentBoardInput.safeParse(write).success, true);
  for (const input of [{ ...write, goal: "a".repeat(71) }, { ...write, items: Array.from({ length: 9 }, () => ({ ...write.items[0], id: randomUUID() })) },
    { ...write, items: [write.items[0], write.items[0]] }, { ...write, items: [{ ...write.items[0], text: " " }] },
    { ...write, items: [{ ...write.items[0], text: "a".repeat(61) }] }, { ...write, items: Array.from({ length: 6 }, () => ({ ...write.items[0], id: randomUUID() })) },
    { ...write, baseRevision: 2147483647 }, { ...write, authorID: "forged" }, { operation: "read", conversationID: randomUUID() }]) assert.equal(AgentBoardInput.safeParse(input).success, false);
  const lineage = { nativeRunId: randomUUID(), sessionId: "session", turnId: "turn", workflowId: "workflow" };
  assert.equal(ConversationBoardParams.safeParse({ ...write, ...lineage }).success, true);
  assert.equal(ConversationBoardParams.safeParse(write).success, false);
  assert.equal(ConversationBoardResult.safeParse({ status: "ok", board: emptyBoard() }).success, true);
  assert.equal(ConversationBoardResult.safeParse({ status: "ok" }).success, false);
});

test("current-turn loopback and embedded board calls stamp lineage and reject expired or model-authored routes", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "phonon-board-channel-"))), store = new PhononStore(join(root, "state.db"));
  const ready = deferred<SendOptions>(), ended = deferred<void>(), registry = new AdapterRegistry();
  const adapter: AgentAdapter = { name: "board", capabilities: { nativeSession: true, nativeCompression: false, contextInjection: false, proactiveOutput: false,
    modelSwitch: false, interrupt: true, injectMidTurn: false, skillManagement: false, hooks: [], streaming: true, workflowRoles: [] },
    async discoverAgents() { return []; }, async createSession(params) { return { sessionId: params.sessionId, model: params.model, async terminate() {},
      async send(_input, options) { ready.resolve(options); await ended.promise; } }; } };
  registry.register(adapter);
  const tc = new TestConn({ registry, store, tenantId: "board-owner", workspaceRoot: root });
  const seen: any[] = [], board = emptyBoard();
  let malformed = false;
  tc.setRequestResponder("conversation.board", raw => { seen.push(raw); return malformed ? { status: "ok" } : { status: "ok", board }; });
  try {
    const project = (await tc.call("project.create", { name: "board", git: false }) as any).project.projectId, nativeRunId = randomUUID();
    const ack = await tc.call("workflow.run", { project, metadata: { native_run_id: nativeRunId, native_chat: true }, plan: { mode: "dag", nodes: [{ nodeId: "reply", agent: "board:main", model: "m1", input: "read" }], finalNodeId: "reply" } }) as any;
    const options = await ready.promise, env = options.environment!;
    const post = (input: unknown, token = env.AGENT_PHONON_INTERACTION_TOKEN, headers: Record<string, string> = {}) => fetch(env.AGENT_PHONON_BOARD_URL!, {
      method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...headers }, body: JSON.stringify(input),
    });
    assert.equal((await post({ operation: "read" })).status, 200);
    assert.equal(seen[0].nativeRunId, nativeRunId); assert.equal(seen[0].workflowId, ack.workflowId); assert.equal(seen[0].turnId, options.turnId); assert.ok(seen[0].sessionId);
    assert.equal((await options.conversationBoard!({ operation: "read" })).board.conversationID, board.conversationID);
    assert.equal((await post({ operation: "read", conversationID: randomUUID() })).status, 409);
    assert.equal((await post({ operation: "read" }, "wrong")).status, 403);
    assert.equal((await post({ operation: "read" }, undefined, { Origin: "https://untrusted.invalid" })).status, 403);
    assert.equal((await post({ operation: "write", requestId: randomUUID(), baseRevision: 0, goal: "", items: [] })).status, 200);
    malformed = true; assert.equal((await post({ operation: "read" })).status, 409);
    await tc.call("session.interrupt", { sessionId: seen[0].sessionId });
    await assert.rejects(post({ operation: "read" }));
    await assert.rejects(options.conversationBoard!({ operation: "read" }), /ended/);
  } finally { ended.resolve(); await tc.conn.dispose(); store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("TypeScript board handler is explicit and never fabricates a successful empty board", async () => {
  const device = new PhononDevice("device", "owner", {} as never), input = { operation: "read" }, result = { status: "ok", board: emptyBoard() };
  await assert.rejects(device._handleInbound("conversation.board", input), /not supported/);
  device.setConversationBoardHandler(async raw => { assert.equal(raw, input); return result; });
  assert.equal(await device._handleInbound("conversation.board", input), result);
});
