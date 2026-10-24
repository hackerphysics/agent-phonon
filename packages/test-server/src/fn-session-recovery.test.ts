import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {fileURLToPath} from "node:url";
import { AdapterRegistry, CodexAdapter, PhononStore } from "@agent-phonon/core";
import { PhononDevice, PhononSession } from "@agent-phonon/server-sdk";
import { TestConn } from "./harness.js";

const nativeID = "11111111-1111-4111-8111-111111111111";
async function until(check:()=>boolean | Promise<boolean>) {
  for (let i=0;i<300;i++) { if (await check()) return; await new Promise(resolve=>setTimeout(resolve,10)); }
  throw new Error("fixture state was not observed");
}
async function setup() {
  const root=realpathSync(mkdtempSync(join(tmpdir(),"phonon-recovery-"))), home=join(root,"codex-home"), bin=join(root,"codex.cjs");
  mkdirSync(home);
  writeFileSync(bin, `#!${process.execPath}
const fs=require('node:fs'),path=require('node:path');
if(process.argv.includes('--version')){console.log('codex fixture');process.exit(0);}
const args=process.argv.slice(2),input=fs.readFileSync(0,'utf8'),home=process.env.CODEX_HOME,id=${JSON.stringify(nativeID)};
if(!args.includes('--skip-git-repo-check')){console.error('Non-Git working directory needs explicit authorization');process.exit(3);}
const dir=path.join(home,'sessions'),file=path.join(dir,'rollout-'+id+'.jsonl');
fs.mkdirSync(dir,{recursive:true});
if(!args.includes('resume'))fs.writeFileSync(file,JSON.stringify({type:'session_meta',payload:{id,cwd:process.cwd()}})+'\\n');
else if(args[2]!==id||!fs.existsSync(file))process.exit(2);
fs.appendFileSync(path.join(home,'invocations.jsonl'),JSON.stringify({args,input})+'\\n');
console.log(JSON.stringify({type:'thread.started',thread_id:input==='different-thread'?'22222222-2222-4222-8222-222222222222':id}));
const done=()=>{console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'result: '+input}}));console.log(JSON.stringify({type:'turn.completed'}));};
if(input==='hold')setTimeout(done,10000);else done();
`, {mode:0o700});
  let store=new PhononStore(join(root,"state.db"));
  const registry=new AdapterRegistry();
  const adapter=new CodexAdapter({env:{binPath:bin,codexHome:home,defaultModel:"model",models:[{id:"model",available:true}]}});
  let nativeSession:Awaited<ReturnType<typeof adapter.createSession>> | undefined;
  const create=adapter.createSession.bind(adapter);
  adapter.createSession=async(params)=>{nativeSession=await create(params);return nativeSession;};
  registry.register(adapter);
  let conn=new TestConn({registry,store,workspaceRoot:root,tenantId:"owner"});
  const project=(await conn.call("project.create",{name:"work",git:false}) as any).project.projectId;
  const session=(await conn.call("session.create",{project,agent:"codex",model:"model"}) as any).sessionId;
  const identity={sessionId:session,project,agent:"codex",model:"model"};
  const invocations=()=>existsSync(join(home,"invocations.jsonl"))?readFileSync(join(home,"invocations.jsonl"),"utf8").trim().split("\n").map(line=>JSON.parse(line)):[];
  return {root,home,bin,get store(){return store;},get nativeSession(){return nativeSession;},registry,identity,invocations,get conn(){return conn;},
    async turn(input:string) { const ack=await conn.call("session.send",{sessionId:session,input}) as any; await conn.waitTurnEnd(ack.turnId); await until(async()=> (await conn.call("session.status",{sessionId:session}) as any).status==="idle"); },
    async restart() {await conn.conn.dispose();store.close();store=new PhononStore(join(root,"state.db"));conn=new TestConn({registry,store,workspaceRoot:root,tenantId:"owner"});return conn;},
    async close(){await conn.conn.dispose();store.close();rmSync(root,{recursive:true,force:true});}};
}

test("Codex recovery verifies native identity without input, then resumes the original thread", async()=>{
  const fixture=await setup();
  try {
    await fixture.turn("first");
    assert.equal(existsSync(join(fixture.root,"work",".git")),false);
    assert.ok(fixture.invocations()[0].args.includes("--skip-git-repo-check"));
    await fixture.conn.call("session.inject",{sessionId:fixture.identity.sessionId,context:[{role:"system",content:"keep this pending context"}]});
    const before=(await fixture.conn.call("session.status",{sessionId:fixture.identity.sessionId}) as any).streamNextSeq;
    const original=fixture.store.loadSessions("owner")[0]!;
    assert.equal(JSON.parse(String(original.recovery_json)).settled,true);
    await fixture.restart();
    const paused=await fixture.conn.call("session.status",{sessionId:fixture.identity.sessionId}) as any;
    assert.deepEqual(paused.recovery,{detached:true,canAttempt:true});
    const recovered=await fixture.conn.call("session.recover",fixture.identity) as any;
    assert.equal(recovered.status,"idle");assert.equal(recovered.sessionId,fixture.identity.sessionId);
    assert.equal(recovered.streamNextSeq,before);assert.equal(fixture.invocations().length,1);
    assert.equal(fixture.conn.streamEvents.length,0);
    await fixture.conn.call("session.recover",fixture.identity);
    assert.equal(fixture.invocations().length,1);
    await fixture.turn("second");
    const resumed=fixture.invocations()[1];
    assert.deepEqual(resumed.args.slice(0,3),["exec","resume",nativeID]);
    assert.ok(resumed.args.includes("--skip-git-repo-check"));
    assert.match(resumed.input,/keep this pending context/);assert.match(resumed.input,/second/);
    assert.ok(fixture.conn.streamEvents.every(event=>Number(event.seq)>=before));
    assert.equal((await fixture.conn.call("workflow.list",{}) as any).workflows.length,0);
  } finally {await fixture.close();}
});

test("interrupted native turns cannot recover or be implicitly recreated by send",async()=>{
  const fixture=await setup();
  try {
    await fixture.turn("settled");
    await fixture.conn.call("session.send",{sessionId:fixture.identity.sessionId,input:"hold"});
    await until(()=>fixture.invocations().length===2);
    await fixture.restart();
    const status=await fixture.conn.call("session.status",{sessionId:fixture.identity.sessionId}) as any;
    assert.equal(status.recovery.canAttempt,false);assert.equal(status.recovery.reason,"interrupted_turn");
    await assert.rejects(fixture.conn.call("session.recover",fixture.identity));
    await assert.rejects(fixture.conn.call("session.send",{sessionId:fixture.identity.sessionId,input:"do not replay"}));
    assert.equal(fixture.invocations().length,2);
    assert.equal(fixture.conn.streamEvents.length,0);
  } finally {await fixture.close();}
});

test("missing, corrupt and wrong-workspace native records fail closed without another CLI start",async()=>{
  for (const variant of ["missing","corrupt","wrong-id","wrong-cwd"]) {
    const fixture=await setup();
    try {
      await fixture.turn("first");await fixture.restart();
      const file=join(fixture.home,"sessions","rollout-"+nativeID+".jsonl");
      if(variant==="missing")rmSync(file);
      else if(variant==="corrupt")writeFileSync(file,"not-json\n");
      else writeFileSync(file,JSON.stringify({type:"session_meta",payload:{id:variant==="wrong-id"?"22222222-2222-4222-8222-222222222222":nativeID,cwd:variant==="wrong-cwd"?fixture.home:join(fixture.root,"work")}})+"\n");
      await assert.rejects(fixture.conn.call("session.recover",fixture.identity));
      assert.equal((await fixture.conn.call("session.status",{sessionId:fixture.identity.sessionId}) as any).status,"paused");
      assert.equal(fixture.invocations().length,1);
    } finally {await fixture.close();}
  }
});

test("recovery checks frozen identity, current policy and tenant ownership",async()=>{
  const fixture=await setup();let restricted:TestConn|undefined,foreign:TestConn|undefined,agentRestricted:TestConn|undefined;
  try {
    await fixture.turn("first");await fixture.restart();
    for(const field of ["project","agent","model"])await assert.rejects(fixture.conn.call("session.recover",{...fixture.identity,[field]:"changed"}));
    foreign=new TestConn({registry:fixture.registry,store:fixture.store,workspaceRoot:fixture.root,tenantId:"other"});
    await assert.rejects(foreign.call("session.recover",fixture.identity));
    restricted=new TestConn({registry:fixture.registry,store:fixture.store,workspaceRoot:fixture.root,tenantId:"owner",policy:{allowedMethods:["session.status"]}});
    await assert.rejects(restricted.call("session.recover",fixture.identity));
    agentRestricted=new TestConn({registry:fixture.registry,store:fixture.store,workspaceRoot:fixture.root,tenantId:"owner",policy:{allowedAgents:["another"] as never}});
    await assert.rejects(agentRestricted.call("session.recover",fixture.identity));
    assert.equal(fixture.invocations().length,1);
  }finally{await restricted?.conn.dispose();await foreign?.conn.dispose();await agentRestricted?.conn.dispose();await fixture.close();}
});

test("TypeScript SDK recovery forwards only Session identity",async()=>{
  const calls:any[]=[];
  const device=new PhononDevice("device","owner",{async request(method:string,params:any){calls.push({method,params});return {worktreeId:"original-worktree"};}} as never);
  const result=await new PhononSession(device,"retained").recover({project:"owned",agent:"codex",model:"model"});
  assert.equal(result.worktreeId,"original-worktree");
  assert.deepEqual(calls,[{method:"session.recover",params:{sessionId:"retained",project:"owned",agent:"codex",model:"model"}}]);
});

test("unstarted native Sessions and adapters without verified recovery remain blocked",async()=>{
  const fixture=await setup();
  try {
    await fixture.restart();
    let meta=await fixture.conn.call("session.status",{sessionId:fixture.identity.sessionId}) as any;
    assert.equal(meta.recovery.reason,"checkpoint_missing");
    await assert.rejects(fixture.conn.call("session.recover",fixture.identity));
    assert.equal(fixture.invocations().length,0);
    (fixture.registry.resolve("codex") as any).recoverSession=undefined;
    meta=await fixture.conn.call("session.status",{sessionId:fixture.identity.sessionId}) as any;
    assert.equal(meta.recovery.reason,"adapter_unsupported");
    await assert.rejects(fixture.conn.call("session.send",{sessionId:fixture.identity.sessionId,input:"no new session"}));
    assert.equal(fixture.invocations().length,0);
  }finally{await fixture.close();}
});

test("teardown fences a late successful recovery without replacing its successor",async()=>{
  const fixture=await setup();let successor:TestConn|undefined, release:(()=>void)|undefined;
  try {
    await fixture.turn("first");await fixture.restart();
    const adapter=fixture.registry.resolve("codex")!, recover=adapter.recoverSession!.bind(adapter);
    let entered=false;
    const gate=new Promise<void>(resolve=>{release=resolve;});
    adapter.recoverSession=async(params,state)=>{entered=true;await gate;return recover(params,state);};
    const old=fixture.conn, pending=old.call("session.recover",fixture.identity);
    const rejected=assert.rejects(pending);
    await until(()=>entered);await old.conn.dispose();
    release!();await rejected;
    adapter.recoverSession=recover;
    successor=new TestConn({registry:fixture.registry,store:fixture.store,workspaceRoot:fixture.root,tenantId:"owner"});
    const meta=await successor.call("session.recover",fixture.identity) as any;
    assert.equal(meta.status,"idle");assert.equal(meta.sessionId,fixture.identity.sessionId);
    assert.equal(fixture.invocations().length,1);
  }finally{release?.();await successor?.conn.dispose();await fixture.close();}
});

test("a resumed CLI cannot replace the retained thread identity",async()=>{
  const fixture=await setup();
  try {
    await fixture.turn("first");await fixture.restart();await fixture.conn.call("session.recover",fixture.identity);
    const ack=await fixture.conn.call("session.send",{sessionId:fixture.identity.sessionId,input:"different-thread"}) as any;
    const result=await fixture.conn.waitTurnEnd(ack.turnId);
    assert.equal(result.status,"failed");assert.match(String(result.message),/different native Session/);
    assert.equal(fixture.invocations().length,2);
    assert.deepEqual(fixture.invocations()[1].args.slice(0,3),["exec","resume",nativeID]);
    assert.equal(fixture.conn.streamEvents.some(event=>event.turnId===ack.turnId&&event.status==="completed"),false);
  }finally{await fixture.close();}
});

test("unconfirmed compression blocks recovery without starting a new turn",async()=>{
  const fixture=await setup();
  try {
    await fixture.turn("first");await fixture.restart();
    const at=new Date().toISOString();
    fixture.store.beginCompression("owner",{operationId:"compression",sessionId:fixture.identity.sessionId,state:"unknown",requestHash:"a".repeat(64),mode:"custom",agent:"codex",model:"model",project:fixture.identity.project,createdAt:at,updatedAt:at} as any);
    const status=await fixture.conn.call("session.status",{sessionId:fixture.identity.sessionId}) as any;
    assert.equal(status.recovery.reason,"control_unconfirmed");assert.equal(status.recovery.canAttempt,false);
    await assert.rejects(fixture.conn.call("session.recover",fixture.identity));
    assert.equal(fixture.invocations().length,1);
  }finally{await fixture.close();}
});

test("legacy and malformed checkpoints never guess a native identity",async()=>{
  for (const recoveryJSON of [undefined,"{broken",JSON.stringify({version:99}),"x".repeat(65537)]) {
    const fixture=await setup();
    try {
      await fixture.turn("first");await fixture.conn.conn.dispose();
      const row=fixture.store.loadSessions("owner")[0]!;
      fixture.store.upsertSession({sessionId:String(row.session_id),tenantId:"owner",projectId:String(row.project_id),agent:String(row.agent_id),model:String(row.model),status:String(row.status),verbosity:String(row.verbosity),createdAt:String(row.created_at),streamSeq:Number(row.stream_seq),recoveryJSON});
      await fixture.restart();
      const status=await fixture.conn.call("session.status",{sessionId:fixture.identity.sessionId}) as any;
      assert.equal(status.status,"paused");assert.equal(status.recovery.reason,"checkpoint_missing");
      await assert.rejects(fixture.conn.call("session.recover",fixture.identity));
      assert.equal(fixture.invocations().length,1);
      assert.ok(existsSync(join(fixture.home,"sessions","rollout-"+nativeID+".jsonl")));
    }finally{await fixture.close();}
  }
});

test("late model/context controls cannot overwrite the successor's paused checkpoint",async()=>{
  for (const operation of ["model","context"]) {
    const fixture=await setup();let successor:TestConn|undefined,release:(()=>void)|undefined;
    try {
      await fixture.turn("first");let entered=false;
      const gate=new Promise<void>(resolve=>{release=resolve;});
      if(operation==="model")fixture.nativeSession!.switchModel=async()=>{entered=true;await gate;return {};};
      else fixture.nativeSession!.inject=async()=>{entered=true;await gate;};
      const pending=operation==="model"?fixture.conn.call("session.switchModel",{sessionId:fixture.identity.sessionId,model:"changed"}):fixture.conn.call("session.inject",{sessionId:fixture.identity.sessionId,context:[{role:"system",content:"late context"}]});
      const rejected=assert.rejects(pending);
      await until(()=>entered);await fixture.conn.conn.dispose();
      successor=new TestConn({registry:fixture.registry,store:fixture.store,workspaceRoot:fixture.root,tenantId:"owner"});
      const before=fixture.store.loadSessions("owner")[0];
      release!();await rejected;
      assert.deepEqual(fixture.store.loadSessions("owner")[0],before);
      const status=await successor.call("session.status",{sessionId:fixture.identity.sessionId}) as any;
      assert.equal(status.model,"model");assert.equal(status.status,"paused");
      assert.equal(fixture.invocations().length,1);
    }finally{release?.();await successor?.conn.dispose();await fixture.close();}
  }
});

test("independent stores cannot adopt one native Session concurrently, and losing disposal cannot rewind it",async()=>{
  const fixture=await setup();let other:TestConn|undefined,store:PhononStore|undefined;
  try {
    await fixture.turn("first");await fixture.restart();
    store=new PhononStore(join(fixture.root,"state.db"));
    other=new TestConn({registry:fixture.registry,store,workspaceRoot:fixture.root,tenantId:"owner"});
    const attempts=await Promise.allSettled([fixture.conn.call("session.recover",fixture.identity),other.call("session.recover",fixture.identity)]);
    assert.equal(attempts.filter(result=>result.status==="fulfilled").length,1);
    const winner=attempts[0]!.status==="fulfilled"?fixture.conn:other;
    const loser=winner===other?fixture.conn:other;
    const before=fixture.store.nativeSessionSnapshot("owner",fixture.identity.sessionId);
    assert.equal((await loser.call("session.status",{sessionId:fixture.identity.sessionId}) as any).recovery.reason,"session_owned_elsewhere");
    await loser.conn.dispose();
    assert.deepEqual(fixture.store.nativeSessionSnapshot("owner",fixture.identity.sessionId),before);
    const ack=await winner.call("session.send",{sessionId:fixture.identity.sessionId,input:"winner"}) as any;
    assert.equal((await winner.waitTurnEnd(ack.turnId)).status,"completed");
    assert.equal(fixture.invocations().length,2);
  }finally{await other?.conn.dispose();store?.close();await fixture.close();}
});

test("a stale observer refreshes the durable stream cursor before native adoption",async()=>{
  const fixture=await setup();let observer:TestConn|undefined;
  try {
    await fixture.turn("first");
    observer=new TestConn({registry:fixture.registry,store:fixture.store,workspaceRoot:fixture.root,tenantId:"owner"});
    await fixture.turn("second");
    const next=(await fixture.conn.call("session.status",{sessionId:fixture.identity.sessionId}) as any).streamNextSeq;
    await fixture.conn.conn.dispose();
    const adopted=await observer.call("session.recover",fixture.identity) as any;
    assert.equal(adopted.streamNextSeq,next);
    const ack=await observer.call("session.send",{sessionId:fixture.identity.sessionId,input:"third"}) as any;
    await observer.waitTurnEnd(ack.turnId);
    assert.ok(observer.streamEvents.every(event=>Number(event.seq)>=next));
  }finally{await observer?.conn.dispose();await fixture.close();}
});

test("native adoption rejects a stop-state change between its verified snapshot and ownership claim",async()=>{
  const fixture=await setup();let observer:TestConn|undefined;
  const claim=fixture.store.claimNativeSession.bind(fixture.store);
  try{
    await fixture.turn("first");await fixture.conn.conn.dispose();
    observer=new TestConn({registry:fixture.registry,store:fixture.store,workspaceRoot:fixture.root,tenantId:"owner"});
    const stop=JSON.stringify({version:1,sessionId:fixture.identity.sessionId,state:"pending",observedAt:new Date().toISOString()});
    fixture.store.claimNativeSession=(...args:Parameters<typeof claim>)=>{
      (fixture.store as any).db.prepare("UPDATE sessions SET native_stop_json=?,status='paused' WHERE session_id=? AND tenant_id=?").run(stop,fixture.identity.sessionId,"owner");
      return claim(...args);
    };
    await assert.rejects(observer.call("session.recover",fixture.identity),(error:any)=>error.data?.appCode==="errSessionBusy");
    assert.equal(fixture.invocations().length,1);
    assert.equal(fixture.store.nativeSessionSnapshot("owner",fixture.identity.sessionId)?.native_stop_json,stop);
  }finally{fixture.store.claimNativeSession=claim;await observer?.conn.dispose();await fixture.close();}
});

test("a dead process owner permits verified idle adoption without another native invocation",async()=>{
  const fixture=await setup();let child:ReturnType<typeof spawn>|undefined,contender:TestConn|undefined;
  try {
    await fixture.turn("first");await fixture.conn.conn.dispose();
    const sourceMode=import.meta.url.endsWith(".ts"),preloads:string[]=[];
    if(sourceMode)for(let i=0;i<process.execArgv.length;i++)if(["--import","--require"].includes(process.execArgv[i]!)){preloads.push(process.execArgv[i]!,process.execArgv[++i]!);}
    const source=`import {AdapterRegistry,CodexAdapter,PhononStore} from ${JSON.stringify(new URL(sourceMode?"../../core/src/index.ts":"../../core/dist/index.js",import.meta.url).href)};
      import {TestConn} from ${JSON.stringify(new URL(sourceMode?"./harness.ts":"./harness.js",import.meta.url).href)};
      const store=new PhononStore(${JSON.stringify(join(fixture.root,"state.db"))}),registry=new AdapterRegistry();
      registry.register(new CodexAdapter({env:${JSON.stringify({binPath:fixture.bin,codexHome:fixture.home,defaultModel:"model"})}}));
      const conn=new TestConn({store,registry,workspaceRoot:${JSON.stringify(fixture.root)},tenantId:'owner'});
      const result=await conn.call('session.recover',${JSON.stringify(fixture.identity)});process.send({ready:true,status:result.status});setInterval(()=>{},1000);`;
    child=spawn(process.execPath,[...preloads,"--input-type=module","-e",source],{stdio:["ignore","pipe","pipe","ipc"],env:{PATH:process.env.PATH,HOME:fixture.root,CODEX_HOME:fixture.home,TMPDIR:fixture.root,
      ...(sourceMode?{TSX_TSCONFIG_PATH:fileURLToPath(new URL("../../../tsconfig.source-tests.json",import.meta.url))}:{})}});
    let timer:ReturnType<typeof setTimeout>|undefined;
    const message=await Promise.race([once(child,"message"),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error("owner subprocess did not become ready")),8000);})]).finally(()=>{if(timer)clearTimeout(timer);});
    assert.equal((message[0] as any).status,"idle");
    contender=new TestConn({store:fixture.store,registry:fixture.registry,workspaceRoot:fixture.root,tenantId:"owner"});
    await assert.rejects(contender.call("session.recover",fixture.identity));
    await contender.conn.dispose();
    const exited=once(child,"exit");child.kill("SIGKILL");await exited;
    await fixture.restart();
    assert.equal((await fixture.conn.call("session.recover",fixture.identity) as any).status,"idle");
    assert.equal(fixture.invocations().length,1);
    await fixture.turn("after process replacement");
    assert.deepEqual(fixture.invocations()[1].args.slice(0,3),["exec","resume",nativeID]);
  }finally{if(child&&child.exitCode===null&&child.signalCode===null){const exited=once(child,"exit");child.kill("SIGKILL");await exited;}await contender?.conn.dispose();await fixture.close();}
});
