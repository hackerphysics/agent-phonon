import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { GatewayClient, OpenClawGatewayAdapter, OpenClawAdapter } from "@agent-phonon/core";
import { NativeInteractionTools, BIND_METHOD, REQUEST_TOOL } from "@agent-phonon/openclaw-plugin/native-interactions";
import { NativeToolPolicy, deriveToolPolicy, POLICY_BIND, POLICY_CONFIRM, POLICY_RELEASE, BLOCKED_NATIVE_TOOLS } from "@agent-phonon/openclaw-plugin/tool-policy";
import { withPeerFixture } from "../../core/dist/testing/peer-fixture.js";

const catalog = (agentId="main") => ({agentId,profiles:[],groups:[
  {source:"core",tools:["read","write","exec","web_fetch",...BLOCKED_NATIVE_TOOLS].map(id=>({id}))},
  {source:"plugin",tools:["unrelated_plugin_tool","phonon_request_interaction","phonon_conversation_message"].map(id=>({id}))},
],effective:{agentId,groups:[{source:"channel",tools:[{id:"fixture_channel_read",source:"channel"},{id:"fixture_channel",source:"channel"}]}]}});

test("dynamic catalog policy preserves unrelated tools without plugin groups or native escape routes",()=>{
  const allowed=deriveToolPolicy(catalog(),"main",name=>name==="fixture_channel");
  for(const name of ["read","write","exec","web_fetch","unrelated_plugin_tool","phonon_request_interaction","phonon_conversation_message","fixture_channel_read","wait","tool_search","tool_describe","tool_call","*__*","lsp_*"])assert.ok(allowed.includes(name),name);
  for(const name of [...BLOCKED_NATIVE_TOOLS,"fixture_channel","*","group:plugins"])assert.ok(!allowed.includes(name),name);
  for(const bad of [catalog("other"),{...catalog(),groups:[]},
    {...catalog(),groups:[{source:"core",tools:[{id:"read"},{id:"read"}]}]},
    {...catalog(),groups:[{source:"plugin",tools:[{id:"group:plugins"}]}]},
    {...catalog(),groups:[{source:"plugin",tools:[{id:"READ"}]}]},
    {...catalog(),groups:[{source:"plugin",tools:[{id:"*"}]}]},
    {...catalog(),groups:[{source:"channel",tools:[{id:"send"}]}]},
  ])assert.throws(()=>deriveToolPolicy(bad,"main"));
});

function fixture(){
  const policy=new NativeToolPolicy({resolveRuntime:()=>"openclaw",isMessagingTool:name=>name==="fixture_channel"}),methods=new Map<string,any>(),hooks=new Map<string,any[]>();
  const connection=new AbortController(),resource=new AbortController(),sessionKey="agent:main:phonon-policy-test",sessionId=randomUUID();
  const config:any={plugins:{entries:{"agent-phonon-hitl":{enabled:true,hooks:{allowPromptInjection:true,allowConversationAccess:true}}}},tools:{codeMode:false,toolSearch:false},agents:{entries:{main:{}}}};
  let entry:any={sessionId,modelProvider:"local",model:"m1"};
  const client:any={connId:randomUUID(),connect:{role:"operator",scopes:["operator.admin"]},connectionSignal:connection.signal};
  let evaluator:any,cleanup:any;
  policy.register({id:"agent-phonon-hitl",runtime:{version:"2026.10.7",config:{current:()=>config},agent:{session:{getSessionEntry:()=>entry}}},
    registerGatewayMethod:(name:any,handler:any,options:any)=>{assert.deepEqual(options,{scope:"operator.write",sessionAccess:{mode:"write"}});methods.set(name,handler);},on:(name:any,handler:any)=>hooks.set(name,[...(hooks.get(name)??[]),handler]),
    registerTrustedToolPolicy:(value:any)=>{evaluator=value.evaluate;},lifecycle:{registerRuntimeLifecycle:(value:any)=>{cleanup=value.cleanup;}}});
  const input={version:1,sessionKey,sessionId,runId:randomUUID(),policyId:randomUUID(),agentId:"main",model:"local/m1",expiresAt:Date.now()+60000,catalog:catalog()};
  const ctx={sessionKey,sessionId,runId:input.runId,agentId:"main"};
  const controllers=new Map<string,any>();
  const start=(params=input)=>{
    const entry={controller:new AbortController(),sessionKey:params.sessionKey,sessionId:params.sessionId,agentId:params.agentId,ownerConnId:client.connId};
    controllers.set(params.runId,entry);return entry;
  };
  start();
  let retained=0;
  const access={target:{sessionKey,sessionId,agentId:"main"},assertCurrent:()=>resource.signal.throwIfAborted(),retain:()=>{
    let released=false;retained++;
    return {signal:resource.signal,assertCurrent:()=>{resource.signal.throwIfAborted();assert.equal(released,false);},release:()=>{if(!released){released=true;retained--;}}};
  }};
  const rpc=async(method:string,params:any=input,who=client,current=()=>true,context:any={chatAbortControllers:controllers},sessionAccessAuthority:any=access)=>{let result:any;await methods.get(method)({params,client:who,context,sessionAccessAuthority,hasCurrentClientAuthority:current,respond:(ok:boolean,payload:any,error:any)=>{result={ok,payload,error};}});return result;};
  const call=(toolName:string,context:any=ctx,event:any={})=>evaluator({toolName,params:{},runId:context.runId,toolCallId:randomUUID(),...event},context);
  return {policy,input,ctx,client,config,connection,resource,access,retained:()=>retained,hooks,rpc,call,start,controllers,evaluator:()=>evaluator,cleanup:()=>cleanup({}),changeEntry:(value:any)=>{entry=value;}};
}

test("policy binding requires live admin, exact native identity and safe qualified surface",async()=>{
  const f=fixture();try{
    for(const who of [null,{...f.client,connId:"foreign",connect:{role:"operator",scopes:["operator.write"]}},{...f.client,connectionSignal:undefined}])assert.equal((await f.rpc(POLICY_BIND,f.input,who)).ok,false);
    assert.equal((await f.rpc(POLICY_BIND,f.input,f.client,()=>false)).ok,false);
    assert.equal((await f.rpc(POLICY_BIND,f.input,f.client,()=>true,{})).ok,false);
    assert.equal((await f.rpc(POLICY_BIND,f.input,f.client,()=>true,undefined,null)).ok,false);
    assert.equal((await f.rpc(POLICY_BIND,f.input,f.client,()=>true,undefined,{...f.access,target:{...f.access.target,sessionId:randomUUID()}})).ok,false);
    for(const patch of [{sessionId:randomUUID()},{agentId:"other"},{sessionKey:"agent:main:personal"},{model:"local/other"},{expiresAt:Date.now()-1},{toolsDeny:["message"]}])assert.equal((await f.rpc(POLICY_BIND,{...f.input,...patch})).ok,false);
    const bound=await f.rpc(POLICY_BIND);assert.equal(bound.ok,true);assert.equal(bound.payload.policyId,f.input.policyId);
    assert.deepEqual(await f.rpc(POLICY_BIND),bound);
    assert.equal((await f.rpc(POLICY_BIND,{...f.input,runId:randomUUID()})).ok,false);
    assert.equal((await f.rpc(POLICY_CONFIRM,f.input,{...f.client,connId:"foreign"})).ok,false);
    assert.equal((await f.rpc(POLICY_RELEASE,f.input,{...f.client,connId:"foreign"})).ok,false);
  }finally{f.cleanup();}
});

test("default Code Mode, Tool Search and configured personal channels do not require global changes",async()=>{
  for(const mode of ["default","code-mode","tool-search","channels"]){
    const f=fixture();try{
      if(mode==="default")delete f.config.tools;
      if(mode==="code-mode")f.config.tools.codeMode=true;
      if(mode==="tool-search")f.config.tools.toolSearch=true;
      if(mode==="channels")f.config.channels={example:{enabled:true}};
      const original=JSON.stringify(f.config);
      assert.equal((await f.rpc(POLICY_BIND)).ok,true,mode);
      f.hooks.get("before_prompt_build")![0]({},f.ctx);
      for(const name of ["exec","wait","tool_search","tool_describe","tool_call","fixture_channel_read"])assert.equal(f.call(name),undefined,name);
      assert.equal(f.call("exec",f.ctx,{toolKind:"code_mode_exec"}),undefined);
      assert.equal(f.call("fixture_channel")?.block,true);
      assert.equal(f.call("ask_user")?.block,true);
      assert.equal(JSON.stringify(f.config),original);
    }finally{f.cleanup();}
  }
});

test("initial and switched native model overrides are qualified instead of trusting stale last-run model facts",async()=>{
  const f=fixture();try{
    f.changeEntry({sessionId:f.input.sessionId,model:"stale",modelProvider:"old",providerOverride:"local",modelOverride:"m1"});
    assert.equal((await f.rpc(POLICY_BIND)).ok,true);
    assert.equal((await f.rpc(POLICY_CONFIRM)).ok,true);
  }finally{f.cleanup();}
});

test("old generation release and agent-end cannot revoke a subsequent owner-bound run",async()=>{
  const f=fixture();try{
    const old={...f.input};assert.equal((await f.rpc(POLICY_BIND)).ok,true);
    assert.equal((await f.rpc(POLICY_RELEASE)).payload.released,true);
    f.input.runId=randomUUID();f.input.policyId=randomUUID();
    const ctx={...f.ctx,runId:f.input.runId};
    const current=f.start();
    assert.equal((await f.rpc(POLICY_BIND)).ok,true);
    f.hooks.get("before_prompt_build")![0]({},ctx);
    assert.equal((await f.rpc(POLICY_RELEASE,old)).ok,false);
    for(const end of f.hooks.get("agent_end")??[])end({},f.ctx);
    assert.equal(current.controller.signal.aborted,false);
    assert.equal(f.call("read",ctx),undefined);
    assert.equal((await f.rpc(POLICY_CONFIRM)).ok,true);
  }finally{f.cleanup();}
});

test("native policy hides and blocks interactive and delegation tools; no prefix grants authority",async()=>{
  const f=fixture();try{
    assert.equal(f.call("ask_user"),undefined,"a prefix alone must not classify a personal run");
    assert.equal((await f.rpc(POLICY_BIND)).ok,true);
    const prompt=f.hooks.get("before_prompt_build")![0]({},f.ctx);
    assert.ok(prompt.toolsAllow.includes("read"));assert.ok(prompt.toolsAllow.includes("phonon_request_interaction"));
    assert.equal(f.hooks.get("before_agent_run")![0]({},f.ctx),undefined);
    for(const name of BLOCKED_NATIVE_TOOLS)assert.equal(f.call(name)?.block,true,name);
    for(const name of ["read","write","web_fetch","phonon_request_interaction","phonon_conversation_message","unrelated_plugin_tool","new_server__read","lsp_definition"])assert.equal(f.call(name),undefined,name);
    assert.equal(f.call("exec",f.ctx,{toolKind:"code_mode_exec"}),undefined);
    assert.equal(f.call("fixture_channel")?.block,true);
    assert.equal(f.call("read",{...f.ctx,runId:randomUUID()})?.block,true);
    assert.equal(f.call("read",{...f.ctx,sessionId:randomUUID()})?.block,true);
    assert.equal(f.call("read",f.ctx,{runId:randomUUID()})?.block,true);
    const personal={sessionKey:"agent:main:personal",sessionId:randomUUID(),runId:randomUUID(),agentId:"main"};
    assert.equal(f.call("ask_user",personal),undefined);
    assert.equal(f.call("sessions_spawn",personal),undefined);
    assert.equal(f.call("read",{...f.ctx,sessionKey:undefined})?.block,true);
    assert.equal(f.call("read",{...f.ctx,sessionKey:f.input.sessionKey+":subagent:child"})?.block,true);
    assert.equal(f.hooks.get("before_agent_run")![0]({},{...f.ctx,runId:randomUUID()}).outcome,"block");
  }finally{f.cleanup();}
});

test("native controller identity is mandatory and revocation never aborts a replacement",async()=>{
  for(const mode of ["missing","session","agent","owner","aborted"]){
    const f=fixture();try{
      const entry=f.controllers.get(f.input.runId);
      if(mode==="missing")f.controllers.delete(f.input.runId);
      if(mode==="session")entry.sessionId=randomUUID();
      if(mode==="agent")entry.agentId="other";
      if(mode==="owner")entry.ownerConnId=randomUUID();
      if(mode==="aborted")entry.controller.abort();
      assert.equal((await f.rpc(POLICY_BIND)).ok,true);
      assert.deepEqual(f.hooks.get("before_prompt_build")![0]({},f.ctx),{toolsAllow:[]},mode);
      assert.equal(f.call("read")?.block,true,mode);
      assert.equal(entry.controller.signal.aborted,mode==="aborted",mode);
    }finally{f.cleanup();}
  }
  const f=fixture();try{
    const original=f.controllers.get(f.input.runId);
    assert.equal((await f.rpc(POLICY_BIND)).ok,true);
    f.hooks.get("before_prompt_build")![0]({},f.ctx);
    const replacement=f.start();
    assert.equal(f.call("read")?.block,true);
    assert.equal(original.controller.signal.aborted,true);
    assert.equal(replacement.controller.signal.aborted,false);
    assert.equal((await f.rpc(POLICY_RELEASE)).ok,true);
    assert.equal(replacement.controller.signal.aborted,false);
  }finally{f.cleanup();}
});

test("completed provenance is bounded without classifying later personal prefix collisions",async()=>{
  const f=fixture();try{
    for(let index=0;index<270;index++){
      if(index){f.input.runId=randomUUID();f.input.policyId=randomUUID();f.start();}
      const ctx={...f.ctx,runId:f.input.runId};
      assert.equal((await f.rpc(POLICY_BIND)).ok,true);
      f.hooks.get("before_prompt_build")![0]({},ctx);
      assert.equal((await f.rpc(POLICY_RELEASE)).ok,true);
      assert.equal(f.controllers.get(f.input.runId).controller.signal.aborted,true);
      f.controllers.delete(f.input.runId);
      assert.equal(f.call("read",ctx)?.block,true);
    }
    assert.ok((f.policy as any).knownRuns.size<=256);
    assert.equal(f.call("ask_user",{...f.ctx,runId:randomUUID()}),undefined);
  }finally{f.cleanup();}
});

test("never-dispatched release discards provenance only before any native controller exists",async()=>{
  const f=fixture();try{
    f.controllers.delete(f.input.runId);
    assert.equal((await f.rpc(POLICY_BIND)).ok,true);
    assert.equal((await f.rpc(POLICY_RELEASE,{...f.input,dispatched:false})).ok,true);
    assert.equal((await f.rpc(POLICY_BIND)).ok,true);
    const native=f.start();
    f.hooks.get("before_prompt_build")![0]({},f.ctx);
    assert.equal((await f.rpc(POLICY_RELEASE,{...f.input,dispatched:false})).ok,true);
    assert.equal(native.controller.signal.aborted,true);
    assert.equal((await f.rpc(POLICY_BIND)).ok,false);
    assert.equal(f.call("read")?.block,true);
  }finally{f.cleanup();}
});

test("client requires matching policy/catalog proof and the original connection epoch; never reconnects a dispatch",async()=>{
  const client:any=new GatewayClient({baseUrl:"ws://127.0.0.1:1",token:"synthetic-secret"});
  const calls:any[]=[];let mode="ok",bound:any;
  Object.assign(client,{connected:true,epoch:1});client.connect=async()=>{};
  client.rpc=async(method:string,params:any)=>{
    calls.push({method,params});
    if(method==="tools.catalog")return catalog(params.agentId);
    if(method==="tools.effective")return catalog(params.agentId).effective;
    if(method==="phonon.policy.bind"){
      bound={version:1,bound:true,policy:"phonon-noninteractive-v1",nativeVersion:"2026.10.7",policyId:params.policyId,
        sessionKey:params.sessionKey,sessionId:params.sessionId,runId:params.runId,catalogHash:createHash("sha256").update(JSON.stringify(params.catalog)).digest("hex"),executionFence:"native-controller-v1"};
      if(mode==="unsupported")throw new Error("secret must not escape");
      return mode==="stale"?{...bound,runId:randomUUID()}:bound;
    }
    if(method==="phonon.policy.confirm")return mode==="stale-confirm"?{...bound,policyId:randomUUID()}:bound;
    return {released:true};
  };
  const input={sessionKey:"agent:main:phonon-client",sessionId:randomUUID(),runId:randomUUID(),agentId:"main",model:"local/m1"};
  try{
    for(mode of ["unsupported","stale"]){await assert.rejects(client.bindNoninteractivePolicy(input),error=>!String(error).includes("secret must not escape"));}
    mode="ok";const policy=await client.bindNoninteractivePolicy(input);await policy.confirm();
    mode="stale-confirm";await assert.rejects(policy.confirm());mode="ok";
    const before=calls.length;client.epoch++;
    await assert.rejects(policy.confirm());await policy.release();
    await assert.rejects(client.rpcOnConnection(policy.epoch,"chat.send",{}));assert.equal(calls.length,before);
    assert.ok(calls.every(call=>call.method!=="chat.send"));
    assert.ok(!JSON.stringify(calls).includes("synthetic-secret"));
  }finally{client.close();}
});

test("ordinary Gateway and native-tool turns require policy; optional reasoning cannot bypass a revoked grant",async()=>{
  const adapter:any=new OpenClawGatewayAdapter({gateway:{baseUrl:"ws://127.0.0.1:1",token:"synthetic"}}),gw:any=adapter.gw;
  let connected=true,epoch=1,mode="ok",session:any,key="",nativeId=randomUUID(),dispatches=0,released=0,confirmed=0;
  const calls:string[]=[];
  gw.connect=async()=>{};gw.isConnected=()=>connected;gw.connectionEpoch=()=>epoch;gw.supportsCapability=()=>true;
  gw.rpc=async(method:string,p:any)=>{
    calls.push(method);
    if(method==="sessions.create"){key=p.key;return {sessionId:nativeId};}
    if(method==="sessions.messages.subscribe")return {};
    if(method==="chat.history")return {sessionKey:key,sessionId:nativeId,messages:[],totalMessages:0,pendingInputs:{items:[],total:0},sessionInfo:{key,sessionId:nativeId,createdAt:1,model:"m1",modelProvider:"local",spawnedCwd:process.cwd(),hasActiveRun:false,activeLeafEntryId:null,archived:false,status:"idle"}};
    if(method==="sessions.patch"){
      if(mode==="revoke")confirmed=-100;
      if(mode==="cancel")abort?.abort();
      if(mode==="disconnect"){connected=false;epoch++;}
      if(mode==="optional-failure")throw new Error("unsupported optional reasoning");
      return {key,entry:{thinkingLevel:p.thinkingLevel}};
    }
    throw new Error("unexpected method "+method);
  };
  let abort:AbortController|undefined;
  gw.bindNoninteractivePolicy=async()=>{
    if(mode==="unsupported")throw new Error("unconfirmed policy");
    const boundEpoch=epoch;
    return {epoch:boundEpoch,release:async()=>{released++;},confirm:async()=>{if(confirmed<0||!connected||epoch!==boundEpoch)throw new Error("revoked policy");confirmed++;}};
  };
  gw.bindNativeInteractions=async()=>async()=>{};
  gw.rpcOnConnection=async(e:number,method:string,p:any)=>{
    assert.equal(e,epoch);assert.equal(connected,true);
    if(method==="agent.wait")return {status:"ok"};
    assert.equal(method,"chat.send");dispatches++;
    assert.equal(p.toolsAllow,undefined);assert.equal(p.toolsDeny,undefined);
    queueMicrotask(()=>session.handleEvent("chat",{runId:p.idempotencyKey,state:"final",finalText:"normal final text"}));return {};
  };
  try{
    session=await adapter.createSession({sessionId:"policy-adapter",model:"local/m1",agentId:"openclaw:main",cwd:process.cwd()});
    const events:any[]=[];
    for(const environment of [undefined,{AGENT_PHONON_INTERACTION_TOKEN:"synthetic"}]){
      mode="ok";await session.send("ordinary input",{turnId:randomUUID(),verbosity:"final",emit:(event:any)=>events.push(event),environment});
    }
    assert.equal(dispatches,2);assert.ok(events.some(event=>event.text==="normal final text"));
    mode="optional-failure";await session.send("no replay",{turnId:randomUUID(),verbosity:"final",emit:()=>{},reasoning:{level:"high"}});assert.equal(dispatches,3);
    for(mode of ["unsupported","revoke","disconnect"]){confirmed=0;connected=true;await assert.rejects(session.send("must not dispatch",{turnId:randomUUID(),verbosity:"final",emit:()=>{},reasoning:{level:"high"}}));assert.equal(dispatches,3);}
    mode="cancel";confirmed=0;connected=true;abort=new AbortController();await session.send("cancelled",{turnId:randomUUID(),verbosity:"final",emit:()=>{},reasoning:{level:"high"},signal:abort.signal});assert.equal(dispatches,3);
    assert.ok(released>=6);assert.ok(calls.includes("sessions.patch"));
  }finally{adapter.close();}
});

test("spawn CLI refuses before launching a provider process",async()=>{
  const adapter=new OpenClawAdapter({binPath:"/this-command-must-never-execute"});
  const session=await adapter.createSession({sessionId:"policy-cli",model:"local/m1",agentId:"openclaw:main" as any,cwd:process.cwd()});
  await assert.rejects(session.send("input",{turnId:randomUUID(),verbosity:"final",emit:()=>{}} as any),/cannot confirm/);
  await assert.rejects(session.compressNative!(),/cannot confirm/);
});

test("qualified latest SDK filters its actual 67-tool catalog and enforces retained execution without inference",{skip:!process.env.PHONON_TEST_OPENCLAW_SDK},()=>withPeerFixture("openclaw-policy-sdk",async scope=>{
  const previous=new Map<string,string|undefined>();
  const f=fixture();let hookRuntime:any;
  const oldFetch=globalThis.fetch;
  scope.defer(()=>{f.cleanup();hookRuntime?.resetGlobalHookRunner();globalThis.fetch=oldFetch;for(const [key,value]of previous){if(value===undefined)delete process.env[key];else process.env[key]=value;}});
  for(const key of ["HOME","OPENCLAW_STATE_DIR","OPENCLAW_CONFIG_PATH","OPENCLAW_LOG_DIR"]){previous.set(key,process.env[key]);process.env[key]=join(scope.root,key);}
    const sdkDir=process.env.PHONON_TEST_OPENCLAW_SDK!,sdk=(name:string)=>import(pathToFileURL(join(sdkDir,name)).href);
    hookRuntime=await sdk("hook-runtime.js");const runtime=await sdk("agent-harness-runtime.js"),pluginRuntime=await sdk("plugin-runtime.js");
    assert.equal(runtime.OPENCLAW_VERSION,"2026.10.7");
    // Exact-version behavioral evidence only. Production uses tools.catalog, never hashed imports.
    const catalogFile=readdirSync(dirname(sdkDir)).find(name=>/^tool-catalog-.*\.mjs$/.test(name))!;
    const nativeCatalog=await import(pathToFileURL(join(dirname(sdkDir),catalogFile)).href);
    const sections=nativeCatalog.a({swarmEnabled:true,personalInstructionsEnabled:true});
    assert.equal(sections.flatMap((section:any)=>section.tools).length,67);
    f.input.catalog.groups[0]!.tools=sections.flatMap((section:any)=>section.tools.map((tool:any)=>({id:tool.id})));
    assert.equal((await f.rpc(POLICY_BIND)).ok,true);
    const native=new NativeInteractionTools(),nativeMethods=new Map<string,any>();let factory:any;
    native.register({registerGatewayMethod:(name,handler)=>{nativeMethods.set(name,handler);},registerTool:value=>{factory=value;},on:(name,handler)=>{f.hooks.set(name,[...(f.hooks.get(name)??[]),handler]);}});
    const token=randomBytes(32).toString("base64url");let interactionRequests=0;
    nativeMethods.get(BIND_METHOD)({params:{version:1,sessionKey:f.input.sessionKey,runId:f.input.runId,expiresAt:Date.now()+60000,token,
      interactionUrl:"http://127.0.0.1:1/interaction",receiptUrl:"http://127.0.0.1:1/applied"},client:f.client,hasCurrentClientAuthority:()=>true,respond:(ok:boolean)=>assert.equal(ok,true)});
    const pluginId="agent-phonon-hitl";
    hookRuntime.initializeGlobalHookRunner({hooks:[],plugins:[{id:pluginId,status:"loaded"}],
      typedHooks:[...f.hooks].flatMap(([hookName,handlers])=>handlers.map(handler=>({pluginId,hookName,handler}))),
      trustedToolPolicies:[{pluginId,source:"fixture",origin:"config",policy:{id:"phonon-noninteractive-v1",description:"fixture",evaluate:f.evaluator()}}]});
    const runner=pluginRuntime.getGlobalHookRunner(),result=await runner.runBeforePromptBuild({prompt:"input",messages:[]},f.ctx);
    let effects=0;
    const names=[...f.input.catalog.groups.flatMap(group=>group.tools.map(tool=>tool.id)),"new_server__tool","lsp_definition"];
    const tools=names.map(name=>({name,label:name,description:name,parameters:{type:"object",properties:{}},execute:async()=>{effects++;return {content:[{type:"text",text:"ok"}],details:{ok:true}};}}));
    const visible=runtime.applyEmbeddedAttemptToolsAllow(tools,result.toolsAllow);
    assert.deepEqual(visible.map((tool:any)=>tool.name).sort(),names.filter(name=>!BLOCKED_NATIVE_TOOLS.includes(name)).sort());
    for(const name of BLOCKED_NATIVE_TOOLS){const tool=tools.find(tool=>tool.name===name)??{...tools[0],name};
      assert.equal((await runtime.wrapToolWithBeforeToolCallHook(tool,f.ctx).execute(randomUUID(),{})).details.status,"blocked",name);}
    assert.equal(effects,0);
    const read=runtime.wrapToolWithBeforeToolCallHook(tools.find(tool=>tool.name==="read"),f.ctx);
    assert.equal((await read.execute(randomUUID(),{})).details.ok,true);assert.equal(effects,1);
    const explicitDenySurface=tools.filter(tool=>tool.name!=="write");
    assert.ok(!runtime.applyEmbeddedAttemptToolsAllow(explicitDenySurface,result.toolsAllow).some((tool:any)=>tool.name==="write"));
    const approval={requireApproval:{title:"Required approval",description:"Native approval must be retained",allowedDecisions:["allow-once","deny"]}};
    const registry={hooks:[],plugins:[{id:pluginId,status:"loaded"}],typedHooks:[...f.hooks].flatMap(([hookName,handlers])=>handlers.map(handler=>({pluginId,hookName,handler}))),trustedToolPolicies:[{pluginId,source:"fixture",origin:"config",policy:{id:"phonon-noninteractive-v1",description:"fixture",evaluate:f.evaluator()}}]};
    hookRuntime.initializeGlobalHookRunner({...registry,typedHooks:[...registry.typedHooks,{pluginId,hookName:"before_tool_call",handler:()=>approval}]});
    assert.deepEqual((await runner.runBeforeToolCall({toolName:"write",params:{},runId:f.ctx.runId,toolCallId:randomUUID()},f.ctx)).requireApproval,{...approval.requireApproval,pluginId});
    hookRuntime.initializeGlobalHookRunner(registry);
    globalThis.fetch=async(_url,options)=>{interactionRequests++;assert.equal(new Headers(options?.headers).get("authorization"),"Bearer "+token);return new Response(JSON.stringify({requestId:"sdk-policy",action:"submit",values:{approve:false},decisionHash:"a".repeat(64)}));};
    const hitl=runtime.wrapToolWithBeforeToolCallHook(factory(f.ctx).find((tool:any)=>tool.name===REQUEST_TOOL),f.ctx);
    const human=await hitl.execute(randomUUID(),{requestId:"sdk-policy",form:{title:"Review",fields:[{key:"approve",label:"Approve",type:"boolean",required:true}]}});
    assert.equal(human.details.values.approve,false);assert.equal(interactionRequests,1);assert.ok(!JSON.stringify(human).includes(token));
    const personal={...f.ctx,sessionKey:"agent:main:personal",runId:randomUUID(),sessionId:randomUUID()};
    assert.equal((await runtime.wrapToolWithBeforeToolCallHook(tools.find(tool=>tool.name==="message"),personal).execute(randomUUID(),{})).details.ok,true);
    f.connection.abort();
    assert.equal((await read.execute(randomUUID(),{})).details.status,"blocked");
    assert.equal((await hitl.execute(randomUUID(),{})).details.status,"blocked");assert.equal(interactionRequests,1);
    // Revoke authority while optional hook work is pending, with and without native cancellation.
    for(const mode of ["disconnect","cancel"]){const cancelled=fixture();try{
      assert.equal((await cancelled.rpc(POLICY_BIND)).ok,true);
      cancelled.hooks.get("before_prompt_build")![0]({},cancelled.ctx);
      const abort=new AbortController();
      hookRuntime.initializeGlobalHookRunner({hooks:[],plugins:[{id:pluginId,status:"loaded"}],typedHooks:[
        {pluginId,hookName:"before_tool_call",priority:50,handler:async()=>{await Promise.resolve();if(mode==="disconnect")cancelled.connection.abort();else abort.abort();}},
        {pluginId,hookName:"before_tool_call",priority:-1000000,handler:cancelled.hooks.get("before_tool_call")![0]},
      ],trustedToolPolicies:[{pluginId,source:"fixture",origin:"config",policy:{id:"phonon-noninteractive-v1",description:"fixture",evaluate:cancelled.evaluator()}}]});
      const before:number=effects;
      const late=runtime.wrapToolWithBeforeToolCallHook(tools.find(tool=>tool.name==="write"),cancelled.ctx);
      try{const result=await late.execute(randomUUID(),{},abort.signal);assert.equal(result.details.status,"blocked");}catch{assert.equal(abort.signal.aborted,true);}
      assert.equal(effects,before);
    }finally{cancelled.cleanup();}}
    const internal=async(pattern:RegExp)=>{
      const file=readdirSync(dirname(sdkDir)).find(name=>pattern.test(name));assert.ok(file);
      return import(pathToFileURL(join(dirname(sdkDir),file)).href);
    };
    const approvalRuntime=await internal(/^agent-tools\.before-tool-call-.*\.mjs$/);
    const embedded=await internal(/^embedded-mode-.*\.mjs$/);
    embedded.n(true);
    try{
      for(const mode of ["release","disconnect","resource","replacement"]){
        const held=fixture();let resolveEntered!:()=>void,resolveDecision!:(value:any)=>void;
        const entered=new Promise<void>(resolve=>{resolveEntered=resolve;}),decision=new Promise<any>(resolve=>{resolveDecision=resolve;});
        const broker={request:async()=>{resolveEntered();return decision;}};
        approvalRuntime.Y(broker);
        let timeout:ReturnType<typeof setTimeout>|undefined;
        try{
          assert.equal((await held.rpc(POLICY_BIND)).ok,true);
          const native=held.controllers.get(held.input.runId);
          held.hooks.get("before_prompt_build")![0]({},held.ctx);
          hookRuntime.initializeGlobalHookRunner({hooks:[],plugins:[{id:pluginId,status:"loaded"}],
            trustedToolPolicies:[{pluginId,source:"fixture",origin:"config",policy:{id:"phonon-noninteractive-v1",description:"fixture",evaluate:held.evaluator()}}],
            typedHooks:[...held.hooks].flatMap(([hookName,handlers])=>handlers.map(handler=>({pluginId,hookName,handler}))).concat([
              {pluginId,hookName:"before_tool_call",handler:()=>approval},
            ])});
          const before:number=effects;
          const execution=runtime.wrapToolWithBeforeToolCallHook(tools.find(tool=>tool.name==="write"),held.ctx).execute(randomUUID(),{},native.controller.signal);
          const observed=execution.then((value:any)=>({value}),(error:Error)=>({error}));
          await Promise.race([entered,new Promise((_,reject)=>{timeout=setTimeout(()=>reject(new Error("Native approval was not held")),3000);})]);
          assert.equal(effects,before);
          if(mode==="disconnect")held.connection.abort();
          else if(mode==="resource")held.resource.abort();
          else if(mode==="replacement"){
            const replacement=held.start();
            assert.equal(held.call("read")?.block,true);
            assert.equal(replacement.controller.signal.aborted,false);
          }else assert.equal((await held.rpc(POLICY_RELEASE)).ok,true);
          assert.equal(native.controller.signal.aborted,true,mode);
          resolveDecision({decision:"allow-once"});
          const outcome=await observed;
          assert.ok(outcome.error||outcome.value?.details.status==="blocked",mode);
          assert.equal(effects,before,mode);
        }finally{clearTimeout(timeout);resolveDecision({decision:"deny"});approvalRuntime.J(broker);held.cleanup();}
      }
    }finally{embedded.n(false);}
}));

test("stale proof, end, expiry, disconnect and native reset cannot authorize retained tool calls",async()=>{
  for(const mode of ["end","disconnect","resource","expiry","reset","config"]){
    const f=fixture();try{
      if(mode==="expiry")f.input.expiresAt=Date.now()+30;
      const bound=await f.rpc(POLICY_BIND);assert.equal(bound.ok,true);
      f.hooks.get("before_prompt_build")![0]({},f.ctx);
      for(const end of f.hooks.get("agent_end")??[])end({},{...f.ctx,runId:randomUUID()});
      assert.equal(f.call("read"),undefined,"wrong-run cleanup must not retire this binding");
      if(mode==="end")for(const end of f.hooks.get("agent_end")??[])end({},f.ctx);
      if(mode==="disconnect")f.connection.abort();
      if(mode==="resource")f.resource.abort();
      if(mode==="expiry")await new Promise(resolve=>setTimeout(resolve,40));
      if(mode==="reset")f.changeEntry({sessionId:randomUUID(),modelProvider:"local",model:"m1"});
      if(mode==="config")f.config.tools.codeMode=true;
      assert.equal((await f.rpc(POLICY_CONFIRM)).ok,false,mode);
      assert.equal(f.call("read")?.block,true,mode);assert.equal(f.call("message")?.block,true,mode);
      assert.equal(f.retained(),0,mode);
      assert.ok(!JSON.stringify(bound).includes("operator.admin"));
    }finally{f.cleanup();}
  }
});
