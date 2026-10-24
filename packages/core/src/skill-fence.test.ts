import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,realpathSync,mkdirSync,rmSync,readFileSync,writeFileSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {randomUUID} from "node:crypto";
import {DatabaseSync} from "node:sqlite";
import {PhononConnection,PhononStore,AdapterRegistry} from "./index.js";
import {PolicyEnforcer} from "./policy.js";
import {requestFingerprint} from "./idempotency.js";
import {AgentCapabilities,AgentId} from "@agent-phonon/protocol";
import {AgentInteractionBridge} from "./agent-interaction-bridge.js";
import {Client} from "@modelcontextprotocol/sdk/client/index.js";
import {StreamableHTTPClientTransport} from "@modelcontextprotocol/sdk/client/streamableHttp.js";

function fixture(){
  const root=realpathSync(mkdtempSync(join(tmpdir(),"phonon-skill-fence-"))),database=join(root,"native.db"),store=new PhononStore(database),registry=new AdapterRegistry();
  const capabilities=AgentCapabilities.parse({nativeSession:false,nativeCompression:false,contextInjection:false,proactiveOutput:false,modelSwitch:false,interrupt:false,injectMidTurn:false,skillManagement:true,hooks:[],streaming:false});
  registry.register({name:"mock",capabilities,async discoverAgents(){return [];},async createSession(){throw Error("No model is used in recovery");}});
  for(const owner of ["a","b"]){const path=join(root,owner);mkdirSync(path);store.upsertProject({projectId:"project-"+owner,namespace:"account-"+owner,name:owner,path,git:false,createdAt:new Date().toISOString()});}
  const connections:PhononConnection[]=[],stores=[store];let sequence=0;
  const actor=(owner="a",data=store,policy:Record<string,unknown>={allowSkillRecovery:true})=>{
    const replies:Array<Record<string,any>>=[];
    const connection=new PhononConnection({tenantId:"account-"+owner,store:data,registry,workspaceRoot:root,policy:{allowedAgents:[AgentId.parse("mock:default"),AgentId.parse("mock:other")],...policy},
      transport:{send:value=>replies.push(JSON.parse(value)),close:()=>{}}});connections.push(connection);
    return {manager:(connection as any).skills,
      async call(method:string,params:unknown){const id=++sequence;await connection.handle(JSON.stringify({jsonrpc:"2.0",id,method,params}));const reply=replies.find(value=>value.id===id);assert.ok(reply);return reply;}};
  };
  const input={clientRequestId:"original",agent:"mock:default",name:"fixed",scope:"project" as const,projectId:"project-a",source:{kind:"inline",files:{"SKILL.md":"Original instructions","helper.txt":"Original helper"}}};
  const scope=()=>{const {source:ignored,...value}=input;return value;};
  const recovery=async(a:ReturnType<typeof actor>)=>{const reply=await a.call("skill.install.status",{...scope(),includeRecoveryContext:true});assert.ok(reply.result?.recovery,JSON.stringify(reply));return reply.result.recovery;};
  const fence=(context:any)=>({clientRequestId:"human-fence",originalRequestId:input.clientRequestId,agent:input.agent,name:input.name,scope:input.scope,projectId:input.projectId,expectedReceiverID:context.receiverID,baseRecoveryRevision:context.revision});
  const partial=async(a:ReturnType<typeof actor>)=>{const write=a.manager.writeSkillFile.bind(a.manager);let count=0;a.manager.writeSkillFile=async(...args:any[])=>{if(++count===2)throw Error("controlled partial write");return write(...args);};
    try{assert.ok((await a.call("skill.install",input)).error);}finally{a.manager.writeSkillFile=write;}};
  return {root,database,store,input,scope,actor,recovery,fence,partial,reopen(){const data=new PhononStore(database);stores.push(data);return data;},
    async close(){for(const connection of connections)await connection.dispose();for(const data of stores)data.close();rmSync(root,{recursive:true,force:true});}};
}

test("recovery requires explicit local permission, never implied by trustLocal or a method allowlist",async()=>{
  const f=fixture();try{
    const a=f.actor();await f.partial(a);const input=f.fence(await f.recovery(a));
    const denied=f.actor("a",f.store,{});assert.equal((await denied.call("skill.install.fence",input)).error?.data?.appCode,"errPolicyDenied");
    const readonly=f.actor("a",f.store,{allowSkillRecovery:true,allowedMethods:["device.info","skill.install.status"]});
    assert.equal((await readonly.call("skill.install.fence",input)).error?.data?.appCode,"errPolicyDenied");
    assert.throws(()=>new PolicyEnforcer({workspaceRoot:f.root,trustLocal:true}).assertSkillRecovery(),/explicit local permission/);
    assert.equal(f.store.skillInstallOperation("account-a",f.input.clientRequestId)!.fence_id,null);
  }finally{await f.close();}
});

test("a partial write can be metadata-fenced without deleting files, releasing its target, confirming absence or changing default status shape",async()=>{
  const f=fixture();try{
    const a=f.actor();await f.partial(a);const path=join(f.root,"a/.agent/skills/fixed/SKILL.md");writeFileSync(path,"Actual human edit after partial write");
    const before=(await a.call("skill.install.status",f.scope())).result;assert.equal(before.state,"unknown");assert.equal(before.recovery,undefined);
    const context=await f.recovery(a),input=f.fence(context),reply=await a.call("skill.install.fence",input);assert.ok(reply.result,JSON.stringify(reply));
    assert.equal(reply.result.outcomeKnown,false);assert.equal(reply.result.targetLocked,true);assert.equal(reply.result.filesDeleted,false);assert.equal(reply.result.originalWritesMayContinue,true);
    assert.equal(readFileSync(path,"utf8"),"Actual human edit after partial write");assert.deepEqual(f.store.loadSkills("account-a"),[]);
    const record=f.store.skillInstallOperation("account-a",f.input.clientRequestId)!;assert.equal(record.state,"unknown");assert.equal(record.result_json,null);assert.equal(record.fence_id,reply.result.fenceID);
    assert.throws(()=>f.store.assertSkillTargetWritable(record.resource_key!),/unconfirmed/);
    assert.equal((await a.call("skill.install.status",f.scope())).result.recovery,undefined);
    assert.equal((await f.recovery(a)).fenceID,record.fence_id);
    assert.deepEqual((await f.actor("a",f.reopen()).call("skill.install.fence",input)).result,reply.result);
    assert.equal((await a.call("skill.install.fence",{...input,baseRecoveryRevision:"f".repeat(64)})).error?.data?.appCode,"errInvalidParams");
    assert.equal((await a.call("skill.install.fence",{...input,clientRequestId:"another-decision"})).error?.data?.appCode,"errSkillRevisionChanged");
    const database=new DatabaseSync(f.database);try{
      assert.throws(()=>database.exec("UPDATE skill_install_fences SET result_json='{}'"),/immutable/);
      assert.throws(()=>database.exec("DELETE FROM skill_install_fences"),/immutable/);
      assert.throws(()=>database.exec("UPDATE skill_install_operations SET fence_id=NULL WHERE request_id='original'"),/immutable/);
    }finally{database.close();}
  }finally{await f.close();}
});

test("a fenced live writer may finish physical I/O but cannot later confirm or activate metadata",async()=>{
  const f=fixture();let release!:()=>void,ready!:()=>void,work:Promise<any>|undefined;
  try{
    const a=f.actor(),write=a.manager.writeSkillFile.bind(a.manager),gate=new Promise<void>(done=>release=done),entered=new Promise<void>(done=>ready=done);let count=0;
    a.manager.writeSkillFile=async(...args:any[])=>{await write(...args);if(++count===1){ready();await gate;}};
    work=a.call("skill.install",f.input);await entered;
    const context=await f.recovery(a);assert.equal((await a.call("skill.install.status",f.scope())).result.state,"dispatched");
    assert.ok((await a.call("skill.install.fence",f.fence(context))).result);
    assert.equal((await a.call("skill.install",f.input)).error?.data?.appCode,"errSkillInstallUnconfirmed");
    release();assert.equal((await work).error?.data?.appCode,"errSkillInstallUnconfirmed");
    assert.deepEqual(f.store.loadSkills("account-a"),[]);assert.equal(f.store.skillInstallOperation("account-a","original")!.state,"unknown");
    assert.equal(readFileSync(join(f.root,"a/.agent/skills/fixed/SKILL.md"),"utf8"),"Original instructions");
  }finally{release?.();await work?.catch(()=>{});await f.close();}
});

test("a stale observation cannot fence an operation after its actual native confirmation",async()=>{
  const f=fixture();let release!:()=>void,ready!:()=>void,work:Promise<any>|undefined;
  try{
    const a=f.actor(),write=a.manager.writeSkillFile.bind(a.manager),gate=new Promise<void>(done=>release=done),entered=new Promise<void>(done=>ready=done);let count=0;
    a.manager.writeSkillFile=async(...args:any[])=>{await write(...args);if(++count===1){ready();await gate;}};
    work=a.call("skill.install",f.input);await entered;const context=await f.recovery(a);release();assert.ok((await work).result);
    assert.equal((await a.call("skill.install.fence",f.fence(context))).error?.data?.appCode,"errSkillRevisionChanged");
    const current=await f.recovery(a);assert.equal((await a.call("skill.install.fence",f.fence(current))).error?.data?.appCode,"errSkillInstallUnconfirmed");
    assert.equal(f.store.skillInstallOperation("account-a","original")!.state,"confirmed");assert.equal(f.store.skillInstallOperation("account-a","original")!.fence_id,null);
  }finally{release?.();await work?.catch(()=>{});await f.close();}
});

test("current namespace, exact original scope, receiver and observation remain mandatory",async()=>{
  const f=fixture();try{
    const a=f.actor();await f.partial(a);const input=f.fence(await f.recovery(a));
    for(const patch of [{expectedReceiverID:randomUUID()},{name:"different"},{originalRequestId:"different"},{baseRecoveryRevision:"f".repeat(64)},{agent:"mock:other"}])
      assert.ok((await a.call("skill.install.fence",{...input,...patch})).error);
    const b=f.actor("b"),ownReceiver=(await b.call("device.info",{})).result.skillReceiverID;
    assert.equal((await b.call("skill.install.fence",{...input,expectedReceiverID:ownReceiver})).error?.data?.appCode,"errProjectNotFound");
    assert.equal((await b.call("skill.install.fence",{...input,projectId:"project-b",expectedReceiverID:ownReceiver})).error?.data?.appCode,"errSkillNotFound");
    assert.equal(f.store.skillInstallOperation("account-a","original")!.fence_id,null);
  }finally{await f.close();}
});

test("an opted-in legacy recovery observation never backfills original receiver identity",async()=>{
  const f=fixture();try{
    const a=f.actor();await f.partial(a);const database=new DatabaseSync(f.database);
    try{database.exec("DROP TRIGGER skill_install_receiver_immutable; ALTER TABLE skill_install_operations DROP COLUMN receiver_id");}finally{database.close();}
    const data=f.reopen(),current=f.actor("a",data),context=await f.recovery(current);assert.equal(context.originalReceiverID,null);
    const result=await current.call("skill.install.fence",f.fence(context));assert.ok(result.result);assert.equal(result.result.originalReceiverID,null);
    assert.equal(data.skillInstallOperation("account-a","original")!.receiver_id,null);
    const proof=await current.call("skill.install.status",{...f.scope(),includeReceiverIdentity:true});assert.equal(proof.result.receiverID,undefined);
  }finally{await f.close();}
});

test("generic cached success cannot bypass an original transaction fence",async()=>{
  const f=fixture();try{
    const a=f.actor();await f.partial(a);assert.ok((await a.call("skill.install.fence",f.fence(await f.recovery(a)))).result);
    f.store.idempotencyPut("account-a\0skill.install\0original",JSON.stringify({skill:{name:"fixed",agent:"mock:default",scope:"project",projectId:"project-a",hash:"f".repeat(64)}}),requestFingerprint(f.input));
    assert.equal((await a.call("skill.install",f.input)).error?.data?.appCode,"errSkillInstallUnconfirmed");
    assert.equal(f.store.skillInstallOperation("account-a","original")!.state,"unknown");assert.deepEqual(f.store.loadSkills("account-a"),[]);
  }finally{await f.close();}
});

for(const state of ["prepared","failed"] as const)test(`a ${state} operation cannot acquire an uncertain-write fence`,async()=>{
  const f=fixture();try{
    const hash=requestFingerprint(f.input);f.store.prepareSkillInstall({tenant:"account-a",requestId:f.input.clientRequestId,requestHash:hash,agent:f.input.agent,name:f.input.name,scope:"project",projectId:f.input.projectId});
    if(state==="failed")f.store.failSkillInstallPreparation("account-a",f.input.clientRequestId,hash);
    const a=f.actor(),context=await f.recovery(a),reply=await a.call("skill.install.fence",f.fence(context));
    assert.equal(reply.error?.data?.appCode,"errSkillInstallUnconfirmed");assert.equal(f.store.skillInstallOperation("account-a","original")!.state,state);assert.equal(f.store.skillInstallOperation("account-a","original")!.fence_id,null);
  }finally{await f.close();}
});

test("current-turn Agent MCP never enumerates or forwards the privileged recovery method",async()=>{
  let calls=0;
  const bridge=new AgentInteractionBridge(async input=>{calls++;return {requestId:input.requestId!,action:"cancel"};},()=>{}),env=await bridge.listen();
  const client=new Client({name:"no-fence-agent",version:"1"});
  try{
    await client.connect(new StreamableHTTPClientTransport(new URL(env.AGENT_PHONON_MCP_URL!),{requestInit:{headers:{authorization:"Bearer "+env.AGENT_PHONON_INTERACTION_TOKEN}}}));
    assert.equal((await client.listTools()).tools.some(tool=>/fence|recovery|unlock|skill/.test(tool.name)),false);
    for(const name of ["skill.install.fence","phonon_skill_install_fence","arbitrary_rpc"])assert.equal((await client.callTool({name,arguments:{}})).isError,true);
    assert.equal(calls,0);
  }finally{await client.close();await bridge.close();}
});
