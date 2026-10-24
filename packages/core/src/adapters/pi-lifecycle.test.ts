import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { PiAdapter } from "./pi.js";
import { withPeerFixture } from "../testing/peer-fixture.js";

const cli = String.raw`
import fs from 'node:fs';import path from 'node:path';
const args=process.argv.slice(2),home=process.env.PI_CODING_AGENT_DIR;
const control=JSON.parse(fs.readFileSync(path.join(home,'control.json'),'utf8'));
if(args.includes('--help')){console.log('--mode text, json, rpc --thinking <level> --session <path> --session-id <id> --extension <path>');process.exit(0);}
if(args.includes('--version')){console.log(control.legacy?'0.70.6':'0.84.1');process.exit(0);}
const emit=value=>console.log(JSON.stringify(value)),id=args[args.indexOf('--session-id')+1];
const dir=path.join(home,'sessions','--'+process.cwd().replace(/^[/\\]/,'').replace(/[/\\:]/g,'-')+'--');fs.mkdirSync(dir,{recursive:true});
const response=command=>emit({type:'response',id:command.id,command:command.type,success:true});
const message=(stopReason,text='')=>emit({type:'message_end',message:{role:'assistant',stopReason,content:[{type:'text',text}]}});
const finish=()=>{message('stop','Only the recovered native result');emit({type:'agent_settled',aborted:false});};
const run=()=>{
 emit({type:'agent_start'});
 if(control.phase.startsWith('thinking-')){
  if(control.phase==='thinking-native-failure'){message('error');emit({type:'agent_settled',aborted:false});}
  else finish();
  return;
 }
 if(control.phase==='hang')return;
 if(control.phase==='stale-success')message('stop','Stale earlier result');
 if(control.phase==='extension-fatal'){emit({type:'extension_error',error:'native extension failed'});finish();return;}
 if(control.phase==='native-abort'){message('aborted');setTimeout(finish,30);return;}
 if(control.phase==='stream-retry'||control.phase==='unsettled-close')emit({type:'message_update',assistantMessageEvent:{type:'error',error:'temporary stream failure'}});
 else message('error');
 if(control.phase==='retry'||control.phase==='stream-retry')setTimeout(finish,30);
 else if(control.phase==='unsettled-close')process.exit(0);
 else emit({type:'agent_settled',aborted:false});
};
if(args[args.indexOf('--mode')+1]!=='rpc'){for await(const chunk of process.stdin){}run();}
else{
 let carry='';for await(const chunk of process.stdin){carry+=chunk;let end;
  while((end=carry.indexOf('\n'))>=0){const line=carry.slice(0,end);carry=carry.slice(end+1);if(!line)continue;const command=JSON.parse(line);
   if(command.type==='get_state')emit({type:'response',id:command.id,command:command.type,success:true,data:{sessionId:id,sessionFile:path.join(dir,'2026-10-24T00-00-00-000Z_'+id+'.jsonl'),model:{provider:'fixture',id:'m1',thinkingLevelMap:{high:control.phase==='thinking-clamped'?null:'high'}},...(control.phase==='thinking-missing'?{}:{thinkingLevel:control.phase==='thinking-clamped'?'low':'high'}),isStreaming:false,isCompacting:false,pendingMessageCount:0}});
   else if(command.type==='prompt'){fs.appendFileSync(path.join(home,'prompts.jsonl'),JSON.stringify(command.message)+'\n');response(command);run();}
  }
 }
}
`;

for(const phase of ['thinking-clamped','thinking-missing','thinking-evidence-rejected','thinking-native-failure']){
  test(`Pi sends the original prompt before deciding actual outcome (${phase})`,{skip:process.platform==='win32',timeout:10000},()=>withPeerFixture('pi-thinking-fallback',async scope=>{
    const home=join(scope.root,'pi'),bin=join(scope.root,'pi.mjs');mkdirSync(home,{mode:0o700});
    writeFileSync(bin,'#!'+process.execPath+'\n'+cli,{mode:0o700});writeFileSync(join(home,'control.json'),JSON.stringify({phase}),{mode:0o600});
    const keys=['PI_CODING_AGENT_DIR','PI_CODING_AGENT_SESSION_DIR','PI_CODING_AGENT_HOME','PHONON_STATE_DIR','PATH'];
    const previous=new Map(keys.map(key=>[key,process.env[key]]));scope.defer(()=>{for(const[key,value]of previous)if(value===undefined)delete process.env[key];else process.env[key]=value;});
    Object.assign(process.env,{PI_CODING_AGENT_DIR:home,PHONON_STATE_DIR:scope.root,PATH:dirname(process.execPath)+':'+(process.env.PATH??'')});
    delete process.env.PI_CODING_AGENT_SESSION_DIR;delete process.env.PI_CODING_AGENT_HOME;
    const session=await new PiAdapter({env:{binPath:bin}}).createSession({sessionId:randomUUID(),agentId:'pi',model:'fixture/m1',cwd:scope.root});
    const controller=new AbortController(),events:any[]=[],values:string[]=[];
    let sending:Promise<void>|undefined;const timer=setTimeout(()=>controller.abort(),6000);scope.defer(()=>clearTimeout(timer));
    scope.defer(async()=>{controller.abort();await session.terminate();await sending;});
    const input='Original prompt for '+phase;
    sending=session.send(input,{turnId:'original',verbosity:'tools',reasoning:{level:'high'},signal:controller.signal,
      acknowledgeReasoning:value=>{if(value!=='high'||phase==='thinking-evidence-rejected')throw Error('setting remains unconfirmed');values.push(value);},emit:event=>events.push(event)});
    scope.watch((session as any).current,true);await sending;
    assert.deepEqual(readFileSync(join(home,'prompts.jsonl'),'utf8').trim().split('\n').map(line=>JSON.parse(line)),[input]);
    assert.equal(events.at(-1)?.status,phase==='thinking-native-failure'?'failed':'completed');
    assert.equal(events.filter(event=>event.final).length,1);
    assert.deepEqual(values,phase==='thinking-native-failure'?['high']:[]);
  }));
}

for (const phase of ["retry", "stream-retry", "exhausted", "stale-success", "unsettled-close", "native-abort", "extension-fatal", "legacy-error"] as const) {
  test(`Pi original RPC settlement owns the final outcome (${phase})`, { skip: process.platform === "win32", timeout: 10000 }, () => withPeerFixture("pi-lifecycle", async scope => {
    const home = join(scope.root, "pi"), bin = join(scope.root, "pi.mjs"); mkdirSync(home, { mode: 0o700 });
    writeFileSync(bin, "#!" + process.execPath + "\n" + cli, { mode: 0o700 });
    writeFileSync(join(home, "control.json"), JSON.stringify({ phase, legacy: phase === "legacy-error" }), { mode: 0o600 });
    const values = { PI_CODING_AGENT_DIR: home, PHONON_STATE_DIR: scope.root, PATH: dirname(process.execPath) + ":" + (process.env.PATH ?? "") };
    const previous = new Map([...Object.keys(values), "PI_CODING_AGENT_SESSION_DIR", "PI_CODING_AGENT_HOME"].map(key => [key, process.env[key]]));
    scope.defer(() => { for (const [key, value] of previous) if (value === undefined) delete process.env[key]; else process.env[key] = value; });
    Object.assign(process.env, values);
    delete process.env.PI_CODING_AGENT_SESSION_DIR; delete process.env.PI_CODING_AGENT_HOME;
    const session = await new PiAdapter({ env: { binPath: bin, defaultModel: "fixture/m1" } }).createSession({ sessionId: randomUUID(), agentId: "pi", model: "fixture/m1", cwd: scope.root });
    const controller = new AbortController(), events: any[] = [];
    const timer = setTimeout(() => controller.abort(), 6000); scope.defer(() => clearTimeout(timer));
    let sending: Promise<void> | undefined;
    scope.defer(async () => { controller.abort(); await session.terminate(); await sending; });
    sending = session.send("Original input", { turnId: "original", verbosity: "tools", signal: controller.signal, emit: event => events.push(event) });
    scope.watch((session as any).current); await sending;
    const recovered = phase === "retry" || phase === "stream-retry";
    assert.equal(events.filter(event => event.final).length, 1);
    assert.equal(events.at(-1)?.status, recovered ? "completed" : phase === "native-abort" ? "interrupted" : "failed");
    if (recovered) assert.equal(events.at(-1)?.text, "Only the recovered native result");
    if (phase === "extension-fatal") assert.match(events.at(-1)?.message, /extension failed/);
    assert.equal(events.some(event => event.final && event.text === "Stale earlier result"), false);
  }));
}

test("Pi proves a native stop only after the supervised tree is gone", { skip: process.platform === "win32", timeout: 15000 }, () => withPeerFixture("pi-stop-proof", async scope => {
  const home = join(scope.root, "pi"), bin = join(scope.root, "pi.mjs"); mkdirSync(home, { mode: 0o700 });
  writeFileSync(bin, "#!" + process.execPath + "\n" + cli, { mode: 0o700 });
  writeFileSync(join(home, "control.json"), JSON.stringify({ phase: "hang", legacy: false }), { mode: 0o600 });
  const values = { PI_CODING_AGENT_DIR: home, PHONON_STATE_DIR: scope.root, PATH: dirname(process.execPath) + ":" + (process.env.PATH ?? "") };
  const previous = new Map([...Object.keys(values), "PI_CODING_AGENT_SESSION_DIR", "PI_CODING_AGENT_HOME"].map(key => [key, process.env[key]]));
  scope.defer(() => { for (const [key, value] of previous) if (value === undefined) delete process.env[key]; else process.env[key] = value; });
  Object.assign(process.env, values);
  delete process.env.PI_CODING_AGENT_SESSION_DIR; delete process.env.PI_CODING_AGENT_HOME;
  const session = await new PiAdapter({ env: { binPath: bin, defaultModel: "fixture/m1" } }).createSession({ sessionId: randomUUID(), agentId: "pi", model: "fixture/m1", cwd: scope.root });
  const controller = new AbortController();
  let sending: Promise<void> | undefined;
  scope.defer(async () => { controller.abort(); await session.terminate(); await sending; });
  sending = session.send("Hold the turn open", { turnId: "held", verbosity: "tools", signal: controller.signal, emit: () => {} });
  const deadline = Date.now() + 5000;
  while (!(session as any).current && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
  scope.watch((session as any).current, true);
  const observe = (turnId: string) => (session as any).observeNativeStop(turnId) as Promise<string | undefined>;
  // A live turn must never be reported as stopped.
  assert.equal(await observe("held"), undefined);
  assert.equal(await observe("another-turn"), undefined);
  await session.interrupt!();
  await sending;
  assert.equal(await observe("held"), "process_tree_exit");
}));
