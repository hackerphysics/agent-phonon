import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { AdapterRegistry, PhononStore } from "@agent-phonon/core";
import type { SendOptions } from "@agent-phonon/core";
import { MockAdapter, TestConn } from "./harness.js";
import { withPeerFixture } from "../../core/dist/testing/peer-fixture.js";

for (const sourceKind of ["native", "dev"] as const) test(`${sourceKind}: SessionEngine binds runtime-only peer checkpoints to the original execution`, () => withPeerFixture("peer-runtime", async scope => {
  const root = scope.root, store = new PhononStore(join(root, "state.db"));scope.defer(()=>store.close());
  const registry = new AdapterRegistry(), adapter = new MockAdapter(), create = adapter.createSession.bind(adapter);
  const self = { id: randomUUID(), position: "1", projectId: randomUUID(), ownerId: "owner", deviceId: randomUUID(), agentId: "mock:default",
    agentKind: "agent", sourceKind, sessionId: "unknown", label: "B", activity: { summary: "", phase: "working", impact: [], dependencies: "" },
    activityRevision: 0, lastSeenAt: null, presence: "active" };
  const message = { id: randomUUID(), position: "2", senderId: randomUUID(), recipientId: self.id, kind: "notice", text: "in-flight-" + randomUUID(),
    references: [], inReplyTo: null, depth: 0, createdAt: null, expiresAt: null, state: "stored", receivedAt: null };
  let pending = false, retained: SendOptions["peerContext"], checkpointUrl = "", prepared = 0;
  const calls: any[] = [], boundaries: string[] = [];
  adapter.createSession = async params => {
    const session = await create(params);
    let ready = false;
    session.preparePeerContext = async (_environment,signal) => { assert.equal(signal?.aborted,false);prepared++;ready=true; };
    session.peerContextCapability = () => ready ? ({ mode: "context_hook", boundary: "before_model", visibility: "hidden", evidence: "provider_payload", nativeSessionId: "bound-native" }) : undefined;
    session.send = async (input, options) => {
      assert.equal(input.includes(message.text), false);
      assert.match(input, /runtime_checkpoint/);
      assert.equal(input.includes("Check inbox before shared changes"), false);
      retained = options.peerContext; assert.ok(retained);
      const modelInbox=await (options.projectCoordination as any)({operation:"inbox"},true);
      assert.equal(modelInbox.deliveryOffers,undefined,"extra model callback arguments cannot select internal runtime mode");
      checkpointUrl = options.environment!.AGENT_PHONON_PEER_CONTEXT_URL!;
      const boundary = () => { const boundaryId = randomUUID(); boundaries.push(boundaryId); return { boundaryId, nativeSessionId: "bound-native" }; };
      assert.equal((await retained.prepare(boundary())).messages.length, 0);
      // A remote participant publishes while this same native execution is running.
      pending = true;
      const headers = { authorization: "Bearer " + options.environment!.AGENT_PHONON_PEER_CONTEXT_TOKEN, "content-type": "application/json" };
      const request = boundary();
      const response = await fetch(checkpointUrl, { method: "POST", headers, body: JSON.stringify(request) });
      assert.equal(response.status, 200);
      const batch = await response.json() as any;
      assert.equal(batch.messages.length, 1); assert.ok(batch.messages[0].content.includes(message.text));
      retained.observe({ ...request, messageIds: [message.id], evidence: "provider_payload" });
      options.emit({ type: "result", sessionId: params.sessionId, turnId: options.turnId, seq: 0, at: new Date().toISOString(), text: "Task done", status: "completed", final: true } as never);
    };
    return session;
  };
  registry.register(adapter);
  const tc = new TestConn({ registry, store, workspaceRoot: root, tenantId: "owner",archiveAuthority:"https://runtime.fixture" });
  scope.defer(()=>tc.conn.dispose());
  tc.setRequestResponder("project.coordination", raw => {
    const request = raw as any; calls.push(request); self.sessionId = request.sessionId;
    return request.action.operation === "peers" ? { self, participants: [], next: null }
      : { self, messages: pending ? [message] : [], next: null,...(request.receive?{receiveReporting:1,evidenceVersion:1}:{}),
        ...(request.evidenceVersion&&pending?{deliveryOffers:[{messageId:message.id,deliveryId:message.id}]}:{}) };
  });
  const reports:any[]=[];
  tc.setRequestResponder("project.coordination.evidence",raw=>{const input=raw as any;reports.push(input);return {version:1,receipts:input.reports.map((report:any)=>({deliveryId:report.deliveryId,status:"recorded",state:report.state}))};});
  try {
    const project = (await tc.call("project.create", { name: "peer-runtime", git: false }) as any).project.projectId;
    const runId = randomUUID();
    const run = await tc.call("workflow.run", { project, metadata: sourceKind === "native" ? { native_chat: true, native_run_id: runId } : { dev_chat: true, dev_run_id: runId },
      plan: { mode: "dag", nodes: [{ nodeId: "reply", agent: "mock:default", model: "m1", input: "Complete the assigned task" }], finalNodeId: "reply" } }) as any;
    let terminal: any;
    for (let i = 0; i < 200; i++) {
      const state = await tc.call("workflow.status", { workflowId: run.workflowId }) as any;
      if (["completed", "failed"].includes(state.status)) { terminal = state; break; }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(terminal?.status, "completed", JSON.stringify(terminal));
    assert.equal(prepared,1,"readiness must be assessed before choosing runtime rather than polling bootstrap");
    assert.deepEqual(calls.map(call => call.action.operation), ["presence", "peers", "inbox", "inbox", "inbox"]);
    assert.equal(calls[2].evidenceVersion,undefined);
    assert.ok(calls.every(call => call.sourceKind === sourceKind && call.runId === runId && call.workflowId === run.workflowId));
    assert.equal(new Set(calls.map(call => call.turnId)).size, 1);
    assert.equal(store.peerContextJournal().records("owner", self.sessionId)[0]?.state, "provider_payload");
    for(let n=0;n<100&&!reports.some(call=>call.reports.some((report:any)=>report.state==="provider_payload"));n++)await new Promise(resolve=>setTimeout(resolve,10));
    assert.ok(reports.some(call=>call.reports.some((report:any)=>report.state==="provider_payload")));
    assert.equal(JSON.stringify(reports).includes("bound-native"),false);
    await assert.rejects(retained!.prepare({ boundaryId: randomUUID(), nativeSessionId: "bound-native" }));
    assert.equal(JSON.stringify(tc.streamEvents).includes(message.text), false);
    await assert.rejects(fetch(checkpointUrl, { method: "POST", body: "{}" }));
  } finally { await tc.conn.dispose(); }
}));

test("optional peer readiness failure retains the assigned turn and its tool-polling fallback",()=>withPeerFixture("peer-readiness",async scope=>{
  const store=new PhononStore(join(scope.root,"state.db"));scope.defer(()=>store.close());
  const registry=new AdapterRegistry(),adapter=new MockAdapter(),create=adapter.createSession.bind(adapter);
  let sends=0,prepares=0;
  adapter.createSession=async params=>{
    const session=await create(params);
    session.preparePeerContext=async()=>{prepares++;throw new Error("Optional native hooks unavailable");};
    session.peerContextCapability=()=>undefined;
    session.send=async(input,options)=>{
      sends++;assert.match(input,/tool_polling/);assert.match(input,/Check inbox before shared changes/);assert.equal(options.peerContext,undefined);
      options.emit({type:"result",sessionId:params.sessionId,turnId:options.turnId,seq:0,at:new Date().toISOString(),text:"Assigned task completed",status:"completed",final:true} as never);
    };
    return session;
  };
  registry.register(adapter);const tc=new TestConn({registry,store,workspaceRoot:scope.root,tenantId:"owner"});scope.defer(()=>tc.conn.dispose());
  const self={id:randomUUID(),position:"1",projectId:randomUUID(),ownerId:"owner",deviceId:randomUUID(),agentId:"mock:default",agentKind:"agent",sourceKind:"native",sessionId:"unknown",label:"fallback",
    activity:{summary:"",phase:"working",impact:[],dependencies:""},activityRevision:0,lastSeenAt:null,presence:"active"};
  tc.setRequestResponder("project.coordination",raw=>{const request=raw as any;self.sessionId=request.sessionId;return request.action.operation==="peers"?{self,participants:[],next:null}:{self,messages:[],next:null};});
  const project=(await tc.call("project.create",{name:"peer-fallback",git:false})as any).project.projectId;
  const run=await tc.call("workflow.run",{project,metadata:{native_chat:true,native_run_id:randomUUID()},plan:{mode:"dag",nodes:[{nodeId:"reply",agent:"mock:default",model:"m1",input:"Complete assigned work"}],finalNodeId:"reply"}})as any;
  let state:any;
  for(let n=0;n<200;n++){state=await tc.call("workflow.status",{workflowId:run.workflowId});if(["completed","failed"].includes(state.status))break;await new Promise(resolve=>setTimeout(resolve,10));}
  assert.equal(state?.status,"completed",JSON.stringify(state));assert.equal(sends,1);assert.equal(prepares,1);
  assert.equal(tc.streamEvents.some(event=>event.type==="error"),false);
}));

for (const [admitted,budgeted,bridgeUnavailable] of [[false,false,false],[true,false,false],[false,true,false],[true,true,false],[false,true,true]]) test(`pending native admission ${admitted ? "can become ready" : "retains fallback"} with ${budgeted?"native budget":"legacy bootstrap"}${bridgeUnavailable?" and unavailable bridge":""}`, () => withPeerFixture("peer-admission", async scope => {
  const store = new PhononStore(join(scope.root, "state.db")); scope.defer(() => store.close());
  if(bridgeUnavailable)store.peerContextJournal=()=>{throw new Error("Synthetic unavailable peer journal");};
  const registry = new AdapterRegistry(), adapter = new MockAdapter(), create = adapter.createSession.bind(adapter);
  const self = { id: randomUUID(), position: "1", projectId: randomUUID(), ownerId: "owner", deviceId: randomUUID(), agentId: "mock:default",
    agentKind: "agent", sourceKind: "native", sessionId: "unknown", label: "pending", activity: { summary: "", phase: "working", impact: [], dependencies: "" },
    activityRevision: 0, lastSeenAt: null, presence: "active" };
  const mail = (position: string) => ({ id: randomUUID(), position, senderId: randomUUID(), recipientId: self.id, kind: "notice", text: "pending-" + randomUUID(),
    references: [], inReplyTo: null, depth: 0, createdAt: null, expiresAt: null, state: "stored", receivedAt: null });
  const initial = mail("2"), next = mail("3"), calls: any[] = [];
  let ready = false, newMail = false, sends = 0;
  adapter.createSession = async params => {
    const session = await create(params);
    session.preparePeerContext = async () => {};
    session.peerContextCapability = () => ({ mode: "context_hook", boundary: "after_tools", visibility: "collapsed", evidence: "context_hook",
      ...(budgeted?{budget:"native_estimate" as const}:{}),
      readiness: ready ? "ready" : "pending", ...(ready ? { nativeSessionId: "admitted-native" } : {}) });
    session.send = async (input, options) => {
      sends++; assert.match(input, bridgeUnavailable?/tool_polling/:/runtime_pending/); assert.match(input, /Check inbox before shared changes/);
      assert.equal(input.includes(initial.text),!budgeted);
      if(bridgeUnavailable){assert.equal(options.peerContext,undefined);options.emit({type:"result",sessionId:params.sessionId,turnId:options.turnId,seq:0,at:new Date().toISOString(),text:"Original work complete",status:"completed",final:true} as never);return;}
      assert.ok(options.peerContext);
      if(budgeted)assert.match(input,/waits for a known native context budget/);
      const boundary = () => ({ boundaryId: randomUUID(), nativeSessionId: "admitted-native" });
      await assert.rejects(options.peerContext.prepare(boundary()), /not active/);
      if (admitted) {
        ready = true;
        assert.deepEqual((await options.peerContext.prepare(boundary())).messages, []);
        newMail = true;
        const batch = await options.peerContext.prepare({...boundary(),...(budgeted?{budget:{state:"known" as const,source:"native_estimate" as const,
          contextWindowTokens:128000,inputTokens:1000,outputTokens:2000,overheadTokens:1000}}:{})});
        assert.deepEqual(batch.messages.map(message => message.messageId), budgeted?[initial.id,next.id]:[next.id]);
        options.peerContext.observe({ boundaryId: batch.boundaryId, nativeSessionId: batch.nativeSessionId, messageIds: batch.messages.map(message=>message.messageId), evidence: "context_hook" });
      }
      options.emit({ type: "result", sessionId: params.sessionId, turnId: options.turnId, seq: 0, at: new Date().toISOString(), text: "Original work complete", status: "completed", final: true } as never);
    };
    return session;
  };
  registry.register(adapter); const tc = new TestConn({ registry, store, workspaceRoot: scope.root, tenantId: "owner" }); scope.defer(() => tc.conn.dispose());
  tc.setRequestResponder("project.coordination", raw => {
    const request = raw as any; calls.push(request); self.sessionId = request.sessionId;
    return request.action.operation === "peers" ? { self, participants: [], next: null }
      : { self, messages: newMail ? [initial, next] : [initial], next: null, ...(request.receive ? {receiveReporting:1} : {}) };
  });
  const project = (await tc.call("project.create", { name: "peer-admission", git: false }) as any).project.projectId;
  const run = await tc.call("workflow.run", { project, metadata: { native_chat: true, native_run_id: randomUUID() }, plan: { mode: "dag",
    nodes: [{ nodeId: "reply", agent: "mock:default", model: "m1", input: "Complete assigned work" }], finalNodeId: "reply" } }) as any;
  let state: any;
  for (let n = 0; n < 200; n++) { state = await tc.call("workflow.status", { workflowId: run.workflowId }); if (["completed", "failed"].includes(state.status)) break; await new Promise(resolve => setTimeout(resolve, 10)); }
  assert.equal(state?.status, "completed", JSON.stringify(state)); assert.equal(sends, 1);
  assert.deepEqual(calls.map(call=>call.action.operation), admitted ? (budgeted?["presence","peers","inbox","inbox"]:["presence", "peers", "inbox", "inbox", "inbox"]) : budgeted?["presence","peers"]:["presence", "peers", "inbox"]);
  assert.equal(calls[0].receive.mode,bridgeUnavailable?"tool_polling":"runtime_pending");
  assert.ok(calls.every(call=>call.receive));
  assert.equal(calls.at(-1).receive.mode,bridgeUnavailable?"tool_polling":admitted?"runtime_checkpoint":"runtime_pending");
  if(!bridgeUnavailable)assert.deepEqual(store.peerContextJournal().records("owner", self.sessionId).map(record => ({ id: record.messageId, state: record.state })),
    admitted ? [...(budgeted?[{id:initial.id,state:"context_hook"}]:[]),{ id: next.id, state: "context_hook" }] : []);
  assert.equal(JSON.stringify(tc.streamEvents).includes(initial.text), false);
  assert.equal(JSON.stringify(tc.streamEvents).includes(next.text), false);
}));
