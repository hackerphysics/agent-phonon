import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFileSync, readFileSync, existsSync, readdirSync, lstatSync, realpathSync } from "node:fs";
import { join, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
import type { ChildProcess } from "node:child_process";
import { PeerContextJournal, PeerContextReceiver } from "../peer-context.js";
import { PeerContextBridge } from "../peer-context-bridge.js";
import { prepareOpenCodePeerContext, openCodePure } from "./opencode-peer-context.js";
import { OpenCodeAdapter } from "./opencode.js";
import type { SendOptions, AdapterSession } from "../adapter.js";
import { withPeerFixture, closePeerServer } from "../testing/peer-fixture.js";
import {AgentInteractionBridge} from "../agent-interaction-bridge.js";
import {SessionEngine,AdapterRegistry} from "../session-engine.js";
import {PhononStore} from "../store.js";
import {CurrentTurnInput} from "../current-turn-input.js";

async function fixture(work: (f: any) => Promise<void>) {
  return withPeerFixture("opencode-peer",async scope=>{
  const root=scope.root,journal=new PeerContextJournal(join(root,"peers.sqlite"));scope.defer(()=>journal.close());
  const self={id:randomUUID(),position:"1",projectId:randomUUID(),ownerId:"owner",deviceId:randomUUID(),agentId:"opencode",
    agentKind:"agent" as const,sourceKind:"native" as const,sessionId:"owned",label:"root",activity:{summary:"",phase:"working" as const,impact:[],dependencies:""},activityRevision:0,lastSeenAt:null,presence:"active" as const};
  const message={id:randomUUID(),position:"2",senderId:randomUUID(),recipientId:self.id,kind:"notice" as const,text:"OPENCODE_PEER_"+randomUUID(),references:[],inReplyTo:null,depth:0,createdAt:null,expiresAt:null,state:"stored" as const,receivedAt:null};
  const state={pending:false,native:"ses_rootFixture" as string|undefined,inbox:0,active:true,budgets:[] as any[]};
  const receiver=new PeerContextReceiver({tenantId:"owner",sessionId:self.sessionId,turnId:"turn",runId:randomUUID(),nativeSessionId:()=>state.native,
    active:()=>scope.active&&state.active,journal,coordinate:async action=>{assert.equal(action.operation,"inbox");state.inbox++;return {self,messages:state.pending?[message]:[],next:null};}});
  const bridge=new PeerContextBridge({prepare:(boundary,signal)=>{state.budgets.push(boundary.budget);return receiver.prepare(boundary,signal);},authorize:value=>receiver.authorize(value),observe:value=>receiver.observe(value)});scope.defer(()=>bridge.close());const environment=await bridge.listen();
  const options:SendOptions={turnId:"turn",verbosity:"tools",emit:()=>{},environment,peerContext:receiver};
  await work({scope,root,journal,self,message,state,receiver,bridge,environment,options});
  });
}

async function activate(f:any,session:Record<string,unknown>={},nativeTransport=false){
  const asset=prepareOpenCodePeerContext(f.options)!;
  const values={...f.environment,...asset.environment},previous=new Map(Object.keys(values).map(key=>[key,process.env[key]]));
  try{
    Object.assign(process.env,values);
    const module=await import(pathToFileURL(asset.path).href);
    assert.equal(process.env.AGENT_PHONON_PEER_CONTEXT_TOKEN,undefined);
    const hooks=await module.default({directory:f.root,client:{session:{get:async({path}:any)=>({data:{id:path.id,directory:f.root,...session}})}}});
    const forwarded:any[]=[];
    let baseURL="http://native.invalid/v1";
    if(nativeTransport){
      const provider=createServer((req,res)=>{void(async()=>{
        let body="";for await(const chunk of req)body+=String(chunk);
        forwarded.push({target:req.url,init:{body,headers:req.headers}});
        res.writeHead(200,{"Content-Type":"application/json"}).end(JSON.stringify({native:true}));
      })().catch(()=>res.destroy());});
      f.scope.defer(()=>closePeerServer(provider));
      await new Promise<void>(resolve=>provider.listen(0,"127.0.0.1",resolve));
      baseURL=`http://127.0.0.1:${(provider.address()as{port:number}).port}/v1`;
    }
    const model={id:"m1",providerID:"fixture",api:{id:"m1",url:baseURL,npm:"@ai-sdk/openai-compatible"},limit:{context:128000,output:2000}};
    let failure:Error|undefined;
    const config:any={provider:{fixture:{npm:"@ai-sdk/openai-compatible",options:{baseURL,apiKey:"owner-key",...(!nativeTransport?{fetch:(target:any,init:any)=>{
      forwarded.push({target,init});if(failure)throw failure;return {native:true};
    }}:{})}}}};
    await hooks.config(config);
    const request=async(event:any={})=>{
      const header={headers:{authorization:"Bearer owner-key"}};
      await hooks["chat.headers"]({sessionID:f.state.native,message:{id:"msg_original"},agent:"build",model,provider:config.provider.fixture,...event},header);
      return config.provider.fixture.options.fetch!(baseURL+"/chat/completions",{method:"POST",headers:header.headers,
        body:JSON.stringify({model:"m1",messages:[{role:"user",content:"Original authorized task"}],max_tokens:2000})});
    };
    return {asset,hooks,config,model,forwarded,request,fail:(value:Error)=>{failure=value;}};
  }catch(error){asset.cleanup();throw error;}
  finally{for(const[key,value]of previous){if(value===undefined)delete process.env[key];else process.env[key]=value;}}
}
function user(sid="ses_rootFixture"){
  return {info:{id:"msg_original",sessionID:sid,role:"user",agent:"build",model:{providerID:"fixture",modelID:"m1"},time:{created:1}},
    parts:[{id:"prt_original",sessionID:sid,messageID:"msg_original",type:"text",text:"Original authorized task"}]};
}

test("OpenCode uses an invocation-only Phonon module without copying capabilities into files or changing existing settings",()=>fixture(async f=>{
  const original='{"permission":{"bash":"deny"},"plugin":["file:///owner/plugin.mjs",["owner-package",{"keep":true}]]}';
  const options={...f.options,environment:{...f.environment,OPENCODE_CONFIG_CONTENT:original}};
  const asset=prepareOpenCodePeerContext(options)!;
  try{
    const config=JSON.parse(asset.environment.OPENCODE_CONFIG_CONTENT!);
    assert.deepEqual(config.permission,{bash:"deny"});assert.deepEqual(config.plugin.slice(0,2),JSON.parse(original).plugin);
    assert.equal(config.plugin[2],pathToFileURL(asset.path).href);
    assert.equal(options.environment.OPENCODE_CONFIG_CONTENT,original);
    const source=readFileSync(asset.path,"utf8");
    assert.equal(source.includes(f.environment.AGENT_PHONON_PEER_CONTEXT_TOKEN),false);
    assert.equal(source.includes(asset.nonce),false);
  }finally{asset.cleanup();}
  assert.equal(existsSync(asset.path),false);
}));

test("OpenCode native fetch reports actual submitted payload while custom fetch retains its weaker ceiling",()=>fixture(async f=>{
  const native=await activate(f,{},true);
  try{
    await native.hooks["chat.message"]({sessionID:f.state.native},{message:user().info,parts:user().parts});
    f.state.pending=true;
    const result=await native.request();assert.equal((await result.json()).native,true);
    assert.equal(native.forwarded.length,1);
    assert.ok(native.forwarded[0].init.body.includes(f.message.text));
    assert.equal(native.forwarded[0].init.headers.authorization,"Bearer owner-key");
    assert.equal(native.forwarded[0].init.headers["x-phonon-native-boundary"],undefined);
    assert.equal(f.journal.records("owner","owned")[0].state,"provider_payload");
  }finally{native.asset.cleanup();}
}));

for(const variant of ["native","custom","revoked"] as const)test(`OpenCode ${variant} transport keeps ordinary insertion bound to actual application`,()=>fixture(async f=>{
  const input=new CurrentTurnInput();
  await input.run({turnId:"turn",verbosity:"tools",emit(){}},{enabled:true,capability:()=>({
    mode:"context_hook",boundary:"before_model",visibility:"hidden",evidence:"provider_payload",nativeSessionId:f.state.native})},async options=>{
    const native=await activate({...f,options,environment:options.environment}, {},variant!=="custom");
    let checks=0;
    const marker="INSERT_NATIVE_"+randomUUID(),operation=input.insert(marker,{turnId:"turn",signal:new AbortController().signal,
      beforeApply:()=>{if(++checks>1&&variant==="revoked")throw new Error("original source revoked");}});
    void operation.catch(()=>{});
    try{
      await native.hooks["chat.message"]({sessionID:f.state.native},{message:user().info,parts:user().parts});
      await native.request();
      if(variant==="native")await operation;
      else await assert.rejects(operation,variant==="custom"?{appCode:"errCapabilityUnsupported"}:/original source revoked/);
      assert.equal(native.forwarded.length,1,"original transport is never replayed");
      assert.equal(native.forwarded[0].init.body.includes(marker),variant==="native");
      assert.equal(f.journal.records("owner","owned").length,0,"ordinary input cannot manufacture peer mail receipts");
    }finally{native.asset.cleanup();}
  });
}));

test("OpenCode denied effect authorization keeps the original provider request and offered-only receipt",()=>fixture(async f=>{
  const native=await activate(f,{},true);
  try{
    await native.hooks["chat.message"]({sessionID:f.state.native},{message:user().info,parts:user().parts});
    f.state.pending=true;f.receiver.authorize=()=>{throw new Error("source withdrawn");};
    await native.request();
    assert.equal(native.forwarded.length,1);
    assert.equal(native.forwarded[0].init.body.includes(f.message.text),false);
    assert.equal(f.journal.records("owner","owned")[0].state,"offered");
  }finally{native.asset.cleanup();}
}));

test("OpenCode receives at the next context boundary without a model inbox call or a stored native user message",()=>fixture(async f=>{
  const {asset,hooks,request,forwarded}=await activate(f);
  try{
    const original=user(),output:{messages:any[]}={messages:[structuredClone(original)]};
    await hooks["chat.message"]({sessionID:f.state.native},{message:original.info,parts:original.parts});
    await hooks["experimental.chat.messages.transform"]({},output);assert.equal(output.messages.length,1);
    await request();assert.equal(JSON.parse(forwarded.at(-1).init.body).messages.length,1);
    f.state.pending=true;
    await request();const received=JSON.parse(forwarded.at(-1).init.body);
    assert.equal(received.messages.length,2);assert.ok(received.messages[1].content.includes(f.message.text));
    assert.deepEqual(original,user());assert.deepEqual(output.messages,[user()]);
    assert.equal(new Headers(forwarded.at(-1).init.headers).get("x-phonon-native-boundary"),null);
    assert.equal(new Headers(forwarded.at(-1).init.headers).get("authorization"),"Bearer owner-key");
    assert.equal(f.journal.records("owner","owned")[0].state,"context_hook");
    await request();assert.equal(JSON.parse(forwarded.at(-1).init.body).messages.length,1);
    await hooks.event({event:{type:"session.idle",properties:{sessionID:f.state.native}}});
    await request();assert.equal(f.state.inbox,3);
  }finally{asset.cleanup();}
}));

test("OpenCode child, foreign-directory and mixed-session inputs cannot acquire the owning receive binding",()=>fixture(async f=>{
  f.state.pending=true;
  for(const session of [{parentID:"ses_parent"},{directory:dirname(f.root)},{id:"ses_other"}]){
    const{asset,hooks,request,forwarded}=await activate(f,session);
    try{await hooks["chat.message"]({sessionID:f.state.native},{message:user().info});
      const output={messages:[user()]};await hooks["experimental.chat.messages.transform"]({},output);assert.equal(output.messages.length,1);
      await request();assert.equal(JSON.parse(forwarded.at(-1).init.body).messages.length,1);
    }finally{asset.cleanup();}
  }
  const{asset,hooks,request}=await activate(f);
  try{await hooks["chat.message"]({sessionID:f.state.native},{message:user().info});
    const output={messages:[user(),user("ses_child")]};await hooks["experimental.chat.messages.transform"]({},output);
    await request({sessionID:"ses_child"});
    assert.equal(f.state.inbox,0);
  }finally{asset.cleanup();}
}));

test("OpenCode actual-request budgets defer unknown/exhausted caps and keep provider errors single-shot",()=>fixture(async f=>{
  const {asset,hooks,config,model,request,forwarded,fail}=await activate(f);
  try{
    await hooks["chat.message"]({sessionID:f.state.native},{message:user().info,parts:user().parts});f.state.pending=true;
    const initial=f.state.inbox;await request({agent:"title"});await request({agent:"summary"});await request({provider:{options:{fetch:()=>{}}}});assert.equal(f.state.inbox,initial);
    model.limit.context=0;await request();assert.deepEqual(f.journal.records("owner","owned"),[]);assert.equal(f.state.budgets.at(-1).state,"unknown");
    model.limit.context=2400;await request();assert.deepEqual(f.journal.records("owner","owned"),[]);assert.equal(f.state.budgets.at(-1).state,"known");
    model.limit.context=128000;const header={headers:{} as Record<string,string>};await hooks["chat.headers"]({sessionID:f.state.native,message:{id:"msg_original"},agent:"build",model,provider:config.provider.fixture},header);
    await config.provider.fixture.options.fetch("http://native.invalid/v1/chat/completions",{method:"POST",headers:header.headers,body:JSON.stringify({model:"m1",messages:[]})});
    assert.equal(f.state.budgets.at(-1).state,"unknown");assert.deepEqual(f.journal.records("owner","owned"),[]);
    const fresh=async()=>{const output={headers:{} as Record<string,string>};await hooks["chat.headers"]({sessionID:f.state.native,message:{id:"msg_original"},agent:"build",model,provider:config.provider.fixture},output);return output.headers;};
    const body=JSON.stringify({model:"m1",messages:[{role:"system",content:"s".repeat(125000)}],tools:[{description:"tool schema".repeat(1000)}],max_tokens:2000});
    await config.provider.fixture.options.fetch("http://native.invalid/v1/chat/completions",{method:"POST",headers:await fresh(),body});
    assert.deepEqual(f.journal.records("owner","owned"),[]);assert.equal(f.state.budgets.at(-1).inputTokens,Buffer.byteLength(body));
    const count=f.state.inbox,replayed=await fresh();
    await config.provider.fixture.options.fetch("http://native.invalid/v1/models",{method:"POST",headers:replayed,body:'{}'});
    await config.provider.fixture.options.fetch("http://native.invalid/v1/chat/completions",{method:"POST",headers:replayed,body:'{}'});
    await config.provider.fixture.options.fetch("http://foreign.invalid/v1/chat/completions",{method:"POST",headers:await fresh(),body:'{}'});
    await config.provider.fixture.options.fetch("http://native.invalid/v1/chat/completions",{method:"POST",headers:await fresh(),body:'{}',signal:AbortSignal.abort()});
    assert.equal(f.state.inbox,count);assert.ok(forwarded.every(row=>!new Headers(row.init.headers).has("x-phonon-native-boundary")));
    const error=new Error("actual provider failure");fail(error);const before=forwarded.length;
    await assert.rejects(request(),value=>value===error);assert.equal(forwarded.length,before+1);
    assert.equal(f.journal.records("owner","owned")[0]?.state,"context_hook");
  }finally{asset.cleanup();}
}));

test("OpenCode native transport does not inject late peer data after source revocation",()=>fixture(async f=>{
  const session={parentID:undefined as string|undefined},native=await activate(f,session);
  try{
    await native.hooks["chat.message"]({sessionID:f.state.native},{message:user().info,parts:user().parts});f.state.pending=true;
    const prepare=f.receiver.prepare.bind(f.receiver);f.receiver.prepare=async(...args:any[])=>{
      const result=await prepare(...args);session.parentID="ses_changed";return result;
    };
    // The read API returns fresh source metadata, including changes after an awaited mailbox read.
    await native.request();assert.equal(JSON.parse(native.forwarded.at(-1).init.body).messages.length,1);
    assert.equal(f.journal.records("owner","owned")[0]?.state,"offered");
  }finally{native.asset.cleanup();}
}));

test("OpenCode pure mode, missing controller callbacks and malformed config never silently enable a plugin",()=>fixture(async f=>{
  assert.equal(prepareOpenCodePeerContext({...f.options,peerContext:undefined}),undefined);
  assert.equal(prepareOpenCodePeerContext({...f.options,environment:{...f.environment,OPENCODE_PURE:"true"}}),undefined);
  assert.equal(openCodePure({OPENCODE_PURE:"false"}),false);
  for(const content of ['[1]','{"plugin":false}','{"plugin":[1]}','{"bad":']){
    assert.throws(()=>prepareOpenCodePeerContext({...f.options,environment:{...f.environment,OPENCODE_CONFIG_CONTENT:content}}));
  }
  assert.throws(()=>prepareOpenCodePeerContext({...f.options,environment:{...f.environment,AGENT_PHONON_PEER_CONTEXT_URL:"https://foreign.invalid/peer-context"}}));
}));

test("OpenCode minimum version admits upgrades, pure mode stays disabled and recovery never creates a replacement",()=>fixture(async f=>{
  for(const version of ["1.14.20","1.15.10","1.15.11","2.0.0","1.15.10-preview","1.14.19","0.0.0","unknown"]){
    const bin=join(f.root,"probe-"+version+".mjs");
    writeFileSync(bin,`#!${process.execPath}\nif(process.argv.includes('--version'))console.log(${JSON.stringify(version)});else process.exit(17);\n`,{mode:0o700});
    const adapter=new OpenCodeAdapter({env:{binPath:bin}}),params={sessionId:"version-"+version,agentId:"opencode",model:"default",cwd:f.root};
    const session=await adapter.createSession(params);
    assert.equal(!!session.peerContextCapability?.(),["1.14.20","1.15.10","1.15.11","2.0.0"].includes(version));
    assert.equal(session.peerContextCapability?.({OPENCODE_PURE:"true"}),undefined);
    await assert.rejects(adapter.createSession({...params,reattach:true}),/replacement session/);
    await session.terminate();
  }
}));

test("OpenCode cancellation stops the owned process before removing its invocation module",()=>fixture(async f=>{
  const bin=join(f.root,"held-opencode.mjs"),marker=join(f.root,"module-started");
  writeFileSync(bin,`#!${process.execPath}\nimport{writeFileSync,renameSync}from'node:fs';import{fileURLToPath}from'node:url';if(process.argv.includes('--version')){console.log('1.14.20');process.exit(0);}const config=JSON.parse(process.env.OPENCODE_CONFIG_CONTENT);writeFileSync(${JSON.stringify(marker+".tmp")},fileURLToPath(config.plugin.at(-1)));renameSync(${JSON.stringify(marker+".tmp")},${JSON.stringify(marker)});setInterval(()=>{},1000);\n`,{mode:0o700});
  const adapter=new OpenCodeAdapter({env:{binPath:bin}}),session=await adapter.createSession({sessionId:"cancel",agentId:"opencode",model:"fixture/m1",cwd:f.root});
  f.scope.defer(()=>session.terminate());const controller=new AbortController(),events:any[]=[];
  const run=session.send("Original task",{...f.options,signal:controller.signal,emit:event=>events.push(event)});
  const child=(session as unknown as{current?:{child:ChildProcess}}).current?.child;f.scope.watch(child,true);
  try{
    for(let n=0;n<100&&!existsSync(marker);n++)await new Promise(resolve=>setTimeout(resolve,10));assert.ok(existsSync(marker));
    const module=readFileSync(marker,"utf8");assert.ok(existsSync(module));controller.abort();await run;
    assert.equal(events.at(-1)?.status,"interrupted");assert.equal(existsSync(module),false);assert.ok(child?.exitCode!==null||child?.signalCode!==null);
  }finally{controller.abort();await session.terminate();await run.catch(()=>{});}
}));

test("OpenCode outgoing uses exact native message/call identities and preserves permission rejection",{
  skip:!process.env.PHONON_TEST_OPENCODE_DEPS,
},()=>fixture(async f=>{
  const config=join(f.root,"config","opencode"),deps=process.env.PHONON_TEST_OPENCODE_DEPS!;
  f.scope.mountOpenCodeDependencies(deps,"1.14.20",config);
  let endDuringSend:()=>Promise<void>=async()=>{};
  const sends:any[]=[],bridge=new AgentInteractionBridge(undefined,undefined,undefined,undefined,undefined,undefined,async args=>{sends.push(args);await endDuringSend();return {status:"left",participantId:randomUUID()};});
  f.scope.defer(()=>bridge.close());const channel=await bridge.listen(),options={...f.options,peerContext:undefined,projectCoordination:async()=>({}),environment:{...channel,XDG_CONFIG_HOME:join(f.root,"config")}};
  const asset=prepareOpenCodePeerContext(options)!;f.scope.defer(()=>asset.cleanup());
  const env={...options.environment,...asset.environment},previous=new Map(Object.keys(env).map(key=>[key,process.env[key]]));
  const args={operation:"leave"},sid="ses_rootFixture",mid="msg_assistant",id="call-original";
  const state={parentID:undefined as string|undefined,role:"assistant",partStatus:"running",changed:false,deny:false,callID:id};
  const {Effect}=await import(pathToFileURL(join(deps,"node_modules","effect","dist","index.js")).href);
  let hooks:any;
  try{Object.assign(process.env,env);const module=await import(pathToFileURL(asset.path).href);
    assert.equal(process.env.AGENT_PHONON_INTERACTION_TOKEN,undefined);
    hooks=await module.default({directory:f.root,client:{session:{get:async()=>({data:{id:sid,directory:f.root,parentID:state.parentID}}),
      message:async()=>({data:{info:{id:mid,sessionID:sid,role:state.role,parentID:"msg_original"},parts:[{type:"tool",tool:"phonon_project_coordination",callID:state.callID,sessionID:sid,messageID:mid,state:{status:state.partStatus,input:state.changed?{operation:"presence"}:args}}]}})}}});
  }finally{for(const[key,value]of previous){if(value===undefined)delete process.env[key];else process.env[key]=value;}}
  const root=user(),context={sessionID:sid,messageID:mid,callID:id,directory:f.root,messages:[root],abort:new AbortController().signal,
    ask:()=>state.deny?Effect.fail(new Error("native permission denied")):Effect.void};
  const run=()=>hooks.tool.phonon_project_coordination.execute(args,context);
  await assert.rejects(run());await hooks["chat.message"]({sessionID:sid},{message:root.info,parts:root.parts});
  await assert.rejects(hooks["tool.execute.before"]({tool:"phonon_project_coordination",sessionID:"ses_child",callID:id},{args}));
  await hooks["tool.execute.before"]({tool:"phonon_project_coordination",sessionID:sid,callID:id},{args});
  state.changed=true;await assert.rejects(run());state.changed=false;state.parentID="ses_parent";await assert.rejects(run());state.parentID=undefined;
  state.partStatus="completed";await assert.rejects(run());state.partStatus="running";
  await assert.rejects(hooks.tool.phonon_project_coordination.execute(args,{...context,abort:AbortSignal.abort()}));
  const concurrent=await Promise.allSettled([run(),run()]);
  assert.equal(concurrent.filter(result=>result.status==="fulfilled").length,1);assert.equal(concurrent.filter(result=>result.status==="rejected").length,1);
  const result=(concurrent.find(result=>result.status==="fulfilled") as PromiseFulfilledResult<string>).value;
  assert.equal(JSON.parse(result).status,"left");await assert.rejects(run());assert.deepEqual(sends,[args]);
  context.callID=state.callID="call-denied";await hooks["tool.execute.before"]({tool:"phonon_project_coordination",sessionID:sid,callID:context.callID},{args});
  state.deny=true;await assert.rejects(run(),/native permission denied/);state.deny=false;await assert.rejects(run());assert.equal(sends.length,1);
  context.callID=state.callID="call-pending";await hooks["tool.execute.before"]({tool:"phonon_project_coordination",sessionID:sid,callID:context.callID},{args});
  await assert.rejects(hooks.tool.phonon_project_coordination.execute(args,{...context,abort:AbortSignal.timeout(20),ask:()=>Effect.never}));assert.equal(sends.length,1);
  context.callID=state.callID="call-late";await hooks["tool.execute.before"]({tool:"phonon_project_coordination",sessionID:sid,callID:context.callID},{args});
  endDuringSend=async()=>{state.parentID="ses_changed";};await assert.rejects(run(),/unconfirmed/);assert.equal(sends.length,2);state.parentID=undefined;
  context.callID=state.callID="call-replaced";await hooks["tool.execute.before"]({tool:"phonon_project_coordination",sessionID:sid,callID:context.callID},{args});
  await hooks["chat.message"]({sessionID:sid},{message:{...root.info,id:"msg_unrelated"},parts:root.parts});await assert.rejects(run());assert.equal(sends.length,2);
  await hooks.event({event:{type:"session.idle",properties:{sessionID:sid}}});await assert.rejects(run());
}));

for(const phase of ["baseline","receive","send","denied","unapproved","child","resume","coordination_only","engine","exchange","headroom","unknown_budget","insert","insert_headroom","insert_unknown"] as const)test(phase==="receive"?"installed OpenCode receives on its original native run and keeps ephemeral peer context out of stored history"
  :phase==="baseline"?"installed OpenCode baseline completes its original tool and final reply without a Phonon plugin":"installed OpenCode project coordination "+phase,{
  skip:!process.env.PHONON_TEST_OPENCODE_BIN || !process.env.PHONON_TEST_OPENCODE_DEPS,timeout:45000,
},()=>fixture(async f=>{
  const inserting=phase.startsWith("insert"),headroom=phase==="headroom"||phase==="insert_headroom",unknown=phase==="unknown_budget"||phase==="insert_unknown";
  const outgoing=!inserting&&!["baseline","receive","headroom","unknown_budget"].includes(phase),peerEnabled=!inserting&&phase!=="baseline"&&phase!=="coordination_only";
  f.state.pending=phase==="exchange";
  let session:AdapterSession|undefined;
  let insertion:Promise<void>|undefined,insertionState:"pending"|"accepted"|"rejected"="pending";
  const dependencies=process.env.PHONON_TEST_OPENCODE_DEPS!,configDirectory=join(f.root,"config","opencode");
  const installed=JSON.parse(readFileSync(join(dependencies,"node_modules","@opencode-ai","plugin","package.json"),"utf8"));
  assert.equal(installed.version,process.env.PHONON_TEST_OPENCODE_VERSION??"1.14.20","prepare the actual matching native plugin package locally before running acceptance");
  f.scope.mountOpenCodeDependencies(dependencies,installed.version,configDirectory);
  const payloads:any[]=[],errors:unknown[]=[],events:any[]=[];
  const sends:any[]=[],action={operation:"send",requestId:randomUUID(),recipientId:randomUUID(),kind:"notice",text:"PRIVATE_OPENCODE_IMPACT_"+randomUUID()};
  const coordination=new AgentInteractionBridge(undefined,undefined,undefined,undefined,undefined,undefined,async input=>{
    assert.deepEqual(input,{...action,references:[]});sends.push(input);return {status:"recorded",requestId:action.requestId,message:{...f.message,recipientId:action.recipientId,text:action.text}};
  });f.scope.defer(()=>coordination.close());const coordinationEnvironment=outgoing?await coordination.listen():{};
  const provider=createServer((req,res)=>{
    void(async()=>{
      if(req.method==="GET"){req.resume();res.writeHead(200,{"Content-Type":"application/json"}).end(JSON.stringify({data:[]}));return;}
      let body="";for await(const chunk of req)body+=String(chunk);
      const payload=JSON.parse(body),names=(payload.tools??[]).map((tool:any)=>tool.function?.name??tool.name);
      assert.equal(req.headers["x-phonon-native-boundary"],undefined,"private request marker must not leave the native process");
      assert.equal(req.headers.authorization,"Bearer synthetic-local-key","native provider authentication must remain unchanged");
      const main=names.includes("read");
      if(!main){res.writeHead(200,{"Content-Type":"text/event-stream"});res.end('data: {"id":"helper","object":"chat.completion.chunk","created":1,"model":"m1","choices":[{"index":0,"delta":{"role":"assistant","content":"Fixture helper"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');return;}
      payloads.push(payload);
      assert.ok(payloads.length<=(phase==="child"?5:phase==="resume"?4:2),"unexpected additional main request");
      res.writeHead(200,{"Content-Type":"text/event-stream"});
      const send=(delta:unknown,finish_reason:string|null)=>res.write("data: "+JSON.stringify({id:"controlled-"+payloads.length,object:"chat.completion.chunk",created:Math.floor(Date.now()/1000),model:"m1",choices:[{index:0,delta,finish_reason}]})+"\n\n");
      if(outgoing){
        if(phase==="exchange")assert.equal(body.includes(f.message.text),payloads.length===1,JSON.stringify({budgets,records:f.journal.records("owner","owned"),request:payloads.length}));
        assert.equal(names.some((name:string)=>name.includes("phonon_request_interaction")||name.includes("phonon_conversation_message")),false);
        const index=payloads.length,final=phase==="resume"?index%2===0:index===(phase==="child"?5:2);
        if(phase==="child"){
          if(index===1)f.state.pending=true;
          assert.equal(body.includes(f.message.text),index===4,"only the original root continuation receives parent mail");
          if(index===3){assert.equal(sends.length,0,"native child cannot publish as the parent");assert.ok(body.includes("original root"));}
        }
        if(final||phase==="child"&&index===3){send({role:"assistant",content:phase==="child"&&index===3?"Child check complete":"Original OpenCode task complete"},null);send({},"stop");}
        else{const task=phase==="child"&&index===1;send({role:"assistant",tool_calls:[{index:0,id:"native-call-"+index,type:"function",function:{name:task?"task":"phonon_project_coordination",
          arguments:JSON.stringify(task?{description:"Controlled child",subagent_type:"general",prompt:"Complete the assigned isolated check."}:action)}}]},null);send({},"tool_calls");}
      }else if(payloads.length===1){assert.equal(body.includes(f.message.text),false);f.state.pending=true;
        if(inserting){
          insertion=session!.insertAtToolGap!(f.message.text,{turnId:"turn",signal:AbortSignal.timeout(30000)});
          void insertion.then(()=>{insertionState="accepted";},()=>{insertionState="rejected";});
        }
        send({role:"assistant",tool_calls:[{index:0,id:"read-once",type:"function",function:{name:"read",arguments:JSON.stringify({filePath:join(f.root,"input.txt")})}}]},null);send({},"tool_calls");
      }else{assert.equal(body.includes(f.message.text),(peerEnabled||inserting)&&!headroom&&!unknown,"native next provider request must match the selected receive capability and available budget");
        if(inserting&&!headroom&&!unknown){await insertion;assert.equal(insertionState,"accepted","input must be confirmed before the original task completes");}
        assert.ok(payload.messages.some((row:any)=>row.role==="tool"));send({role:"assistant",content:"Original OpenCode task complete"},null);send({},"stop");}
      res.write("data: "+JSON.stringify({id:"controlled-"+payloads.length,object:"chat.completion.chunk",created:Math.floor(Date.now()/1000),model:"m1",choices:[],usage:{prompt_tokens:100,completion_tokens:20,total_tokens:120}})+"\n\n");
      res.end("data: [DONE]\n\n");
    })().catch(error=>{errors.push(error);res.destroy();});
  });
  f.scope.defer(()=>closePeerServer(provider));f.scope.defer(()=>session?.terminate());
  await new Promise<void>(resolve=>provider.listen(0,"127.0.0.1",resolve));
  const port=(provider.address()as{port:number}).port;
  writeFileSync(join(f.root,"input.txt"),"Only this fixture file\n");
  const config={model:"fixture/m1",small_model:"fixture/m1",share:"disabled",autoupdate:false,snapshot:false,
    permission:{"*":"deny",read:"allow",...(outgoing?{phonon_project_coordination:phase==="denied"?"deny":phase==="unapproved"?"ask":"allow",...(phase==="child"?{task:"allow"}:{})}:{}),external_directory:{[f.root]:"allow",[f.root+"/*"]:"allow"}},provider:{fixture:{npm:"@ai-sdk/openai-compatible",name:"Local fixture",
      options:{baseURL:`http://127.0.0.1:${port}/v1`,apiKey:"synthetic-local-key"},models:{m1:{name:"m1",limit:{context:headroom?8000:unknown?0:128000,output:2000},cost:{input:0,output:0},toolcall:true}}}}};
  const receiver=new PeerContextReceiver({tenantId:"owner",sessionId:f.self.sessionId,turnId:"turn",runId:randomUUID(),
    nativeSessionId:()=>session?.peerContextCapability?.()?.nativeSessionId,journal:f.journal,active:()=>f.state.active,
    coordinate:async()=>({self:f.self,messages:f.state.pending?[f.message]:[],next:null})});
  const budgets:any[]=[];
  const access={prepare:(boundary:Parameters<PeerContextReceiver["prepare"]>[0],signal?:AbortSignal)=>{budgets.push(boundary.budget);return receiver.prepare(boundary,signal);},
    authorize:(value:Parameters<PeerContextReceiver["authorize"]>[0])=>receiver.authorize(value),observe:(value:Parameters<PeerContextReceiver["observe"]>[0])=>receiver.observe(value)};
  const nativeBridge=new PeerContextBridge(access);f.scope.defer(()=>nativeBridge.close());const environment=await nativeBridge.listen();
  const previousHome=process.env.HOME,previousProfile=process.env.USERPROFILE;
  process.env.HOME=f.root;process.env.USERPROFILE=f.root;
  try{
    const adapter=new OpenCodeAdapter({env:{binPath:process.env.PHONON_TEST_OPENCODE_BIN!}});
    if(phase==="engine"){
      const registry=new AdapterRegistry();registry.register(adapter);const store=new PhononStore(join(f.root,"engine.sqlite"));f.scope.defer(()=>store.close());
      const requests:any[]=[],runId=randomUUID(),original=adapter.createSession.bind(adapter);
      adapter.createSession=async params=>session=await original(params);
      const engine=new SessionEngine(registry,event=>events.push(event),undefined,store,{projectCoordination:async request=>{
        requests.push(request);const self={...f.self,sessionId:request.sessionId};
        if(request.action.operation==="send")return {status:"recorded",requestId:action.requestId,message:{...f.message,senderId:self.id,recipientId:action.recipientId,text:action.text}};
        return request.action.operation==="peers"?{self,participants:[],next:null}:{self,messages:[],next:null};
      }},"owner");f.scope.defer(()=>engine.dispose());
      const owned=await engine.create({tenantId:"owner",project:"owned-opencode-project",cwd:f.root,agent:"opencode",model:"fixture/m1",verbosity:"tools",
        workflowAttr:{workflowId:"opencode-owned-workflow",nodeId:"reply",nativeRunId:runId}});
      const assigned=await engine.send("owner",owned.sessionId,"Complete the assigned isolated task.",{environment:{
        XDG_CONFIG_HOME:join(f.root,"config"),XDG_DATA_HOME:join(f.root,"data"),XDG_CACHE_HOME:join(f.root,"cache"),XDG_STATE_HOME:join(f.root,"state"),
        OPENCODE_CONFIG_CONTENT:JSON.stringify(config),OPENCODE_DISABLE_PROJECT_CONFIG:"true",OPENCODE_DISABLE_DEFAULT_PLUGINS:"true",OPENCODE_DISABLE_EXTERNAL_SKILLS:"true",
        OPENCODE_DISABLE_LSP_DOWNLOAD:"true",OPENCODE_DISABLE_AUTOUPDATE:"true",OPENCODE_DISABLE_MODELS_FETCH:"true",
        HTTP_PROXY:"",HTTPS_PROXY:"",ALL_PROXY:"",http_proxy:"",https_proxy:"",all_proxy:""}});
      for(let n=0;n<1500&&!events.some(event=>event.final);n++)await new Promise(resolve=>setTimeout(resolve,20));
      await engine.settleTurn("owner",owned.sessionId,assigned.turnId);assert.equal(events.at(-1)?.status,"completed",JSON.stringify({events,requests}));
      const sent=requests.filter(request=>request.action.operation==="send");assert.equal(sent.length,1);
      assert.deepEqual(sent[0].action,{...action,references:[]});assert.equal(sent[0].runId,runId);assert.equal(sent[0].sessionId,owned.sessionId);assert.equal(sent[0].turnId,assigned.turnId);
      assert.equal(JSON.stringify(events).includes(action.text),false);assert.equal(payloads.length,2);assert.ok(JSON.stringify(payloads.at(-1).messages).includes("recorded"));
      await engine.dispose();return;
    }
    session=await adapter.createSession({sessionId:f.self.sessionId,agentId:"opencode",model:"fixture/m1",cwd:f.root});
    assert.ok(session.peerContextCapability?.(),"installed OpenCode must qualify before peer receive");
    let raw="";
    const options:SendOptions={turnId:"turn",verbosity:"tools",...(peerEnabled?{peerContext:access}:{}),...(outgoing?{projectCoordination:async()=>({})}:{}),emit:event=>events.push(event),signal:AbortSignal.timeout(30000),environment:{...environment,...coordinationEnvironment,
      ...(phase==="baseline"?{OPENCODE_PURE:"true"}:{}),
      XDG_CONFIG_HOME:join(f.root,"config"),XDG_DATA_HOME:join(f.root,"data"),XDG_CACHE_HOME:join(f.root,"cache"),
      XDG_STATE_HOME:join(f.root,"state"),
      OPENCODE_CONFIG_CONTENT:JSON.stringify(config),OPENCODE_DISABLE_PROJECT_CONFIG:"true",OPENCODE_DISABLE_DEFAULT_PLUGINS:"true",OPENCODE_DISABLE_EXTERNAL_SKILLS:"true",
      OPENCODE_DISABLE_LSP_DOWNLOAD:"true",OPENCODE_DISABLE_AUTOUPDATE:"true",OPENCODE_DISABLE_MODELS_FETCH:"true",
      HTTP_PROXY:"",HTTPS_PROXY:"",ALL_PROXY:"",http_proxy:"",https_proxy:"",all_proxy:""}};
    const run=session.send(outgoing?"Complete the assigned isolated task.":"Read input.txt once and finish the original task.",options);
    const startupDeadline=Date.now()+5000;
    while(!(session as unknown as{current?:unknown}).current&&!events.some(event=>event.final)&&Date.now()<startupDeadline)await new Promise(resolve=>setTimeout(resolve,10));
    const native=(session as unknown as{current?:{child:ChildProcess}}).current?.child;
    f.scope.watch(native,true);
    native?.stdout?.on("data",chunk=>{raw=(raw+String(chunk)).slice(-262144);});
    await run;
    if(phase==="resume"){
      const offset=events.length;
      const again=session.send("Continue this assigned session.",{...options,turnId:"next-turn",signal:AbortSignal.timeout(30000)});
      const deadline=Date.now()+5000;
      while(!(session as unknown as{current?:unknown}).current&&!events.slice(offset).some(event=>event.final)&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,10));
      f.scope.watch((session as unknown as{current?:{child:ChildProcess}}).current?.child,true);await again;
    }
    assert.deepEqual(errors,[]);
    const logDirectory=join(f.root,"data","opencode","log");
    const logs=events.at(-1)?.status==="completed"&&(!outgoing||sends.length)?[]:existsSync(logDirectory)?readdirSync(logDirectory).slice(-2).map(name=>readFileSync(join(logDirectory,name),"utf8").slice(-16000).replaceAll(environment.AGENT_PHONON_PEER_CONTEXT_TOKEN!,"[redacted]")):[];
    if(phase==="unapproved"){
      assert.equal(sends.length,0);assert.equal(events.at(-1)?.status,"failed");assert.equal(payloads.length,1);
      assert.ok(raw.includes("The user rejected permission"));assert.equal(JSON.stringify(events).includes(action.text),false);return;
    }
    assert.equal(events.at(-1)?.status,"completed",JSON.stringify({events,requests:payloads.length,receipts:f.journal.records("owner","owned"),raw,logs}));
    if(outgoing){
      assert.equal(sends.length,["denied","unapproved"].includes(phase)?0:phase==="resume"?2:1,JSON.stringify({events,tools:payloads.map(p=>p.tools.map((t:any)=>t.function?.name)),results:payloads.map(p=>p.messages.filter((m:any)=>m.role==="tool")),sends,raw,logs}));
      assert.equal(payloads.length,phase==="child"?5:phase==="resume"?4:2);
      assert.equal(JSON.stringify(events).includes(action.text),false);
      assert.equal(events.some(event=>event.toolName==="phonon_project_coordination"),false);
      assert.ok(JSON.stringify(payloads.at(-1).messages).includes(phase==="denied"?"unavailable":"recorded"));
    }else{assert.equal(payloads.length,2);assert.equal(f.journal.records("owner","owned")[0]?.state,peerEnabled&&!headroom&&!unknown?"provider_payload":undefined);}
    if(inserting){
      assert.ok(insertion,"the original native task must reach input admission");
      if(headroom||unknown)await assert.rejects(insertion);else await insertion;
      assert.equal(insertionState,headroom||unknown?"rejected":"accepted");
      assert.ok(events.every(event=>event.turnId==="turn"),"insertion must retain its original turn");
    }
    if(peerEnabled){assert.ok(budgets.length>=2,JSON.stringify({phase,budgets}));assert.ok(budgets.every(budget=>budget?.state===(phase==="unknown_budget"?"unknown":"known")),JSON.stringify(budgets));}
    assert.equal(JSON.stringify(events).includes(f.message.text),false);
    assert.equal(raw.includes(f.message.text),false);
    const database=new DatabaseSync(join(f.root,"data","opencode","opencode.db"),{readOnly:true});
    try{
      assert.equal(JSON.stringify(database.prepare("SELECT data FROM part").all()).includes(f.message.text),false,"peer context cannot become stored human messages");
      const sessions=database.prepare("SELECT id,directory FROM session").all() as Array<{id:string;directory:string}>;
      assert.ok(sessions.length>0);assert.ok(sessions.every(row=>row.directory===f.root),"native sessions must not adopt the daemon's inherited PWD");
      if(phase==="resume")assert.equal(sessions.length,1,"two assigned turns must retain the same native session");
    }finally{database.close();}
    assert.equal(events.filter(event=>event.type==="tool_call"&&event.toolName==="read").length,outgoing?0:1);
    assert.ok(lstatSync(join(configDirectory,"node_modules")).isSymbolicLink(),"native acceptance must retain the shared dependency view");
    assert.equal(realpathSync(join(configDirectory,"node_modules")),realpathSync(join(dependencies,"node_modules")));
  }finally{
    if(previousHome===undefined)delete process.env.HOME;else process.env.HOME=previousHome;
    if(previousProfile===undefined)delete process.env.USERPROFILE;else process.env.USERPROFILE=previousProfile;
    await session?.terminate();await nativeBridge.close();provider.closeAllConnections();await new Promise<void>(resolve=>provider.close(()=>resolve()));
  }
}));
