import test from "node:test";
import assert from "node:assert/strict";
import {appendFileSync,mkdirSync,readFileSync,writeFileSync,symlinkSync,linkSync} from "node:fs";
import {join} from "node:path";
import {randomUUID} from "node:crypto";
import {withPeerFixture} from "../testing/peer-fixture.js";
import {readCodexContext,resolveCodexContextFile} from "./codex-context.js";
import {CodexAdapter} from "./codex.js";
import {dropToolIOFromJsonlFiles} from "../custom-compress.js";

const timestamp="2026-10-23T00:00:00.000Z";
const context=(model="fixture")=>({type:"turn_context",timestamp,payload:{model}});
const usage=()=>({type:"event_msg",timestamp,payload:{type:"token_count",info:{last_token_usage:{input_tokens:120,output_tokens:30,total_tokens:150},total_token_usage:{input_tokens:9000,output_tokens:1000,total_tokens:10000},model_context_window:1000}}});
async function fixture(work:(f:any)=>Promise<void>){
  await withPeerFixture("codex-context",async scope=>{
    const home=join(scope.root,"home"),cwd=join(scope.root,"work"),threadID=randomUUID();mkdirSync(home);mkdirSync(cwd);mkdirSync(join(home,"sessions"));
    const file=join(home,"sessions","rollout-"+threadID+".jsonl"),meta={type:"session_meta",payload:{id:threadID,cwd}},identity={home,cwd,threadID,model:"fixture"};
    const write=(rows:unknown[])=>writeFileSync(file,[meta,...rows].map(row=>JSON.stringify(row)).join("\n")+"\n");
    write([context(),usage()]);await work({scope,home,cwd,threadID,file,identity,meta,write});
  });
}

test("reads native last inference total, not cumulative billing or prompt length",()=>fixture(async f=>{
  assert.equal(await resolveCodexContextFile(f.home,f.threadID),f.file);
  assert.deepEqual(await readCodexContext(f.file,f.identity),{contextWindow:1000,usedTokens:150});
  const next=usage();next.payload.info.last_token_usage={input_tokens:200,output_tokens:10,total_tokens:210};appendFileSync(f.file,JSON.stringify(next)+"\n");
  assert.deepEqual(await readCodexContext(f.file,f.identity),{contextWindow:1000,usedTokens:210});
}));
test("context locator does not follow linked directories or scan beyond its depth budget",()=>fixture(async f=>{
  assert.equal(await resolveCodexContextFile(f.home,"../thread"),undefined);
  const nested=join(f.home,"sessions","one","two","three","four","five");mkdirSync(nested,{recursive:true});
  assert.equal(await resolveCodexContextFile(f.home,f.threadID),undefined);
}));

test("peer budget uses current-turn native usage records and counts post-inference tool/event bytes",()=>fixture(async f=>{
  const turnID=randomUUID(),identity={...f.identity,turnID};
  const started={type:"event_msg",timestamp,payload:{type:"task_started",turn_id:turnID,model_context_window:100000}};
  const ctx={...context(),payload:{model:"fixture",turn_id:turnID}};
  const record={type:"token_usage_record",timestamp,payload:{thread_id:f.threadID,session_id:f.threadID,turn_id:turnID,usage:{input_tokens:120,output_tokens:30,total_tokens:150},thread_token_usage:{total_tokens:999999}}};
  const trailing={type:"response_item",timestamp,payload:{type:"function_call_output",output:"tool data"}};
  f.write([started,ctx,record,trailing]);
  const value=await readCodexContext(f.file,identity);
  assert.deepEqual(value.peerBudget,{state:"known",source:"native_estimate",contextWindowTokens:100000,inputTokens:150+Buffer.byteLength(JSON.stringify(trailing))+1,
    outputTokens:0,outputReservation:"native_usable_window",overheadTokens:17024});
  const legacy=usage();legacy.payload.info.model_context_window=200000;
  f.write([started,ctx,legacy]);
  const wider=(await readCodexContext(f.file,identity)).peerBudget;assert.ok(wider?.state==="known");
  assert.equal(wider.contextWindowTokens,100000);
  legacy.payload.info.model_context_window=50000;f.write([started,ctx,legacy]);
  const narrower=(await readCodexContext(f.file,identity)).peerBudget;assert.ok(narrower?.state==="known");
  assert.equal(narrower.contextWindowTokens,50000);
  for(const patch of [{turn_id:randomUUID()},{thread_id:randomUUID()},{session_id:randomUUID()},{usage:{input_tokens:1,output_tokens:1,total_tokens:3}}]){
    f.write([started,ctx,record,{...record,payload:{...record.payload,...patch}}]);assert.deepEqual(await readCodexContext(f.file,identity),{});
  }
  for(const rows of [[ctx,record],[started,context(),record],[started,ctx,record,{type:"compacted",payload:{}}],
    [started,ctx,record,{...started,payload:{...started.payload,turn_id:randomUUID()}},record],
    [started,ctx,record,{type:"compacted",payload:{}},usage()],
    [started,ctx,{...record,timestamp:"invalid"}],[started,ctx,{...record,timestamp:"2026-10-22T00:00:00.000Z"}]]){
    f.write(rows);assert.deepEqual(await readCodexContext(f.file,{...identity,notBefore:Date.parse(timestamp)}),{});
  }
}));
test("missing, foreign thread/cwd/model and observations before the current input remain unknown",()=>fixture(async f=>{
  for(const patch of [{threadID:randomUUID()},{cwd:f.home},{model:"other"},{notBefore:Date.parse(timestamp)+1}])assert.deepEqual(await readCodexContext(f.file,{...f.identity,...patch}),{});
  assert.deepEqual(await readCodexContext(join(f.home,"missing"),f.identity),{});
}));

test("native completion requires an exact fresh root turn and is invalidated by later abort or input",()=>fixture(async f=>{
  const turnID=randomUUID(),identity={...f.identity,turnID,verifyCompletion:true},started={type:"event_msg",timestamp,payload:{type:"task_started",turn_id:turnID,model_context_window:128000}};
  const ctx={...context(),payload:{model:"fixture",turn_id:turnID}},complete={type:"event_msg",timestamp,payload:{type:"task_complete",turn_id:turnID,root_turn_id:turnID,last_agent_message:"Actual final reply"}};
  f.write([started,ctx,complete]);assert.deepEqual(await readCodexContext(f.file,identity),{completedText:"Actual final reply"});
  for(const patch of [{turn_id:randomUUID()},{root_turn_id:randomUUID()},{last_agent_message:""}]){
    f.write([started,ctx,{...complete,payload:{...complete.payload,...patch}}]);assert.deepEqual(await readCodexContext(f.file,identity),{});
  }
  for(const row of [{type:"event_msg",payload:{type:"turn_aborted"}},started,ctx,{type:"compacted",payload:{}}]){
    f.write([started,ctx,complete,row]);assert.deepEqual(await readCodexContext(f.file,identity),{});
  }
  f.write([started,ctx,complete]);assert.deepEqual(await readCodexContext(f.file,{...identity,notBefore:Date.parse(timestamp)+1}),{});
}));

test("native outgoing proof is exact root model/turn/call/item/namespace/arguments and ends on tool result",()=>fixture(async f=>{
  const turnID=randomUUID(),callID="native-call",itemID="native-item",args={operation:"presence"},namespace="mcp__phonon_current_turn",name="phonon_project_coordination";
  const identity={...f.identity,turnID,verifyToolCall:{callID,itemID,namespace,name,arguments:args}};
  const ctx={...context(),payload:{model:"fixture",turn_id:turnID}},row={type:"response_item",timestamp,metadata:{client_authored:false},payload:{type:"function_call",id:itemID,call_id:callID,name,namespace,arguments:JSON.stringify(args),internal_chat_message_metadata_passthrough:{turn_id:turnID}}};
  f.write([ctx,row]);assert.deepEqual(await readCodexContext(f.file,identity),{toolCallVerified:true});
  for(const patch of [{itemID:"foreign"},{namespace:"mcp__foreign"},{name:"foreign"},{callID:"foreign"},{arguments:{operation:"leave"}}])
    assert.deepEqual(await readCodexContext(f.file,{...identity,verifyToolCall:{...identity.verifyToolCall,...patch}}),{});
  for(const next of [{...row,metadata:{client_authored:true}},{...row,payload:{...row.payload,internal_chat_message_metadata_passthrough:{turn_id:"child"}}},
    {type:"event_msg",payload:{type:"task_complete"}},{type:"event_msg",payload:{type:"turn_aborted"}},
    {type:"response_item",payload:{type:"function_call_output",call_id:callID,output:"already returned"}},context("other")]){
    f.write([ctx,row,next]);assert.deepEqual(await readCodexContext(f.file,identity),{});
  }
}));
test("new input, native compaction, new model and incomplete native records invalidate the earlier count",()=>fixture(async f=>{
  for(const row of [context("other"),context(),{type:"compacted",payload:{}},{type:"event_msg",payload:{type:"context_compacted"}},{type:"event_msg",payload:{type:"task_started"}},usage()]){
    f.write([context(),usage(),row]);if("type" in row.payload&&row.payload.type==="token_count")appendFileSync(f.file,'{"type":');
    assert.deepEqual(await readCodexContext(f.file,f.identity),{});
  }
  f.write([context(),usage()]);appendFileSync(f.file,"not json\n");assert.deepEqual(await readCodexContext(f.file,f.identity),{});
}));
test("invalid, missing, fractional, unsafe and inconsistent native counters never reuse an earlier count",()=>fixture(async f=>{
  const variants:any[]=[];
  for(const value of [-1,1.5,"150",Number.MAX_SAFE_INTEGER+1,null]){const row=usage();row.payload.info.last_token_usage.total_tokens=value as never;variants.push(row);}
  for(const value of [0,-1,1.5,"1000",null]){const row=usage();row.payload.info.model_context_window=value as never;variants.push(row);}
  const wrong=usage();wrong.payload.info.last_token_usage.total_tokens=149;variants.push(wrong);
  const missing=usage();delete (missing.payload.info as any).last_token_usage;variants.push(missing);
  const noTimestamp=usage();delete (noTimestamp as any).timestamp;variants.push(noTimestamp);
  for(const row of variants){f.write([context(),usage(),row]);assert.deepEqual(await readCodexContext(f.file,f.identity),{});}
}));
test("bounded tails without a matching context never scan unbounded history or guess the model",()=>fixture(async f=>{
  f.write([context(),{type:"response_item",payload:{text:"x".repeat(1100000)}},usage()]);
  assert.deepEqual(await readCodexContext(f.file,f.identity),{});
}));
test("refuses symlink, hardlink and outside-home files",()=>fixture(async f=>{
  const outside=join(f.scope.root,"outside.jsonl");writeFileSync(outside,readFileSync(f.file));
  assert.deepEqual(await readCodexContext(outside,f.identity),{});
  const link=join(f.home,"linked.jsonl");symlinkSync(f.file,link);assert.deepEqual(await readCodexContext(link,f.identity),{});
  const hard=join(f.home,"hard.jsonl");linkSync(f.file,hard);assert.deepEqual(await readCodexContext(f.file,f.identity),{});
}));
test("adapter exposes native usage and a history rewrite removes stale counts even after recovery",()=>fixture(async f=>{
  const adapter=new CodexAdapter({env:{codexHome:f.home,defaultModel:"fixture",binPath:join(f.scope.root,"no-native-process")}});
  const checkpoint={threadId:f.threadID,nativeHome:f.home,pendingInject:[]};
  const session=await adapter.recoverSession({sessionId:"test",agentId:"codex",model:"fixture",cwd:f.cwd},checkpoint);
  assert.deepEqual(await session.describe?.(),{contextWindow:1000,usedTokens:150});
  await session.switchModel?.("other");assert.deepEqual(await session.describe?.(),{});
  await session.switchModel?.("fixture");assert.deepEqual(await session.describe?.(),{});
  f.write([context(),{type:"response_item",payload:{type:"function_call",call_id:"old",name:"read",arguments:"{}"}},{type:"response_item",payload:{type:"function_call_output",call_id:"old",output:"old"}},usage()]);
  const compressed=await session.compressCustom?.("dropToolIO",{keepRecentToolCalls:0});assert.equal(compressed?.filesChanged,1);
  assert(!readFileSync(f.file,"utf8").includes('"token_count"'));
  const recovered=await adapter.recoverSession({sessionId:"recovered",agentId:"codex",model:"fixture",cwd:f.cwd},checkpoint);
  assert.deepEqual(await recovered.describe?.(),{});
  appendFileSync(f.file,[context(),usage()].map(row=>JSON.stringify(row)).join("\n")+"\n");
  assert.deepEqual(await recovered.describe?.(),{contextWindow:1000,usedTokens:150});
  await recovered.terminate();await session.terminate();
}));
test("no-op compression keeps the unchanged native usage",()=>fixture(async f=>{
  const adapter=new CodexAdapter({env:{codexHome:f.home,defaultModel:"fixture"}}),checkpoint={threadId:f.threadID,nativeHome:f.home,pendingInject:[]};
  const session=await adapter.recoverSession({sessionId:"test",agentId:"codex",model:"fixture",cwd:f.cwd},checkpoint);
  const before=readFileSync(f.file);assert.equal((await session.compressCustom?.("dropToolIO",{keepRecentToolCalls:0}))?.filesChanged,0);
  assert.deepEqual(readFileSync(f.file),before);assert.deepEqual(await session.describe?.(),{contextWindow:1000,usedTokens:150});await session.terminate();
}));
test("model-switch invalidation survives recovery without changing the native thread or replaying input",()=>fixture(async f=>{
  const adapter=new CodexAdapter({env:{codexHome:f.home,defaultModel:"fixture"}}),checkpoint={threadId:f.threadID,nativeHome:f.home,pendingInject:[]};
  const params={sessionId:"test",agentId:"codex",model:"fixture",cwd:f.cwd},session=await adapter.recoverSession(params,checkpoint);
  await session.switchModel?.("other");await session.switchModel?.("fixture");
  const saved=session.recoveryCheckpoint?.();assert.equal(saved?.threadId,f.threadID);assert.equal(typeof saved?.contextNotBefore,"number");
  const recovered=await adapter.recoverSession(params,saved!);assert.deepEqual(await recovered.describe?.(),{});
  assert.equal(recovered.recoveryCheckpoint?.()?.threadId,f.threadID);await recovered.terminate();await session.terminate();
}));
test("ordinary non-Codex history compression does not silently remove token observations",()=>fixture(async f=>{
  f.write([context(),{type:"response_item",payload:{type:"function_call",call_id:"old",name:"read",arguments:"{}"}},usage()]);
  const result=await dropToolIOFromJsonlFiles([f.file],{keepRecentToolCalls:0});assert.equal(result.filesChanged,1);
  assert(readFileSync(f.file,"utf8").includes('"token_count"'));
}));
test("a newly submitted but cancelled input cannot retain the previous inference count",()=>fixture(async f=>{
  const adapter=new CodexAdapter({env:{codexHome:f.home,defaultModel:"fixture",binPath:join(f.scope.root,"must-not-run")}});
  const session=await adapter.recoverSession({sessionId:"test",agentId:"codex",model:"fixture",cwd:f.cwd},{threadId:f.threadID,nativeHome:f.home,pendingInject:[]});
  assert.deepEqual(await session.describe?.(),{contextWindow:1000,usedTokens:150});
  const signal=AbortSignal.abort(),events:any[]=[];
  await session.send("cancelled before native work",{turnId:"cancelled",verbosity:"final",signal,emit:event=>events.push(event)});
  assert.equal(events.at(-1)?.status,"interrupted");assert.deepEqual(await session.describe?.(),{});
  assert.equal(session.recoveryCheckpoint?.()?.threadId,f.threadID);await session.terminate();
}));
