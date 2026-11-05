import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { SessionEngine, AdapterRegistry } from "./session-engine.js";
import { PhononStore } from "./store.js";
import { withPeerFixture } from "./testing/peer-fixture.js";
import type { AgentAdapter, CreateSessionParams, SendOptions } from "./adapter.js";
import { SessionId } from "@agent-phonon/protocol";

const wait = (ms = 10) => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(predicate: () => boolean | Promise<boolean>, attempts = 200) {
  for (let n = 0; n < attempts; n++) {
    if (await predicate()) return;
    await wait();
  }
  throw new Error("condition not met");
}

test("late interrupted-turn finally does not suspend a rebound replacement turn MCP binding", () => withPeerFixture("mcp-late-finally", async scope => {
  const store = new PhononStore(join(scope.root, "state.sqlite")); scope.defer(() => store.close());
  const registry = new AdapterRegistry(), events: any[] = [];
  let releaseFirst!: () => void;
  const firstHold = new Promise<void>(resolve => { releaseFirst = resolve; });
  let firstEnv = "", firstToken = "", secondCalls = 0, firstEntered = false;
  const adapter: AgentAdapter = {
    name: "mock",
    capabilities: { nativeSession: false, nativeCompression: false, contextInjection: false, proactiveOutput: false,
      modelSwitch: false, interrupt: true, injectMidTurn: false, skillManagement: false, hooks: [], streaming: true, workflowRoles: ["worker"] },
    discoverAgents: async () => [],
    createSession: async (params: CreateSessionParams) => ({
      sessionId: params.sessionId, model: params.model, terminate: async () => {},
      interrupt: async () => {},
      send: async (_input: string, options: SendOptions) => {
        const endpoint = options.environment!.AGENT_PHONON_MCP_URL!;
        const token = options.environment!.AGENT_PHONON_INTERACTION_TOKEN!;
        const post = (method: string, paramsBody: unknown = {}) => fetch(endpoint, {
          method: "POST",
          headers: { authorization: "Bearer " + token, "content-type": "application/json", accept: "application/json, text/event-stream" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: paramsBody }),
        });
        if (!firstEntered) {
          firstEntered = true;
          firstEnv = endpoint; firstToken = token;
          await firstHold;
          // Old turn settles after replacement already rebound; its finally must not 409 the new turn.
          options.emit({ type: "result", sessionId: SessionId.parse(params.sessionId), turnId: options.turnId, seq: 0,
            at: new Date().toISOString(), origin: "solicited", text: "interrupted-settled", status: "failed", final: true });
          return;
        }
        assert.equal(endpoint, firstEnv); assert.equal(token, firstToken);
        const ok = await (await post("tools/call", { name: "phonon_request_interaction", arguments: { requestId: "alive", form: { title: "Q", fields: [] } } })).json() as any;
        assert.notEqual(ok.result?.isError, true, JSON.stringify(ok));
        secondCalls++;
        options.emit({ type: "result", sessionId: SessionId.parse(params.sessionId), turnId: options.turnId, seq: 0,
          at: new Date().toISOString(), origin: "solicited", text: "replacement ok", status: "completed", final: true });
      },
    }),
  };
  registry.register(adapter);
  const engine = new SessionEngine(registry, event => events.push(event), undefined, store, {
    requestInteraction: async (directive: any) => ({ requestId: directive.requestId!, action: "cancel" as const }),
  }, "owner");
  scope.defer(() => engine.dispose());
  const session = await engine.create({
    tenantId: "owner", project: "owned-project", cwd: scope.root, agent: "mock:default", model: "m1", verbosity: "tools",
    workflowAttr: { workflowId: "wf", nodeId: "worker", devRunId: randomUUID() },
  });
  await engine.send("owner", session.sessionId, "first", {});
  await waitFor(() => firstEntered);
  await engine.send("owner", session.sessionId, "replacement", { whenBusy: "queue" });
  await engine.interrupt("owner", session.sessionId, "test", true);
  releaseFirst();
  await waitFor(() => events.some(event => event.status === "completed" && event.text === "replacement ok"));
  assert.equal(secondCalls, 1);
  await engine.terminate("owner", session.sessionId);
}));

test("terminate during pre-bridge await closes a late-created listener instead of leaving token residue", () => withPeerFixture("mcp-prebridge-terminate", async scope => {
  const store = new PhononStore(join(scope.root, "state.sqlite")); scope.defer(() => store.close());
  const registry = new AdapterRegistry(), events: any[] = [];
  let releaseInventory!: () => void;
  const inventoryHold = new Promise<void>(resolve => { releaseInventory = resolve; });
  let sendReached = false, observedEndpoint = "", observedToken = "";
  const adapter: AgentAdapter = {
    name: "mock",
    capabilities: { nativeSession: false, nativeCompression: false, contextInjection: false, proactiveOutput: false,
      modelSwitch: false, interrupt: false, injectMidTurn: false, skillManagement: false, hooks: [], streaming: true,
      workflowRoles: ["worker"], reasoningControl: true },
    discoverAgents: async () => [],
    createSession: async (params: CreateSessionParams) => ({
      sessionId: params.sessionId, model: params.model, terminate: async () => {},
      send: async (_input: string, options: SendOptions) => {
        sendReached = true;
        observedEndpoint = options.environment?.AGENT_PHONON_MCP_URL ?? "";
        observedToken = options.environment?.AGENT_PHONON_INTERACTION_TOKEN ?? "";
        options.emit({ type: "result", sessionId: SessionId.parse(params.sessionId), turnId: options.turnId, seq: 0,
          at: new Date().toISOString(), origin: "solicited", text: "should-not-keep-listener", status: "failed", final: true });
      },
    }),
  };
  registry.register(adapter);
  const previousList = registry.inventory.list.bind(registry.inventory);
  registry.inventory.list = (async () => {
    await inventoryHold;
    return [{ agentId: "mock:default", displayName: "mock", adapter: "mock", available: true, models: [{ id: "m1", available: true, reasoningLevels: ["low" as const] }], capabilities: adapter.capabilities, scannedAt: new Date().toISOString() }] as any;
  }) as typeof registry.inventory.list;
  scope.defer(() => { registry.inventory.list = previousList; });
  const engine = new SessionEngine(registry, event => events.push(event), undefined, store, {
    requestInteraction: async (directive: any) => ({ requestId: directive.requestId!, action: "cancel" as const }),
  }, "owner");
  scope.defer(() => engine.dispose());
  const session = await engine.create({
    tenantId: "owner", project: "owned-project", cwd: scope.root, agent: "mock:default", model: "m1", verbosity: "tools",
    workflowAttr: { workflowId: "wf", nodeId: "worker", nativeRunId: randomUUID() },
  });
  const pending = engine.send("owner", session.sessionId, "during-inventory", { reasoning: { level: "low" } });
  await wait(30);
  await engine.terminate("owner", session.sessionId);
  releaseInventory();
  await pending.catch(() => {});
  await wait(50);
  // Either send never reached with a live env, or any observed endpoint is dead.
  if (observedEndpoint) {
    await assert.rejects(fetch(observedEndpoint, {
      method: "POST",
      headers: { authorization: "Bearer " + observedToken, "content-type": "application/json" },
      body: "{}",
    }));
  }
  // Session record must not retain a live bridge after terminate.
  const snap = engine.snapshot("owner").find(row => row.sessionId === session.sessionId);
  assert.equal(snap?.status, "terminated");
  assert.equal((engine as any).sessions.get(session.sessionId)?.interactionBridge, undefined);
}));
