import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync,readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AdapterRegistry,PhononStore,HermesAdapter,OpenClawGatewayAdapter,CodexAdapter } from "@agent-phonon/core";
import type { SendOptions } from "@agent-phonon/core";
import { PhononDevice,PhononSession } from "@agent-phonon/server-sdk";
import { MockAdapter,TestConn } from "./harness.js";
import {PeerFixture} from "../../core/dist/testing/peer-fixture.js";

async function setup(send?: (input:string,opts:SendOptions)=>Promise<void>,reasoningControl=true){
  const scope=new PeerFixture("turn-reasoning"),root=scope.root,store=new PhononStore(join(root,"state.db")),registry=new AdapterRegistry();
  const adapter=new MockAdapter({caps:{reasoningControl},reasoningLevels:["low","standard","high"],sendDelayMs:30});
  if(send){const create=adapter.createSession.bind(adapter);adapter.createSession=async params=>{const session=await create(params);session.send=send;return session;};}
  registry.register(adapter);const tc=new TestConn({registry,store,workspaceRoot:root,tenantId:"owner"});
  const project=(await tc.call("project.create",{name:"reasoning",git:false}) as any).project.projectId;
  const session=(await tc.call("session.create",{project,agent:"mock:default",model:"m1"}) as any).sessionId;
  return {root,store,registry,adapter,tc,project,session,close:async()=>{try{await tc.conn.dispose();}finally{try{store.close();}finally{await scope.dispose();}}}};
}

test("per-turn reasoning preserves queued choices and explicit default, emitting controller-owned proof at final verbosity",async()=>{
  const state=await setup();
  try{
    for(const [turn,level] of [["first","high"],["second","standard"],["third",null]] as const){
      await state.tc.call("session.send",{sessionId:state.session,input:turn,turnId:turn,verbosity:"final",reasoning:{level}});
    }
    await state.tc.waitTurnEnd("third");
    const proof=state.tc.streamEvents.filter(event=>event.type==="runtime_settings");
    assert.deepEqual(proof.map(event=>[event.turnId,(event.reasoning as any).requestedLevel,(event.reasoning as any).nativeValue]),[["first","high","high"],["second","standard","medium"],["third",null,null]]);
    assert.ok(proof.every(event=>event.sessionId===state.session&&event.agent==="mock:default"&&event.model==="m1"));
    const unsupported=await state.tc.call("session.send",{sessionId:state.session,input:"unsupported",turnId:"bad",reasoning:{level:"xhigh"}});
    assert.equal((await state.tc.waitTurnEnd("bad")).status,"completed");
    assert.equal(state.tc.streamEvents.filter(event=>event.type==="runtime_settings"&&event.turnId==="bad").length,0);
    assert.ok(unsupported);
  }finally{await state.close();}
});

test("unconfirmed settings do not falsify task outcome and forged or late setting proofs stay rejected",async()=>{
  let retained:SendOptions["acknowledgeReasoning"];
  const state=await setup(async(_input,opts)=>{
    retained=opts.acknowledgeReasoning;
    opts.emit({type:"runtime_settings",sessionId:"forged",turnId:opts.turnId,seq:0,at:new Date().toISOString(),agent:"mock:default",model:"m1",reasoning:{requestedLevel:"high",nativeValue:"high",effectiveLevel:"high"}} as never);
    opts.emit({type:"result",sessionId:"forged",turnId:opts.turnId,seq:0,at:new Date().toISOString(),text:"not proof",status:"completed",final:true} as never);
  });
  try{
    const ack=await state.tc.call("session.send",{sessionId:state.session,input:"never confirmed",reasoning:{level:"high"}}) as any;
    assert.equal((await state.tc.waitTurnEnd(ack.turnId)).status,"completed");
    assert.equal(state.tc.streamEvents.filter(event=>event.type==="runtime_settings").length,0);
    assert.throws(()=>retained!("high"));
  }finally{await state.close();}
});

test("an unnegotiated optional setting never prevents the original adapter send",async()=>{
  const seen:Array<{input:string;reasoning:unknown}>=[];
  const state=await setup(async(input,opts)=>{seen.push({input,reasoning:opts.reasoning});opts.emit({type:"result",sessionId:"ignored",turnId:opts.turnId,seq:0,at:new Date().toISOString(),text:"actual result",status:"completed",final:true} as never);},false);
  try{
    const result=await state.tc.call("session.send",{sessionId:state.session,input:"original message",reasoning:{level:"max"}}) as any;
    assert.equal((await state.tc.waitTurnEnd(result.turnId)).status,"completed");
    assert.deepEqual(seen,[{input:"original message",reasoning:undefined}]);
    assert.equal(state.tc.streamEvents.filter(event=>event.type==="runtime_settings").length,0);
  }finally{await state.close();}
});

test("fallback after optional inventory failure cannot bypass a changed agent policy",async()=>{
  let release!:()=>void,entered!:()=>void,sends=0;
  const waiting=new Promise<void>(resolve=>{release=resolve;}),started=new Promise<void>(resolve=>{entered=resolve;});
  const state=await setup(async()=>{sends++;});
  try{
    state.registry.inventory.list=async()=>{entered();await waiting;throw Error("catalog unavailable");};
    const response=await state.tc.call("session.send",{sessionId:state.session,input:"do not execute after permission withdrawal",reasoning:{level:"high"}}) as any;
    await started;(state.tc.conn as any).policy.policy.allowedAgents=["mock:other"];release();
    assert.equal((await state.tc.waitTurnEnd(response.turnId)).appCode,"errPolicyDenied");assert.equal(sends,0);
  }finally{release();await state.close();}
});

test("a setting preference does not reject insertion or change the active turn's setting",async()=>{
  let release!:()=>void,entered!:()=>void;
  const waiting=new Promise<void>(resolve=>{release=resolve;}),started=new Promise<void>(resolve=>{entered=resolve;}),inserted:string[]=[];
  const state=await setup(async(_input,opts)=>{opts.acknowledgeReasoning?.("high");entered();await waiting;opts.emit({type:"result",sessionId:"ignored",turnId:opts.turnId,seq:0,at:new Date().toISOString(),text:"actual result",status:"completed",final:true} as never);});
  try{
    (state.adapter.capabilities as any).injectMidTurn=true;
    (state.adapter.lastSession as any).insertAtToolGap=async(input:string)=>{inserted.push(input);};
    const running=await state.tc.call("session.send",{sessionId:state.session,input:"held",reasoning:{level:"high"}}) as any;await started;
    const result=await state.tc.call("session.send",{sessionId:state.session,input:"original insertion",whenBusy:"inject",turnId:running.turnId,reasoning:{level:"max"}}) as any;
    assert.equal(result.disposition,"injected");assert.deepEqual(inserted,["original insertion"]);
    const proof=state.tc.streamEvents.filter(event=>event.type==="runtime_settings");assert.equal(proof.length,1);assert.equal((proof[0]!.reasoning as any).requestedLevel,"high");
    await assert.rejects(state.tc.call("session.send",{sessionId:state.session,input:"wrong turn",whenBusy:"inject",turnId:"other",reasoning:{level:"max"}}));
    assert.equal(inserted.length,1);release();await state.tc.waitTurnEnd(running.turnId);
  }finally{release();await state.close();}
});

test("optional inventory failure falls back without editing input or claiming the requested level",async()=>{
  const seen:Array<{input:string;reasoning:unknown}>=[];
  const state=await setup(async(input,opts)=>{seen.push({input,reasoning:opts.reasoning});opts.acknowledgeReasoning?.("low");opts.emit({type:"result",sessionId:"ignored",turnId:opts.turnId,seq:0,at:new Date().toISOString(),text:"actual result",status:"completed",final:true} as never);});
  try{
    state.registry.inventory.list=async()=>{throw Error("catalog unavailable");};
    const result=await state.tc.call("session.send",{sessionId:state.session,input:"original message",reasoning:{level:"high"}}) as any;
    assert.equal((await state.tc.waitTurnEnd(result.turnId)).status,"completed");
    assert.deepEqual(seen,[{input:"original message",reasoning:{level:null}}]);
    assert.equal(state.tc.streamEvents.filter(event=>event.type==="runtime_settings").length,0);
  }finally{await state.close();}
});

test("bad or duplicate optional acknowledgements cannot invent proof or replace a real failure",async()=>{
  let count=0;
  const state=await setup(async(_input,opts)=>{
    count++;opts.acknowledgeReasoning?.("low");opts.acknowledgeReasoning?.("not-a-native-level");
    if(count===1){opts.acknowledgeReasoning?.("high");opts.acknowledgeReasoning?.("high");}
    opts.emit({type:count===1?"result":"error",sessionId:"ignored",turnId:opts.turnId,seq:0,at:new Date().toISOString(),text:"actual result",message:"actual executor error",status:count===1?"completed":"failed",final:true} as never);
  });
  try{
    for(const status of ["completed","failed"]){const response=await state.tc.call("session.send",{sessionId:state.session,input:status,reasoning:{level:"high"}}) as any;assert.equal((await state.tc.waitTurnEnd(response.turnId)).status,status);}
    const proofs=state.tc.streamEvents.filter(event=>event.type==="runtime_settings");
    assert.equal(proofs.length,1);assert.equal((proofs[0]!.reasoning as any).nativeValue,"high");assert.equal(count,2);
  }finally{await state.close();}
});

test("native workflow nodes preserve reasoning with retained Sessions and do not leak it to another Session",async()=>{
  const state=await setup();
  try{
    const run=await state.tc.call("workflow.run",{project:state.project,plan:{mode:"dag",nodes:[{nodeId:"reply",agent:"mock:default",model:"m1",sessionId:state.session,reasoning:{level:"standard"}}]},metadata:{native_chat:true,native_run_id:"6a46662b-d574-4411-9d99-235f5e566a90"}}) as any;
    for(let i=0;i<100;i++){const status=await state.tc.call("workflow.status",{workflowId:run.workflowId}) as any;if(status.status==="completed")break;await new Promise(resolve=>setTimeout(resolve,10));}
    const proof=state.tc.streamEvents.find(event=>event.type==="runtime_settings") as any;
    assert.equal(proof.sessionId,state.session);assert.equal(proof.reasoning.effectiveLevel,"standard");assert.equal(proof.nativeRunId,"6a46662b-d574-4411-9d99-235f5e566a90");
    const second=(await state.tc.call("session.create",{project:state.project,agent:"mock:default",model:"m1"}) as any).sessionId;
    const plain=await state.tc.call("session.send",{sessionId:second,input:"no override"}) as any;await state.tc.waitTurnEnd(plain.turnId);
    assert.equal(state.tc.streamEvents.filter(event=>event.type==="runtime_settings"&&event.sessionId===second).length,0);
  }finally{await state.close();}
});

test("TypeScript SDK forwards native reasoning and explicit default without agentConfig or prompt rewriting",async()=>{
  const calls:any[]=[];const device=new PhononDevice("device","owner",{request:async(method:string,params:unknown)=>{calls.push({method,params});return {};}} as never),session=new PhononSession(device,"session");
  await session.send("task",{reasoning:{level:"high"}});await session.send("reset",{reasoning:{level:null}});await session.send("maximum",{reasoning:{level:"max"}});
  assert.deepEqual(calls.map(call=>call.params),[{sessionId:"session",input:"task",reasoning:{level:"high"}},{sessionId:"session",input:"reset",reasoning:{level:null}},{sessionId:"session",input:"maximum",reasoning:{level:"max"}}]);
});

test("Codex keeps actual completion when fresh setting evidence is absent or mismatched",async()=>{
  const scope=new PeerFixture("codex-effort-turns"),root=scope.root,home=process.env.HOME;
  process.env.HOME=root;
  try{
    const bin=join(root,"codex");
    writeFileSync(bin,`#!${process.execPath}\nconst fs=require('node:fs'),p=require('node:path');const dir=p.join(process.env.HOME,'.codex','sessions');fs.mkdirSync(dir,{recursive:true});const args=process.argv.slice(2),input=fs.readFileSync(0,'utf8');fs.appendFileSync(p.join(process.env.HOME,'args.jsonl'),JSON.stringify(args)+'\\n');if(input!=='missing')fs.appendFileSync(p.join(dir,'rollout-thread.jsonl'),JSON.stringify({type:'turn_context',timestamp:new Date().toISOString(),payload:{model:'model',effort:input==='wrong'?'low':args.includes('model_reasoning_effort=medium')?'medium':'high'}})+'\\n');for(const e of [{type:'thread.started',thread_id:'thread'},{type:'item.completed',item:{type:'agent_message',text:'native result'}},{type:'turn.completed'}])console.log(JSON.stringify(e));\n`,{mode:0o700});
    const session=await new CodexAdapter({env:{binPath:bin,defaultModel:"model"}}).createSession({sessionId:"test",agentId:"codex",model:"model",cwd:root});
    for(const [input,level,expected] of [["first","standard","medium"],["default",null,"high"],["missing","high",undefined],["wrong","high",undefined]] as const){
      const values:any[]=[],events:any[]=[];
      await session.send(input,{turnId:input,verbosity:"final",reasoning:{level},acknowledgeReasoning:value=>{if(level&&value!==(level==="standard"?"medium":level))throw Error("mismatch");values.push(value);},emit:event=>events.push(event)});
      assert.deepEqual(values,expected===undefined?[]:[expected]);assert.equal(events.at(-1).status,"completed");
    }
    const args=readFileSync(join(root,"args.jsonl"),"utf8").trim().split("\n").map(line=>JSON.parse(line));
    assert.ok(args[0].includes("model_reasoning_effort=medium"));assert.ok(!args[1].some((arg:string)=>arg.startsWith("model_reasoning_effort=")));assert.ok(args[1].includes("resume"));
    await session.terminate();
  }finally{if(home===undefined)delete process.env.HOME;else process.env.HOME=home;await scope.dispose();}
});

test("Hermes attempts native work even when its optional effort is clamped",async()=>{
  const scope=new PeerFixture("hermes-effort-turns"),root=scope.root;
  try{
    mkdirSync(join(root,"hermes_cli"));writeFileSync(join(root,"hermes"),"#!/usr/bin/python3\n");writeFileSync(join(root,"hermes_cli","__init__.py"),"");writeFileSync(join(root,"hermes_cli","config.py"),"def load_config(): return {}\n");
    writeFileSync(join(root,"hermes_cli","main.py"),"def main():\n import sys\n from run_agent import AIAgent\n a=AIAgent()\n a.reasoning_config={'effort':sys.argv[sys.argv.index('--reasoning')+1] if '--reasoning' in sys.argv else 'low'}\n if 'mismatch' in sys.argv: a.reasoning_config={'effort':'low'}\n a.run_conversation()\n");
    writeFileSync(join(root,"run_agent.py"),"class AIAgent:\n def run_conversation(self,*a,**kw): return {'completed':True,'final_response':'native ran','messages':[]}\n");
    const session=await new HermesAdapter({env:{binPath:join(root,"hermes")}}).createSession({sessionId:"test",agentId:"hermes:base",model:"model",cwd:root});
    for(const [input,level,expected] of [["override","standard","medium"],["default",null,"low"],["mismatch","high","low"]] as const){
      const values:any[]=[],events:any[]=[];
      await session.send(input,{turnId:input,verbosity:"final",reasoning:{level},acknowledgeReasoning:value=>values.push(value),emit:event=>events.push(event)});
      assert.deepEqual(values,[expected]);assert.equal(events.at(-1).status,"completed");
    }
    await session.terminate();
  }finally{await scope.dispose();}
});

test("OpenClaw attempts the original chat even when its optional settings patch is unconfirmed",async()=>{
  const adapter=new OpenClawGatewayAdapter({gateway:{baseUrl:"ws://127.0.0.1:1",token:"fixture"}}),gw=(adapter as any).gw;
  const calls:any[]=[],values:any[]=[];let unconfirmed=0;
  gw.connect=async()=>{};gw.rpc=async(method:string,params:any)=>{
    calls.push({method,params});
    if(method==="sessions.patch"){if(unconfirmed===2)throw Error("settings unavailable");return unconfirmed?{}:{entry:params.thinkingLevel===null?{}:{thinkingLevel:params.thinkingLevel}};}
    if(method==="chat.send"){if(params.message==="actual native failure")throw Error("native send failed");queueMicrotask(()=>((adapter as any).sessions.get(params.sessionKey)).handleEvent("chat",{sessionKey:params.sessionKey,runId:params.idempotencyKey,state:"final",finalText:"native final"}));}
    return {};
  };
  const session=await adapter.createSession({sessionId:"test",agentId:"openclaw:base",model:"model",cwd:tmpdir()});
  try{
    await session.send("task",{turnId:"first",verbosity:"final",reasoning:{level:"high"},acknowledgeReasoning:value=>values.push(value),emit:()=>{}});
    await session.send("clear",{turnId:"second",verbosity:"final",reasoning:{level:null},acknowledgeReasoning:value=>values.push(value),emit:()=>{}});
    assert.deepEqual(values,["high",null]);assert.deepEqual(calls.filter(call=>call.method==="sessions.patch").map(call=>call.params.thinkingLevel),["high",null]);
    unconfirmed=1;await session.send("original message",{turnId:"third",verbosity:"final",reasoning:{level:"low"},emit:()=>{}});
    const sent=calls.filter(call=>call.method==="chat.send");assert.equal(sent.length,3);assert.equal(sent[2].params.message,"original message");assert.equal("thinking" in sent[2].params,false);
    unconfirmed=2;await session.send("send despite settings outage",{turnId:"fourth",verbosity:"final",reasoning:{level:"low"},emit:()=>{}});
    const events:any[]=[];await session.send("actual native failure",{turnId:"fifth",verbosity:"final",reasoning:{level:"low"},emit:event=>events.push(event)});
    assert.equal(events.at(-1).status,"failed");assert.equal(calls.filter(call=>call.method==="chat.send").length,5);assert.deepEqual(values,["high",null]);
  }finally{adapter.close();}
});

test("cancelling during optional OpenClaw settings does not send or abort another chat",async()=>{
  const adapter=new OpenClawGatewayAdapter({gateway:{baseUrl:"ws://127.0.0.1:1",token:"fixture"}}),gw=(adapter as any).gw;
  let entered!:()=>void,release!:(value:unknown)=>void;const started=new Promise<void>(resolve=>{entered=resolve;}),patch=new Promise(resolve=>{release=resolve;});
  const calls:string[]=[],events:any[]=[],values:any[]=[],controller=new AbortController();
  gw.connect=async()=>{};gw.rpc=async(method:string)=>{calls.push(method);if(method==="sessions.patch"){entered();return patch;}return {};};
  const session=await adapter.createSession({sessionId:"test",agentId:"openclaw:base",model:"model",cwd:tmpdir()});
  const sending=session.send("cancel before chat",{turnId:"original",verbosity:"final",reasoning:{level:"high"},signal:controller.signal,acknowledgeReasoning:value=>values.push(value),emit:event=>events.push(event)});
  try{await started;controller.abort();release({entry:{thinkingLevel:"high"}});await sending;assert.equal(events.at(-1)?.status,"interrupted");assert.deepEqual(values,[]);assert.equal(calls.includes("chat.send"),false);assert.equal(calls.includes("chat.abort"),false);}
  finally{controller.abort();release({});await sending;adapter.close();}
});

test("OpenClaw reasoning discovery is agent-scoped and does not invent levels from a reasoning boolean",async()=>{
  const adapter=new OpenClawGatewayAdapter({gateway:{baseUrl:"ws://127.0.0.1:1",token:"fixture"}}),gw=(adapter as any).gw;
  gw.connect=async()=>{};gw.isConnected=()=>true;gw.rpc=async(method:string,params:any)=>method==="agents.list"?{agents:[{id:"one"},{id:"two"}]}:
    {models:params.agentId==="one"?[{id:"model",provider:"native",available:true,thinkingLevels:[{id:"low"},{id:"medium"},{id:"high"},{id:"max"}]}]:[{id:"other",provider:"native",available:true,reasoning:true}]};
  try{
    const rows=await adapter.discoverAgents();
    assert.equal(rows.length,2);
    assert.deepEqual(rows[0]!.models[0]!.reasoningLevels,["low","standard","high","max"]);
    assert.equal(rows[1]!.models[0]!.reasoningLevels,undefined);
    assert.equal(rows[1]!.models[0]!.id,"native/other");
  }finally{adapter.close();}
});

test("Codex native model-cache metadata does not authorize a different configured provider",async()=>{
  const scope=new PeerFixture("codex-effort-cache"),root=scope.root,home=process.env.HOME;
  process.env.HOME=root;
  try{
    mkdirSync(join(root,".codex"));const bin=join(root,"codex");
    writeFileSync(bin,`#!${process.execPath}\nif(process.argv[2]!=='--version')process.exit(1);console.log('codex test');\n`,{mode:0o700});
    writeFileSync(join(root,".codex","models_cache.json"),JSON.stringify({models:[{slug:"model",supported_reasoning_levels:[{effort:"low"},{effort:"medium"},{effort:"high"}]}]}));
    const adapter=new CodexAdapter({env:{binPath:bin,defaultModel:"model"}});
    assert.deepEqual((await adapter.discoverAgents())[0]!.models[0]!.reasoningLevels,["low","standard","high"]);
    writeFileSync(join(root,".codex","config.toml"),'model_provider = "custom"\n');
    assert.equal((await adapter.discoverAgents())[0]!.models[0]!.reasoningLevels,undefined);
  }finally{if(home===undefined)delete process.env.HOME;else process.env.HOME=home;await scope.dispose();}
});
