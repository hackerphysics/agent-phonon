import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,rmSync,realpathSync,symlinkSync,linkSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {PhononConnection} from "./index.js";
import {PhononStore} from "./store.js";
import {AdapterRegistry} from "./session-engine.js";
import type {AgentAdapter} from "./adapter.js";
import {AgentCapabilities,AgentDescriptor,AgentId} from "@agent-phonon/protocol";
import {DatabaseSync} from "node:sqlite";

function fixture(){
  const capabilities=AgentCapabilities.parse({nativeSession:true,nativeCompression:false,contextInjection:false,proactiveOutput:false,modelSwitch:false,
    interrupt:false,injectMidTurn:false,skillManagement:true,hooks:[],streaming:false});
  const root=realpathSync(mkdtempSync(join(tmpdir(),"phonon-skill-tenancy-"))),store=new PhononStore(join(root,"native.db")),registry=new AdapterRegistry();
  const global=join(root,"global");mkdirSync(global);let selectedGlobal=global;
  const adapter:AgentAdapter={name:"mock",capabilities,async discoverAgents(){return [AgentDescriptor.parse({agentId:"mock:default",displayName:"Isolated skill fixture",adapter:"mock",available:true,models:[],capabilities,scannedAt:new Date().toISOString()})];},
    async createSession(){throw Error("No model/session is part of a skill isolation test");},globalSkillDir:()=>selectedGlobal};
  registry.register(adapter);
  for(const owner of ["a","b"]){const path=join(root,owner);mkdirSync(path);store.upsertProject({projectId:"project-"+owner,name:owner,path,git:false,createdAt:new Date().toISOString(),namespace:"tenant-"+owner});}
  const connections:PhononConnection[]=[],stores=[store];let sequence=0;
  const connect=(owner:string,policy:Record<string,unknown>={},sourceStore=store)=>{
    const replies:Array<Record<string,any>>=[];
    const connection=new PhononConnection({tenantId:"tenant-"+owner,registry,store:sourceStore,workspaceRoot:root,
      policy:{allowedAgents:[AgentId.parse("mock:default")],...policy},transport:{send:value=>replies.push(JSON.parse(value)),close:()=>{}}});connections.push(connection);
    return {connection,async call(method:string,params:unknown){const id=++sequence;await connection.handle(JSON.stringify({jsonrpc:"2.0",id,method,params}));
      const reply=replies.find(value=>value.id===id);assert.ok(reply,"actual RPC response required");return reply;}};
  };
  return {root,global,store,connect,reopen(){const opened=new PhononStore(join(root,"native.db"));stores.push(opened);return opened;},
    selectGlobal:(path:string)=>selectedGlobal=path,async close(){for(const connection of connections)await connection.dispose();for(const opened of stores)opened.close();rmSync(root,{recursive:true,force:true});}};
}

test("skill list and explicit Project selectors cannot cross real connection tenants sharing one native store",async()=>{
  const f=fixture();try{
    const a=f.connect("a"),installed=await a.call("skill.install",{agent:"mock:default",name:"private-a",scope:"project",projectId:"project-a",source:{kind:"inline",files:{"SKILL.md":"Private tenant A instructions"}}});
    assert.ok(installed.result?.skill.hash);
    const b=f.connect("b"),own=await b.call("skill.list",{});
    assert.deepEqual(own.result.skills,[],"tenant B must not see tenant A's name, hash or private path");
    for(const projectId of ["project-a","missing-project"]){const result=await b.call("skill.list",{projectId});assert.equal(result.error?.data?.appCode,"errProjectNotFound");}
    assert.deepEqual((await a.call("skill.list",{projectId:"project-a"})).result.skills.map((row:any)=>row.name),["private-a"]);
    assert.equal((await b.call("skill.uninstall",{agent:"mock:default",name:"private-a",scope:"project",projectId:"project-a"})).error?.data?.appCode,"errProjectNotFound");
    assert.equal(readFileSync(join(f.root,"a/.agent/skills/private-a/SKILL.md"),"utf8"),"Private tenant A instructions");
  }finally{await f.close();}
});

test("global skill removal requires the same explicit host permission as global installation",async()=>{
  const f=fixture();try{
    const target=join(f.global,"host-owned");mkdirSync(target);writeFileSync(join(target,"SKILL.md"),"Must be preserved");
    const result=await f.connect("b").call("skill.uninstall",{agent:"mock:default",name:"host-owned",scope:"global"});
    assert.equal(result.error?.data?.appCode,"errPolicyDenied");assert.equal(readFileSync(join(target,"SKILL.md"),"utf8"),"Must be preserved");
  }finally{await f.close();}
});

test("skill mutation cannot select a runtime forbidden by the connection policy",async()=>{
  const f=fixture();try{
    const result=await f.connect("a").call("skill.install",{agent:"mock:forbidden",name:"not-allowed",scope:"project",projectId:"project-a",source:{kind:"inline",files:{"SKILL.md":"No write allowed"}}});
    assert.equal(result.error?.data?.appCode,"errPolicyDenied");assert.equal(existsSync(join(f.root,"a/.agent/skills/not-allowed")),false);
  }finally{await f.close();}
});

test("global skill metadata and directories remain scoped after reconnect, without adopting another tenant's files",async()=>{
  const f=fixture();try{
    const a=f.connect("a",{allowGlobalSkillInstall:true}),input={agent:"mock:default",name:"owned-global",scope:"global",source:{kind:"inline",files:{"SKILL.md":"Original A"}}};
    assert.ok((await a.call("skill.install",input)).result?.skill.hash);
    const b=f.connect("b",{allowGlobalSkillInstall:true});
    assert.deepEqual((await b.call("skill.list",{})).result.skills,[]);
    assert.deepEqual((await b.call("skill.dirs",{agent:"mock:default",scope:"global"})).result.directories,[]);
    assert.equal((await b.call("skill.uninstall",{agent:"mock:default",name:"owned-global",scope:"global"})).error?.data?.appCode,"errSkillNotFound");
    assert.equal((await b.call("skill.install",{...input,source:{kind:"inline",files:{"SKILL.md":"Must not overwrite A"}}})).error?.data?.appCode,"errPolicyDenied");
    assert.equal(readFileSync(join(f.global,"owned-global/SKILL.md"),"utf8"),"Original A");
    assert.ok((await a.call("skill.install",{...input,source:{kind:"inline",files:{"SKILL.md":"Owned update"}}})).result?.skill.hash);
    assert.equal(f.store.loadSkills("tenant-a").length,1,"NULL Project IDs must not duplicate scoped global records");
    await a.connection.dispose();const current=f.connect("a",{allowGlobalSkillInstall:true},f.reopen());
    const visible=(await current.call("skill.list",{})).result.skills;assert.equal(visible.length,1);assert.equal(visible[0].name,"owned-global");
    assert.equal("tenantId" in visible[0],false);assert.equal("tenant_id" in visible[0],false);
    assert.equal((await current.call("skill.dirs",{agent:"mock:default",scope:"global"})).result.directories.length,1);
  }finally{await f.close();}
});

test("skill retry identity survives reconnect but changed payload, revoked scope and removed Projects cannot reuse it",async()=>{
  const f=fixture();try{
    const a=f.connect("a"),input={clientRequestId:"exact-install",agent:"mock:default",name:"exact",scope:"project",projectId:"project-a",source:{kind:"inline",files:{"SKILL.md":"Exact original bytes"}}};
    const first=await a.call("skill.install",input);assert.ok(first.result?.skill.hash);assert.deepEqual((await a.call("skill.install",input)).result,first.result);
    assert.equal((await a.call("skill.install",{...input,source:{kind:"inline",files:{"SKILL.md":"Changed payload"}}})).error?.data?.appCode,"errInvalidParams");
    await a.connection.dispose();const reconnected=f.connect("a");assert.deepEqual((await reconnected.call("skill.install",input)).result,first.result);
    const forbidden=f.connect("a",{allowedAgents:[AgentId.parse("mock:other")]});
    assert.equal((await forbidden.call("skill.install",input)).error?.data?.appCode,"errPolicyDenied");
    assert.deepEqual((await forbidden.call("skill.list",{})).result.skills,[]);
    assert.equal((await forbidden.call("skill.list",{agent:"mock:default"})).error?.data?.appCode,"errPolicyDenied");
    f.store.deleteProject("project-a");assert.equal((await reconnected.call("skill.install",input)).error?.data?.appCode,"errProjectNotFound");
    assert.equal(readFileSync(join(f.root,"a/.agent/skills/exact/SKILL.md"),"utf8"),"Exact original bytes");
    const global=f.connect("b",{allowGlobalSkillInstall:true}),request={...input,clientRequestId:"global-original",name:"g",scope:"global",projectId:undefined};
    const g=await global.call("skill.install",request);assert.ok(g.result?.skill.hash);await global.connection.dispose();
    assert.equal((await f.connect("b").call("skill.install",request)).error?.data?.appCode,"errPolicyDenied");
  }finally{await f.close();}
});

test("native skill migration preserves legacy rows, proves Project visibility and never backfills global ownership",()=>{
  const root=realpathSync(mkdtempSync(join(tmpdir(),"phonon-skill-upgrade-"))),path=join(root,"old.db"),old=new DatabaseSync(path);
  old.exec(`CREATE TABLE skills(id INTEGER PRIMARY KEY AUTOINCREMENT,agent_id TEXT NOT NULL,name TEXT NOT NULL,scope TEXT NOT NULL,project_id TEXT,
    version TEXT,hash TEXT,installed_path TEXT NOT NULL,installed_at TEXT NOT NULL,UNIQUE(agent_id,scope,name,project_id));
    INSERT INTO skills(agent_id,name,scope,hash,installed_path,installed_at) VALUES('mock:default','unknown','global','old-1','/old/global','old'),('mock:default','unknown','global','old-2','/old/global','old');
    INSERT INTO skills(agent_id,name,scope,project_id,hash,installed_path,installed_at) VALUES('mock:default','legacy-project','project','legacy','old-project','/old/project','old')`);
  const before=old.prepare("SELECT * FROM skills ORDER BY id").all();old.close();
  const store=new PhononStore(path);
  try{
    store.upsertProject({projectId:"legacy",name:"Legacy namespace source",path:root,git:false,createdAt:"2026-10-22T00:00:00.000Z",namespace:"tenant-a"});
    const read=new DatabaseSync(path);try{
      const after=read.prepare("SELECT * FROM skills ORDER BY id").all();assert.equal(after.length,before.length);
      for(let n=0;n<before.length;n++){for(const key of Object.keys(before[n]!))assert.deepEqual(after[n]![key],before[n]![key]);assert.equal(after[n]!.tenant_id,null);}
    }finally{read.close();}
    assert.deepEqual(store.loadSkills("tenant-a").map(row=>row.name),["legacy-project"]);assert.deepEqual(store.loadSkills("tenant-b"),[]);
    store.deleteSkill({tenantId:"tenant-b",agent:"mock:default",name:"legacy-project",scope:"project",projectId:"legacy"});
    assert.equal(store.loadSkills().length,3);
    store.deleteProject("legacy");assert.deepEqual(store.loadSkills("tenant-a"),[]);
  }finally{store.close();rmSync(root,{recursive:true,force:true});}
});

test("changing a runtime global directory cannot lend an old owned name to a different location",async()=>{
  const f=fixture();try{
    const a=f.connect("a",{allowGlobalSkillInstall:true}),input={agent:"mock:default",name:"same-name",scope:"global",source:{kind:"inline",files:{"SKILL.md":"Original"}}};
    assert.ok((await a.call("skill.install",input)).result?.skill.hash);
    const other=join(f.root,"other-global");mkdirSync(join(other,"same-name"),{recursive:true});writeFileSync(join(other,"same-name/SKILL.md"),"Unrelated directory");f.selectGlobal(other);
    for(const [method,params] of [["skill.dirs",{agent:"mock:default",scope:"global"}],["skill.install",input],["skill.uninstall",{agent:"mock:default",scope:"global",name:"same-name"}]] as const)
      assert.equal((await a.call(method,params)).error?.data?.appCode,"errPolicyDenied");
    assert.equal(readFileSync(join(other,"same-name/SKILL.md"),"utf8"),"Unrelated directory");
    assert.equal(readFileSync(join(f.global,"same-name/SKILL.md"),"utf8"),"Original");
  }finally{await f.close();}
});

test("unverifiable legacy skill retry receipts are preserved but never replayed as current installation",async()=>{
  const f=fixture();try{
    const key="tenant-a\0skill.install\0legacy",original=JSON.stringify({skill:{name:"prior",scope:"project"}});
    f.store.idempotencyPut(key,original);
    const result=await f.connect("a").call("skill.install",{clientRequestId:"legacy",agent:"mock:default",name:"prior",scope:"project",projectId:"project-a",source:{kind:"inline",files:{"SKILL.md":"Must not run"}}});
    assert.equal(result.error?.data?.appCode,"errInvalidParams");assert.equal(f.store.idempotencyGet(key),original);
    assert.equal(existsSync(join(f.root,"a/.agent/skills/prior")),false);
  }finally{await f.close();}
});

test("a Project skill parent link cannot redirect installation or removal into another tenant's files",async()=>{
  const f=fixture();try{
    const outside=join(f.root,"b/other-skills"),target=join(outside,"redirected");mkdirSync(target,{recursive:true});writeFileSync(join(target,"SKILL.md"),"Tenant B original");
    mkdirSync(join(f.root,"a/.agent"));symlinkSync(outside,join(f.root,"a/.agent/skills"),process.platform==="win32"?"junction":"dir");
    const a=f.connect("a");
    assert.equal((await a.call("skill.install",{agent:"mock:default",name:"redirected",scope:"project",projectId:"project-a",source:{kind:"inline",files:{"SKILL.md":"Must not escape"}}})).error?.data?.appCode,"errPolicyDenied");
    assert.equal((await a.call("skill.uninstall",{agent:"mock:default",name:"redirected",scope:"project",projectId:"project-a"})).error?.data?.appCode,"errPolicyDenied");
    assert.equal(readFileSync(join(target,"SKILL.md"),"utf8"),"Tenant B original");
  }finally{await f.close();}
});

test("an existing skill leaf hard link cannot overwrite another tenant's file",async()=>{
  const f=fixture();try{
    const outside=join(f.root,"b/private.txt"),target=join(f.root,"a/.agent/skills/leaf");writeFileSync(outside,"Other tenant original");mkdirSync(target,{recursive:true});linkSync(outside,join(target,"SKILL.md"));
    const result=await f.connect("a").call("skill.install",{agent:"mock:default",name:"leaf",scope:"project",projectId:"project-a",source:{kind:"inline",files:{"SKILL.md":"Must not overwrite"}}});
    assert.equal(result.error?.data?.appCode,"errPolicyDenied");assert.equal(readFileSync(outside,"utf8"),"Other tenant original");
  }finally{await f.close();}
});

test("skill removal retries retain original identity without deleting a replacement or bypassing current policy",async()=>{
  const f=fixture();try{
    const a=f.connect("a",{allowGlobalSkillInstall:true});
    const create={agent:"mock:default",name:"remove-me",scope:"global",source:{kind:"inline",files:{"SKILL.md":"Original"}}};
    assert.ok((await a.call("skill.install",create)).result?.skill.hash);
    const remove={clientRequestId:"remove-exact",agent:"mock:default",name:"remove-me",scope:"global"};
    const original=await a.call("skill.uninstall",remove);assert.equal(original.result.uninstalled,true);
    assert.deepEqual((await a.call("skill.uninstall",remove)).result,original.result);
    assert.equal((await a.call("skill.uninstall",{...remove,name:"different"})).error?.data?.appCode,"errInvalidParams");
    await a.connection.dispose();
    assert.equal((await f.connect("a").call("skill.uninstall",remove)).error?.data?.appCode,"errPolicyDenied");
  }finally{await f.close();}
});
