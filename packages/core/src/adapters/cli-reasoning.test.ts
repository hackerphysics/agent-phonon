import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { withPeerFixture } from "../testing/peer-fixture.js";
import { CopilotAdapter } from "./copilot.js";
import { discoverCopilotNativeModels, parseCopilotNativeModels } from "./copilot-models.js";
import { OpenCodeAdapter } from "./opencode.js";
import { parseOpenCodeNativeModels } from "./opencode-models.js";
import {OpenClawAdapter} from "./openclaw.js";
import {parseOpenClawNativeModels} from "./openclaw-models.js";

const models=[{id:"model",name:"Model",capabilities:{supports:{reasoningEffort:true}},supportedReasoningEfforts:["low","medium","high","xhigh","max"]}];
const opencode={id:"model",providerID:"fixture",name:"Native",capabilities:{reasoning:true},variants:{low:{reasoningEffort:"low"},normal:{reasoningEffort:"medium"},maximum:{reasoningEffort:"max"},disabled:{reasoningEffort:"high",disabled:true}}};
const cli=String.raw`
import fs from 'node:fs';import path from 'node:path';import {fileURLToPath} from 'node:url';
const root=path.dirname(fileURLToPath(import.meta.url)),args=process.argv.slice(2),control=JSON.parse(fs.readFileSync(path.join(root,'control.json'),'utf8'));
const log=value=>fs.appendFileSync(path.join(root,'calls.jsonl'),JSON.stringify(value)+'\n');
if(args.includes('--version')){console.log(control.kind==='copilot'?'1.0.82':'1.15.10');process.exit(0);}
if(args.includes('--help')){console.log(control.kind==='copilot'?'--reasoning-effort <level>':control.kind==='openclaw'?'--thinking <level>':'--variant <name>');process.exit(0);}
if(control.kind==='openclaw'){
 log({args});if(args[0]==='models')console.log(JSON.stringify({models:[{key:'fixture/model',available:true}]}));
 else if(args[0]==='gateway')console.log(JSON.stringify({models:[{id:'model',provider:'fixture',available:true,thinkingLevels:[{id:'low'},{id:'medium'},{id:'max'}]}]}));
 else console.log(JSON.stringify({payloads:[{text:'actual completion'}]}));process.exit(0);
}
if(args[0]==='models'){log({args});for(const model of [control.opencode,...control.additionalOpenCode??[]])console.log(model.providerID+'/'+model.id+'\n'+JSON.stringify(model,null,2));process.exit(0);}
if(args[0]==='debug'){console.log(JSON.stringify({model:'fixture/model'}));process.exit(0);}
if(args.includes('--headless')){
 let buffer=Buffer.alloc(0);for await(const chunk of process.stdin){buffer=Buffer.concat([buffer,chunk]);let end;
 while((end=buffer.indexOf('\r\n\r\n'))>=0){const length=Number(buffer.subarray(0,end).toString().match(/Content-Length: (\d+)/i)[1]);if(buffer.length<end+4+length)break;
 const q=JSON.parse(buffer.subarray(end+4,end+4+length).toString());buffer=buffer.subarray(end+4+length);log({query:q,args});
 if(!['ping','models.list'].includes(q.method))throw Error('A metadata probe must never create a session or send a task');
 const send=value=>{const json=JSON.stringify(value),wire='Content-Length: '+Buffer.byteLength(json)+'\r\n\r\n'+json;process.stdout.write(wire.slice(0,9));process.stdout.write(wire.slice(9));};
 send({jsonrpc:'2.0',id:q.id,method:'native.request',params:{}});
 send({jsonrpc:'2.0',id:q.id,result:q.method==='ping'?{message:'metadata'}:{models:control.models}});
 }}process.exit(0);
}
if(control.kind==='copilot'){
 let prompt='';for await(const chunk of process.stdin)prompt+=chunk;log({args,prompt});
 const sessionId='11111111-1111-4111-8111-111111111111',model=args[args.indexOf('--model')+1],effort=args[args.indexOf('--reasoning-effort')+1];
 const data={sessionId,selectedModel:model,reasoningEffort:effort,...control.evidence};
 console.log(JSON.stringify({type:args.some(a=>a.startsWith('--resume'))?'session.resume':'session.start',timestamp:control.stale?'2000-01-01T00:00:00.000Z':new Date().toISOString(),data}));
 console.log(JSON.stringify({type:'assistant.message',data:{content:'actual completion'}}));
 console.log(JSON.stringify({type:'result',exitCode:0,sessionId}));
}else{
 log({args});console.log(JSON.stringify({type:'text',sessionID:'ses_fixture',part:{text:'actual completion'}}));console.log(JSON.stringify({type:'step_finish',sessionID:'ses_fixture'}));
}
`;

function fixture(root:string,control:Record<string,unknown>){
  const bin=join(root,"native.mjs");
  writeFileSync(bin,"#!"+process.execPath+"\n"+cli,{mode:0o700});
  const configure=(next:Record<string,unknown>)=>writeFileSync(join(root,"control.json"),JSON.stringify({models,opencode,...control,...next}),{mode:0o600});
  configure({});
  return {bin,configure,calls:()=>readFileSync(join(root,"calls.jsonl"),"utf8").trim().split("\n").map(row=>JSON.parse(row))};
}

test("Copilot uses authenticated per-model effort lists, not a reasoning boolean or static help",()=>{
  const result=parseCopilotNativeModels({models:[models[0],{id:"plain",capabilities:{supports:{reasoningEffort:false}},supportedReasoningEfforts:["max"]},{id:"disabled",policy:{state:"disabled"}}]});
  assert.deepEqual(result[0]?.reasoningLevels,["low","standard","high","xhigh","max"]);
  assert.equal(result[1]?.reasoningLevels,undefined);assert.equal(result[2]?.available,false);
  assert.throws(()=>parseCopilotNativeModels({models:[models[0],models[0]]}));
});

test("OpenCode maps only unambiguous, enabled native effort variants and strips private options",()=>{
  const result=parseOpenCodeNativeModels("fixture/model\n"+JSON.stringify({...opencode,headers:{Authorization:"synthetic"}},null,2));
  assert.deepEqual(result.models,[{id:"fixture/model",displayName:"Native",available:true,reasoningLevels:["low","standard","max"]}]);
  assert.equal(result.variants.get("fixture/model")?.get("max"),"maximum");
  const ambiguous={...opencode,variants:{one:{reasoningEffort:"high"},two:{reasoningEffort:"high"}}};
  assert.deepEqual(parseOpenCodeNativeModels("fixture/model\n"+JSON.stringify(ambiguous,null,2)).models[0]?.reasoningLevels,[]);
  assert.throws(()=>parseOpenCodeNativeModels("other/model\n"+JSON.stringify(opencode,null,2)));
});

test("OpenClaw retains native id-based thinking levels without guessing model support",()=>{
  assert.deepEqual(parseOpenClawNativeModels({models:[{id:"model",provider:"native",available:true,thinkingLevels:[{id:"off"},{id:"medium"},{id:"xhigh"},{id:"max"}]}]})[0]?.reasoningLevels,["standard","xhigh","max"]);
  assert.equal(parseOpenClawNativeModels({models:[{key:"native/plain",available:true}]})[0]?.reasoningLevels,undefined);
  assert.throws(()=>parseOpenClawNativeModels({models:[{key:"duplicate"},{key:"duplicate"}]}));
});

test("framed Copilot metadata handles chunks and ignores native requests without starting tasks",{skip:process.platform==="win32"},()=>withPeerFixture("copilot-effort-metadata",async scope=>{
  const f=fixture(scope.root,{kind:"copilot"});
  const found=await discoverCopilotNativeModels({bin:f.bin,onRuntime:runtime=>scope.watch(runtime.child,true)});
  assert.deepEqual(found[0]?.reasoningLevels,["low","standard","high","xhigh","max"]);
  assert.deepEqual(f.calls().map(call=>call.query.method),["ping","models.list"]);
}));

test("Copilot default sentinel enriches only the proven configured native model",{skip:process.platform==="win32"},()=>withPeerFixture("copilot-effort-alias",async scope=>{
  const f=fixture(scope.root,{kind:"copilot"}),previous=process.env.COPILOT_HOME;
  writeFileSync(join(scope.root,"config.json"),JSON.stringify({model:"model"}),{mode:0o600});
  process.env.COPILOT_HOME=scope.root;
  try{
    const explicit=[{id:"default",available:true}],adapter=new CopilotAdapter({env:{binPath:f.bin,defaultModel:"default",models:explicit}});
    assert.deepEqual((await adapter.discoverAgents())[0]?.models[0]?.reasoningLevels,["low","standard","high","xhigh","max"]);
    assert.deepEqual(explicit,[{id:"default",available:true}]);
  }finally{if(previous===undefined)delete process.env.COPILOT_HOME;else process.env.COPILOT_HOME=previous;}
}));

test("Copilot passes the native effort, confirms only fresh exact-session evidence and never replays",{skip:process.platform==="win32"},()=>withPeerFixture("copilot-effort-send",async scope=>{
  const f=fixture(scope.root,{kind:"copilot"});
  const adapter=new CopilotAdapter({env:{binPath:f.bin,defaultModel:"model",models:[{id:"model",available:true}]}});
  const descriptor=(await adapter.discoverAgents())[0]!;
  assert.equal(descriptor.capabilities.reasoningControl,true);assert.deepEqual(descriptor.models[0]?.reasoningLevels,["low","standard","high","xhigh","max"]);
  const session=await adapter.createSession({sessionId:"fixture",agentId:"copilot",model:"model",cwd:scope.root});
  scope.defer(()=>session.terminate());
  for(const [index,control]of [{},{stale:true},{evidence:{sessionId:"other"}},{evidence:{selectedModel:"other"}},{evidence:{reasoningEffort:"high"}}].entries()){
    f.configure(control);const events:any[]=[],proof:unknown[]=[];
    await session.send("original input "+index,{turnId:"turn-"+index,verbosity:"trace",emit:event=>events.push(event),reasoning:{level:"max"},acknowledgeReasoning:value=>proof.push(value)});
    assert.equal(events.at(-1)?.status,"completed");assert.deepEqual(proof,index===0?["max"]:[]);
  }
  const sends=f.calls().filter(call=>call.prompt);assert.equal(sends.length,5);
  assert(sends.every(call=>call.args[call.args.indexOf("--reasoning-effort")+1]==="max"));
  assert(sends[1].args.some((arg:string)=>arg.startsWith("--resume=")));
}));

test("OpenCode discovers pure native metadata and applies the mapped variant once without fabricated proof",{skip:process.platform==="win32"},()=>withPeerFixture("opencode-effort-send",async scope=>{
  const f=fixture(scope.root,{kind:"opencode",additionalOpenCode:[{...opencode,id:"other",variants:{peak:{reasoningEffort:"max"}}}]}),adapter=new OpenCodeAdapter({env:{binPath:f.bin}});
  const descriptor=(await adapter.discoverAgents())[0]!;
  assert.equal(descriptor.capabilities.reasoningControl,true);assert.deepEqual(descriptor.models[0]?.reasoningLevels,["low","standard","max"]);
  const session=await adapter.createSession({sessionId:"fixture",agentId:"opencode",model:"fixture/model",cwd:scope.root});scope.defer(()=>session.terminate());
  const events:any[]=[],proof:unknown[]=[];
  await session.send("original input",{turnId:"turn",verbosity:"trace",emit:event=>events.push(event),reasoning:{level:"max"},acknowledgeReasoning:value=>proof.push(value)});
  await session.switchModel!("fixture/other");
  await session.send("next original input",{turnId:"next",verbosity:"trace",emit:event=>events.push(event),reasoning:{level:"max"},acknowledgeReasoning:value=>proof.push(value)});
  assert.equal(events.at(-1)?.status,"completed");assert.deepEqual(proof,[]);
  const calls=f.calls();assert(calls.find(call=>call.args[0]==="models").args.includes("--pure"));
  const sends=calls.filter(call=>call.args[0]==="run");assert.equal(sends.length,2);
  assert.equal(sends[0].args[sends[0].args.indexOf("--variant")+1],"maximum");
  assert.equal(sends[1].args[sends[1].args.indexOf("--variant")+1],"peak");
}));

test("OpenClaw one-shot CLI uses agent-scoped native levels and sends thinking without inventing confirmation",{skip:process.platform==="win32"},()=>withPeerFixture("openclaw-cli-effort",async scope=>{
  const f=fixture(scope.root,{kind:"openclaw"}),adapter=new OpenClawAdapter({binPath:f.bin,defaultAgent:"owned"});
  const descriptor=(await adapter.discoverAgents())[0]!;
  assert.equal(descriptor.capabilities.reasoningControl,true);assert.deepEqual(descriptor.models[0]?.reasoningLevels,["low","standard","max"]);
  const session=await adapter.createSession({sessionId:"fixture",agentId:"openclaw:owned",model:"fixture/model",cwd:scope.root});scope.defer(()=>session.terminate());
  const events:any[]=[],proof:unknown[]=[];
  await session.send("original input",{turnId:"turn",verbosity:"trace",emit:event=>events.push(event),reasoning:{level:"standard"},acknowledgeReasoning:value=>proof.push(value)});
  assert.equal(events.at(-1)?.status,"completed");assert.deepEqual(proof,[]);
  const calls=f.calls(),sent=calls.filter(call=>call.args.includes("--message"));assert.equal(sent.length,1);
  assert.equal(sent[0].args[sent[0].args.indexOf("--thinking")+1],"medium");
  assert.equal(calls.find(call=>call.args[0]==="models").args[3],"owned");
  assert.equal(JSON.parse(calls.find(call=>call.args[0]==="gateway").args[4]).agentId,"owned");
}));
