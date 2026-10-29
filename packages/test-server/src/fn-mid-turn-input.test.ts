import { test } from "node:test";
import assert from "node:assert/strict";
import { AdapterRegistry, SessionEngine } from "@agent-phonon/core";
import type { AgentAdapter, AdapterSession } from "@agent-phonon/core";
import { PhononDevice, PhononSession } from "@agent-phonon/server-sdk";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
async function setup(options: { capable?: boolean; implemented?: boolean } = {}) {
  const finish = deferred(), gap = deferred(), inserting = deferred();
  const inputs: string[] = [], inserted: string[] = [], turns: string[] = [];
  const adapter: AgentAdapter = {
    name: "input-test",
    capabilities: { nativeSession: true,nativeCompression: false,contextInjection: true,proactiveOutput: false,modelSwitch: false,interrupt: false,injectMidTurn: options.capable ?? false,skillManagement: false,hooks: [],streaming: true,workflowRoles: [] },
    async discoverAgents() { return []; },
    async createSession(params): Promise<AdapterSession> {
      return { sessionId: params.sessionId,model: params.model,
        async send(input, context) { inputs.push(input); turns.push(context.turnId); await finish.promise;
          context.emit({ type: "result",sessionId: params.sessionId as never,turnId: context.turnId,origin: "solicited",seq: 0,at: new Date().toISOString(),text: "done",status: "completed",final: true }); },
        ...(options.implemented ? { async insertAtToolGap(input: string, context: { turnId: string; signal: AbortSignal; beforeApply?: () => void }) {
          inserting.resolve(); await gap.promise;
          if (context.signal.aborted) throw new Error("tool gap closed");
          context.beforeApply?.();
          inserted.push(input);
        } } : {}),
        async terminate() {},
      };
    },
  };
  const registry = new AdapterRegistry(); registry.register(adapter);
  const engine = new SessionEngine(registry, () => {});
  const session = await engine.create({ tenantId: "tenant",project: "project",cwd: "/tmp",agent: "input-test:main",model: "model",verbosity: "tools" });
  await engine.send("tenant", session.sessionId, "initial", { turnId: "active" });
  return { engine, session, finish, gap, inserting, inputs, inserted, turns };
}

test("unsupported inject rejects instead of silently becoming a queued turn", async () => {
  const state = await setup();
  try {
    await assert.rejects(state.engine.send("tenant",state.session.sessionId,"extra",{ whenBusy: "inject" }), { appCode: "errCapabilityUnsupported" });
    await assert.rejects(state.engine.send("tenant",state.session.sessionId,"interrupt",{ whenBusy: "interrupt" }), { appCode: "errCapabilityUnsupported" });
    state.finish.resolve(); await new Promise((resolve) => setTimeout(resolve,10));
    assert.deepEqual(state.inputs,["initial"]);
  } finally { state.finish.resolve(); await state.engine.dispose(); }
});
test("an explicit supported fallback queues, but a false capability or missing adapter operation cannot claim insertion", async () => {
  const state = await setup({ capable: true });
  try {
    await assert.rejects(state.engine.send("tenant",state.session.sessionId,"not implemented",{ whenBusy: "inject" }), { appCode: "errCapabilityUnsupported" });
    const ack = await state.engine.send("tenant",state.session.sessionId,"explicit queue",{ whenBusy: "inject", fallback: "queue" });
    assert.equal(ack.disposition,"queued");
  } finally { state.finish.resolve(); await state.engine.dispose(); }
});
test("inject waits for a real tool gap and keeps the active turn without restart", async () => {
  const state = await setup({ capable: true,implemented: true });
  try {
    await assert.rejects(state.engine.send("tenant",state.session.sessionId,"wrong turn",{ whenBusy: "inject",turnId: "new-turn" }), { appCode: "errInvalidParams" });
    let acknowledged = false;
    const operation = state.engine.send("tenant",state.session.sessionId,"steering",{ whenBusy: "inject" }).then((reply) => { acknowledged = true; return reply; });
    await state.inserting.promise;
    assert.equal(acknowledged,false); assert.deepEqual(state.inputs,["initial"]);
    state.gap.resolve(); const ack = await operation;
    assert.deepEqual(ack,{ turnId: "active",disposition: "injected" });
    assert.deepEqual(state.inserted,["steering"]); assert.deepEqual(state.turns,["active"]);
  } finally { state.finish.resolve(); await state.engine.dispose(); }
});
test("a closed turn rejects a pending insertion and never carries it into the next turn", async () => {
  const state = await setup({ capable: true,implemented: true });
  try {
    const operation = state.engine.send("tenant",state.session.sessionId,"too late",{ whenBusy: "inject" });
    const rejected = assert.rejects(operation,{ appCode: "errSessionBusy" });
    await state.inserting.promise; state.finish.resolve(); await rejected;
    state.gap.resolve(); await new Promise((resolve) => setTimeout(resolve,10));
    assert.deepEqual(state.inputs,["initial"]); assert.deepEqual(state.inserted,[]);
  } finally { state.finish.resolve(); state.gap.resolve(); await state.engine.dispose(); }
});
test("an input waiting for its native tool gap revalidates the original source before application", async () => {
  const state = await setup({ capable: true, implemented: true });
  let allowed = true, reservations = 0;
  try {
    const operation = state.engine.send("tenant", state.session.sessionId, "revoked input", { whenBusy: "inject",
      beforeInsertion: () => { reservations++; },
      assertInsertion: () => { if (!allowed) throw new Error("original source revoked"); } });
    const rejected = assert.rejects(operation, /original source revoked/);
    await state.inserting.promise;
    allowed = false;
    state.gap.resolve();
    await rejected;
    assert.deepEqual(state.inputs, ["initial"]);
    assert.deepEqual(state.inserted, []);
    assert.equal(reservations, 1, "receipt reservation is separate from repeated source validation");
  } finally { state.finish.resolve(); state.gap.resolve(); await state.engine.dispose(); }
});
for(const field of ["sessionId","tenantId","project","worktreeId","cwd","agent"] as const)test(`a pending native insertion cannot adopt a changed original ${field}`,async()=>{
  const state=await setup({capable:true,implemented:true}),record=state.engine.assertTenant(state.session.sessionId,"tenant") as unknown as Record<string,unknown>,original=record[field];
  try{
    const operation=state.engine.send("tenant",state.session.sessionId,"scope-bound input",{whenBusy:"inject"}),rejected=assert.rejects(operation);
    await state.inserting.promise;record[field]="foreign-scope";state.gap.resolve();await rejected;
    assert.deepEqual(state.inputs,["initial"]);assert.deepEqual(state.inserted,[]);assert.deepEqual(state.turns,["active"]);
  }finally{record[field]=original;state.finish.resolve();state.gap.resolve();await state.engine.dispose();}
});
test("an insertion arriving after a turn ends cannot start another model invocation",async()=>{
  const state=await setup({capable:true,implemented:true});
  try{
    state.finish.resolve();await state.engine.settleTurn("tenant",state.session.sessionId,"active");
    await assert.rejects(state.engine.send("tenant",state.session.sessionId,"late bound",{whenBusy:"inject",turnId:"active"}),{appCode:"errSessionBusy"});
    await assert.rejects(state.engine.send("tenant",state.session.sessionId,"late unbound",{whenBusy:"inject"}),{appCode:"errSessionBusy"});
    assert.deepEqual(state.inputs,["initial"]);assert.deepEqual(state.inserted,[]);assert.deepEqual(state.turns,["active"]);
  }finally{state.gap.resolve();await state.engine.dispose();}
});

test("TypeScript SDK forwards explicit send modes and session configuration without inventing a fallback", async () => {
  const calls: Array<{ method: string; params: Record<string,unknown> }> = [];
  const device = new PhononDevice("device","tenant",{ async request(method: string, params: Record<string,unknown>) {
    calls.push({ method,params }); return method === "session.create" ? { sessionId: "created" } : { turnId: "active",disposition: "injected" };
  } } as never);
  const session = new PhononSession(device,"session");
  await session.send("steer",{ whenBusy: "inject",turnId: "active",clientRequestId: "one" });
  assert.deepEqual(calls[0],{ method: "session.send",params: { sessionId: "session",input: "steer",whenBusy: "inject",turnId: "active",clientRequestId: "one" } });
  await session.send("explicit",{ whenBusy: "inject",fallback: "queue" });
  assert.equal(calls[1]!.params.fallback,"queue");
  await device.createSession({ project: "project",agent: "agent",model: "model",clientTag: "native",agentConfig: { thinking: "high" },initialContext: [{ role: "system",content: "Review" }] });
  assert.deepEqual(calls[2]!.params.initialContext,[{ role: "system",content: "Review" }]);
  assert.deepEqual(calls[2]!.params.agentConfig,{ thinking: "high" });
  assert.equal(calls[2]!.params.clientTag,"native");
});
