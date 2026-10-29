import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFileSync, readFileSync, existsSync, mkdirSync,symlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { createServer, type ServerResponse } from "node:http";
import { PeerContextJournal, PeerContextReceiver } from "../peer-context.js";
import { PeerContextBridge } from "../peer-context-bridge.js";
import { prepareClaudePeerRunner } from "./claude-peer-context.js";
import { spawnSync } from "node:child_process";
import { ClaudeCodeAdapter } from "./claude-code.js";
import type { AdapterSession, SendOptions } from "../adapter.js";
import type { ChildProcess } from "node:child_process";
import { withPeerFixture, closePeerServer } from "../testing/peer-fixture.js";
import {AgentInteractionBridge} from "../agent-interaction-bridge.js";
import {SessionEngine,AdapterRegistry} from "../session-engine.js";
import {PhononStore} from "../store.js";

async function fixture(work:(f:any)=>Promise<void>){
  return withPeerFixture("claude-peer",async scope=>{
  const root=scope.root,journal=new PeerContextJournal(join(root,"peer.sqlite"));
  scope.defer(()=>journal.close());
  const self={id:randomUUID(),position:"1",projectId:randomUUID(),ownerId:"owner",deviceId:randomUUID(),agentId:"claude-code",
    agentKind:"agent" as const,sourceKind:"native" as const,sessionId:"owned",label:"root",activity:{summary:"",phase:"working" as const,impact:[],dependencies:""},activityRevision:0,lastSeenAt:null,presence:"active" as const};
  const message={id:randomUUID(),position:"2",senderId:randomUUID(),recipientId:self.id,kind:"notice" as const,text:"CLAUDE_PEER_"+randomUUID(),references:[],inReplyTo:null,depth:0,createdAt:null,expiresAt:null,state:"stored" as const,receivedAt:null};
  const state={pending:false,active:true,native:randomUUID(),inbox:0};
  const receiver=new PeerContextReceiver({tenantId:"owner",sessionId:self.sessionId,turnId:"turn",runId:randomUUID(),nativeSessionId:()=>state.native,
    active:()=>scope.active&&state.active,journal,requireBudget:true,evidence:"context_hook",coordinate:async action=>{assert.equal(action.operation,"inbox");state.inbox++;return {self,messages:state.pending?[message]:[],next:null};}});
  const bridge=new PeerContextBridge(receiver);scope.defer(()=>bridge.close());const environment=await bridge.listen();
  const options:SendOptions={turnId:"turn",verbosity:"tools",emit:()=>{},environment,peerContext:receiver};
  await work({scope,root,journal,self,message,state,receiver,bridge,environment,options});
  });
}

test("Claude SDK hooks return peer data only for the owned native root and known root tool IDs",()=>fixture(async f=>{
  const asset=prepareClaudePeerRunner(f.options,{entry:"/owned/cli.js",sdk:"/owned/sdk.mjs"},{sessionId:f.state.native,prompt:"Original task",model:"default",resume:false});
  const module=await import(pathToFileURL(asset.args[0]!).href),rootTools=new Set(["root-read"]);
  const calls:any[]=[];
  const checkpoint=async(path:string,input:any)=>{calls.push(input);if(path.endsWith("/observe")){f.receiver.observe(input);return {observed:true};}return f.receiver.prepare(input);};
  const hooks=module.createPeerHooks({sessionId:f.state.native,cwd:f.root,checkpoint,rootTools,getBudget:()=>({state:"known",source:"native_estimate",contextWindowTokens:200000,inputTokens:1000,outputTokens:150001,overheadTokens:1024})});
  const context={session_id:f.state.native,cwd:f.root,transcript_path:join(f.root,f.state.native+".jsonl")};
  try{
    assert.deepEqual(Object.keys(hooks).sort(),["PostToolUse","PreCompact","SessionStart","UserPromptSubmit"]);
    const invoke=hooks.PostToolUse[0].hooks[0];
    f.state.pending=true;
    for(const input of [{...context,session_id:randomUUID()},{...context,transcript_path:join(f.root,"agent-child.jsonl")},{...context,cwd:dirname(f.root)}]){
      assert.deepEqual(await invoke({...input,hook_event_name:"PostToolUse"},"root-read",{}),{});
    }
    assert.deepEqual(await invoke({...context,hook_event_name:"PostToolUse"},"child-read",{}),{});
    assert.deepEqual(await invoke({...context,hook_event_name:"PostToolUse"},"root-read",{signal:AbortSignal.abort()}),{});
    assert.equal(calls.length,0);
    const output=await invoke({...context,hook_event_name:"PostToolUse"},"root-read",{});
    assert.deepEqual(Object.keys(output),["hookSpecificOutput"]);
    assert.equal(output.hookSpecificOutput.hookEventName,"PostToolUse");assert.ok(output.hookSpecificOutput.additionalContext.includes(f.message.text));
    assert.deepEqual(await invoke({...context,hook_event_name:"PostToolUse"},"root-read",{}),{});
    assert.equal(f.journal.records("owner","owned")[0].state,"context_hook");
    assert.equal(readFileSync(asset.args[0]!,"utf8").includes(f.environment.AGENT_PHONON_PEER_CONTEXT_TOKEN),false);
    assert.equal(asset.args.join(" ").includes(f.environment.AGENT_PHONON_PEER_CONTEXT_TOKEN),false);
  }finally{asset.cleanup();}
  assert.equal(existsSync(asset.args[0]!),false);
}));

test("Claude coordination uses exact original-root native tool metadata without granting permissions",()=>fixture(async f=>{
  const asset=prepareClaudePeerRunner(f.options,{entry:"/owned/cli.js",sdk:"/owned/sdk.mjs"},{sessionId:f.state.native,prompt:"Original",model:"default",resume:false});
  const module=await import(pathToFileURL(asset.args[0]!).href),name="mcp__phonon_current_turn__phonon_project_coordination";
  let active=true,ready=true;const calls:any[]=[];
  const guard=module.createCoordinationGuard({sessionId:f.state.native,cwd:f.root,active:()=>active,ready:()=>ready,invoke:async(input:any)=>{calls.push(input);return {ok:true};}});
  const input={operation:"presence"},id="native-root-tool",context={session_id:f.state.native,cwd:f.root,transcript_path:join(f.root,f.state.native+".jsonl"),tool_name:name,tool_input:input};
  const message={type:"assistant",session_id:f.state.native,parent_tool_use_id:null,message:{content:[{type:"tool_use",id,name,input}]}};
  const call=(extra:any={})=>guard.call({name:"phonon_project_coordination",arguments:input},{_meta:{"claudecode/toolUseId":id},...extra});
  try{
    guard.record(message);await assert.rejects(call());guard.submitted();
    const child=await guard.pre({...context,transcript_path:join(f.root,"agent-child.jsonl")},id,{});assert.equal(child.hookSpecificOutput.permissionDecision,"deny");
    guard.record({...message,parent_tool_use_id:"parent",message:{content:[{type:"tool_use",id:"child",name,input}]}});
    assert.equal((await guard.pre(context,"child",{})).hookSpecificOutput.permissionDecision,"deny");
    assert.equal((await guard.pre({...context,tool_input:{operation:"leave"}},id,{})).hookSpecificOutput.permissionDecision,"deny");
    ready=false;assert.equal((await guard.pre(context,id,{})).hookSpecificOutput.permissionDecision,"deny");ready=true;
    assert.deepEqual(await guard.pre(context,id,{}),{},"admission must not auto-approve native permissions");
    await assert.rejects(call({_meta:{}}));await assert.rejects(guard.call({name:"phonon_project_coordination",arguments:{operation:"leave"}},{_meta:{"claudecode/toolUseId":id}}));
    assert.deepEqual(await call(),{ok:true});await assert.rejects(call());assert.deepEqual(calls,[input]);
    active=false;guard.close();await assert.rejects(call());
  }finally{guard.close();asset.cleanup();}
}));

test("Claude canceled or ended native sends are not retried or reported as confirmed",()=>fixture(async f=>{
  const asset=prepareClaudePeerRunner(f.options,{entry:"/owned/cli.js",sdk:"/owned/sdk.mjs"},{sessionId:f.state.native,prompt:"Original",model:"default",resume:false});
  const module=await import(pathToFileURL(asset.args[0]!).href),name="mcp__phonon_current_turn__phonon_project_coordination",args={operation:"presence"};
  let live=true,calls=0,release:()=>void=()=>{};const pending=new Promise<void>(done=>release=done);
  const guard=module.createCoordinationGuard({sessionId:f.state.native,cwd:f.root,active:()=>live,invoke:async()=>{calls++;await pending;return {status:"recorded"};}});
  const id="native-one-shot",context={session_id:f.state.native,cwd:f.root,transcript_path:join(f.root,f.state.native+".jsonl"),tool_name:name,tool_input:args};
  try{
    guard.submitted();guard.record({type:"assistant",session_id:f.state.native,message:{content:[{type:"tool_use",id,name,input:args}]}});
    assert.deepEqual(await guard.pre(context,id,{}),{});
    await assert.rejects(guard.call({name:"phonon_project_coordination",arguments:args},{_meta:{"claudecode/toolUseId":id},signal:AbortSignal.abort()}));assert.equal(calls,0);
    const send=guard.call({name:"phonon_project_coordination",arguments:args},{_meta:{"claudecode/toolUseId":id}});
    live=false;release();await assert.rejects(send,/unconfirmed/);assert.equal(calls,1);
    await assert.rejects(guard.call({name:"phonon_project_coordination",arguments:args},{_meta:{"claudecode/toolUseId":id}}));assert.equal(calls,1);
  }finally{release();guard.close();asset.cleanup();}
}));

test("Claude cancellation waits for the native process before deleting its invocation runner",()=>fixture(async f=>{
  const cli=join(f.root,"cli.js"),sdk=join(f.root,"sdk.mjs"),marker=join(f.root,"runner-started");
  writeFileSync(cli,`#!${process.execPath}\nconsole.log('2.0.1 (Claude Code)');\n`,{mode:0o700});
  writeFileSync(sdk,`import{writeFileSync}from'node:fs';export function createSdkMcpServer(){};export async function* query(){writeFileSync(${JSON.stringify(marker)},process.argv[1]);await new Promise(()=>{setInterval(()=>{},1000);});}\n`);
  const adapter=new ClaudeCodeAdapter({env:{binPath:cli,defaultModel:"default"}}),session=await adapter.createSession({sessionId:"cancel",agentId:"claude-code",model:"default",cwd:f.root});
  f.scope.defer(()=>session.terminate());const controller=new AbortController(),events:any[]=[];
  const run=session.send("Original task",{...f.options,signal:controller.signal,emit:event=>events.push(event)});
  const native=(session as unknown as{current?:{child:ChildProcess}}).current?.child;f.scope.watch(native,true);
  try{
    for(let n=0;n<100&&!existsSync(marker);n++)await new Promise(resolve=>setTimeout(resolve,10));
    assert.ok(existsSync(marker));const runner=readFileSync(marker,"utf8");assert.ok(existsSync(runner));
    controller.abort();await run;
    assert.equal(events.at(-1)?.status,"interrupted");assert.equal(existsSync(runner),false);
    assert.ok(native?.exitCode!==null||native?.signalCode!==null);
  }finally{controller.abort();await session.terminate();await run.catch(()=>{});}
}));

test("Claude SessionStart offers already-pending mail once and closed SDK runs cannot drain another boundary",()=>fixture(async f=>{
  const asset=prepareClaudePeerRunner(f.options,{entry:"/owned/cli.js",sdk:"/owned/sdk.mjs"},{sessionId:f.state.native,prompt:"Original task",model:"default",resume:false});
  let live=true;const calls:any[]=[];
  const module=await import(pathToFileURL(asset.args[0]!).href);
  const hooks=module.createPeerHooks({sessionId:f.state.native,cwd:f.root,rootTools:new Set(),active:()=>live,getBudget:()=>({state:"known",source:"native_estimate",contextWindowTokens:200000,inputTokens:1000,outputTokens:150001,overheadTokens:1024}),
    checkpoint:async(path:string,input:any)=>{calls.push(input);if(path.endsWith("/observe")){f.receiver.observe(input);return {observed:true};}return f.receiver.prepare(input);}});
  const input={session_id:f.state.native,cwd:f.root,transcript_path:join(f.root,f.state.native+".jsonl"),hook_event_name:"SessionStart",source:"startup"};
  try{
    f.state.pending=true;const value=await hooks.SessionStart[0].hooks[0](input,undefined,{});
    assert.ok(value.hookSpecificOutput.additionalContext.includes(f.message.text));
    live=false;const count=calls.length;
    assert.deepEqual(await hooks.SessionStart[0].hooks[0]({...input,source:"resume"},undefined,{}),{});assert.equal(calls.length,count);
  }finally{asset.cleanup();}
}));

test("Claude original-input context is exact, root-scoped and one-shot",()=>fixture(async f=>{
  const asset=prepareClaudePeerRunner(f.options,{entry:"/owned/cli.js",sdk:"/owned/sdk.mjs"},{sessionId:f.state.native,prompt:"Original task",model:"default",resume:false});
  const module=await import(pathToFileURL(asset.args[0]!).href);
  const hooks=module.createPeerHooks({sessionId:f.state.native,cwd:f.root,prompt:"Original task",rootTools:new Set(),getBudget:()=>({state:"known",source:"native_estimate",contextWindowTokens:200000,inputTokens:1000,outputTokens:150001,overheadTokens:1024}),
    checkpoint:async(path:string,input:any)=>{if(path.endsWith("/observe")){f.receiver.observe(input);return {observed:true};}return f.receiver.prepare(input);}});
  const input={session_id:f.state.native,cwd:f.root,transcript_path:join(f.root,f.state.native+".jsonl"),hook_event_name:"UserPromptSubmit"};
  try{
    f.state.pending=true;const invoke=hooks.UserPromptSubmit[0].hooks[0];
    assert.deepEqual(await invoke({...input,prompt:"Other child prompt"},undefined,{}),{});assert.equal(f.state.inbox,0);
    assert.ok((await invoke({...input,prompt:"Original task"},undefined,{})).hookSpecificOutput.additionalContext.includes(f.message.text));
    assert.deepEqual(await invoke({...input,prompt:"Original task"},undefined,{}),{});assert.equal(f.state.inbox,1);
  }finally{asset.cleanup();}
}));

test("Claude native budget charges current root inference caches, tool results and later records without billing totals",()=>fixture(async f=>{
  const asset=prepareClaudePeerRunner(f.options,{entry:"/owned/cli.js",sdk:"/owned/sdk.mjs"},{sessionId:f.state.native,prompt:"Original",model:"default",resume:false});f.scope.defer(asset.cleanup);
  const module=await import(pathToFileURL(asset.args[0]!).href),model="claude-sonnet-4-5-20250929";
  const budget=module.createClaudePeerBudget({sessionId:f.state.native,outputReserve:()=>32000});
  const init={type:"system",subtype:"init",session_id:f.state.native,model},assistant={type:"assistant",session_id:f.state.native,message:{model,
    usage:{input_tokens:100,output_tokens:20,cache_creation_input_tokens:200,cache_read_input_tokens:300}}};
  budget.observe(init);assert.equal(budget.budget().state,"unknown");budget.observe(assistant);
  const result={output:"native tool"};let value=budget.budget(result);assert.equal(value.inputTokens,620+Buffer.byteLength(JSON.stringify(result)));
  assert.equal(value.contextWindowTokens,200000);assert.equal(value.outputTokens,32000);
  budget.observe({...assistant,parent_tool_use_id:"child",message:{...assistant.message,usage:{input_tokens:1}}});assert.deepEqual(budget.budget(result),value);
  const user={type:"user",session_id:f.state.native,message:{content:[{type:"tool_result",content:"later output"}]}};budget.observe(user);
  assert.equal(budget.budget(result).inputTokens,value.inputTokens+Buffer.byteLength(JSON.stringify(user)));
  for(const patch of [{model:"other"},{usage:{input_tokens:1,output_tokens:1}},{usage:{...assistant.message.usage,cache_read_input_tokens:-1}}]){
    budget.observe({...assistant,message:{...assistant.message,...patch}});assert.equal(budget.budget().state,"unknown");budget.observe(assistant);
  }
  budget.observe({type:"system",subtype:"compact_boundary",session_id:f.state.native});assert.equal(budget.budget().state,"unknown");
  budget.observe(assistant);assert.equal(budget.budget().state,"known");budget.invalidate();assert.equal(budget.budget().state,"unknown");
  let reserve=100000;const startup=module.createClaudePeerBudget({sessionId:f.state.native,outputReserve:()=>reserve});reserve=32000;
  startup.observe(init);startup.observe(assistant);assert.equal(startup.budget().outputTokens,100000,"native startup settings may remain cached after an on-disk decrease");
}));

test("Claude output reserve includes all possible native settings without changing or copying configuration",()=>fixture(async f=>{
  const asset=prepareClaudePeerRunner(f.options,{entry:"/owned/cli.js",sdk:"/owned/sdk.mjs"},{sessionId:f.state.native,prompt:"Original",model:"default",resume:false});f.scope.defer(asset.cleanup);
  const module=await import(pathToFileURL(asset.args[0]!).href),config=join(f.root,"config"),cwd=join(f.root,"workspace");mkdirSync(config);mkdirSync(cwd);mkdirSync(join(cwd,".claude"));
  const input={cwd,home:f.root,platform:"darwin",environment:{CLAUDE_CONFIG_DIR:config}};
  assert.equal(module.claudeOutputReserve(input),32000);
  writeFileSync(join(config,"settings.json"),JSON.stringify({env:{MAX_THINKING_TOKENS:"100000"}}));
  writeFileSync(join(cwd,".claude","settings.json"),JSON.stringify({env:{MAX_THINKING_TOKENS:"50000"}}));
  assert.equal(module.claudeOutputReserve(input),100001);
  assert.equal(module.claudeOutputReserve({...input,environment:{...input.environment,MAX_THINKING_TOKENS:"180000"}}),180001);
  const standalone=join(f.root,"standalone.json");writeFileSync(standalone,"{}");
  assert.equal(module.claudeOutputReserve({...input,settingsPath:standalone}),32000);
  writeFileSync(join(config,"settings.json"),"invalid");assert.equal(module.claudeOutputReserve(input),undefined);
  const linked=join(f.root,"linked-settings.json");symlinkSync(standalone,linked);assert.equal(module.claudeOutputReserve({...input,settingsPath:linked}),undefined);
  const large=join(f.root,"large-settings.json");writeFileSync(large," ".repeat(262145));assert.equal(module.claudeOutputReserve({...input,settingsPath:large}),undefined);
  for(const value of ["bad","-1","1.5","1000000000"])assert.equal(module.claudeOutputReserve({...input,settingsPath:standalone,environment:{MAX_THINKING_TOKENS:value}}),undefined);
}));

test("Claude required headroom defers initial/near-full mail and recovers once without synthetic ACK",()=>fixture(async f=>{
  const asset=prepareClaudePeerRunner(f.options,{entry:"/owned/cli.js",sdk:"/owned/sdk.mjs"},{sessionId:f.state.native,prompt:"Original",model:"default",resume:false});f.scope.defer(asset.cleanup);
  const module=await import(pathToFileURL(asset.args[0]!).href),model="claude-sonnet-4-5-20250929",budget=module.createClaudePeerBudget({sessionId:f.state.native,outputReserve:()=>32000});
  const rootTools=new Set<string>(),boundaries:any[]=[],hooks=module.createPeerHooks({sessionId:f.state.native,cwd:f.root,prompt:"Original",rootTools,
    getBudget:budget.budget,invalidateBudget:budget.invalidate,budgetGeneration:budget.generation,
    checkpoint:async(path:string,input:any)=>{if(path.endsWith("/observe")){f.receiver.observe(input);return{};}boundaries.push(input);return f.receiver.prepare(input);}});
  const base={session_id:f.state.native,cwd:f.root,transcript_path:join(f.root,f.state.native+".jsonl")};f.state.pending=true;
  budget.observe({type:"system",subtype:"init",session_id:f.state.native,model});
  assert.deepEqual(await hooks.UserPromptSubmit[0].hooks[0]({...base,hook_event_name:"UserPromptSubmit",prompt:"Original"},undefined,{}),{});
  assert.deepEqual(f.journal.records("owner","owned"),[]);
  const observe=(tokens:number)=>budget.observe({type:"assistant",session_id:f.state.native,message:{model,usage:{input_tokens:tokens,output_tokens:20,cache_creation_input_tokens:0,cache_read_input_tokens:0}}});
  const invoke=async(id:string,response:any={})=>{rootTools.add(id);return hooks.PostToolUse[0].hooks[0]({...base,hook_event_name:"PostToolUse",tool_response:response},id,{});};
  observe(170000);assert.deepEqual(await invoke("full"),{});assert.deepEqual(f.journal.records("owner","owned"),[]);
  observe(100);assert.deepEqual(await invoke("large",{text:"x".repeat(180000)}),{});assert.deepEqual(f.journal.records("owner","owned"),[]);
  observe(100);
  const output=await invoke("recovered");assert.ok(output.hookSpecificOutput.additionalContext.includes(f.message.text));
  assert.equal(f.journal.records("owner","owned")[0]?.state,"context_hook");assert.deepEqual(await invoke("deduplicated"),{});
  assert.equal(boundaries[0].budget.state,"unknown");assert.equal(boundaries[1].budget.state,"known");
  await hooks.PreCompact[0].hooks[0]({...base,session_id:"foreign-child",hook_event_name:"PreCompact"});assert.equal(budget.budget().state,"known");
  await hooks.PreCompact[0].hooks[0]({...base,hook_event_name:"PreCompact"});assert.equal(budget.budget().state,"unknown");
}));

test("Claude parallel root tool outputs share accounting and cannot both claim the same inference headroom",()=>fixture(async f=>{
  const asset=prepareClaudePeerRunner(f.options,{entry:"/owned/cli.js",sdk:"/owned/sdk.mjs"},{sessionId:f.state.native,prompt:"Original",model:"default",resume:false});f.scope.defer(asset.cleanup);
  const module=await import(pathToFileURL(asset.args[0]!).href),model="claude-sonnet-4-5-20250929",budget=module.createClaudePeerBudget({sessionId:f.state.native,outputReserve:()=>32000});
  budget.observe({type:"system",subtype:"init",session_id:f.state.native,model});budget.observe({type:"assistant",session_id:f.state.native,message:{model,usage:{input_tokens:100,output_tokens:20,cache_creation_input_tokens:0,cache_read_input_tokens:0}}});
  let release:()=>void=()=>{},entered:()=>void=()=>{};const pending=new Promise<void>(done=>release=done),started=new Promise<void>(done=>entered=done),calls:any[]=[];
  const hooks=module.createPeerHooks({sessionId:f.state.native,cwd:f.root,rootTools:new Set(["a","b"]),getBudget:budget.budget,budgetGeneration:budget.generation,
    checkpoint:async(path:string,input:any)=>{calls.push(path);if(path.endsWith("/observe"))return{};entered();await pending;return{...input,messages:[{messageId:randomUUID(),content:"peer"}],deferred:[]};}});
  const input={session_id:f.state.native,cwd:f.root,transcript_path:join(f.root,f.state.native+".jsonl"),hook_event_name:"PostToolUse",tool_response:{text:"x".repeat(60000)}};
  const first=hooks.PostToolUse[0].hooks[0](input,"a",{});await started;
  const second=await hooks.PostToolUse[0].hooks[0](input,"b",{});release();assert.deepEqual(second,{});assert.deepEqual(await first,{});
  assert.deepEqual(calls,["/peer-context"],"later tool-result growth suppresses a stale projection without observation");
}));

for(const mode of["default","plan","missing","duplicate"] as const)test(`Claude startup normalization is root-only and fail-closed for ${mode}`,()=>fixture(async f=>{
  const cli=join(f.root,"startup-cli.mjs"),effect=join(f.root,"startup-effect.json");
  writeFileSync(cli,`import{writeFileSync}from'node:fs';writeFileSync(${JSON.stringify(effect)},JSON.stringify({args:process.argv.slice(2),execArgs:process.execArgv}));\n`);
  const asset=prepareClaudePeerRunner(f.options,{entry:cli,sdk:"/owned/sdk.mjs"},{sessionId:f.state.native,prompt:"Original",model:"default",resume:false});
  const module=await import(pathToFileURL(asset.args[0]!).href),startup=module.prepareNativeStartup({entry:cli,directory:join(f.root)});
  try{
    const modeArgs=mode==="missing"?[]:mode==="duplicate"?["--permission-mode","default","--permission-mode","default"]:["--permission-mode",mode];
    const result=spawnSync(process.execPath,["--no-warnings",...startup.executableArgs,cli,...modeArgs,"--model","owned-model"],{encoding:"utf8"});
    assert.equal(result.status===0,mode==="default");assert.equal(startup.confirmed(),mode==="default");
    if(mode==="default"){
      const data=JSON.parse(readFileSync(effect,"utf8"));assert.deepEqual(data.args,["--model","owned-model"]);
      assert.deepEqual(data.execArgs,["--no-warnings"],"the compatibility preload must not leak into native child forks");
    }else assert.equal(existsSync(effect),false,"unexpected SDK policy must stop before the CLI executes");
  }finally{asset.cleanup();}
}));

const MOCK_SDK=String.raw`
import {readFileSync} from "node:fs";
import {join} from "node:path";
import {execFileSync} from "node:child_process";
export async function* query({prompt,options}) {
  if(options.env.AGENT_PHONON_PEER_CONTEXT_TOKEN || process.env.AGENT_PHONON_PEER_CONTEXT_TOKEN)throw new Error('private capability leaked to native tool environment');
  execFileSync(process.execPath,[...options.executableArgs,options.pathToClaudeCodeExecutable,'--permission-mode','default','--version'],{env:options.env,stdio:'pipe'});
  const sid=options.resume||options.extraArgs['session-id'];
  const base={session_id:sid,cwd:options.cwd,transcript_path:join(options.cwd,sid+'.jsonl')};
  yield {type:'system',subtype:'init',session_id:sid,cwd:options.cwd,model:'claude-sonnet-4-5-20250929'};
  await options.hooks.UserPromptSubmit[0].hooks[0]({...base,hook_event_name:'UserPromptSubmit',prompt},undefined,{});
  yield {type:'assistant',session_id:'child-native-session',parent_tool_use_id:'parent-task',message:{content:[{type:'tool_use',id:'child-read',name:'Read',input:{}}]}};
  await options.hooks.PostToolUse[0].hooks[0]({...base,hook_event_name:'PostToolUse'},'child-read',{});
  await options.hooks.UserPromptSubmit[0].hooks[0]({...base,hook_event_name:'UserPromptSubmit',prompt},undefined,{});
  yield {type:'assistant',session_id:sid,parent_tool_use_id:null,message:{model:'claude-sonnet-4-5-20250929',usage:{input_tokens:100,output_tokens:20,cache_creation_input_tokens:0,cache_read_input_tokens:0},content:[{type:'text',text:'Intermediate planning'},{type:'tool_use',id:'root-read',name:'Read',input:{file_path:join(options.cwd,'input.txt')}}]}};
  await fetch(process.env.PHONON_CLAUDE_TEST_CONTROL,{method:'POST',body:'{}'});
  const output=await options.hooks.PostToolUse[0].hooks[0]({...base,hook_event_name:'PostToolUse'},'root-read',{});
  if(!output.hookSpecificOutput?.additionalContext.includes('CLAUDE_PEER_'))throw new Error('peer did not reach original root');
  yield {type:'user',session_id:sid,parent_tool_use_id:null,message:{content:[{type:'tool_result',tool_use_id:'root-read',content:readFileSync(join(options.cwd,'input.txt'),'utf8')} ]}};
  yield {type:'assistant',session_id:sid,parent_tool_use_id:null,message:{content:[{type:'text',text:'Final native task complete'}]}};
  yield {type:'result',subtype:process.env.PHONON_CLAUDE_TEST_ERROR==='1'?'error_during_execution':'success',is_error:process.env.PHONON_CLAUDE_TEST_ERROR==='1',session_id:sid,result:'Final native task complete'};
}
export function createSdkMcpServer(){throw new Error('Mock receive fixture must not register native tools');}
`;

for(const failure of[false,true])test(`Claude owned SDK transport keeps native identity, filters child tools and ${failure?"rejects native error results":"uses only native final text"}`,()=>fixture(async f=>{
  const cli=join(f.root,"cli.js"),sdk=join(f.root,"sdk.mjs");
  writeFileSync(cli,`#!${process.execPath}\nconsole.log('2.0.1 (Claude Code)');\n`,{mode:0o700});writeFileSync(sdk,MOCK_SDK);
  writeFileSync(join(f.root,"input.txt"),"Actual fixture bytes\n");
  const control=createServer((req,res)=>{req.resume();f.state.pending=true;res.writeHead(200).end("{}");});
  f.scope.defer(()=>closePeerServer(control));
  await new Promise<void>(resolve=>control.listen(0,"127.0.0.1",resolve));
  let session:AdapterSession|undefined;const events:any[]=[];f.scope.defer(()=>session?.terminate());
  try{
    const adapter=new ClaudeCodeAdapter({env:{binPath:cli,defaultModel:"default"}});
    session=await adapter.createSession({sessionId:f.self.sessionId,agentId:"claude-code",model:"default",cwd:f.root});
    const capability=session.peerContextCapability?.();assert.ok(capability);assert.equal(capability.boundary,"after_tools");f.state.native=capability.nativeSessionId!;
    const run=session.send("Original assigned task",{...f.options,emit:event=>events.push(event),environment:{...f.environment,
      PHONON_CLAUDE_TEST_CONTROL:`http://127.0.0.1:${(control.address()as{port:number}).port}`,PHONON_CLAUDE_TEST_ERROR:failure?"1":"0"}});
    f.scope.watch((session as unknown as{current?:{child:ChildProcess}}).current?.child,true);await run;
    assert.equal(events.at(-1)?.status,failure?"failed":"completed");
    if(!failure)assert.equal(events.at(-1).text,"Final native task complete");
    assert.equal(events.some(event=>event.toolCallId==="child-read"),false);
    assert.equal(events.filter(event=>event.type==="tool_call").length,1);
    assert.equal(JSON.stringify(events.filter(event=>event.type==="message"||event.type==="result")).includes(f.message.text),false);
    assert.equal(f.state.inbox,2);assert.equal(f.journal.records("owner","owned")[0]?.state,"context_hook");
    await assert.rejects(adapter.createSession({sessionId:"no-replacement",agentId:"claude-code",model:"default",cwd:f.root,reattach:true}),/replacement session/);
    const standalone=new ClaudeCodeAdapter({env:{binPath:cli,defaultModel:"default",settingsPath:join(f.root,"owner.json")}});
    assert.ok((await standalone.createSession({sessionId:"standalone",agentId:"claude-code",model:"default",cwd:f.root})).peerContextCapability?.());
  }finally{await session?.terminate();control.closeAllConnections();await new Promise<void>(resolve=>control.close(()=>resolve()));}
}));

for(const mode of["success","native_error","missing_result","foreign_session"] as const)test(`Claude CLI final evidence is strict for ${mode}`,()=>fixture(async f=>{
  const cli=join(f.root,"cli.js");
  writeFileSync(cli,`#!${process.execPath}\nif(process.argv.includes('--version')){console.log('unsupported-fixture');process.exit(0);}\nlet input='';for await(const chunk of process.stdin)input+=chunk;const args=process.argv;const id=args[args.indexOf(args.includes('--resume')?'--resume':'--session-id')+1];const sid=${JSON.stringify(mode)}==='foreign_session'?'foreign':id;const emit=message=>process.stdout.write(JSON.stringify({...message,session_id:sid})+'\\n');emit({type:'assistant',message:{content:[{type:'text',text:'Intermediate planning'}]}});if(${JSON.stringify(mode)}!=='missing_result')process.stdout.write(JSON.stringify({type:'result',session_id:sid,subtype:${JSON.stringify(mode)}==='native_error'?'error_during_execution':'success',is_error:${JSON.stringify(mode)}==='native_error',result:'Only native final'}) );\n`,{mode:0o700});
  const adapter=new ClaudeCodeAdapter({env:{binPath:cli,defaultModel:"default"}}),events:any[]=[];
  const session=await adapter.createSession({sessionId:"legacy",agentId:"claude-code",model:"default",cwd:f.root});
  f.scope.defer(()=>session.terminate());
  try{
    assert.equal(session.peerContextCapability?.(),undefined);
    const run=session.send("Original",{turnId:"legacy-turn",verbosity:"tools",emit:event=>events.push(event)});
    f.scope.watch((session as unknown as{current?:{child:ChildProcess}}).current?.child,true);await run;
    assert.equal(events.at(-1)?.status,mode==="success"?"completed":"failed");
    if(mode==="success")assert.equal(events.at(-1).text,"Only native final");
    if(mode==="foreign_session")assert.equal(events.some(event=>event.type==="message"),false);
  }finally{await session.terminate();}
}));

function anthropicResponse(res:ServerResponse,payload:any,content:any[],id:string,inputTokens=100){
  const stop=content.some(part=>part.type==="tool_use")?"tool_use":"end_turn";
  if(!payload.stream){res.writeHead(200,{"Content-Type":"application/json"}).end(JSON.stringify({id,type:"message",role:"assistant",model:payload.model,content,
    stop_reason:stop,stop_sequence:null,usage:{input_tokens:inputTokens,output_tokens:20}}));return;}
  res.writeHead(200,{"Content-Type":"text/event-stream"});
  const send=(type:string,data:unknown)=>res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
  send("message_start",{type:"message_start",message:{id,type:"message",role:"assistant",model:payload.model,content:[],stop_reason:null,stop_sequence:null,
    usage:{input_tokens:inputTokens,output_tokens:0,cache_creation_input_tokens:0,cache_read_input_tokens:0}}});
  content.forEach((part,index)=>{
    const tool=part.type==="tool_use";
    send("content_block_start",{type:"content_block_start",index,content_block:tool?{type:"tool_use",id:part.id,name:part.name,input:{}}:{type:"text",text:""}});
    send("content_block_delta",{type:"content_block_delta",index,delta:tool?{type:"input_json_delta",partial_json:JSON.stringify(part.input)}:{type:"text_delta",text:part.text}});
    send("content_block_stop",{type:"content_block_stop",index});
  });
  send("message_delta",{type:"message_delta",delta:{stop_reason:stop,stop_sequence:null},usage:{output_tokens:20}});
  send("message_stop",{type:"message_stop"});res.end();
}

for(const phase of["baseline","midturn","initial","child","denied","plan_cli","plan_sdk","standalone_cli","standalone_sdk","send","send_denied","send_child","coordination_only","send_resume","send_unapproved","send_engine","receive_engine","headroom","unknown_budget"] as const)test(phase==="midturn"?"installed Claude SDK receives an in-flight peer at its original tool boundary"
  :phase==="initial"?"installed Claude SDK defers initial mail until a qualified native tool boundary"
  :phase==="child"?"installed Claude SDK keeps peer mail out of delegated native child requests"
  :phase==="denied"?"installed Claude SDK retains an explicit project Read denial"
  :phase==="plan_cli"?"installed Claude CLI baseline retains the project's plan mode"
  :phase==="plan_sdk"?"installed Claude SDK retains the project's plan mode"
  :phase==="standalone_cli"?"installed Claude CLI baseline retains standalone settings without project merging"
  :phase==="standalone_sdk"?"installed Claude SDK retains standalone settings without copying credentials or dropping plan mode"
  :["send","send_denied","send_child","coordination_only","send_resume","send_unapproved","send_engine","receive_engine","headroom","unknown_budget"].includes(phase)?"installed Claude native project coordination "+phase
  :"installed Claude CLI baseline completes the same read and final reply without SDK hooks",{
  skip:!process.env.PHONON_TEST_CLAUDE_BIN,timeout:45000,
},()=>fixture(async f=>{
  const peerEnabled=phase!=="baseline"&&phase!=="plan_cli"&&phase!=="standalone_cli";
  const outgoing=["send","send_denied","send_child","coordination_only","send_resume","send_unapproved","send_engine"].includes(phase),coordinationName="mcp__phonon_current_turn__phonon_project_coordination";
  const action={operation:"send",requestId:randomUUID(),recipientId:randomUUID(),kind:"notice",text:"PRIVATE_CLAUDE_IMPACT_"+randomUUID()},sent:any[]=[];
  let outgoingEnvironment={};
  if(outgoing&&phase!=="send_engine"){const bridge=new AgentInteractionBridge(undefined,undefined,undefined,undefined,undefined,undefined,async input=>{
    assert.deepEqual(input,{...action,references:[]});sent.push(input);return {status:"recorded",requestId:action.requestId,message:{...f.message,recipientId:action.recipientId,text:action.text}};
  });f.scope.defer(()=>bridge.close());outgoingEnvironment=await bridge.listen();}
  f.state.pending=phase==="initial"||phase==="unknown_budget"||phase==="headroom";
  const payloads:any[]=[],requests:any[]=[],errors:unknown[]=[],events:any[]=[];
  const provider=createServer((req,res)=>{
    void(async()=>{
      const path=new URL(req.url??"/","http://local").pathname;
      if(req.method==="GET"){req.resume();res.writeHead(200,{"Content-Type":"application/json"}).end('{}');return;}
      let body="";for await(const chunk of req)body+=String(chunk);
      const payload=JSON.parse(body);requests.push({path,model:payload.model,names:(payload.tools??[]).map((tool:any)=>tool.name)});
      if(path.endsWith("/count_tokens")){res.writeHead(200,{"Content-Type":"application/json"}).end('{"input_tokens":100}');return;}
      const main=(payload.tools??[]).some((tool:any)=>tool.name==="Read");
      assert.equal(req.headers.authorization,"Bearer controlled-claude-key","native endpoint must use only the explicit synthetic authentication");
      if(main){payloads.push(payload);assert.ok(payloads.length<=(phase==="child"?4:phase==="send_child"?5:phase==="send_resume"?4:2),"unexpected main inference loop");}
      if(main&&outgoing){
        const index=payloads.length,names=payload.tools.map((tool:any)=>tool.name);
        if(phase==="send_child"&&index===3){assert.equal(sent.length,0,"child must not publish as its parent");assert.ok(body.includes("Phonon coordination requires the active original root tool call"));}
        if(phase==="send_child"&&index===5)assert.equal(sent.length,1,"the original root must retain its own outgoing capability");
        assert.equal(names.some((name:string)=>name.includes("phonon_request_interaction")||name.includes("phonon_conversation_message")),false);
        if(phase!=="send_denied")assert.ok(names.includes(coordinationName));
        const content=phase==="send_child"&&index===1?[{type:"tool_use",id:"root-delegate",name:"Task",input:{description:"Controlled collaboration child",subagent_type:"general-purpose",prompt:"Complete the assigned isolated check",model:"sonnet"}}]
          :phase==="send_child"&&index===3?[{type:"text",text:"Child fixture check complete"}]
          :(phase==="send_resume"?index%2===0:index===(phase==="send_child"?5:2))?[{type:"text",text:"Original Claude task complete"}]
          :[{type:"tool_use",id:phase==="send_child"&&index===2?"child-send":"root-send-"+index,name:coordinationName,input:action}];
        anthropicResponse(res,payload,content,"outgoing-"+index);return;
      }
      if(main&&phase==="child"){
        const index=payloads.length;
        assert.equal(body.includes(f.message.text),index===4,"only the original parent continuation can receive peer mail");
        if(index===1)f.state.pending=true;
        const content=index===1?[{type:"tool_use",id:"root-delegate",name:"Task",input:{description:"Read isolated fixture",subagent_type:"general-purpose",prompt:"Read input.txt exactly once and return a concise summary.",model:"sonnet"}}]
          :index===2?[{type:"tool_use",id:"child-read",name:"Read",input:{file_path:join(f.root,"input.txt")}}]
          :[{type:"text",text:index===3?"Child fixture read complete":"Original Claude task complete"}];
        anthropicResponse(res,payload,content,"child-sequence-"+index);return;
      }
      if(main&&phase==="unknown_budget"){
        assert.equal(body.includes(f.message.text),false);anthropicResponse(res,payload,[{type:"text",text:"Original Claude task complete"}],"unknown-budget");return;
      }
      const tool=main&&payloads.length===1;
      if(tool){assert.equal(body.includes(f.message.text),false,"pending mail must wait for native usage");f.state.pending=true;}
      else if(main)assert.equal(body.includes(f.message.text),peerEnabled&&phase!=="denied"&&phase!=="headroom","peer must be present in the next actual provider request only with native headroom");
      const content=tool?[{type:"tool_use",id:"native-read-once",name:"Read",input:{file_path:join(f.root,"input.txt")}}]
        :[{type:"text",text:main?"Original Claude task complete":"Controlled helper response"}];
      anthropicResponse(res,payload,content,"message-"+requests.length,phase==="headroom"?150000:100);
    })().catch(error=>{errors.push(error);res.destroy();});
  });
  f.scope.defer(()=>closePeerServer(provider));
  await new Promise<void>(resolve=>provider.listen(0,"127.0.0.1",resolve));
  const port=(provider.address()as{port:number}).port;
  writeFileSync(join(f.root,"input.txt"),"Actual isolated Claude fixture\n");
  if(outgoing&&phase!=="send_unapproved"){mkdirSync(join(f.root,".claude"));writeFileSync(join(f.root,".claude","settings.json"),JSON.stringify({permissions:phase==="send_denied"?{deny:[coordinationName]}:{allow:[coordinationName]}}));}
  if(phase==="denied"||phase==="plan_cli"||phase==="plan_sdk"){
    mkdirSync(join(f.root,".claude"));writeFileSync(join(f.root,".claude","settings.json"),JSON.stringify({permissions:phase==="denied"?{deny:["Read"]}:{defaultMode:"plan"}}));
  }
  const standalone=phase==="standalone_cli"||phase==="standalone_sdk",settingsPath=join(f.root,"owner-settings.json");
  const standaloneSettings=JSON.stringify({env:{ANTHROPIC_BASE_URL:`http://127.0.0.1:${port}`,ANTHROPIC_AUTH_TOKEN:"controlled-claude-key"},
    model:"claude-sonnet-4-5-20250929",permissions:{defaultMode:"plan"}});
  if(standalone){
    writeFileSync(settingsPath,standaloneSettings,{mode:0o600});mkdirSync(join(f.root,".claude"));
    writeFileSync(join(f.root,".claude","settings.json"),JSON.stringify({permissions:{deny:["Read"]}}));
  }
  const keys=["HOME","USERPROFILE","CLAUDE_CONFIG_DIR","ANTHROPIC_API_KEY","ANTHROPIC_AUTH_TOKEN","CLAUDE_CODE_OAUTH_TOKEN","CLAUDE_CODE_USE_BEDROCK","CLAUDE_CODE_USE_VERTEX","ANTHROPIC_MODEL"];
  const previous=new Map(keys.map(key=>[key,process.env[key]]));
  for(const key of keys)delete process.env[key];process.env.HOME=f.root;process.env.USERPROFILE=f.root;process.env.CLAUDE_CONFIG_DIR=join(f.root,"claude");
  let session:AdapterSession|undefined,nativeOut="",nativeErr="";f.scope.defer(()=>session?.terminate());
  try{
    const adapter=new ClaudeCodeAdapter({env:{binPath:process.env.PHONON_TEST_CLAUDE_BIN!,baseUrl:`http://127.0.0.1:${standalone?1:port}`,authToken:standalone?"stale-key-never-used":"controlled-claude-key",
      defaultModel:"claude-sonnet-4-5-20250929",...(standalone?{settingsPath}:{})}});
    if(phase==="send_engine"||phase==="receive_engine"){
      const receiving=phase==="receive_engine";
      const store=new PhononStore(join(f.root,"engine.sqlite"));f.scope.defer(()=>store.close());const registry=new AdapterRegistry();registry.register(adapter);
      const requests:any[]=[],runId=randomUUID(),engine=new SessionEngine(registry,event=>events.push(event),undefined,store,{projectCoordination:async request=>{
        requests.push(request);const self={...f.self,sessionId:request.sessionId};
        if(request.action.operation==="send")return {status:"recorded",requestId:action.requestId,message:{...f.message,senderId:self.id,recipientId:action.recipientId,text:action.text}};
        return request.action.operation==="peers"?{self,participants:[],next:null}:{self,messages:receiving&&f.state.pending?[f.message]:[],next:null};
      }},"owner");f.scope.defer(()=>engine.dispose());
      const owned=await engine.create({tenantId:"owner",project:"controlled-project",cwd:f.root,agent:"claude-code",model:"claude-sonnet-4-5-20250929",verbosity:"tools",
        workflowAttr:{workflowId:"claude-owned-workflow",nodeId:"reply",nativeRunId:runId}});
      const turn=await engine.send("owner",owned.sessionId,"Complete the assigned isolated task.",{environment:{CLAUDE_CONFIG_DIR:join(f.root,"claude"),
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:"1",DISABLE_TELEMETRY:"1",DISABLE_ERROR_REPORTING:"1",HTTP_PROXY:"",HTTPS_PROXY:"",ALL_PROXY:"",http_proxy:"",https_proxy:"",all_proxy:""}});
      for(let n=0;n<1500&&!events.some(event=>event.final);n++)await new Promise(resolve=>setTimeout(resolve,20));
      await engine.settleTurn("owner",owned.sessionId,turn.turnId);
      assert.equal(events.at(-1)?.status,"completed",JSON.stringify({events,requests}));
      const sends=requests.filter(request=>request.action.operation==="send");assert.equal(sends.length,receiving?0:1);
      if(receiving){
        const records=store.peerContextJournal().records("owner",owned.sessionId);assert.equal(records.length,1);assert.equal(records[0]?.state,"context_hook");
        assert.equal(records[0]?.turnId,turn.turnId);assert.ok(JSON.stringify(payloads.at(-1)).includes(f.message.text));assert.equal(JSON.stringify(events).includes(f.message.text),false);
      }else{
        assert.deepEqual(sends[0].action,{...action,references:[]});assert.equal(sends[0].runId,runId);assert.equal(sends[0].turnId,turn.turnId);
        assert.equal(sends[0].sessionId,owned.sessionId);assert.equal(JSON.stringify(events).includes(action.text),false);
        assert.ok(JSON.stringify(payloads.at(-1)).includes("recorded"));
      }
      assert.equal(payloads.length,2);
      await engine.dispose();return;
    }
    session=await adapter.createSession({sessionId:f.self.sessionId,agentId:"claude-code",model:standalone?"default":"claude-sonnet-4-5-20250929",cwd:f.root});
    const capability=session.peerContextCapability?.();assert.ok(capability,"installed CLI/SDK pair must qualify in the selected Node environment");f.state.native=capability.nativeSessionId!;
    const run=session.send(phase==="child"?"Use one general-purpose subagent to read input.txt and then finish the original task.":outgoing?"Complete the assigned isolated task.":"Read input.txt once and then finish the original task.",{...f.options,...(peerEnabled&&phase!=="coordination_only"?{}:{peerContext:undefined}),
      ...(outgoing?{projectCoordination:async()=>({})}:{}),emit:event=>events.push(event),signal:AbortSignal.timeout(30000),
      environment:{...f.environment,...outgoingEnvironment,CLAUDE_CONFIG_DIR:join(f.root,"claude"),CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:"1",DISABLE_TELEMETRY:"1",DISABLE_ERROR_REPORTING:"1",
        ...(phase==="headroom"?{MAX_THINKING_TOKENS:"55000"}:{}),
        HTTP_PROXY:"",HTTPS_PROXY:"",ALL_PROXY:"",http_proxy:"",https_proxy:"",all_proxy:""}});
    const native=(session as unknown as{current?:{child:ChildProcess}}).current?.child;
    f.scope.watch(native,true);
    native?.stdout?.on("data",chunk=>{nativeOut=(nativeOut+String(chunk)).slice(-30000);});
    native?.stderr?.on("data",chunk=>{nativeErr=(nativeErr+String(chunk)).slice(-20000);});
    await run;
    if(phase==="send_resume"){
      const again=session.send("Continue the same assigned session.",{...f.options,projectCoordination:async()=>({}),emit:event=>events.push(event),signal:AbortSignal.timeout(30000),
        environment:{...f.environment,...outgoingEnvironment,CLAUDE_CONFIG_DIR:join(f.root,"claude"),CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:"1",DISABLE_TELEMETRY:"1",DISABLE_ERROR_REPORTING:"1",
          HTTP_PROXY:"",HTTPS_PROXY:"",ALL_PROXY:"",http_proxy:"",https_proxy:"",all_proxy:""}});
      const child=(session as unknown as{current?:{child:ChildProcess}}).current?.child;f.scope.watch(child,true);
      child?.stdout?.on("data",chunk=>{nativeOut=(nativeOut+String(chunk)).slice(-30000);});await again;
    }
    const diagnostic=JSON.stringify({events,requests,nativeOut,nativeErr,receipts:f.journal.records("owner","owned")}).replaceAll(f.environment.AGENT_PHONON_PEER_CONTEXT_TOKEN,"[redacted]");
    assert.deepEqual(errors,[]);assert.equal(events.at(-1)?.status,"completed",diagnostic);
    if(outgoing){
      assert.equal(sent.length,["send_denied","send_unapproved"].includes(phase)?0:phase==="send_resume"?2:1,diagnostic);assert.equal(payloads.length,phase==="send_child"?5:phase==="send_resume"?4:2,diagnostic);
      assert.equal(JSON.stringify(events).includes(action.text),false,diagnostic);assert.equal(events.some(event=>event.toolName===coordinationName),false,diagnostic);
      const expected=phase==="send_unapproved"?"haven't granted":phase==="send_denied"?"denied":"recorded";
      assert.ok(payloads.at(-1).messages.some((message:any)=>JSON.stringify(message).includes(expected)),diagnostic);
      if(phase==="send_resume"){
        const inits=nativeOut.split("\n").filter(Boolean).map(line=>JSON.parse(line)).filter(row=>row.type==="system"&&row.subtype==="init");
        assert.equal(inits.length,2);assert.equal(new Set(inits.map(row=>row.session_id)).size,1);
        assert.equal(inits[0].session_id,f.state.native);assert.equal(new Set(events.filter(event=>event.type==="result").map(event=>event.sessionId)).size,1);
      }
      assert.equal(events.at(-1).text,"Original Claude task complete");return;
    }
    if(phase==="denied"){
      const init=nativeOut.split("\n").filter(Boolean).map(row=>JSON.parse(row)).find(row=>row.type==="system"&&row.subtype==="init");
      assert.ok(!init.tools.includes("Read"),"explicit native Read denial must retain the native tool filter");
      assert.equal(events.some(event=>event.type==="tool_call"&&event.toolName==="Read"),false);
      assert.equal(JSON.stringify(events).includes("Actual isolated Claude fixture"),false);
      assert.equal(f.journal.records("owner","owned").length,0);return;
    }
    assert.equal(payloads.length,phase==="child"?4:phase==="unknown_budget"?1:2,diagnostic);assert.equal(events.at(-1).text,"Original Claude task complete");
    assert.equal(events.filter(event=>event.type==="tool_call"&&event.toolName===(phase==="child"?"Task":"Read")).length,phase==="unknown_budget"?0:1);
    if(phase==="child")assert.equal(events.some(event=>event.toolCallId==="child-read"),false);
    assert.equal(JSON.stringify(events.filter(event=>event.type==="message"||event.type==="result")).includes(f.message.text),false);
    assert.equal(f.journal.records("owner","owned")[0]?.state,peerEnabled&&phase!=="headroom"&&phase!=="unknown_budget"?"context_hook":undefined);
    if(peerEnabled){
      const outcome=nativeOut.split("\n").filter(Boolean).map(row=>JSON.parse(row)).find(row=>row.type==="result");
      const used=outcome?.modelUsage?.["claude-sonnet-4-5-20250929"];
      assert.equal(used?.contextWindow,200000,"installed native window must agree with the version-fenced conservative budget");
      assert.ok(payloads.every((payload:any)=>Number.isSafeInteger(payload.max_tokens)&&payload.max_tokens>0&&payload.max_tokens<=(phase==="headroom"?55001:32000)));
      if(phase==="headroom")assert.equal(payloads[0].max_tokens,55001,"native thinking reserve must reach the actual request without a coordination override");
    }
    if(phase==="plan_cli"||phase==="plan_sdk"||standalone){
      const init=nativeOut.split("\n").filter(Boolean).map(row=>JSON.parse(row)).find(row=>row.type==="system"&&row.subtype==="init");
      assert.equal(init?.permissionMode,"plan",diagnostic);
    }
    if(standalone){assert.equal(readFileSync(settingsPath,"utf8"),standaloneSettings);assert.equal(nativeErr.includes("controlled-claude-key"),false);}
  }finally{
    for(const[key,value]of previous){if(value===undefined)delete process.env[key];else process.env[key]=value;}
    await session?.terminate();provider.closeAllConnections();await new Promise<void>(resolve=>provider.close(()=>resolve()));
  }
}));
