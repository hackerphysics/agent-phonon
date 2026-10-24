import test from "node:test";
import assert from "node:assert/strict";
import {createHash,randomUUID} from "node:crypto";
import {mkdtempSync,realpathSync,readFileSync,writeFileSync,rmSync,existsSync,copyFileSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {ManagedMcpManager,managedMcpSourceFingerprint,configureManagedMcpConsent,managedMcpStateDir} from "./managed-mcp.js";
import {managedMcpEntryName,managedMcpSourceStatePath} from "./managed-mcp-source.js";
import {defaultConfig,writeConfig,loadConfig,type ServerConfig} from "./config.js";
import {runManagedMcpWorker} from "./managed-mcp-worker-client.js";
import {managedConfigTarget,patchManagedMcp} from "./managed-mcp-config.js";
import type {AgentDescriptor} from "@agent-phonon/protocol";

function fixture(){
  const home=realpathSync(mkdtempSync(join(tmpdir(),"phonon-mcp-source-"))),server="https://example.invalid/phonon",configPath=join(home,"daemon.json"),config=defaultConfig();
  const a:ServerConfig={url:server,deviceKey:"synthetic-private-source-a",expectedTenantId:randomUUID()},b:ServerConfig={url:server,deviceKey:"synthetic-private-source-b",expectedTenantId:randomUUID()};
  const sourceA=managedMcpSourceFingerprint(a)!,sourceB=managedMcpSourceFingerprint(b)!;
  a.managedMcp={allow:true,agents:["codex"],sourceFingerprint:sourceA};b.managedMcp={allow:true,agents:["codex"],sourceFingerprint:sourceB};
  Object.assign(config,{dbPath:join(home,"private.db"),workspaceRoot:home,adapters:[],servers:[a,b]});writeConfig(config,configPath);
  const inventory=async()=>[{agentId:"codex",adapter:"codex",available:true,version:"1.0.0"}] as AgentDescriptor[];
  const options=(sourceFingerprint:string)=>({server,sourceFingerprint,configPath,stateDir:managedMcpStateDir(config),home,env:{},command:process.execPath,args:["/trusted/cli.js"]});
  const create=(source:string,observe=inventory)=>new ManagedMcpManager({...options(source),inventory:observe});
  const managerA=create(sourceA),managerB=create(sourceB),binding=randomUUID(),input=(revision:number,enabled=true)=>({revision,bindings:[{id:binding,agentId:"codex",enabled}]});
  const profile=join(home,".codex/config.toml"),read=()=>readFileSync(profile,"utf8"),cleanup=()=>rmSync(home,{recursive:true,force:true});
  return {home,server,configPath,config,a,b,sourceA,sourceB,inventory,options,create,managerA,managerB,binding,input,profile,read,cleanup};
}

test("same URL and equal binding IDs retain independent source selection, aliases, reports and revisions",async()=>{
  const f=fixture();try{
    assert.equal((await f.managerA.configure(f.input(10))).bindings[0]?.state,"configured");
    assert.equal((await f.managerB.configure(f.input(1))).bindings[0]?.state,"configured");
    const nameA=managedMcpEntryName(f.binding,f.sourceA),nameB=managedMcpEntryName(f.binding,f.sourceB);assert.notEqual(nameA,nameB);
    assert.ok(f.read().includes(nameA));assert.ok(f.read().includes(nameB));assert.ok(f.read().includes(f.sourceA));assert.ok(f.read().includes(f.sourceB));
    assert.equal(f.managerA.status().revision,10);assert.equal(f.managerB.status().revision,1);
    await f.managerB.configure({revision:11,bindings:[]});assert.ok(f.read().includes(nameA));assert.ok(!f.read().includes(nameB));
    assert.equal(f.managerA.status().revision,10);assert.equal(f.managerA.status().bindings[0]?.id,f.binding);
    assert.deepEqual(f.managerB.status().bindings,[]);
    assert.ok(!f.read().includes(f.a.deviceKey!));assert.ok(!f.read().includes(f.b.deviceKey!));
  }finally{f.cleanup();}
});

test("unselected duplicate URLs cannot choose an account or change human local consent",()=>{
  const f=fixture();try{
    const before=readFileSync(f.configPath,"utf8");
    const {sourceFingerprint:_source,...options}=f.options(f.sourceA);
    assert.throws(()=>new ManagedMcpManager({...options,inventory:f.inventory}),/mcp_source_ambiguous/);
    assert.deepEqual(new ManagedMcpManager({...options,sourceFingerprint:undefined,inventory:f.inventory}).status(),{revision:-1,allowed:false,bindings:[]});
    assert.equal(readFileSync(f.configPath,"utf8"),before);assert.equal(existsSync(f.profile),false);
  }finally{f.cleanup();}
});

test("human CLI selection binds consent only to the exact registered source",()=>{
  const f=fixture();try{
    const before=readFileSync(f.configPath,"utf8");
    assert.throws(()=>configureManagedMcpConsent(["deny","--config",f.configPath,"--server",f.server]),/mcp_source_ambiguous/);
    assert.equal(readFileSync(f.configPath,"utf8"),before);
    configureManagedMcpConsent(["deny","--config",f.configPath,"--server",f.server,"--source",f.sourceB]);
    const cfg=loadConfig(f.configPath);assert.equal(cfg.servers[0]!.managedMcp?.allow,true);assert.equal(cfg.servers[1]!.managedMcp?.allow,false);
    assert.equal(cfg.servers[1]!.managedMcp?.sourceFingerprint,f.sourceB);
  }finally{f.cleanup();}
});

test("legacy or copied consent cannot enable another source",async()=>{
  const f=fixture();try{
    delete f.a.managedMcp!.sourceFingerprint;f.b.managedMcp!.sourceFingerprint=f.sourceA;writeConfig(f.config,f.configPath);
    assert.equal((await f.managerA.configure(f.input(1))).allowed,false);assert.equal((await f.managerB.configure(f.input(1))).allowed,false);
    assert.equal(existsSync(f.profile),false);
    configureManagedMcpConsent(["allow","--config",f.configPath,"--server",f.server,"--source",f.sourceB,"--agents","codex"]);
    assert.equal((await f.managerB.configure(f.input(1))).bindings[0]?.state,"configured");assert.equal(f.managerA.status().allowed,false);
  }finally{f.cleanup();}
});

test("a running Manager does not adopt a replacement account or its old consent",async()=>{
  const f=fixture();try{
    f.config.servers=[f.a];writeConfig(f.config,f.configPath);
    const manager=new ManagedMcpManager({...f.options(f.sourceA),inventory:f.inventory});await manager.configure(f.input(10));const before=f.read();
    f.config.servers=[{...f.b,managedMcp:{...f.a.managedMcp!}}];writeConfig(f.config,f.configPath);
    assert.equal(manager.status().allowed,false);const replacement=f.create(f.sourceB);
    assert.deepEqual(replacement.status().bindings,[]);assert.equal((await replacement.configure(f.input(1))).allowed,false);assert.equal(f.read(),before);
    configureManagedMcpConsent(["allow","--config",f.configPath,"--server",f.server,"--agents","codex"]);
    assert.equal((await replacement.configure(f.input(1))).bindings[0]?.state,"configured");assert.ok(f.read().includes(managedMcpEntryName(f.binding,f.sourceA)));
  }finally{f.cleanup();}
});

test("unknown URL-only legacy state and old aliases are neither adopted nor removed",async()=>{
  const f=fixture();try{
    const old=managedConfigTarget("codex",f.binding,process.execPath,["/old/cli.js","mcp","proxy"],{home:f.home,env:{}})!;
    const owned=patchManagedMcp(old,true)!;const legacyPath=join(managedMcpStateDir(f.config),createHash("sha256").update(f.server).digest("hex")+".json");
    await f.managerA.configure({revision:0,bindings:[]});
    const encoded=JSON.stringify({snapshot:f.input(99),entries:{[f.binding]:owned},report:{revision:99,allowed:true,bindings:[]}});writeFileSync(legacyPath,encoded,{mode:0o600});
    await f.managerB.configure(f.input(1));assert.equal(readFileSync(legacyPath,"utf8"),encoded);assert.ok(f.read().includes(old.name));assert.ok(f.read().includes(managedMcpEntryName(f.binding,f.sourceB)));
    assert.equal(f.managerA.status().revision,0);assert.equal(f.managerB.status().revision,1);
  }finally{f.cleanup();}
});

test("copied state cannot become ownership proof for a different source",async()=>{
  const f=fixture();try{
    await f.managerA.configure(f.input(5));const before=f.read();
    copyFileSync(managedMcpSourceStatePath(managedMcpStateDir(f.config),f.sourceA),managedMcpSourceStatePath(managedMcpStateDir(f.config),f.sourceB));
    assert.throws(()=>f.managerB.status(),/mcp_state_source_unconfirmed/);await assert.rejects(f.managerB.configure(f.input(6)),/mcp_state_source_unconfirmed/);assert.equal(f.read(),before);
  }finally{f.cleanup();}
});

test("the source-state lock rechecks revision after asynchronous preparation",async()=>{
  const f=fixture();let release!:()=>void,entered!:()=>void;const gate=new Promise<void>(done=>release=done),ready=new Promise<void>(done=>entered=done);
  const older=f.create(f.sourceA,async()=>{entered();await gate;return f.inventory();});let pending:Promise<unknown>|undefined;
  try{
    pending=older.configure(f.input(1));void pending.catch(()=>{});await ready;await f.managerA.configure(f.input(2));const before=f.read();release();
    await assert.rejects(pending,/mcp_revision_conflict/);assert.equal(f.read(),before);assert.equal(f.managerA.status().revision,2);
  }finally{release();await pending?.catch(()=>{});f.cleanup();}
});

test("workers retain the selected source rather than inferring a different current account",async()=>{
  const f=fixture();try{
    const result=await runManagedMcpWorker(f.options(f.sourceB),{operation:"configure",snapshot:f.input(1),inventory:await f.inventory()});assert.equal(result.bindings[0]?.state,"configured");
    assert.deepEqual(f.managerA.status().bindings,[]);assert.equal(f.managerB.status().revision,1);
    f.config.servers=[f.a];writeConfig(f.config,f.configPath);
    assert.equal((await runManagedMcpWorker(f.options(f.sourceB),{operation:"status",inventory:[]})).allowed,false);assert.deepEqual(f.managerA.status().bindings,[]);
  }finally{f.cleanup();}
});

test("source identity rejects unsafe transports and changes with every trusted account selector",()=>{
  const base:ServerConfig={url:"https://example.invalid/phonon",deviceKey:"synthetic-private-source",expectedTenantId:randomUUID()};
  const source=managedMcpSourceFingerprint(base);assert.match(source!,/^[a-f0-9]{64}$/);
  assert.notEqual(managedMcpSourceFingerprint({...base,deviceKey:"synthetic-replacement-source"}),source);
  assert.notEqual(managedMcpSourceFingerprint({...base,expectedTenantId:randomUUID()}),source);
  assert.notEqual(managedMcpSourceFingerprint({...base,url:base.url+"/other"}),source);
  assert.equal(managedMcpSourceFingerprint({...base,deviceKey:""}),undefined);
  for(const url of ["https://user:password@example.invalid/phonon","https://example.invalid/phonon?token=x","https://example.invalid/phonon#account",
    "http://example.invalid/phonon","ws://example.invalid/phonon","file:///private/source","not-a-url"]){
    assert.equal(managedMcpSourceFingerprint({...base,url}),undefined,url);
  }
  for(const url of ["https://example.invalid/phonon","wss://example.invalid/phonon","http://127.0.0.1:1234/phonon","ws://[::1]:1234/phonon"]){
    assert.match(managedMcpSourceFingerprint({...base,url})!,/^[a-f0-9]{64}$/,url);
  }
});

test("per-source local agent allowlists cannot be broadened by another source or a server snapshot",async()=>{
  const f=fixture();try{
    f.b.managedMcp!.agents=["pi"];writeConfig(f.config,f.configPath);
    assert.equal((await f.managerA.configure(f.input(1))).bindings[0]?.state,"configured");
    const denied=await f.managerB.configure(f.input(1));assert.equal(denied.allowed,true);assert.equal(denied.bindings[0]?.state,"local_consent_required");
    assert.ok(f.read().includes(f.sourceA));assert.ok(!f.read().includes(f.sourceB));
    f.b.managedMcp!.agents=["*"];writeConfig(f.config,f.configPath);
    assert.equal((await f.managerB.configure(f.input(1))).bindings[0]?.state,"configured");
    f.b.managedMcp!.agents=[];writeConfig(f.config,f.configPath);
    assert.equal((await f.managerB.configure(f.input(2))).bindings[0]?.state,"local_consent_required");
    assert.ok(f.read().includes(f.sourceA));assert.ok(!f.read().includes(f.sourceB));assert.equal(f.managerA.status().revision,1);
  }finally{f.cleanup();}
});

test("local revocation during asynchronous preparation removes only that source's owned registration",async()=>{
  const f=fixture();let release!:()=>void,entered!:()=>void;
  const gate=new Promise<void>(done=>release=done),ready=new Promise<void>(done=>entered=done);
  const preparing=f.create(f.sourceA,async()=>{entered();await gate;return f.inventory();});let pending:ReturnType<ManagedMcpManager["configure"]>|undefined;
  try{
    await f.managerA.configure(f.input(1));await f.managerB.configure(f.input(1));
    pending=preparing.configure(f.input(2));void pending.catch(()=>{});await ready;
    f.a.managedMcp!.allow=false;writeConfig(f.config,f.configPath);release();
    const report=await pending;assert.equal(report.allowed,false);assert.equal(report.bindings[0]?.state,"local_consent_required");
    assert.ok(!f.read().includes(f.sourceA));assert.ok(f.read().includes(f.sourceB));assert.equal(f.managerB.status().allowed,true);
  }finally{release();await pending?.catch(()=>{});f.cleanup();}
});

test("state with a foreign selector or unowned registration cannot authorize native profile mutations",async()=>{
  const f=fixture();try{
    await f.managerA.configure(f.input(1));const path=managedMcpSourceStatePath(managedMcpStateDir(f.config),f.sourceA),original=readFileSync(path,"utf8"),profile=f.read();
    for(const change of [
      (state:any)=>{state.entries[f.binding].name=managedMcpEntryName(f.binding,f.sourceB);},
      (state:any)=>{const args=state.entries[f.binding].entry.args;args[args.indexOf("--source")+1]=f.sourceB;},
      (state:any)=>{const args=state.entries[f.binding].entry.args;args[args.indexOf("--binding")+1]=randomUUID();},
      (state:any)=>{state.snapshot.bindings=[];},
    ]){
      const state=JSON.parse(original);change(state);writeFileSync(path,JSON.stringify(state),{mode:0o600});
      assert.throws(()=>f.managerA.status(),/mcp_state_source_unconfirmed/);
      await assert.rejects(f.managerA.configure(f.input(2)),/mcp_state_source_unconfirmed/);assert.equal(f.read(),profile);
    }
    writeFileSync(path,original,{mode:0o600});assert.equal(f.managerA.status().revision,1);
  }finally{f.cleanup();}
});
