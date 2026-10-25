import test from "node:test";
import assert from "node:assert/strict";
import { RpcPeer } from "@agent-phonon/core";
import { qualifyOpenClawTestGateway } from "./openclaw-policy-fixture.js";

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
  const adapter = new OpenClawGatewayAdapter({ gateway: { baseUrl: "ws://127.0.0.1:1", token: "unit-test" } });
  const calls: Array<{ method: string; params: any }> = [];
  const fake = {
    async connect() {},
    async rpc(method: string, params: any) { calls.push({ method, params }); return method === "sessions.compact" ? { ok: true, compacted: false, reason: "nothing to compact" } : {}; },
    async patchSessionModel() { throw new Error("native model rejected"); },
  };
  qualifyOpenClawTestGateway(fake,{cwd:"/tmp",model:"m1",agent:"main"});
  (adapter as any).gw = fake;
  const session = await adapter.createSession({ sessionId: "s-unit", agentId: "openclaw:main", model: "m1", cwd: "/tmp" });
  await session.inject!([{ role: "user", content: "INJECTED" }]);
  const events: any[] = [];
  const controller = new AbortController();
  const sending = session.send("input", { turnId: "t1", verbosity: "tools", emit: (e) => events.push(e), signal: controller.signal });
  await new Promise<void>(resolve=>setImmediate(resolve));
  try {
  const request = calls.find((c) => c.method === "chat.send")!;
  assert.match(request.params.message, /INJECTED/);
  const tool = (data: Record<string, unknown>) => (session as any).handleEvent("agent", {stream: "tool", runId: request.params.idempotencyKey, data: {name: "read", toolCallId: "tool-full", ...data}});
  tool({phase: "start", args: {path: "proof.txt"}});
  tool({phase: "result", result: {content: "verified bytes"}, isError: false});
  (session as any).handleEvent("agent", {stream: "item", runId: request.params.idempotencyKey, data: {kind: "tool", phase: "end", name: "read", toolCallId: "tool-full", status: "completed"}});
  for (const phase of ["start", "end", "end"]) (session as any).handleEvent("agent", { stream: "item", runId: request.params.idempotencyKey, data: { kind: "tool", phase, name: "read", toolCallId: "tool-1", status: phase === "start" ? "running" : "completed" } });
  assert.equal(events.filter((e) => e.type === "tool_call").length, 2);
  assert.equal(events.filter((e) => e.type === "tool_result").length, 2);
  assert.deepEqual(events.find(e => e.type === "tool_call" && e.toolCallId === "tool-full").args, {path: "proof.txt"});
  assert.deepEqual(events.find(e => e.type === "tool_result" && e.toolCallId === "tool-full").output, {content: "verified bytes"});
  } finally { controller.abort(); await sending; }
  assert.equal(events.at(-1).status, "interrupted");
  await assert.rejects(session.switchModel!("m2"), /native model rejected/);
  assert.equal(session.model, "m1");
  assert.equal((await session.compressNative!()).applied,false);
  await session.terminate();
});

test("Gateway cancellation during mandatory confirmation settles the original input without dispatch",async()=>{
  const {OpenClawGatewayAdapter}=await import("@agent-phonon/core");
  const adapter=new OpenClawGatewayAdapter({gateway:{baseUrl:"ws://127.0.0.1:1",token:"unit-test"}}),controller=new AbortController();
  const calls:string[]=[],events:any[]=[];
  const fake={async connect(){},async rpc(method:string){calls.push(method);return {};}};
  const policy=qualifyOpenClawTestGateway(fake,{cwd:"/tmp",model:"m1",agent:"main",onConfirm:count=>{if(count===2)controller.abort();}});
  (adapter as any).gw=fake;
  const session=await adapter.createSession({sessionId:"mandatory-cancel",agentId:"openclaw:main",model:"m1",cwd:"/tmp"});
  try{
    await session.send("original input",{turnId:"original",verbosity:"final",signal:controller.signal,emit:event=>events.push(event)});
    assert.equal(events.at(-1)?.status,"interrupted");assert.equal(calls.includes("chat.send"),false);
    assert.equal(calls.includes("chat.abort"),false);assert.equal(policy.activePolicies(),0);
  }finally{await session.terminate();adapter.close();}
});

test("Gateway final output waits for the original native run settlement before returning",async()=>{
  const {OpenClawGatewayAdapter}=await import("@agent-phonon/core");
  const adapter=new OpenClawGatewayAdapter({gateway:{baseUrl:"ws://127.0.0.1:1",token:"unit-test"}});
  let settle!:()=>void,entered!:()=>void,session:any,runId:string|undefined,returned=false;
  const settling=new Promise<void>(resolve=>{settle=resolve;}),waiting=new Promise<void>(resolve=>{entered=resolve;});
  const calls:string[]=[],events:any[]=[];
  const fake={async connect(){},async rpc(method:string,params:any){
    calls.push(method);
    if(method==="chat.send"){
      runId=params.idempotencyKey;
      queueMicrotask(()=>session.handleEvent("chat",{runId,state:"final",finalText:"Original final"}));
    }
    if(method==="agent.wait"){assert.equal(params.runId,runId);entered();await settling;return {status:"ok"};}
    return {};
  }};
  const policy=qualifyOpenClawTestGateway(fake,{cwd:"/tmp",model:"m1",agent:"main"});
  (adapter as any).gw=fake;
  session=await adapter.createSession({sessionId:"native-settle",agentId:"openclaw:main",model:"m1",cwd:"/tmp"});
  const sending=session.send("original input",{turnId:"original",verbosity:"final",emit:(event:any)=>events.push(event)}).then(()=>{returned=true;});
  try{
    await waiting;
    assert.equal(events.at(-1)?.text,"Original final");assert.equal(events.at(-1)?.status,"completed");
    assert.equal(returned,false);assert.equal(policy.activePolicies(),1);
    settle();await sending;
    assert.equal(returned,true);assert.equal(policy.activePolicies(),0);
    assert.equal(calls.filter(method=>method==="chat.send").length,1);
    assert.equal(calls.includes("chat.abort"),false);
  }finally{settle();await sending;await session.terminate();adapter.close();}
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
