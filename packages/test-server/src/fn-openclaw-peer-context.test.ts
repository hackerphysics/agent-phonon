import test,{after} from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { join,sep } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { OpenClawGatewayAdapter, GatewayClient, spawnSupervisedAgent,SessionEngine,AdapterRegistry,PhononStore } from "@agent-phonon/core";
import { NativePeerContexts, PEER_BIND, PEER_RELEASE, PEER_CAPABILITIES, PEER_BLOCK_TAG,openClawPeerBudgetConfig, type NativePeerApi } from "@agent-phonon/openclaw-plugin/peer-context";
import { PeerContextJournal, PeerContextReceiver,peerContextHeadroom } from "../../core/dist/peer-context.js";
import { PeerContextBridge } from "../../core/dist/peer-context-bridge.js";
import { OpenClawInputCapabilities,projectOpenClawToolResult } from "../../core/dist/adapters/openclaw-peer-context.js";
import { PeerFixture, withPeerFixture, closePeerServer } from "../../core/dist/testing/peer-fixture.js";
import type { AdapterSession } from "@agent-phonon/core";
import { CurrentTurnInput } from "../../core/dist/current-turn-input.js";

function deferred(){let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return {promise,resolve};}
const tokens=(value:unknown):value is number=>Number.isSafeInteger(value)&&Number(value)>0;
let nativeCompileCache:PeerFixture|undefined;
let nativeCompileDirectory:string|undefined;
after(async()=>{await nativeCompileCache?.dispose();nativeCompileCache=undefined;nativeCompileDirectory=undefined;});
async function nativeFixture(work:(f:any)=>Promise<void>){
  if(!nativeCompileCache){
    nativeCompileCache=new PeerFixture("openclaw-compile-cache");
    writeFileSync(join(nativeCompileCache.root,"runtime.json"),JSON.stringify({sdk:process.env.PHONON_TEST_OPENCLAW_SDK,node:process.execPath,version:process.version}),{mode:0o600});
    const sdk=process.env.PHONON_TEST_OPENCLAW_SDK!,installRoot=join(sdk,"../..");
    const native=await import(pathToFileURL(join(installRoot,"node-compile-cache.mjs")).href);
    nativeCompileDirectory=native.resolveOpenClawCompileCacheDirectory({installRoot,env:{NODE_COMPILE_CACHE:join(nativeCompileCache.root,"cache")}});
    assert.ok(nativeCompileDirectory?.startsWith(join(nativeCompileCache.root,"cache")+sep),"compile cache must remain under its owned test resource");
  }
  const cache=nativeCompileCache;
  return fixture(f=>work({...f,compileCache:cache,compileDirectory:nativeCompileDirectory}));
}
class Host {
  selectedRuntime="openclaw";
  readonly rows=new Map<string,Record<string,unknown>>();
  readonly peers=new NativePeerContexts({resolveRuntime:()=>this.selectedRuntime});
  readonly connection=new AbortController();
  readonly client={connId:randomUUID(),connect:{role:"operator",scopes:["operator.admin"]},connectionSignal:this.connection.signal,invalidated:false};
  readonly methods=new Map<string,any>();
  readonly hooks=new Map<string,any>();
  readonly config:any={models:{providers:{fixture:{api:"openai-completions",models:[{id:"m1",contextWindow:128000,maxTokens:2000}]}}},plugins:{enabled:true,entries:{"agent-phonon-hitl":{enabled:true,config:{peerContext:true,nativeInteractions:false},hooks:{allowPromptInjection:true,allowConversationAccess:true}}}}};
  middleware!:any;
  cleanup!:any;
  current=true;
  constructor(version="2026.10.7"){
    const api:NativePeerApi={id:"agent-phonon-hitl",config:this.config,runtime:{version,config:{current:()=>this.config},agent:{session:{getSessionEntry:input=>this.rows.get(input.sessionKey)}}},
      registerGatewayMethod:(name,handler,options)=>{assert.equal(options.scope,"operator.admin");this.methods.set(name,handler);},
      registerAgentToolResultMiddleware:(handler,options)=>{assert.deepEqual(options.runtimes,["openclaw"]);this.middleware=handler;},
      on:(name,handler,options)=>{if(name==="before_prompt_build")assert.equal((options as any).requiresToolAuthority,true);this.hooks.set(name,handler);},
      lifecycle:{registerRuntimeLifecycle:value=>{this.cleanup=value.cleanup;}}};
    this.peers.register(api);
  }
  rpc(method:string,params:any,client:any=this.client){let result:any;
    this.methods.get(method)({params,client,hasCurrentClientAuthority:()=>this.current,respond:(ok:boolean,payload:any,error:any)=>{result={ok,payload,error};}});return result;}
  context(input:any){return {sessionKey:input.sessionKey,sessionId:input.sessionId,runId:input.runId,agentId:"worker",workspaceDir:input.workspaceDir,runtime:"openclaw",modelProviderId:"fixture",modelId:"m1"};}
  budget(input:any){const ctx=this.context(input),base={runId:input.runId,sessionId:input.sessionId,sessionKey:input.sessionKey,provider:"fixture",model:"m1"};
    this.hooks.get("llm_input")({...base,systemPrompt:"Native system",prompt:"Original task",historyMessages:[],tools:[],imagesCount:0},ctx);
    this.hooks.get("model_call_started")({...base,api:"openai-completions",callId:randomUUID(),contextTokenBudget:128000,contextWindowSource:"modelsConfig"},{...ctx,contextTokenBudget:128000,contextWindowSource:"modelsConfig"});}
  close(){this.connection.abort();this.cleanup?.({});}
}

async function fixture(work:(f:any)=>Promise<void>){return withPeerFixture("openclaw-peer",async scope=>{
  const journal=new PeerContextJournal(join(scope.root,"peer.sqlite"));scope.defer(()=>journal.close());
  const host=new Host();scope.defer(()=>host.close());
  const self={id:randomUUID(),position:"1",projectId:randomUUID(),ownerId:"owner",deviceId:randomUUID(),agentId:"openclaw:worker",agentKind:"agent" as const,sourceKind:"native" as const,
    sessionId:"owned",label:"root",activity:{summary:"",phase:"working" as const,impact:[],dependencies:""},activityRevision:0,lastSeenAt:null,presence:"active" as const};
  const message={id:randomUUID(),position:"2",senderId:randomUUID(),recipientId:self.id,kind:"notice" as const,text:"OPENCLAW_PEER_"+randomUUID(),references:[],inReplyTo:null,depth:0,
    createdAt:null,expiresAt:null,state:"stored" as const,receivedAt:null};
  const state={pending:false,active:true,blocked:false,inbox:0,hold:false,budgets:[] as any[],applications:[] as any[],requestSignal:undefined as AbortSignal|undefined,session:undefined as AdapterSession|undefined},received=deferred(),release=deferred();scope.defer(()=>release.resolve());
  const native=randomUUID();
  const receiver=new PeerContextReceiver({tenantId:"owner",sessionId:self.sessionId,turnId:"turn",runId:randomUUID(),nativeSessionId:()=>state.session?state.session.peerContextCapability?.()?.nativeSessionId:native,journal,requireBudget:true,evidence:"context_hook",
    active:()=>scope.active&&state.active,blocked:()=>state.blocked,coordinate:async action=>{assert.equal(action.operation,"inbox");state.inbox++;
      if(state.hold){received.resolve();await release.promise;}return {self,messages:state.pending?[message]:[],next:null};}});
  const bridge=new PeerContextBridge({prepare:(boundary,signal)=>{state.budgets.push(boundary.budget);state.requestSignal=signal;return receiver.prepare(boundary,signal);},
    authorize:input=>receiver.authorize(input),contextApplied:input=>{state.applications.push(input);receiver.observe({...input,evidence:"context_hook"});},observe:input=>receiver.observe(input)});scope.defer(()=>bridge.close());const environment=await bridge.listen();
  const input={version:1,sessionKey:"agent:worker:phonon-owned",sessionId:native,model:"fixture/m1",runId:randomUUID(),workspaceDir:scope.root,projectionId:randomUUID(),expiresAt:Date.now()+60000,
    endpoint:environment.AGENT_PHONON_PEER_CONTEXT_URL!,token:environment.AGENT_PHONON_PEER_CONTEXT_TOKEN!};
  const result={content:[{type:"text",text:"Actual original tool output"}],details:{status:"completed",exitCode:0}};
  host.rows.set(input.sessionKey,{sessionId:native});
  const event={toolCallId:"root-tool",toolName:"read",args:{},cwd:scope.root,result,isError:false};
  await work({scope,journal,host,self,message,state,receiver,input,event,result,received,release,environment});
});}

for(const variant of ["applied","offer-only","wrong-projection","wrong-tool","synthetic","child","compaction","source-revoked","foreign-model","late-terminal"] as const)
  test(`OpenClaw ordinary native input requires accepted context and original-run continuation: ${variant}`,()=>fixture(async f=>{
    const inbox=new CurrentTurnInput(),started=deferred(),finished=deferred(),abort=new AbortController();let channel:Record<string,string>|undefined,accepted=false,checks=0;
    const run=inbox.run({turnId:"original",verbosity:"tools",emit:()=>{}},{enabled:true,receipt:"native_context",capability:()=>({mode:"context_hook",boundary:"after_tools",visibility:"collapsed",evidence:"context_hook",nativeSessionId:f.input.sessionId})},
      async options=>{channel=options.environment;started.resolve();await finished.promise;});
    try{
      await started.promise;assert.ok(channel);
      const input={...f.input,nativeInput:true,endpoint:channel.AGENT_PHONON_PEER_CONTEXT_URL,token:channel.AGENT_PHONON_PEER_CONTEXT_TOKEN};
      assert.equal(f.host.rpc(PEER_BIND,input).ok,true);f.host.budget(input);
      const insertion=inbox.insert("Original-turn synthetic input",{turnId:"original",signal:abort.signal,
        ...(variant==="source-revoked"?{beforeApply(){if(++checks>1)throw new Error("Original source withdrawn");}}:{})});
      void insertion.then(()=>{accepted=true;},()=>{});
      const result=await f.host.middleware(f.event,f.host.context(input));
      if(variant==="source-revoked"){assert.equal(result,undefined);await assert.rejects(insertion);assert.equal(checks,2);return;}
      assert.ok(result?.result.content[1].text.includes("Original-turn synthetic input"));assert.equal(accepted,false);
      const content=structuredClone(result.result.content);
      if(variant==="wrong-projection")content[1][PEER_BLOCK_TAG].projectionId=randomUUID();
      if(variant!=="offer-only")f.host.hooks.get("tool_result_persist")({toolName:"read",toolCallId:"root-tool",isSynthetic:variant==="synthetic",
        message:{role:"toolResult",toolCallId:"root-tool",content,isError:false}},
        {...f.host.context(input),toolCallId:variant==="wrong-tool"?"foreign":"root-tool",...(variant==="child"?{sessionKey:"agent:worker:subagent-child"}:{})});
      assert.equal(accepted,false,"persistence observation alone cannot confirm insertion");
      if(variant==="compaction")f.host.hooks.get("before_compaction")({},f.host.context(input));
      if(variant==="late-terminal")f.host.hooks.get("agent_end")({},f.host.context(input));
      await f.host.hooks.get("model_call_started")({runId:input.runId,sessionId:input.sessionId,sessionKey:input.sessionKey,provider:variant==="foreign-model"?"foreign":"fixture",model:"m1",
        api:"openai-completions",callId:randomUUID(),contextTokenBudget:128000,contextWindowSource:"modelsConfig"},
        {...f.host.context(input),contextTokenBudget:128000,contextWindowSource:"modelsConfig"});
      if(variant==="applied")await insertion;else{assert.equal(accepted,false);abort.abort();await assert.rejects(insertion);}
    }finally{abort.abort();finished.resolve();await run;}
  }));

test("OpenClaw peer grants are independent of HITL tools, admin-only, source-bound and idempotent",()=>fixture(async f=>{
  f.host.config.plugins.entries.unrelated={enabled:true,config:{peerContext:"unrelated-plugin-value"}};
  assert.equal(f.host.rpc(PEER_CAPABILITIES,{version:1}).payload.available,true);
  for(const client of [null,{...f.host.client,connectionSignal:undefined},{...f.host.client,connect:{role:"operator",scopes:["operator.write"]}},{...f.host.client,invalidated:true}]){
    const response=f.host.rpc(PEER_BIND,f.input,client);assert.equal(response.ok,false);assert.equal(JSON.stringify(response).includes(f.input.token),false);
  }
  for(const patch of [{endpoint:"https://foreign.invalid/peer-context"},{endpoint:f.input.endpoint+"?x=y"},{sessionId:"invalid"},{runId:"invalid"},{projectionId:"invalid"},
    {sessionKey:"agent:worker:personal"},{expiresAt:Date.now()-1},{expiresAt:Date.now()+3600000},{senderId:randomUUID()}]){
    assert.equal(f.host.rpc(PEER_BIND,{...f.input,...patch}).ok,false);
  }
  const bound=f.host.rpc(PEER_BIND,f.input);assert.deepEqual(bound.payload,{version:1,bound:true,projectionId:f.input.projectionId});
  assert.equal(f.host.rpc(PEER_BIND,f.input).ok,true);assert.equal(JSON.stringify(bound).includes(f.input.token),false);
  assert.equal(f.host.rpc(PEER_BIND,{...f.input,runId:randomUUID()}).ok,false);
  assert.equal(f.host.rpc(PEER_RELEASE,{sessionKey:f.input.sessionKey,runId:f.input.runId},{...f.host.client,connId:randomUUID()}).ok,false);
  assert.equal(f.host.rpc(PEER_RELEASE,{sessionKey:f.input.sessionKey,runId:randomUUID()}).payload.released,false);
  assert.equal(f.host.rpc(PEER_RELEASE,{sessionKey:f.input.sessionKey,runId:f.input.runId}).payload.released,true);
}));

test("OpenClaw ordinary input requires its explicit qualified lifecycle instead of inferring it from older peer support",()=>fixture(async f=>{
  const capabilities=f.host.rpc(PEER_CAPABILITIES,{version:1}).payload;assert.equal(OpenClawInputCapabilities.safeParse(capabilities).success,true);
  assert.equal(OpenClawInputCapabilities.safeParse({...capabilities,currentTurnInput:undefined}).success,false);
  const older=new Host("2026.9.3");f.scope.defer(()=>older.close());older.rows.set(f.input.sessionKey,{sessionId:f.input.sessionId});
  const old=older.rpc(PEER_CAPABILITIES,{version:1}).payload;
  assert.equal(old.available,true);assert.equal(old.currentTurnInput,undefined);assert.equal(older.hooks.has("tool_result_persist"),false);
  assert.equal(older.rpc(PEER_BIND,{...f.input,nativeInput:true}).ok,false);
  assert.equal(f.host.rpc(PEER_BIND,{...f.input,nativeInput:false}).ok,false);
  assert.equal(older.rpc(PEER_BIND,f.input).ok,true,"ordinary peer receive retains its prior native contract");
}));

test("OpenClaw peer readiness follows the native selected runtime and original session generation",()=>fixture(async f=>{
  const query={version:1,sessionKey:f.input.sessionKey,sessionId:f.input.sessionId,model:f.input.model};
  assert.equal(f.host.rpc(PEER_CAPABILITIES,query).payload.selectedRuntime,"openclaw");
  f.host.rpc(PEER_BIND,f.input);f.state.pending=true;f.host.selectedRuntime="codex";
  assert.equal(f.host.rpc(PEER_CAPABILITIES,query).payload.available,false);assert.equal(await f.host.middleware(f.event,f.host.context(f.input)),undefined);
  f.host.selectedRuntime="openclaw";assert.equal(await f.host.middleware(f.event,f.host.context(f.input)),undefined,"runtime re-selection must not resurrect an old grant");
  f.host.rpc(PEER_BIND,f.input);f.host.rows.set(f.input.sessionKey,{sessionId:randomUUID()});
  assert.equal(f.host.rpc(PEER_CAPABILITIES,query).payload.available,false);assert.equal(await f.host.middleware(f.event,f.host.context(f.input)),undefined);assert.equal(f.state.inbox,0);
}));

test("OpenClaw receives at a native tool boundary while preserving the real result and private human projection",()=>fixture(async f=>{
  f.host.rpc(PEER_BIND,f.input);const ctx=f.host.context(f.input);
  const initial=f.host.hooks.get("before_prompt_build");assert.equal(await initial({},ctx),undefined);
  assert.equal(await initial({}, {...ctx,toolAuthority:{assertActive(){}}}),undefined);assert.equal(f.state.inbox,1);
  f.host.budget(f.input);
  f.state.pending=true;
  for(const patch of [{sessionId:randomUUID()},{runId:randomUUID()},{agentId:"other"},{sessionKey:"agent:worker:phonon-other"},{runtime:"codex"}]){
    assert.equal(await f.host.middleware(f.event,{...ctx,...patch}),undefined);
  }
  assert.equal(await f.host.middleware({...f.event,cwd:join(f.scope.root,"missing")},ctx),undefined);
  assert.equal(f.state.inbox,1);
  const output=await f.host.middleware(f.event,ctx);assert.ok(output.result.content[1].text.includes(f.message.text));
  assert.deepEqual(output.result.content[0],f.result.content[0]);assert.deepEqual(output.result.details,f.result.details);assert.equal(f.result.content.length,1);
  const scope={projectionId:f.input.projectionId,runId:f.input.runId,sessionId:f.input.sessionId};
  assert.deepEqual(projectOpenClawToolResult(output.result,scope),f.result);
  assert.deepEqual(projectOpenClawToolResult(output.result,{...scope,projectionId:randomUUID()}),output.result,"foreign data must not be stripped");
  assert.equal(await f.host.middleware(f.event,ctx),undefined);assert.equal(f.state.inbox,2);
  assert.equal(f.journal.records("owner","owned")[0].state,"context_hook");
  assert.deepEqual(Object.keys(output.result.content[1][PEER_BLOCK_TAG]).sort(),["boundaryId","projectionId","runId","sessionId","version"]);
  f.host.hooks.get("agent_end")({},{});f.host.hooks.get("agent_end")({}, {...ctx,runId:randomUUID()});
  f.host.hooks.get("agent_end")({},ctx);assert.equal(await f.host.middleware({...f.event,toolCallId:"late"},ctx),undefined);
}));

test("OpenClaw initial peer enrichment defers pending mail until native budget exists",()=>fixture(async f=>{
  f.state.pending=true;f.host.rpc(PEER_BIND,f.input);let assertions=0;
  const output=await f.host.hooks.get("before_prompt_build")({}, {...f.host.context(f.input),toolAuthority:{assertActive(){assertions++;}}});
  assert.equal(output,undefined);assert.ok(assertions>=2);
  assert.deepEqual(f.journal.records("owner","owned"),[]);
  f.host.budget(f.input);const received=await f.host.middleware(f.event,f.host.context(f.input));assert.ok(received.result.content[1].text.includes(f.message.text));
}));

test("OpenClaw native output budget uses explicit model/agent limits without provider secrets",()=>fixture(async f=>{
  const config=structuredClone(f.host.config);
  config.agents={defaults:{params:{max_tokens:3000},models:{"fixture/m1":{params:{maxTokens:4000}}}},entries:{worker:{params:{max_completion_tokens:5000}}}};
  const value=openClawPeerBudgetConfig(config,"fixture/m1","worker");assert.equal(value?.output,5000);assert.equal(value?.window,128000);
  config.models.providers.fixture.apiKey="synthetic-provider-secret";assert.deepEqual(openClawPeerBudgetConfig(config,"fixture/m1","worker"),value);
  for(const patch of [{maxTokens:0},{maxTokens:"2000"},{contextWindow:0},{api:"anthropic-messages"}]){
    const invalid=structuredClone(config);Object.assign(invalid.models.providers.fixture.models[0],patch);assert.equal(openClawPeerBudgetConfig(invalid,"fixture/m1","worker"),undefined);
  }
  config.agents.entries.worker.params.maxTokens=-1;assert.equal(openClawPeerBudgetConfig(config,"fixture/m1","worker"),undefined);
  delete config.agents.entries.worker.params.maxTokens;
  config.agents.entries.worker.params.extra_body={max_tokens:100000};assert.equal(openClawPeerBudgetConfig(config,"fixture/m1","worker"),undefined);
}));

test("OpenClaw unknown/full budgets leave IDs pending and later native boundaries recover without duplicate claims",()=>fixture(async f=>{
  f.state.pending=true;f.host.rpc(PEER_BIND,f.input);const ctx=f.host.context(f.input);
  assert.equal(await f.host.middleware(f.event,ctx),undefined);assert.equal(f.state.budgets.at(-1).state,"unknown");assert.deepEqual(f.journal.records("owner","owned"),[]);
  f.host.config.models.providers.fixture.models[0].maxTokens=64000;f.host.budget(f.input);
  assert.equal(await f.host.middleware({...f.event,toolCallId:"full"},ctx),undefined);assert.equal(f.state.budgets.at(-1).state,"known");assert.equal(peerContextHeadroom(f.state.budgets.at(-1)),0);
  assert.deepEqual(f.journal.records("owner","owned"),[]);
  f.host.hooks.get("before_compaction")({},ctx);f.host.config.models.providers.fixture.models[0].maxTokens=2000;f.host.budget(f.input);
  const output=await f.host.middleware({...f.event,toolCallId:"recovered"},ctx);assert.ok(output.result.content[1].text.includes(f.message.text));
  assert.equal(f.journal.records("owner","owned").length,1);assert.equal(await f.host.middleware({...f.event,toolCallId:"deduplicated"},ctx),undefined);
}));

test("OpenClaw runtime retries and tool results cumulatively consume one native run budget",()=>fixture(async f=>{
  f.host.rpc(PEER_BIND,f.input);f.host.budget(f.input);const ctx=f.host.context(f.input);
  await f.host.middleware(f.event,ctx);const first=f.state.budgets.at(-1).inputTokens;
  const event={runId:f.input.runId,sessionId:f.input.sessionId,sessionKey:f.input.sessionKey,provider:"fixture",model:"m1",api:"openai-completions",callId:randomUUID(),contextTokenBudget:128000,contextWindowSource:"modelsConfig"};
  f.host.hooks.get("model_call_started")(event,{...ctx,contextTokenBudget:128000,contextWindowSource:"modelsConfig"});
  await f.host.middleware({...f.event,toolCallId:"retry"},ctx);assert.ok(f.state.budgets.at(-1).inputTokens>first+2000);
  f.host.hooks.get("model_call_started")(event,{...ctx,contextTokenBudget:128000,contextWindowSource:"modelsConfig"});
  await f.host.middleware({...f.event,toolCallId:"duplicate-call"},ctx);assert.equal(f.state.budgets.at(-1).state,"unknown");
}));

for(const missing of ["tools","system","image-history","image-result","model-call","duplicate-input"] as const)test(`OpenClaw ${missing} cannot borrow a text-native budget`,()=>fixture(async f=>{
  f.host.rpc(PEER_BIND,f.input);f.state.pending=true;const ctx=f.host.context(f.input);
  const base={runId:f.input.runId,sessionId:f.input.sessionId,sessionKey:f.input.sessionKey,provider:"fixture",model:"m1"};
  const input:any={...base,systemPrompt:"Native system",prompt:"Original",historyMessages:[],tools:[],imagesCount:0};
  if(missing==="tools")delete input.tools;if(missing==="system")delete input.systemPrompt;
  if(missing==="image-history")input.historyMessages=[{role:"user",content:[{type:"image",data:"synthetic"}]}];
  f.host.hooks.get("llm_input")(input,ctx);
  if(missing!=="model-call")f.host.hooks.get("model_call_started")({...base,callId:randomUUID(),api:"openai-completions",contextTokenBudget:128000,contextWindowSource:"modelsConfig"},
    {...ctx,contextTokenBudget:128000,contextWindowSource:"modelsConfig"});
  if(missing==="duplicate-input")f.host.hooks.get("llm_input")(input,ctx);
  const event=missing==="image-result"?{...f.event,result:{content:[{type:"image",data:"synthetic",mimeType:"image/png"}]}}:f.event;
  assert.equal(await f.host.middleware(event,ctx),undefined);assert.deepEqual(f.journal.records("owner","owned"),[]);
  if(missing!=="image-result")assert.equal(f.state.budgets.at(-1).state,"unknown");
}));

for(const change of ["compaction","route","foreign-call","parallel-tool"] as const)test(`OpenClaw ${change} cannot return stale budgeted context`,()=>fixture(async f=>{
  f.host.rpc(PEER_BIND,f.input);f.host.budget(f.input);f.state.pending=true;f.state.hold=true;const ctx=f.host.context(f.input);
  const waiting=f.host.middleware(f.event,ctx);await f.received.promise;
  if(change==="compaction")f.host.hooks.get("before_compaction")({},ctx);
  if(change==="route")f.host.config.models.providers.fixture.baseUrl="http://changed.invalid/v1";
  if(change==="foreign-call")f.host.hooks.get("model_call_started")({runId:f.input.runId,sessionId:f.input.sessionId,provider:"foreign",model:"other"},ctx);
  if(change==="parallel-tool")assert.equal(await f.host.middleware({...f.event,toolCallId:"parallel"},ctx),undefined);
  f.release.resolve();assert.equal(await waiting,undefined);
  assert.ok(f.journal.records("owner","owned").every((row:any)=>row.state==="offered"),"ambiguous offers cannot be upgraded to hook evidence");
}));

for(const permission of ["allowPromptInjection","allowConversationAccess","peerContext","version"] as const)test(`OpenClaw respects revoked ${permission} instead of bypassing it with middleware`,()=>fixture(async f=>{
  if(permission==="version"){
    const unsupported=new Host("unqualified");f.scope.defer(()=>unsupported.close());assert.equal(unsupported.rpc(PEER_CAPABILITIES,{version:1}).payload.available,false);assert.equal(unsupported.rpc(PEER_BIND,f.input).ok,false);return;
  }
  f.host.rpc(PEER_BIND,f.input);f.state.pending=true;
  const entry=f.host.config.plugins.entries["agent-phonon-hitl"];
  if(permission==="peerContext")entry.config.peerContext=false;else entry.hooks[permission]=false;
  assert.equal(f.host.rpc(PEER_CAPABILITIES,{version:1}).payload.available,false);
  assert.equal(await f.host.middleware(f.event,f.host.context(f.input)),undefined);assert.equal(f.state.inbox,0);
  if(permission==="peerContext")entry.config.peerContext=true;else entry.hooks[permission]=true;
  assert.equal(await f.host.middleware(f.event,f.host.context(f.input)),undefined,"renewing config does not resurrect a retired grant");
}));

test("OpenClaw cancellation and pending human decisions leave peer context unapplied",()=>fixture(async f=>{
  f.host.rpc(PEER_BIND,f.input);f.host.budget(f.input);f.state.pending=true;f.state.blocked=true;
  assert.equal(await f.host.middleware(f.event,f.host.context(f.input)),undefined);assert.equal(f.state.inbox,0);
  f.state.blocked=false;f.state.hold=true;
  const waiting=f.host.middleware({...f.event,toolCallId:"held"},f.host.context(f.input));await f.received.promise;f.host.connection.abort();
  await new Promise<void>((resolve,reject)=>{
    const signal:AbortSignal=f.state.requestSignal;if(signal.aborted){resolve();return;}
    const done=()=>{clearTimeout(timer);signal.removeEventListener("abort",done);resolve();};
    const timer=setTimeout(()=>{signal.removeEventListener("abort",done);reject(new Error("Peer checkpoint did not observe disconnect"));},1000);
    signal.addEventListener("abort",done,{once:true});
  });
  f.release.resolve();assert.equal(await waiting,undefined);assert.equal(f.journal.records("owner","owned").length,0);
}));

test("OpenClaw peer middleware never changes failure or pending-approval results",()=>fixture(async f=>{
  f.host.rpc(PEER_BIND,f.input);f.state.pending=true;
  for(const event of [{...f.event,isError:true},{...f.event,result:{...f.result,details:{status:"approval-pending"}}},{...f.event,result:{...f.result,details:{status:"failed"}}}]){
    assert.equal(await f.host.middleware(event,f.host.context(f.input)),undefined);
  }
  assert.equal(f.state.inbox,0);
}));

test("installed OpenClaw native middleware runner accepts the sourced peer block without replacing original content",{
  skip:!process.env.PHONON_TEST_OPENCLAW_SDK,timeout:20000,
},()=>fixture(async f=>{
  const previous=process.env.HOME;process.env.HOME=f.scope.root;f.scope.defer(()=>{if(previous===undefined)delete process.env.HOME;else process.env.HOME=previous;});
  const sdk=await import(pathToFileURL(join(process.env.PHONON_TEST_OPENCLAW_SDK!,"agent-harness-runtime.js")).href);
  f.host.rpc(PEER_BIND,f.input);f.state.pending=true;
  f.host.budget(f.input);
  const runner=sdk.createAgentToolResultMiddlewareRunner(f.host.context(f.input),[f.host.middleware]);
  const result=await runner.applyToolResultMiddleware(f.event);
  assert.equal(result.content.length,2);assert.ok(result.content[1].text.includes(f.message.text));assert.deepEqual(result.details,f.result.details);
  assert.deepEqual(projectOpenClawToolResult(result,{projectionId:f.input.projectionId,runId:f.input.runId,sessionId:f.input.sessionId}),f.result);
}));

for(const phase of ["baseline","midturn","initial","headroom","unknown_budget","resume","engine","engine_send","native_context",
  "insert","insert_revoked","insert_headroom","insert_unknown","insert_closed","insert_stop","insert_engine"] as const)test(`installed OpenClaw Gateway ${phase} keeps collaboration out of human messages and ordinary tool output`,{
  skip:!process.env.PHONON_TEST_OPENCLAW_SDK,timeout:60000,
},()=>nativeFixture(async f=>{
  f.state.pending=phase==="initial"||phase==="headroom"||phase==="unknown_budget";
  const ordinary=phase.startsWith("insert"),marker="OPENCLAW_INSERT_"+randomUUID();
  let insertion:Promise<unknown>|undefined,stopping:Promise<void>|undefined,inserted=false,checks=0,insertEngine:SessionEngine|undefined,insertSessionId:string|undefined,insertAck:any;
  const workspace=join(f.scope.root,"workspace"),stateDir=join(f.scope.root,"native"),artifact=join(f.scope.root,"plugin");mkdirSync(workspace);mkdirSync(stateDir);
  writeFileSync(join(workspace,"input.txt"),"Actual OpenClaw native fixture bytes\n");
  const prepare=new URL("../../openclaw-plugin/scripts/prepare-artifact.mjs",import.meta.url);
  execFileSync(process.execPath,[fileURLToPath(prepare),artifact],{encoding:"utf8",stdio:"pipe"});
  const errors:unknown[]=[],requests:any[]=[],events:any[]=[],nativeFrames:any[]=[],abort=new AbortController();
  const outgoing={operation:"send" as const,requestId:randomUUID(),recipientId:randomUUID(),kind:"notice" as const,text:"OPENCLAW_IMPACT_"+randomUUID()};
  const provider=createServer((req,res)=>{
    void(async()=>{
      if(req.method!=="POST"){req.resume();res.writeHead(200,{"Content-Type":"application/json"}).end('{"data":[]}');return;}
      let body="";for await(const chunk of req)body+=String(chunk);const payload=JSON.parse(body);
      const main=payload.tools?.some((tool:any)=>tool.function?.name==="read");requests.push({main,model:payload.model,names:(payload.tools??[]).map((tool:any)=>tool.function?.name),cap:payload.max_completion_tokens??payload.max_tokens});
      const index=requests.filter(request=>request.main).length;assert.ok(requests.length<=(phase==="resume"?6:4),"unexpected auxiliary inference");
      const receivesInput=ordinary&&!["insert_revoked","insert_headroom","insert_unknown","insert_closed","insert_stop"].includes(phase)&&index===2;
      if(main){
        assert.equal(body.includes(marker),receivesInput,"ordinary input belongs only to the original native model continuation");
        if(ordinary&&index===1){
          assert.ok(f.state.session);
          insertion=insertEngine?insertEngine.send("owner",insertSessionId!,marker,{turnId:"turn",expectedActiveTurnId:"turn",whenBusy:"inject"}).then(value=>{insertAck=value;}):
            f.state.session.insertAtToolGap!(marker,{turnId:"turn",signal:AbortSignal.any([abort.signal,AbortSignal.timeout(25000)]),
              ...(phase==="insert_revoked"?{beforeApply(){if(++checks>1)throw new Error("Original input source withdrawn");}}:{})});
          assert.ok(insertion);void insertion.then(()=>{inserted=true;},()=>{});
          if(phase==="insert_stop"){abort.abort();stopping=f.state.session.interrupt!();void stopping?.catch(()=>{});return;}
        }
      }
      if(main){assert.ok(index<=(phase==="resume"?4:2),"unexpected native inference loop");assert.equal(body.includes(f.message.text),["initial","midturn","resume","engine","native_context"].includes(phase)&&index%2===0,"new peer must enter the same native run's continuation with headroom");
        if(!["unknown_budget","insert_unknown"].includes(phase))assert.ok(tokens(requests.at(-1).cap)&&requests.at(-1).cap<=(["headroom","insert_headroom"].includes(phase)?60000:2000),"actual native request must stay within the reserved output ceiling");
        assert.equal(body.includes(PEER_BLOCK_TAG),false,"carrier-only metadata must not be sent as provider content fields");}
      if(main&&phase==="engine_send"){
        assert.ok(payload.tools.some((tool:any)=>tool.function?.name==="phonon_project_coordination"),"coordination-only tool must be natively callable");
        assert.ok(!payload.tools.some((tool:any)=>/phonon_(request_interaction|acknowledge_interaction|conversation_message|workflow|conversation_board)/.test(tool.function?.name??"")),"project-only execution must not acquire human/group tools");
      }
      res.writeHead(200,{"Content-Type":"text/event-stream"});
      const send=(delta:any,finish_reason:string|null)=>res.write("data: "+JSON.stringify({id:"controlled_"+requests.length,object:"chat.completion.chunk",created:1,model:payload.model,
        choices:[{index:0,delta,finish_reason}]})+"\n\n");
      if(main&&index%2===1&&phase!=="insert_closed"){
        if(phase!=="engine_send")f.state.pending=true;
        send({role:"assistant",tool_calls:[{index:0,id:"read_once_"+index,type:"function",function:{name:phase==="engine_send"?"phonon_project_coordination":"read",arguments:JSON.stringify(phase==="engine_send"?outgoing:{path:join(workspace,"input.txt")})}}]},null);send({},"tool_calls");
      }else{
        if(main&&phase!=="insert_closed")assert.ok(body.includes(phase==="engine_send"?"recorded":"Actual OpenClaw native fixture bytes"));send({role:"assistant",content:main?"Original OpenClaw task complete":"Controlled helper response"},null);
        if(main&&receivesInput){await insertion;assert.equal(inserted,true);assert.equal(events.some(event=>event.final),false,"insertion must be accepted before native task completion");}
        if(main&&phase==="native_context"&&index===2){
          const deadline=Date.now()+5000;while(!f.state.applications.length&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,10));
          assert.equal(f.state.applications.length,1,"native context must be confirmed before the original task completes");
          assert.equal(events.some(event=>event.final),false);
        }
        send({},"stop");
      }
      res.end("data: [DONE]\n\n");
    })().catch(error=>{errors.push(error);abort.abort();res.destroy();});
  });
  f.scope.defer(()=>closePeerServer(provider));await new Promise<void>(resolve=>provider.listen(0,"127.0.0.1",resolve));
  const reservation=createServer();f.scope.defer(()=>closePeerServer(reservation));await new Promise<void>(resolve=>reservation.listen(0,"127.0.0.1",resolve));
  const port=(reservation.address()as{port:number}).port;await closePeerServer(reservation);
  const configPath=join(stateDir,"openclaw.json"),token="isolated-gateway-"+randomUUID();
  const config={gateway:{mode:"local",port,bind:"loopback",auth:{mode:"token",token}},browser:{enabled:false},logging:{file:join(stateDir,"gateway.log")},
    discovery:{mdns:{mode:"off"}},cron:{enabled:false},tools:{codeMode:false,toolSearch:false,allow:phase==="engine_send"?["read","phonon_project_coordination"]:["read"]},
    agents:{defaults:{workspace,model:"phonon-fixture/m1"},entries:{worker:{workspace,model:"phonon-fixture/m1"}}},
    models:{mode:"merge",providers:{"phonon-fixture":{baseUrl:`http://127.0.0.1:${(provider.address()as{port:number}).port}/v1`,apiKey:"controlled-local-key",api:"openai-completions",
      agentRuntime:{id:"openclaw"},models:[{id:"m1",name:"Controlled local fixture",reasoning:false,input:["text"],contextWindow:128000,maxTokens:["headroom","insert_headroom"].includes(phase)?60000:2000,...(["unknown_budget","insert_unknown"].includes(phase)?{params:{maxTokens:0}}:{})}]}}},
    plugins:{enabled:true,allow:["agent-phonon-hitl"],load:{paths:[artifact]},entries:{"agent-phonon-hitl":{enabled:true,hooks:{allowPromptInjection:true,allowConversationAccess:true},
      config:{peerContext:true,nativeInteractions:false,interceptTools:["fixture-no-legacy-hook"]}}}}};
  const originalConfig=JSON.stringify(config);writeFileSync(configPath,originalConfig,{mode:0o600});
  const entry=join(process.env.PHONON_TEST_OPENCLAW_SDK!,"../../openclaw.mjs");
  const native=spawnSupervisedAgent(process.execPath,[entry,"gateway","run","--port",String(port),"--bind","loopback"],{cwd:workspace,env:{PATH:process.env.PATH,HOME:f.scope.root,USERPROFILE:f.scope.root,
    TMPDIR:f.scope.root,TMP:f.scope.root,TEMP:f.scope.root,NODE_COMPILE_CACHE:f.compileDirectory,OPENCLAW_STATE_DIR:stateDir,OPENCLAW_CONFIG_PATH:configPath,OPENCLAW_GATEWAY_TOKEN:token,
    HTTP_PROXY:"",HTTPS_PROXY:"",ALL_PROXY:"",http_proxy:"",https_proxy:"",all_proxy:""}});
  const retireCache=f.compileCache.watch(native.child,true);f.scope.defer(retireCache);
  f.scope.watch(native.child,true);f.scope.defer(async()=>{
    await native.terminate();const deadline=Date.now()+3000;
    while(!native.hasStopped()&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,20));
    assert.ok(native.hasStopped(),"owned Gateway process group must settle before fixture removal");
  });let logs="";
  native.child.stdout.on("data",chunk=>{logs=(logs+String(chunk)).slice(-18000);});native.child.stderr.on("data",chunk=>{logs=(logs+String(chunk)).slice(-18000);});native.child.stdin.end();
  const gateway={baseUrl:`ws://127.0.0.1:${port}`,token},probe=new GatewayClient(gateway);f.scope.defer(()=>probe.close());
  let ready=false;const deadline=Date.now()+15000;
  while(Date.now()<deadline&&!native.hasStopped()){
    try{const response=await probe.rpc(PEER_CAPABILITIES,{version:1},1000);if(response.available===true){ready=true;break;}}catch{}
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  assert.equal(ready,true,logs.replaceAll(token,"[redacted]"));probe.close();
  // Native startup owns schema migrations; collaboration must not mutate the settled config.
  const settledConfig=readFileSync(configPath,"utf8");assert.deepEqual(JSON.parse(settledConfig).tools,config.tools);
  const adapter=new OpenClawGatewayAdapter({gateway,defaultAgent:"worker"});f.scope.defer(()=>adapter.close());
  if(phase==="insert_stop"){
    (adapter as unknown as{gw:GatewayClient}).gw.onEvent((event,payload)=>{
      if(nativeFrames.length<128&&["chat","agent"].includes(event))nativeFrames.push({event,runId:payload.runId,sessionKey:payload.sessionKey,state:payload.state,
        stream:payload.stream,phase:(payload.data as any)?.phase});
    });
  }
  if(ordinary){const inventory=await adapter.discoverAgents();assert.equal(inventory.find(row=>row.agentId==="openclaw:worker")?.capabilities.injectMidTurn,true);}
  if(phase==="native_context"){
    const gw=(adapter as unknown as{gw:GatewayClient}).gw,bind=gw.bindPeerContext.bind(gw);
    gw.bindPeerContext=(input,environment)=>bind({...input,nativeInput:true},environment);
  }
  if(phase==="engine"||phase==="engine_send"||phase==="insert_engine"){
    const store=new PhononStore(join(f.scope.root,"engine.sqlite"));f.scope.defer(()=>store.close());
    const registry=new AdapterRegistry();registry.register(adapter);
    if(phase==="insert_engine"){const create=adapter.createSession.bind(adapter);adapter.createSession=async params=>f.state.session=await create(params);}
    const calls:any[]=[],runId=randomUUID(),engine=new SessionEngine(registry,event=>events.push(event),undefined,store,phase==="insert_engine"?undefined:{projectCoordination:async request=>{
      calls.push(request);const self={...f.self,sessionId:request.sessionId};
      if(request.action.operation==="send"){
        assert.deepEqual(request.action,{...outgoing,references:[]});
        return {self,status:"recorded" as const,requestId:outgoing.requestId,message:{...f.message,id:randomUUID(),senderId:self.id,recipientId:outgoing.recipientId,text:outgoing.text}};
      }
      return request.action.operation==="peers"?{self,participants:[],next:null}:{self,messages:f.state.pending?[f.message]:[],next:null};
    }},"owner");f.scope.defer(()=>engine.dispose());
    const owned=await engine.create({tenantId:"owner",project:"openclaw-project",cwd:workspace,agent:"openclaw:worker",model:"phonon-fixture/m1",verbosity:"tools",
      workflowAttr:{workflowId:"owned-workflow",nodeId:"reply",nativeRunId:runId}});
    if(phase==="insert_engine"){insertEngine=engine;insertSessionId=owned.sessionId;}
    const turn=await engine.send("owner",owned.sessionId,"Read input.txt once, then finish the original task.",phase==="insert_engine"?{turnId:"turn"}:{});
    for(let n=0;n<1000&&!events.some(event=>event.final);n++)await new Promise(resolve=>setTimeout(resolve,20));
    await engine.settleTurn("owner",owned.sessionId,turn.turnId);
    const diagnostic=JSON.stringify({events,calls,errors:errors.map(String)});
    assert.deepEqual(errors,[],diagnostic);assert.equal(events.at(-1)?.status,"completed",diagnostic);
    if(phase==="insert_engine"){
      assert.ok(insertion);await insertion;assert.deepEqual(insertAck,{turnId:"turn",disposition:"injected"});
      assert.equal(store.peerContextJournal().records("owner",owned.sessionId).length,0,"ordinary input cannot manufacture peer receipts");
      assert.equal(requests.filter(request=>request.main).length,2);assert.equal(readFileSync(configPath,"utf8"),settledConfig);return;
    }
    const records=store.peerContextJournal().records("owner",owned.sessionId);assert.equal(records.length,phase==="engine_send"?0:1,diagnostic);
    if(phase==="engine"){assert.equal(records[0]?.state,"context_hook");assert.equal(records[0]?.turnId,turn.turnId);}
    else{assert.equal(calls.filter(call=>call.action.operation==="send").length,1);assert.equal(JSON.stringify(events).includes(outgoing.text),false,"private coordination tool/result must not become a human stream event");}
    assert.ok(calls.every(call=>call.sessionId===owned.sessionId&&call.runId===runId));
    assert.equal(JSON.stringify(events).includes(f.message.text),false);assert.equal(readFileSync(configPath,"utf8"),settledConfig);return;
  }
  const session=await adapter.createSession({sessionId:f.self.sessionId,agentId:"openclaw:worker",model:"phonon-fixture/m1",cwd:workspace});f.state.session=session;f.scope.defer(()=>session.terminate());
  await session.preparePeerContext?.(f.environment,AbortSignal.timeout(10000));assert.ok(session.peerContextCapability?.(),logs.replaceAll(token,"[redacted]"));
  let testedStaleRun=false;
  await session.send("Read input.txt once, then finish the original task.",{turnId:"turn",verbosity:"tools",...(phase==="baseline"||ordinary?{}:{peerContext:f.receiver}),environment:f.environment,
    signal:AbortSignal.any([abort.signal,AbortSignal.timeout(25000)]),emit:event=>{
      events.push(event);
      if(!testedStaleRun&&event.type==="tool_call"){
        testedStaleRun=true;
        (session as AdapterSession&{handleEvent:(event:string,payload:Record<string,unknown>)=>void}).handleEvent("agent",{
          sessionKey:"agent:worker:phonon-owned",runId:randomUUID(),stream:"tool",data:{phase:"result",name:"read",toolCallId:"stale-tool",result:{content:[{type:"text",text:f.message.text}]}}});
      }
    }});
  if(phase==="resume"){
    const original=session.peerContextCapability?.()?.nativeSessionId;f.message.id=randomUUID();f.message.text="OPENCLAW_RESUME_"+randomUUID();f.state.pending=false;
    await session.preparePeerContext?.(f.environment,AbortSignal.timeout(10000));
    if(!session.peerContextCapability?.()){
      const history=await probe.rpc("chat.history",{sessionKey:"agent:worker:phonon-owned",agentId:"worker",limit:4,offset:0,maxBytes:32768,maxChars:512},5000);
      assert.fail(JSON.stringify({history,logs}).replaceAll(token,"[redacted]").replaceAll(f.input.token,"[redacted]"));
    }
    assert.equal(session.peerContextCapability?.()?.nativeSessionId,original);
    await session.send("Continue the original session; read input.txt once and finish.",{turnId:"resumed",verbosity:"tools",peerContext:f.receiver,environment:f.environment,
      signal:AbortSignal.any([abort.signal,AbortSignal.timeout(25000)]),emit:event=>events.push(event)});
    assert.equal(session.peerContextCapability?.()?.nativeSessionId,original);assert.equal(f.journal.records("owner","owned").length,2);
  }
  const diagnostic=JSON.stringify({requests,budgets:f.state.budgets,errors:errors.map(String),events,logs}).replaceAll(token,"[redacted]").replaceAll(f.input.token,"[redacted]");
  if(phase==="insert_stop"){
    await stopping;const deadline=Date.now()+5000;let proof=await session.observeNativeStop?.("turn");
    while(!proof&&Date.now()<deadline){await new Promise(resolve=>setTimeout(resolve,20));proof=await session.observeNativeStop?.("turn");}
    assert.equal(proof,"native_terminal","stop must be observed on the original native run: "+JSON.stringify({events,nativeFrames}));
  }
  assert.deepEqual(errors,[],diagnostic);assert.equal(events.at(-1)?.status,phase==="insert_stop"?"interrupted":"completed",diagnostic);
  if(phase!=="insert_stop")assert.equal(events.at(-1).text,"Original OpenClaw task complete",diagnostic);
  if(ordinary){
    assert.ok(insertion);if(["insert_revoked","insert_headroom","insert_unknown","insert_closed","insert_stop"].includes(phase))await assert.rejects(insertion);else await insertion;
    if(phase==="insert_revoked")assert.equal(checks,2);assert.equal(f.state.budgets.length,0,"ordinary input uses its own checkpoint and admission");
  }
  assert.equal(requests.filter(request=>request.main).length,phase==="resume"?4:["insert_closed","insert_stop"].includes(phase)?1:2,diagnostic);assert.equal(JSON.stringify(events).includes(f.message.text),false,"routine tool events must omit the peer carrier");
  assert.equal(testedStaleRun,!["insert_closed","insert_stop"].includes(phase),"a foreign-run result must be tested during a real native tool call");assert.equal(events.some(event=>event.toolCallId==="stale-tool"),false);
  assert.equal(f.journal.records("owner","owned")[0]?.state,ordinary||["baseline","headroom","unknown_budget"].includes(phase)?undefined:"context_hook",diagnostic);assert.equal(readFileSync(configPath,"utf8"),settledConfig,"collaboration must retain native config");
  if(phase!=="baseline"&&!ordinary)assert.equal(f.state.budgets[0]?.state,phase==="native_context"?"known":"unknown",diagnostic);
  if(phase==="headroom"){assert.equal(f.state.budgets.at(-1)?.state,"known",diagnostic);assert.equal(peerContextHeadroom(f.state.budgets.at(-1)),0,diagnostic);}
  if(phase==="unknown_budget")assert.ok(f.state.budgets.every((budget:any)=>budget.state==="unknown"),diagnostic);
  if(["initial","midturn"].includes(phase))assert.equal(f.state.budgets.at(-1)?.contextWindowTokens,128000,diagnostic);
  const history=await probe.rpc("chat.history",{sessionKey:"agent:worker:phonon-owned",agentId:"worker",limit:20,offset:0,maxBytes:65536,maxChars:20000},5000);
  const visible=(history.messages as any[]).filter(message=>["user","assistant"].includes(message.role??message.message?.role));
  assert.ok(visible.length>=(phase==="insert_stop"?1:2),"native human transcript rows must be observed");
  assert.equal(JSON.stringify(visible).includes(f.message.text),false,"peer context must not be stored as human/assistant chat prose");
  if(ordinary)assert.equal(JSON.stringify(visible).includes(marker),false,"insertion is not an extra native user message");
}));
