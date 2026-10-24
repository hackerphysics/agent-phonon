import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,mkdirSync,realpathSync,rmSync,readFileSync,writeFileSync,existsSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {PhononConnection} from "./index.js";
import {PhononStore} from "./store.js";
import {AdapterRegistry} from "./session-engine.js";
import {AgentCapabilities,AgentId} from "@agent-phonon/protocol";
import type {SkillManager} from "./skill-manager.js";
import {spawn} from "node:child_process";
import {once} from "node:events";
import {fileURLToPath} from "node:url";
import {DatabaseSync} from "node:sqlite";
import {randomUUID} from "node:crypto";

function fixture(){
  const root=realpathSync(mkdtempSync(join(tmpdir(),"phonon-skill-operations-"))),path=join(root,"native.db"),store=new PhononStore(path),registry=new AdapterRegistry();
  const capabilities=AgentCapabilities.parse({nativeSession:false,nativeCompression:false,contextInjection:false,proactiveOutput:false,modelSwitch:false,
    interrupt:false,injectMidTurn:false,skillManagement:true,hooks:[],streaming:false});
  registry.register({name:"mock",capabilities,async discoverAgents(){return [];},async createSession(){throw Error("No model is used for native install receipts");},globalSkillDir:()=>join(root,"global")});
  for(const owner of ["a","b"]){const path=join(root,owner);mkdirSync(path);store.upsertProject({projectId:"project-"+owner,namespace:"account-"+owner,name:owner,path,git:false,createdAt:new Date().toISOString()});}
  const connections:PhononConnection[]=[],stores=[store];let sequence=0;
  const actor=(owner="a",data=store,policy:Record<string,unknown>={})=>{
    const replies:Array<Record<string,any>>=[];
    const connection=new PhononConnection({tenantId:"account-"+owner,store:data,registry,workspaceRoot:root,
      policy:{allowedAgents:[AgentId.parse("mock:default"),AgentId.parse("mock:other")],...policy},transport:{send:value=>replies.push(JSON.parse(value)),close:()=>{}}});connections.push(connection);
    return {connection,manager:(connection as unknown as {skills:SkillManager}).skills,
      async call(method:string,params:unknown){const id=++sequence;await connection.handle(JSON.stringify({jsonrpc:"2.0",id,method,params}));const reply=replies.find(value=>value.id===id);assert.ok(reply);return reply;}};
  };
  const input={clientRequestId:"original-install",agent:"mock:default",name:"fixed",scope:"project",projectId:"project-a",
    source:{kind:"inline",files:{"SKILL.md":"Original supplied instructions","helper.txt":"Original supplied helper"}}};
  return {root,store,actor,input,reopen(){const data=new PhononStore(path);stores.push(data);return data;},
    async close(){for(const connection of connections)await connection.dispose();for(const data of stores)data.close();rmSync(root,{recursive:true,force:true});}};
}

function statusScope(input:ReturnType<typeof fixture>["input"]){const {source:_,...scope}=input;return scope;}
function partialFailure(actor:ReturnType<ReturnType<typeof fixture>["actor"]>){
  const manager=actor.manager as unknown as {writeSkillFile:(...args:any[])=>Promise<void>},write=manager.writeSkillFile.bind(manager);let count=0;
  manager.writeSkillFile=async(...args)=>{if(++count===2)throw Error("controlled partial file failure");await write(...args);};
  return ()=>{manager.writeSkillFile=write;};
}
async function until(check:()=>boolean){const deadline=Date.now()+5000;while(!check()){if(Date.now()>deadline)throw Error("skill operation did not reach its expected boundary");await new Promise(resolve=>setTimeout(resolve,5));}}

test("an uncertain partial skill install cannot replay its original nonce over subsequent human edits",async()=>{
  const f=fixture();try{
    const a=f.actor(),manager=a.manager as unknown as {writeSkillFile:(...args:any[])=>Promise<void>},write=manager.writeSkillFile.bind(manager);let writes=0;
    manager.writeSkillFile=async(...args)=>{if(++writes===2)throw Error("controlled write failure after first file");await write(...args);};
    assert.ok((await a.call("skill.install",f.input)).error);manager.writeSkillFile=write;
    const path=join(f.root,"a/.agent/skills/fixed/SKILL.md");assert.equal(readFileSync(path,"utf8"),"Original supplied instructions");writeFileSync(path,"Preserve this actual human edit");
    const retry=await a.call("skill.install",f.input);assert.equal(retry.error?.data?.appCode,"errSkillInstallUnconfirmed");
    assert.equal(readFileSync(path,"utf8"),"Preserve this actual human edit");
  }finally{await f.close();}
});

test("unknown skill writes survive store reopen and cannot be bypassed with another nonce, runtime, no nonce or removal",async()=>{
  const f=fixture();try{
    const a=f.actor(),restore=partialFailure(a);assert.ok((await a.call("skill.install",f.input)).error);restore();
    const path=join(f.root,"a/.agent/skills/fixed/SKILL.md");writeFileSync(path,"Actual human edit after uncertainty");
    const current=f.actor("a",f.reopen()),scope=statusScope(f.input);
    assert.equal((await current.call("skill.install.status",scope)).result.state,"unknown");
    const {clientRequestId:_,...withoutIdentity}=f.input;
    for(const params of [f.input,{...f.input,clientRequestId:"another-key"},withoutIdentity,{...f.input,clientRequestId:"other-runtime",agent:"mock:other"},
      {...f.input,clientRequestId:"case-alias",name:"FIXED"}])
      assert.equal((await current.call("skill.install",params)).error?.data?.appCode,"errSkillInstallUnconfirmed");
    assert.equal((await current.call("skill.uninstall",scope)).error?.data?.appCode,"errSkillInstallUnconfirmed");
    assert.equal(readFileSync(path,"utf8"),"Actual human edit after uncertainty");
  }finally{await f.close();}
});

test("confirmed native install results survive generic-cache loss and remain historical after a newer installation",async()=>{
  const f=fixture();try{
    const a=f.actor(),first=await a.call("skill.install",f.input);assert.ok(first.result?.skill.hash);
    assert.deepEqual((await a.call("skill.install.status",statusScope(f.input))).result.result,first.result);
    const path=join(f.root,"a/.agent/skills/fixed/SKILL.md");writeFileSync(path,"Actual human edit before receipt replay");
    const database=new DatabaseSync(join(f.root,"native.db"));
    try{database.prepare("DELETE FROM idempotency WHERE k=?").run("account-a\0skill.install\0"+f.input.clientRequestId);}finally{database.close();}
    const current=f.actor("a",f.reopen()),changed={...f.input,clientRequestId:"new-installed-version",source:{kind:"inline",files:{"SKILL.md":"Explicit newer installation"}}};
    assert.equal(f.store.idempotencyGet("account-a\0skill.install\0"+f.input.clientRequestId),undefined);
    assert.deepEqual((await current.call("skill.install",f.input)).result,first.result);assert.equal(readFileSync(path,"utf8"),"Actual human edit before receipt replay");
    const next=await current.call("skill.install",changed);assert.ok(next.result?.skill.hash);assert.notEqual(next.result.skill.hash,first.result.skill.hash);
    assert.deepEqual((await current.call("skill.install",f.input)).result,first.result);
    assert.deepEqual((await current.call("skill.install.status",statusScope(f.input))).result.result,first.result);
    assert.equal(readFileSync(join(f.root,"a/.agent/skills/fixed/SKILL.md"),"utf8"),"Explicit newer installation");
  }finally{await f.close();}
});

test("preparation failure is known no-dispatch, retains its fingerprint and never creates the target",async()=>{
  const f=fixture();try{
    const a=f.actor(),bad={...f.input,source:{kind:"inline",files:{"../escape":"Never write"}}};
    assert.ok((await a.call("skill.install",bad)).error);
    assert.deepEqual((await a.call("skill.install.status",statusScope(f.input))).result,{clientRequestId:f.input.clientRequestId,
      state:"failed",found:true,outcomeKnown:true,dispatchClaimed:false,reasonCode:"preparation_failed",
      createdAt:f.store.skillInstallOperation("account-a",f.input.clientRequestId)!.created_at,updatedAt:f.store.skillInstallOperation("account-a",f.input.clientRequestId)!.updated_at});
    assert.equal(existsSync(join(f.root,"a/.agent/skills/fixed")),false);
    assert.equal((await a.call("skill.install",f.input)).error?.data?.appCode,"errInvalidParams");
    assert.ok((await a.call("skill.install",{...f.input,clientRequestId:"known-new-preparation"})).result?.skill.hash);
  }finally{await f.close();}
});

test("metadata and confirmed receipt commit atomically rather than leaving new metadata after a failed final commit",async()=>{
  const f=fixture();try{
    const a=f.actor(),seed={...f.input,clientRequestId:undefined,source:{kind:"inline",files:{"SKILL.md":"Original stored metadata"}}};
    const original=(await a.call("skill.install",seed)).result.skill,upsert=f.store.upsertSkill.bind(f.store);
    f.store.upsertSkill=(record)=>{upsert(record);throw Error("controlled failure after metadata statement");};
    try{assert.ok((await a.call("skill.install",f.input)).error);}finally{f.store.upsertSkill=upsert;}
    assert.equal(f.store.loadSkills("account-a")[0]!.hash,original.hash);
    assert.equal(f.store.skillInstallOperation("account-a",f.input.clientRequestId)!.state,"unknown");
    assert.equal(f.store.skillInstallOperation("account-a",f.input.clientRequestId)!.result_json,null);
    assert.equal(readFileSync(join(f.root,"a/.agent/skills/fixed/SKILL.md"),"utf8"),"Original supplied instructions");
  }finally{await f.close();}
});

test("a same-store observer reports active dispatch, another store reports uncertainty without changing the live owner's record",async()=>{
  const f=fixture();let release!:()=>void,pending:Promise<any>|undefined;
  try{
    const a=f.actor(),manager=a.manager as unknown as {writeSkillFile:(...args:any[])=>Promise<void>},write=manager.writeSkillFile.bind(manager),gate=new Promise<void>(done=>{release=done;});let entered=false;
    manager.writeSkillFile=async(...args)=>{if(!entered){entered=true;await gate;}await write(...args);};
    pending=a.call("skill.install",f.input);await until(()=>entered);
    assert.equal((await f.actor().call("skill.install.status",statusScope(f.input))).result.state,"dispatched");
    const observer=f.actor("a",f.reopen());
    assert.equal((await observer.call("skill.install.status",statusScope(f.input))).result.reasonCode,"controller_not_observed");
    assert.equal(f.store.skillInstallOperation("account-a",f.input.clientRequestId)!.state,"dispatched");
    assert.equal((await observer.call("skill.install",f.input)).error?.data?.appCode,"errSkillInstallUnconfirmed");
    release();assert.ok((await pending).result?.skill.hash);
    assert.equal((await observer.call("skill.install.status",statusScope(f.input))).result.state,"confirmed");
  }finally{release?.();await pending?.catch(()=>undefined);await f.close();}
});

test("two independent nonces cannot concurrently mutate one Project skill target",async()=>{
  const f=fixture();let release!:()=>void,pending:Promise<any>|undefined;
  try{
    const a=f.actor(),manager=a.manager as unknown as {writeSkillFile:(...args:any[])=>Promise<void>},write=manager.writeSkillFile.bind(manager),gate=new Promise<void>(done=>{release=done;});let entered=false;
    manager.writeSkillFile=async(...args)=>{if(!entered){entered=true;await gate;}await write(...args);};
    pending=a.call("skill.install",f.input);await until(()=>entered);
    const b=f.actor("a",f.reopen());assert.equal((await b.call("skill.install",{...f.input,clientRequestId:"competing-operation"})).error?.data?.appCode,"errSkillInstallUnconfirmed");
    assert.equal(f.store.skillInstallOperation("account-a",f.input.clientRequestId)!.state,"dispatched");
    assert.equal((await b.call("skill.install.status",{...statusScope(f.input),clientRequestId:"competing-operation"})).result.dispatchClaimed,false);
    release();assert.ok((await pending).result?.skill.hash);
  }finally{release?.();await pending?.catch(()=>undefined);await f.close();}
});

test("prepared status is observable without filesystem effects and disposal before dispatch remains known no-dispatch",async()=>{
  const f=fixture();let release!:()=>void,pending:Promise<any>|undefined,closing:Promise<void>|undefined;
  try{
    const a=f.actor(),broker=(a.manager as unknown as {broker:{available:()=>Promise<boolean>}}).broker,gate=new Promise<void>(done=>{release=done;});let entered=false;
    broker.available=async()=>{entered=true;await gate;return false;};
    pending=a.call("skill.install",f.input);await until(()=>entered);
    assert.equal((await f.actor().call("skill.install.status",statusScope(f.input))).result.state,"prepared");
    assert.equal(existsSync(join(f.root,"a/.agent/skills/fixed")),false);
    closing=a.connection.dispose();release();assert.ok((await pending).error);await closing;
    assert.equal((await f.actor().call("skill.install.status",statusScope(f.input))).result.state,"failed");
    assert.equal(existsSync(join(f.root,"a/.agent/skills/fixed")),false);
  }finally{release?.();await pending?.catch(()=>undefined);await closing;await f.close();}
});

test("connection disposal drains in-flight skill work and fences its late metadata confirmation",async()=>{
  const f=fixture();let release!:()=>void,pending:Promise<any>|undefined,closing:Promise<void>|undefined;
  try{
    const a=f.actor(),manager=a.manager as unknown as {writeSkillFile:(...args:any[])=>Promise<void>},write=manager.writeSkillFile.bind(manager),gate=new Promise<void>(done=>{release=done;});let entered=false;
    manager.writeSkillFile=async(...args)=>{await write(...args);if(!entered){entered=true;await gate;}};
    pending=a.call("skill.install",f.input);await until(()=>entered);let drained=false;closing=a.connection.dispose().then(()=>{drained=true;});
    assert.equal((await f.actor().call("skill.install.status",statusScope(f.input))).result.state,"unknown");assert.equal(drained,false);
    release();assert.ok((await pending).error);await closing;assert.equal(drained,true);assert.deepEqual(f.store.loadSkills("account-a"),[]);
    assert.equal(f.store.skillInstallOperation("account-a",f.input.clientRequestId)!.state,"unknown");
  }finally{release?.();await pending?.catch(()=>undefined);await closing;await f.close();}
});

test("skill status never crosses accounts, names, current runtime policy or lost Project ownership",async()=>{
  const f=fixture();try{
    const a=f.actor();assert.ok((await a.call("skill.install",f.input)).result?.skill.hash);
    const scope=statusScope(f.input),b=f.actor("b");
    assert.equal((await b.call("skill.install.status",{...scope,projectId:"project-b"})).result.state,"not_found");
    for(const projectId of ["project-a","missing"])assert.equal((await b.call("skill.install.status",{...scope,projectId})).error?.data?.appCode,"errProjectNotFound");
    assert.equal((await a.call("skill.install.status",{...scope,name:"different"})).result.state,"not_found");
    assert.equal((await f.actor("a",f.store,{allowedAgents:["mock:other"]}).call("skill.install.status",scope)).error?.data?.appCode,"errPolicyDenied");
    f.store.deleteProject("project-a");assert.equal((await a.call("skill.install.status",scope)).error?.data?.appCode,"errProjectNotFound");
  }finally{await f.close();}
});

test("an actual killed writer cannot be replayed after its first physical file write and a store reopen",async()=>{
  const f=fixture();let child:ReturnType<typeof spawn>|undefined;
  try{
    const sourceMode=import.meta.url.endsWith(".ts"),preloads:string[]=[];
    if(sourceMode)for(let n=0;n<process.execArgv.length;n++)if(["--import","--require"].includes(process.execArgv[n]!))preloads.push(process.execArgv[n]!,process.execArgv[++n]!);
    const source=`import {PhononConnection,PhononStore,AdapterRegistry} from ${JSON.stringify(new URL(sourceMode?"./index.ts":"./index.js",import.meta.url).href)};
      const store=new PhononStore(${JSON.stringify(join(f.root,"native.db"))}),registry=new AdapterRegistry();
      registry.register({name:'mock',capabilities:{skillManagement:true},discoverAgents:async()=>[],createSession:async()=>{throw Error('No model');}});
      const conn=new PhononConnection({tenantId:'account-a',store,registry,workspaceRoot:${JSON.stringify(f.root)},policy:{allowedAgents:['mock:default']},transport:{send:()=>{},close:()=>{}}});
      const manager=conn.skills,write=manager.writeSkillFile.bind(manager);let count=0;
      manager.writeSkillFile=async(...args)=>{await write(...args);if(++count===1){process.send({written:true});await new Promise(()=>{});}};
      void conn.handle(JSON.stringify({jsonrpc:'2.0',id:1,method:'skill.install',params:${JSON.stringify(f.input)}}));setInterval(()=>{},1000);`;
    child=spawn(process.execPath,[...preloads,"--input-type=module","-e",source],{stdio:["ignore","pipe","pipe","ipc"],env:{PATH:process.env.PATH,HOME:f.root,TMPDIR:f.root,
      ...(sourceMode?{TSX_TSCONFIG_PATH:fileURLToPath(new URL("../../../tsconfig.source-tests.json",import.meta.url))}:{})}});
    let timer:ReturnType<typeof setTimeout>|undefined;
    const ready=await Promise.race([once(child,"message"),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error("owned writer did not reach the first file")),10000);})]).finally(()=>{if(timer)clearTimeout(timer);});
    assert.equal((ready[0] as {written:boolean}).written,true);
    const path=join(f.root,"a/.agent/skills/fixed/SKILL.md");assert.equal(readFileSync(path,"utf8"),"Original supplied instructions");
    const exited=once(child,"exit");child.kill("SIGKILL");await exited;writeFileSync(path,"Actual human edit after process loss");
    const current=f.actor("a",f.reopen());assert.equal((await current.call("skill.install.status",statusScope(f.input))).result.state,"unknown");
    assert.equal((await current.call("skill.install",f.input)).error?.data?.appCode,"errSkillInstallUnconfirmed");
    assert.equal(readFileSync(path,"utf8"),"Actual human edit after process loss");
    assert.equal(f.store.skillInstallOperation("account-a",f.input.clientRequestId)!.state,"dispatched","read-only observation does not rewrite the abandoned record");
  }finally{if(child&&child.exitCode===null&&child.signalCode===null){const exited=once(child,"exit");child.kill("SIGKILL");await exited;}await f.close();}
});

test("a memory-only store never claims durable install receipt support",async()=>{
  const f=fixture(),memory=new PhononStore(":memory:");try{assert.equal(f.store.supportsDurableSkillInstalls,true);assert.equal(memory.supportsDurableSkillInstalls,false);}finally{memory.close();await f.close();}
});

test("status lookup preserves valid legacy install names longer than the managed-selection name limit",async()=>{
  const f=fixture();try{
    const a=f.actor(),input={...f.input,name:"k".repeat(129)};assert.ok((await a.call("skill.install",input)).result?.skill.hash);
    assert.equal((await a.call("skill.install.status",statusScope(input))).result.state,"confirmed");
  }finally{await f.close();}
});

test("persistent receiver identities are namespace scoped, stable on independent store reopen, and never advertised by memory-only stores",async()=>{
  const f=fixture(),memory=new PhononStore(":memory:"),other=new PhononStore(join(f.root,"separate.db"));
  try{
    const a=f.actor(),b=f.actor("b"),info=(await a.call("device.info",{})).result,foreign=(await b.call("device.info",{})).result;
    assert.ok(info.capabilities.includes("skill_install_receiver_identity_v1"));assert.match(info.skillReceiverID,/^[a-f0-9-]{36}$/);
    assert.notEqual(info.skillReceiverID,foreign.skillReceiverID);
    assert.equal((await f.actor("a",f.reopen()).call("device.info",{})).result.skillReceiverID,info.skillReceiverID);
    assert.notEqual(other.skillReceiverIdentity("account-a"),info.skillReceiverID);
    const temporary=(await f.actor("a",memory).call("device.info",{})).result;
    assert.equal(temporary.skillReceiverID,undefined);assert.equal(temporary.capabilities.includes("skill_install_receiver_identity_v1"),false);
  }finally{other.close();memory.close();await f.close();}
});

test("an opted-in exact receipt proves its originally captured receiver after reconnect without changing default status or another account",async()=>{
  const f=fixture();try{
    const a=f.actor(),receiverID=(await a.call("device.info",{})).result.skillReceiverID,installed=await a.call("skill.install",f.input);assert.ok(installed.result);
    const scope=statusScope(f.input),old=(await a.call("skill.install.status",scope)).result;
    assert.equal(old.receiverID,undefined);assert.equal(f.store.skillInstallOperation("account-a",f.input.clientRequestId)!.receiver_id,receiverID);
    const current=f.actor("a",f.reopen()),proof=(await current.call("skill.install.status",{...scope,includeReceiverIdentity:true})).result;
    assert.equal(proof.receiverID,receiverID);assert.deepEqual(proof.result,installed.result);
    const {receiverID:ignored,...unchanged}=proof;assert.deepEqual(unchanged,old);
    const foreign=(await f.actor("b").call("skill.install.status",{...scope,projectId:"project-b",includeReceiverIdentity:true})).result;
    assert.equal(foreign.state,"not_found");assert.equal(foreign.receiverID,undefined);
  }finally{await f.close();}
});

test("legacy receipt migration never manufactures receiver proof, even after a receiver is observed or an old nonce replays",async()=>{
  const f=fixture();try{
    const a=f.actor(),installed=await a.call("skill.install",f.input);assert.ok(installed.result);
    const database=new DatabaseSync(join(f.root,"native.db"));
    try{database.exec("DROP TRIGGER skill_install_receiver_immutable; ALTER TABLE skill_install_operations DROP COLUMN receiver_id");}finally{database.close();}
    const current=f.actor("a",f.reopen()),scope={...statusScope(f.input),includeReceiverIdentity:true};
    assert.ok((await current.call("device.info",{})).result.skillReceiverID);
    assert.equal((await current.call("skill.install.status",scope)).result.receiverID,undefined);
    assert.deepEqual((await current.call("skill.install",f.input)).result,installed.result);
    assert.equal((await current.call("skill.install.status",scope)).result.receiverID,undefined);
    assert.equal(f.store.skillInstallOperation("account-a",f.input.clientRequestId)!.receiver_id,null);
  }finally{await f.close();}
});

test("receiver identities and operation receiver tags cannot be rewritten to adopt historical proof",async()=>{
  const f=fixture();try{
    const a=f.actor();assert.ok((await a.call("skill.install",f.input)).result);
    const database=new DatabaseSync(join(f.root,"native.db"));
    try{
      assert.throws(()=>database.prepare("UPDATE skill_receivers SET receiver_id=? WHERE tenant_id='account-a'").run(randomUUID()),/identity is immutable/);
      assert.throws(()=>database.exec("DELETE FROM skill_receivers WHERE tenant_id='account-a'"),/identity is immutable/);
      assert.throws(()=>database.prepare("UPDATE skill_install_operations SET receiver_id=? WHERE tenant_id='account-a'").run(randomUUID()),/proof is immutable/);
    }finally{database.close();}
  }finally{await f.close();}
});

test("read-only receipt lookup cannot recreate a missing receiver identity or retag its original receipt",async()=>{
  const f=fixture();try{
    const a=f.actor();assert.ok((await a.call("skill.install",f.input)).result);
    const original=f.store.skillInstallOperation("account-a",f.input.clientRequestId)!.receiver_id,database=new DatabaseSync(join(f.root,"native.db"));
    try{database.exec("DROP TRIGGER skill_receiver_delete_immutable; DELETE FROM skill_receivers WHERE tenant_id='account-a'");}finally{database.close();}
    assert.equal(f.store.skillReceiverIdentity("account-a",false),undefined);
    const proof=(await a.call("skill.install.status",{...statusScope(f.input),includeReceiverIdentity:true})).result;
    assert.equal(proof.state,"confirmed");assert.equal(proof.receiverID,undefined);assert.equal(f.store.skillReceiverIdentity("account-a",false),undefined);
    assert.equal(f.store.skillInstallOperation("account-a",f.input.clientRequestId)!.receiver_id,original);
  }finally{await f.close();}
});
