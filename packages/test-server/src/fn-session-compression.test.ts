import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AdapterRegistry, PhononStore, HermesAdapter } from "@agent-phonon/core";
import { PhononDevice, PhononSession } from "@agent-phonon/server-sdk";
import { SessionCompressResult, CompressionReceipt } from "@agent-phonon/protocol";
import { MockAdapter, TestConn } from "./harness.js";

function deferred<T>() { let resolve!: (value:T)=>void; const promise=new Promise<T>(r=>{resolve=r;});return {promise,resolve}; }
async function setup(options?:{native?:()=>Promise<any>;custom?:()=>Promise<any>;switchModel?:()=>Promise<any>}){
  const root=realpathSync(mkdtempSync(join(tmpdir(),"phonon-comp-"))),store=new PhononStore(join(root,"state.db")),registry=new AdapterRegistry();
  let changed=false;
  const adapter=new MockAdapter({caps:{customCompression:true}}),create=adapter.createSession.bind(adapter);
  adapter.createSession=async params=>{
    const session=await create(params);
    session.compressNative=async()=>{const result=await (options?.native?.()??Promise.resolve({applied:true}));changed=result.applied===true;return result;};
    (session as any).compressCustom=options?.custom??(async()=>({filesChanged:0}));
    (session as any).describe=async()=>({usedTokens:changed?40:100,contextWindow:200});
    if(options?.switchModel)session.switchModel=options.switchModel;
    return session;
  };
  registry.register(adapter);const tc=new TestConn({registry,store,tenantId:"owner",workspaceRoot:root});
  const project=(await tc.call("project.create",{name:"compress",git:false}) as any).project.projectId;
  const session=(await tc.call("session.create",{project,agent:"mock:default",model:"m1"}) as any).sessionId;
  const close=async()=>{await tc.conn.dispose();store.close();rmSync(root,{recursive:true,force:true});};
  return {root,store,registry,tc,session,adapter,close};
}

test("compression has durable progress/proof, rejects concurrent session mutations and replays without another effect",async()=>{
  const started=deferred<void>(),finish=deferred<void>();let calls=0;
  const state=await setup({native:async()=>{calls++;started.resolve();await finish.promise;return {applied:true,summary:"verified"};}});
  try{
    const request={sessionId:state.session,mode:"native",clientRequestId:randomUUID()};
    const compressing=state.tc.call("session.compress",request);await started.promise;
    const running=await state.tc.call("session.compression.status",{sessionId:state.session,operationId:request.clientRequestId}) as any;
    assert.equal(running.state,"running");assert.equal(running.tokensBefore,undefined);
    assert.equal((await state.tc.call("session.status",{sessionId:state.session}) as any).compression.blocked,true);
    for(const[method,params]of [
      ["session.send",{input:"do not overlap"}],["session.switchModel",{model:"m2"}],["session.inject",{context:[{role:"user",content:"do not overlap"}]}],
      ["session.interrupt",{}],["session.terminate",{}],["session.compress",{mode:"native",clientRequestId:randomUUID()}],
    ] as Array<[string,Record<string,unknown>]>)await assert.rejects(state.tc.call(method,{sessionId:state.session,...params}));
    assert.equal((await state.tc.call("session.compress",request) as any).state,"running");assert.equal(calls,1);
    finish.resolve();const done=await compressing as any;
    assert.equal(done.state,"succeeded");assert.equal(done.tokensBefore,100);assert.equal(done.tokensAfter,40);assert.match(done.requestHash,/^[a-f0-9]{64}$/);
    assert.deepEqual(await state.tc.call("session.compress",request),done);assert.equal(calls,1);
    await assert.rejects(state.tc.call("session.compress",{...request,mode:"custom"}));
    const foreign=new TestConn({registry:state.registry,store:state.store,workspaceRoot:state.root,tenantId:"foreign"});
    try{await assert.rejects(foreign.call("session.compression.status",{sessionId:state.session,operationId:request.clientRequestId}));}finally{await foreign.conn.dispose();}
    await state.tc.call("session.send",{sessionId:state.session,input:"after proof"});
  }finally{finish.resolve();await state.close();}
});

test("compression cannot start while model switching is awaiting native confirmation",async()=>{
  const started=deferred<void>(),finish=deferred<void>();
  const state=await setup({switchModel:async()=>{started.resolve();await finish.promise;return {};}});
  try{
    const switching=state.tc.call("session.switchModel",{sessionId:state.session,model:"m2"});await started.promise;
    await assert.rejects(state.tc.call("session.compress",{sessionId:state.session,mode:"native"}));
    await assert.rejects(state.tc.call("session.send",{sessionId:state.session,input:"do not overlap"}));
    finish.resolve();await switching;
  }finally{finish.resolve();await state.close();}
});

test("background compression acknowledges its receipt before completion and leaves status queries responsive",async()=>{
  const started=deferred<void>(),finish=deferred<void>();
  const state=await setup({native:async()=>{started.resolve();await finish.promise;return {applied:true};}});
  try{
    const operationId=randomUUID();
    const accepted=await state.tc.call("session.compress",{sessionId:state.session,mode:"native",clientRequestId:operationId,background:true}) as any;
    assert.equal(accepted.state,"running");await started.promise;
    await state.tc.call("device.info",{});
    assert.equal((await state.tc.call("session.compression.status",{sessionId:state.session,operationId}) as any).state,"running");
    finish.resolve();
    let receipt:any;
    for(let i=0;i<100;i++){receipt=await state.tc.call("session.compression.status",{sessionId:state.session,operationId});if(receipt.state==="succeeded")break;await new Promise(resolve=>setTimeout(resolve,5));}
    assert.equal(receipt.state,"succeeded");
  }finally{finish.resolve();await state.close();}
});

test("noop compression is distinct from a verified change and does not invent token reduction",async()=>{
  const state=await setup({native:async()=>({applied:false})});
  try{
    const result=await state.tc.call("session.compress",{sessionId:state.session,mode:"native"}) as any;
    assert.equal(result.state,"noop");assert.equal(result.tokensBefore,100);assert.equal(result.tokensAfter,100);
    assert.equal((await state.tc.call("session.status",{sessionId:state.session}) as any).compression.blocked,false);
  }finally{await state.close();}
});

test("unverified or failed native outcomes pause reuse and never become successful retries",async()=>{
  for(const result of [{},{applied:"yes"},null]){
    let calls=0;const state=await setup({native:async()=>{calls++;if(result===null)throw new Error("native connection lost");return result;}});
    try{
      const request={sessionId:state.session,mode:"native",clientRequestId:randomUUID()},receipt=await state.tc.call("session.compress",request) as any;
      assert.equal(receipt.state,"unknown");assert.equal(receipt.tokensAfter,undefined);
      assert.equal((await state.tc.call("session.status",{sessionId:state.session}) as any).status,"paused");
      await assert.rejects(state.tc.call("session.send",{sessionId:state.session,input:"no automatic restart"}));
      assert.equal((await state.tc.call("session.compress",request) as any).state,"unknown");assert.equal(calls,1);
    }finally{await state.close();}
  }
});

test("a reopened receipt survives device storage reopen and an unowned running receipt becomes unknown",async()=>{
  const state=await setup();const operation=randomUUID();
  const receipt=await state.tc.call("session.compress",{sessionId:state.session,mode:"native",clientRequestId:operation}) as any;
  await state.tc.conn.dispose();state.store.close();
  const store=new PhononStore(join(state.root,"state.db"));
  const tc=new TestConn({registry:state.registry,store,tenantId:"owner",workspaceRoot:state.root});
  try{
    assert.deepEqual(await tc.call("session.compression.status",{sessionId:state.session,operationId:operation}),receipt);
    const lost={...receipt,operationId:randomUUID(),state:"running"};store.beginCompression("owner",lost);
    const status=await tc.call("session.compression.status",{sessionId:state.session,operationId:lost.operationId}) as any;
    assert.equal(status.state,"unknown");
    await assert.rejects(tc.call("session.send",{sessionId:state.session,input:"no restart while outcome is unknown"}));
    await assert.rejects(tc.call("session.compress",{sessionId:state.session,mode:"native",clientRequestId:randomUUID()}));
  }finally{await tc.conn.dispose();store.close();rmSync(state.root,{recursive:true,force:true});}
});

test("custom compression receipts retain adapter statistics without touching memory or returning backup paths",async()=>{
  let mutations=0;const state=await setup({custom:async()=>{mutations++;return {filesChanged:1,blocksRemoved:4,bytesBefore:200,bytesAfter:100,backups:["/private/local/backup"]};}});
  try{
    const memory=join(state.root,"MEMORY.md");writeFileSync(memory,"preserved memory");
    const request={sessionId:state.session,mode:"custom",clientRequestId:randomUUID(),strategy:"dropToolIO",keepRecentToolCalls:3};
    const receipt=await state.tc.call("session.compress",request) as any;
    assert.equal(receipt.state,"succeeded");assert.equal(receipt.blocksRemoved,4);assert.equal(receipt.backups,undefined);
    assert.deepEqual(SessionCompressResult.parse(receipt),receipt);
    assert.deepEqual(CompressionReceipt.parse(receipt),receipt);
    assert.deepEqual(SessionCompressResult.parse({sessionId:state.session,mode:"custom"}),{sessionId:state.session,mode:"custom"});
    assert.equal(readFileSync(memory,"utf8"),"preserved memory");
    await state.tc.call("session.compress",request);assert.equal(mutations,1);
    await assert.rejects(state.tc.call("session.compress",{...request,keepRecentToolCalls:0}));
  }finally{await state.close();}
});

test("TypeScript Session SDK forwards compression identities/options and the status method",async()=>{
  const calls:any[]=[];const device=new PhononDevice("device","owner",{request:async(method:string,params:unknown)=>{calls.push({method,params});return {};}} as never),session=new PhononSession(device,"session");
  await session.compress("custom",{clientRequestId:"operation",background:true,strategy:"dropToolIO",keepRecentToolCalls:2});await session.compressionStatus("operation");
  assert.deepEqual(calls,[{method:"session.compress",params:{sessionId:"session",mode:"custom",clientRequestId:"operation",background:true,strategy:"dropToolIO",keepRecentToolCalls:2}},
    {method:"session.compression.status",params:{sessionId:"session",operationId:"operation"}}]);
});

test("Hermes tool-history compression uses its verified profile, not another profile with the same native Session id",{skip:!existsSync("/usr/bin/python3")},async()=>{
  const root=realpathSync(mkdtempSync(join(tmpdir(),"phonon-hermes-comp-profile-"))),previous=process.env.HERMES_HOME;
  const own=join(root,"employee"),other=join(root,"default"),checkout=join(root,"checkout");
  for(const folder of [own,other,checkout,join(root,"hermes_cli")])mkdirSync(folder);
  const seed=(home:string)=>{
    const db=new DatabaseSync(join(home,"state.db"));
    db.exec(`CREATE TABLE sessions(id TEXT PRIMARY KEY); INSERT INTO sessions VALUES('native-session');
      CREATE TABLE messages(id INTEGER PRIMARY KEY,session_id TEXT,role TEXT,content TEXT,reasoning TEXT,tool_calls TEXT,tool_call_id TEXT,tool_name TEXT);
      INSERT INTO messages VALUES(1,'native-session','user','keep user',NULL,NULL,NULL,NULL);
      INSERT INTO messages VALUES(2,'native-session','assistant','keep narration','keep reasoning','[{"id":"tool-one"}]',NULL,NULL);
      INSERT INTO messages VALUES(3,'native-session','tool','old tool detail',NULL,NULL,'tool-one','read');`);db.close();
    writeFileSync(join(home,"MEMORY.md"),"preserved native memory");
  };
  seed(own);seed(other);process.env.HERMES_HOME=other;
  const otherBytes=readFileSync(join(other,"state.db")),bin=join(root,"hermes");
  writeFileSync(bin,"#!/usr/bin/python3\n");writeFileSync(join(root,"hermes_cli","__init__.py"),"");
  writeFileSync(join(root,"hermes_cli","config.py"),"def load_config(): return {}\n");
  writeFileSync(join(root,"hermes_cli","main.py"),"def main():\n from run_agent import AIAgent\n AIAgent().run_conversation()\n");
  writeFileSync(join(root,"hermes_constants.py"),`from pathlib import Path\ndef get_hermes_home(): return Path(${JSON.stringify(own)})\n`);
  writeFileSync(join(root,"run_agent.py"),"class AIAgent:\n session_id='native-session'\n def run_conversation(self,*a,**kw): return {'completed':True,'final_response':'done','messages':[]}\n");
  const adapter=new HermesAdapter({env:{binPath:bin}});
  const session=await adapter.createSession({sessionId:"owned-profile",agentId:"hermes:base",model:"m1",cwd:checkout,
    employee:{employeeId:randomUUID(),revision:1,runtimeProfile:"phn-owned",provider:"hermes",home:own,context:[]}});
  try{
    const events:any[]=[];await session.send("fixture",{turnId:"turn",verbosity:"final",emit:event=>events.push(event)});
    assert.equal(events.at(-1).status,"completed");assert.equal(session.compressionModes!().custom,true);
    const result=await session.compressCustom!("dropToolIO",{keepRecentToolCalls:0});assert.equal(result.filesChanged,1);
    const db=new DatabaseSync(join(own,"state.db"),{readOnly:true});
    try{
      const rows=db.prepare("SELECT role,content,reasoning,tool_calls FROM messages ORDER BY id").all() as any[];
      assert.deepEqual(rows.map(row=>row.role),["user","assistant"]);assert.equal(rows[1].content,"keep narration");assert.equal(rows[1].reasoning,"keep reasoning");assert.equal(rows[1].tool_calls,null);
    }finally{db.close();}
    assert.deepEqual(readFileSync(join(other,"state.db")),otherBytes);
    for(const home of [own,other])assert.equal(readFileSync(join(home,"MEMORY.md"),"utf8"),"preserved native memory");
  }finally{await session.terminate();if(previous===undefined)delete process.env.HERMES_HOME;else process.env.HERMES_HOME=previous;rmSync(root,{recursive:true,force:true});}
});
