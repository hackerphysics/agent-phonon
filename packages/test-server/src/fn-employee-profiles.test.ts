import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID,createHash } from "node:crypto";
import { mkdtempSync,realpathSync,rmSync,mkdirSync,writeFileSync,readFileSync,existsSync,symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { AdapterRegistry,PhononStore,HermesAdapter,OpenClawGatewayAdapter,type EmployeeProfileTarget,type CreateSessionParams } from "@agent-phonon/core";
import { PhononDevice } from "@agent-phonon/server-sdk";
import { EmployeeProfileApplyParams } from "@agent-phonon/protocol";
import { TestConn,MockAdapter } from "./harness.js";

const hash=(text:string)=>createHash("sha256").update(text).digest("hex");
const docs=(target:EmployeeProfileTarget)=>({"SOUL.md":`# ${target.input.name}\n\n${target.input.responsibility}\n\n${target.input.documents.soul}`,"AGENTS.md":target.input.documents.agents,"USER.md":target.input.documents.user,"TOOLS.md":target.input.documents.tools});
const spec=()=>EmployeeProfileApplyParams.parse({employeeId:randomUUID(),revision:1,agent:"hermes:base",model:"m1",profileId:"employee",name:"Engineer",responsibility:"Delivery",documents:{soul:"Verify outcomes",agents:"Respect project boundaries",user:"Preferred language: English",tools:"Use native permissions"}});
class EmployeeAdapter extends MockAdapter{
  targets=new Map<string,EmployeeProfileTarget>();created:CreateSessionParams[]=[];
  constructor(){super({name:"hermes",agentIds:["hermes:base"],sendDelayMs:40,caps:{employeeProfiles:true}});}
  override async createSession(params:CreateSessionParams){this.created.push(params);return super.createSession(params);}
  async provisionEmployee(target:EmployeeProfileTarget){
    const old=this.targets.get(target.runtimeProfile);if(old&&old.nonce!==target.nonce)throw new Error("Owner mismatch");
    this.targets.set(target.runtimeProfile,target);
    for(const [file,body]of Object.entries(docs(target)))writeFileSync(join(target.workspace,file),body);
    return this.inspectEmployee(target);
  }
  async inspectEmployee(target:EmployeeProfileTarget){
    return {home:target.workspace,documentHashes:Object.fromEntries(Object.keys(docs(target)).map(file=>[file,hash(readFileSync(join(target.workspace,file),"utf8"))])),memoryBytes:existsSync(join(target.workspace,"MEMORY.md"))?readFileSync(join(target.workspace,"MEMORY.md")).length:0};
  }
}
test("employee provisioning is explicitly gated, owner-scoped, versioned and binds distinct Sessions to persistent memory",async()=>{
  const root=realpathSync(mkdtempSync(join(tmpdir(),"phonon-employee-"))),store=new PhononStore(join(root,"state.db")),registry=new AdapterRegistry(),adapter=new EmployeeAdapter();registry.register(adapter);
  const denied=new TestConn({store,registry,tenantId:"owner",workspaceRoot:root});
  const input=spec();await assert.rejects(denied.call("employee.profile.apply",input));assert.equal(store.employeeProfile("owner",input.employeeId),undefined);await denied.conn.dispose();
  const tc=new TestConn({store,registry,tenantId:"owner",workspaceRoot:root,policy:{allowEmployeeProfiles:true,allowedAgents:["hermes:base"] as never}});
  try{
    const applied=await tc.call("employee.profile.apply",input) as any;assert.equal(applied.state,"ready");assert.equal(applied.privateWorkspace.employeeId,input.employeeId);
    assert.equal(readFileSync(join(applied.privateWorkspace.path,"SOUL.md"),"utf8"),docs({input} as EmployeeProfileTarget)["SOUL.md"]);
    assert.deepEqual(await tc.call("employee.profile.apply",input),applied);
    await assert.rejects(tc.call("employee.profile.apply",{...input,name:"Changed without revision"}));
    const project=(await tc.call("project.create",{name:"Work",git:false}) as any).project.projectId;
    const binding={employee:{id:input.employeeId,revision:1}};
    const first=await tc.call("session.create",{project:applied.privateWorkspace.projectId,agent:"hermes:base",model:"m1",agentConfig:binding}) as any;
    const second=await tc.call("session.create",{project,agent:"hermes:base",model:"m1",agentConfig:binding}) as any;
    assert.notEqual(first.sessionId,second.sessionId);assert.equal(adapter.created[0]!.employee?.runtimeProfile,adapter.created[1]!.employee?.runtimeProfile);
    assert.equal((await tc.call("session.status",{sessionId:first.sessionId}) as any).employeeId,input.employeeId);
    const sent=await tc.call("session.send",{sessionId:first.sessionId,input:"Task"}) as any;
    await assert.rejects(tc.call("employee.profile.apply",{...input,revision:2}));await tc.waitTurnEnd(sent.turnId);
    await new Promise(resolve=>setTimeout(resolve,10));writeFileSync(join(applied.privateWorkspace.path,"MEMORY.md"),"Remember verified outcomes");
    const updated=await tc.call("employee.profile.apply",{...input,revision:2,documents:{...input.documents,soul:"New identity guidance"}}) as any;
    assert.equal(updated.state,"ready");assert.ok(updated.memoryBytes>0);assert.equal(updated.privateWorkspace.projectId,applied.privateWorkspace.projectId);
    assert.equal(readFileSync(join(updated.privateWorkspace.path,"MEMORY.md"),"utf8"),"Remember verified outcomes");
    const foreign=new TestConn({store,registry,tenantId:"other",workspaceRoot:root});
    try{await assert.rejects(foreign.call("employee.profile.status",{employeeId:input.employeeId}));await assert.rejects(foreign.call("session.create",{project,agent:"hermes:base",model:"m1",agentConfig:binding}));}finally{await foreign.conn.dispose();}
  }finally{await tc.conn.dispose();store.close();rmSync(root,{recursive:true,force:true});}
});

test("OpenClaw uses native isolated-agent APIs and refuses profile/file ownership changes",async()=>{
  const input=EmployeeProfileApplyParams.parse({...spec(),agent:"openclaw:base"}),target:EmployeeProfileTarget={input,runtimeProfile:"phn-test",workspace:"/owned/employee",nonce:randomUUID()};
  const files=new Map<string,string>(),agents=[{id:"base",workspace:"/base"}];const calls:any[]=[];
  const adapter=new OpenClawGatewayAdapter({gateway:{baseUrl:"ws://127.0.0.1:1",token:"test"}});
  (adapter as unknown as {gw:unknown}).gw={connect:async()=>{},rpc:async(method:string,params:any)=>{
    calls.push({method,params});if(method==="agents.list")return {agents};if(method==="agents.create"){agents.push({id:params.name,workspace:params.workspace});return {agentId:params.name,workspace:params.workspace};}
    if(method==="agents.files.set"){files.set(params.name,params.content);return {ok:true};}
    if(method==="agents.files.get")return {workspace:target.workspace,file:{missing:!files.has(params.name),content:files.get(params.name)}};
    return {ok:true};
  }};
  const first=await adapter.provisionEmployee(target);assert.equal(first.home,target.workspace);assert.ok(files.get("SOUL.md")?.includes("Verify outcomes"));
  assert.ok(calls.some(call=>call.method==="agents.create"));assert.equal(calls.some(call=>call.method.startsWith("chat.")),false);
  files.set("MEMORY.md","Native memory");assert.ok((await adapter.inspectEmployee(target)).memoryBytes>0);
  files.set("SOUL.md","Local user change");await assert.rejects(adapter.provisionEmployee({...target,previousHashes:first.documentHashes}));assert.equal(files.get("SOUL.md"),"Local user change");
  files.set("IDENTITY.md","Unowned");await assert.rejects(adapter.inspectEmployee(target));
});

test("OpenClaw waits for acknowledged creation to enter the runtime catalog without recreating the agent",async()=>{
  const input=EmployeeProfileApplyParams.parse({...spec(),agent:"openclaw:base"}),target:EmployeeProfileTarget={input,runtimeProfile:"phn-eventual",workspace:"/owned/eventual",nonce:randomUUID()};
  const files=new Map<string,string>();let created=false,reads=0,creates=0,updated=false;
  const adapter=new OpenClawGatewayAdapter({gateway:{baseUrl:"ws://127.0.0.1:1",token:"test"}});
  (adapter as any).gw={connect:async()=>{},rpc:async(method:string,params:any)=>{
    if(method==="agents.list"){if(created)reads++;return {agents:created&&reads>=3?[{id:target.runtimeProfile,workspace:target.workspace}]:[]};}
    if(method==="agents.create"){created=true;creates++;return {agentId:target.runtimeProfile,workspace:target.workspace};}
    if(method==="agents.update"){assert.ok(reads>=3,"do not update before native visibility");updated=true;return {ok:true};}
    if(method==="agents.files.set"){assert.equal(updated,true);files.set(params.name,params.content);return {ok:true};}
    if(method==="agents.files.get")return {workspace:target.workspace,file:{missing:!files.has(params.name),content:files.get(params.name)}};
    throw new Error("unexpected method");
  }};
  const result=await adapter.provisionEmployee(target);assert.equal(result.home,target.workspace);assert.equal(creates,1);assert.equal(updated,true);
});

test("OpenClaw creation visibility checks reject changed workspace and do not survive adapter closure",async()=>{
  const input=EmployeeProfileApplyParams.parse({...spec(),agent:"openclaw:base"}),target:EmployeeProfileTarget={input,runtimeProfile:"phn-visible",workspace:"/owned/visible",nonce:randomUUID()};
  for(const scenario of ["changed","closed","denied"]){
    let created=false,writes=0,creates=0;
    const adapter=new OpenClawGatewayAdapter({gateway:{baseUrl:"ws://127.0.0.1:1",token:"test"}});
    (adapter as any).gw={connect:async()=>{},close(){},rpc:async(method:string)=>{
      if(method==="agents.list"){
        if(!created)return {agents:[]};
        if(scenario==="changed")return {agents:[{id:target.runtimeProfile,workspace:"/foreign"}]};
        if(scenario==="denied")throw new Error("permission denied",{cause:{code:"FORBIDDEN"}});
        adapter.close();return {agents:[]};
      }
      if(method==="agents.create"){created=true;creates++;return {agentId:target.runtimeProfile,workspace:target.workspace};}
      writes++;throw new Error("must not write");
    }};
    await assert.rejects(adapter.provisionEmployee(target),error=>scenario==="denied"?/permission denied/.test(String(error)):["employee_profile_identity_changed","errSessionBusy"].includes((error as {appCode:string}).appCode));
    assert.equal(creates,1);assert.equal(writes,0);
  }
});

test("OpenClaw visibility timeout is unconfirmed, bounded and never repeats creation",{timeout:8000},async()=>{
  const input=EmployeeProfileApplyParams.parse({...spec(),agent:"openclaw:base"}),target:EmployeeProfileTarget={input,runtimeProfile:"phn-pending",workspace:"/owned/pending",nonce:randomUUID()};
  let creates=0,writes=0,reads=0;
  const adapter=new OpenClawGatewayAdapter({gateway:{baseUrl:"ws://127.0.0.1:1",token:"test"}});
  (adapter as any).gw={connect:async()=>{},rpc:async(method:string)=>{
    if(method==="agents.list"){reads++;return {agents:[]};}
    if(method==="agents.create"){creates++;return {agentId:target.runtimeProfile,workspace:target.workspace};}
    writes++;return {};
  }};
  const started=Date.now();await assert.rejects(adapter.provisionEmployee(target),error=>(error as {appCode:string}).appCode==="employee_profile_native_pending");
  assert.equal(creates,1);assert.equal(writes,0);assert.ok(reads<25);assert.ok(Date.now()-started<6500);
});

test("installed Hermes recognizes isolated profile layout without copying base memory or rotating auth stores",async t=>{
  const bin=process.env.PHONON_TEST_HERMES_BIN;if(!bin){t.skip("Set PHONON_TEST_HERMES_BIN for the installed-native isolated-home smoke test");return;}
  const root=realpathSync(mkdtempSync(join(tmpdir(),"phonon-hermes-profile-"))),old=process.env.HERMES_HOME;process.env.HERMES_HOME=root;
  try{
    mkdirSync(join(root,"memories"));writeFileSync(join(root,"config.yaml"),"model:\n  default: m1\n  provider: openai-api\nterminal:\n  cwd: /not-the-task\n");
    writeFileSync(join(root,".env"),"OPENAI_API_KEY=test-provider-key\nTELEGRAM_BOT_TOKEN=must-not-copy\n");
    writeFileSync(join(root,"memories/MEMORY.md"),"Must not clone source memory");writeFileSync(join(root,"auth.json"),"{\"test\":\"must-not-copy\"}");
    const input=EmployeeProfileApplyParams.parse({...spec(),agent:"hermes:default"}),target:EmployeeProfileTarget={input,runtimeProfile:"phn-"+randomUUID().replaceAll("-",""),workspace:join(root,"work"),nonce:randomUUID()};
    const adapter=new HermesAdapter({env:{binPath:bin}}),first=await adapter.provisionEmployee(target);
    assert.ok(first.home.startsWith(join(root,"profiles")));assert.equal(readFileSync(join(first.home,"SOUL.md"),"utf8"),docs(target)["SOUL.md"]);
    assert.equal(existsSync(join(first.home,"auth.json")),false);assert.equal(existsSync(join(first.home,"memories/MEMORY.md")),false);
    assert.ok(!readFileSync(join(first.home,".env"),"utf8").includes("TELEGRAM"));
    assert.ok(readFileSync(join(first.home,".env"),"utf8").includes("test-provider-key"));
    assert.ok(execFileSync(bin,["profile","list"],{env:{...process.env,HERMES_HOME:root},encoding:"utf8",timeout:20000}).includes(target.runtimeProfile));
    writeFileSync(join(first.home,"memories/MEMORY.md"),"Independent learned memory");
    await adapter.provisionEmployee({...target,input:{...input,revision:2,documents:{...input.documents,soul:"Updated"}},previousHashes:first.documentHashes});
    assert.equal(readFileSync(join(first.home,"memories/MEMORY.md"),"utf8"),"Independent learned memory");
    const external=join(root,"external");writeFileSync(external,"Preserve me");rmSync(join(first.home,"TOOLS.md"));symlinkSync(external,join(first.home,"TOOLS.md"));
    await assert.rejects(adapter.provisionEmployee(target));assert.equal(readFileSync(external,"utf8"),"Preserve me");
  }finally{if(old===undefined)delete process.env.HERMES_HOME;else process.env.HERMES_HOME=old;rmSync(root,{recursive:true,force:true});}
});

test("OpenClaw tolerates only explicitly unsupported empty TOOLS guidance and never drops nonempty settings",async()=>{
  const input=EmployeeProfileApplyParams.parse({...spec(),agent:"openclaw:base",documents:{...spec().documents,tools:""}});
  const target:EmployeeProfileTarget={input,runtimeProfile:"phn-test",workspace:"/owned/employee",nonce:randomUUID()};
  const files=new Map<string,string>(),agents=[{id:"base",workspace:"/base"}],calls:any[]=[];
  let failure={code:"INVALID_REQUEST",message:'unsupported file "TOOLS.md"'};
  const adapter=new OpenClawGatewayAdapter({gateway:{baseUrl:"ws://127.0.0.1:1",token:"test"}});
  (adapter as unknown as {gw:unknown}).gw={connect:async()=>{},rpc:async(method:string,params:any)=>{
    calls.push({method,params});
    if(method==="agents.list")return {agents};
    if(method==="agents.create"){agents.push({id:params.name,workspace:params.workspace});return {agentId:params.name,workspace:params.workspace};}
    if(method.startsWith("agents.files.")&&params.name==="TOOLS.md")throw new Error("Native file request rejected",{cause:failure});
    if(method==="agents.files.set"){files.set(params.name,params.content);return {ok:true};}
    if(method==="agents.files.get")return {workspace:target.workspace,file:{missing:!files.has(params.name),content:files.get(params.name)}};
    return {ok:true};
  }};
  const first=await adapter.provisionEmployee(target);assert.equal(first.documentHashes["TOOLS.md"],hash(""));
  assert.equal(files.has("TOOLS.md"),false);assert.equal(calls.some(call=>call.method.startsWith("chat.")),false);
  await assert.rejects(adapter.provisionEmployee({...target,input:{...input,documents:{...input.documents,tools:"Must not be dropped"}},previousHashes:first.documentHashes}));
  for(const message of ['permission denied','unsupported file "SOUL.md"']){
    failure={code:"INVALID_REQUEST",message};await assert.rejects(adapter.inspectEmployee(target));
  }
  failure={code:"UNAVAILABLE",message:'unsupported file "TOOLS.md"'};await assert.rejects(adapter.inspectEmployee(target));
});

test("OpenClaw discovery preserves native display names and stable distinct agent identities",async()=>{
  const adapter=new OpenClawGatewayAdapter({gateway:{baseUrl:"ws://127.0.0.1:1",token:"test"}});
  (adapter as unknown as {gw:unknown}).gw={onEvent:()=>{},connect:async()=>{},isConnected:()=>true,rpc:async(method:string)=>method==="agents.list"?{agents:[{id:"reviewer",name:"Code reviewer"},{id:"researcher",name:"Research analyst"},{id:"plain",name:"plain"}]}:{models:[{id:"m1",provider:"local",available:true}]}};
  const rows=await adapter.discoverAgents();
  assert.deepEqual(rows.map(row=>[row.agentId,row.displayName]),[["openclaw:reviewer","OpenClaw / Code reviewer (reviewer)"],["openclaw:researcher","OpenClaw / Research analyst (researcher)"],["openclaw:plain","OpenClaw / plain"]]);
});

test("TypeScript SDK exposes equivalent employee apply/status operations",async()=>{
  const calls:any[]=[];const device=new PhononDevice("device","owner",{request:async(method:string,params:unknown)=>{calls.push({method,params});return {};}} as never);
  const input=spec();await device.employeeProfiles.apply(input as never);await device.employeeProfiles.status(input.employeeId);
  assert.deepEqual(calls.map(call=>call.method),["employee.profile.apply","employee.profile.status"]);
});

test("a successful adapter call without matching document readback never becomes ready",async()=>{
  const root=realpathSync(mkdtempSync(join(tmpdir(),"phonon-employee-verification-"))),store=new PhononStore(join(root,"state.db")),registry=new AdapterRegistry();
  class WrongAdapter extends EmployeeAdapter{override async provisionEmployee(target:EmployeeProfileTarget){await super.provisionEmployee(target);writeFileSync(join(target.workspace,"SOUL.md"),"Wrong native output");return this.inspectEmployee(target);}}
  registry.register(new WrongAdapter());const tc=new TestConn({store,registry,workspaceRoot:root,tenantId:"owner",policy:{allowEmployeeProfiles:true}});
  try{const status=await tc.call("employee.profile.apply",spec()) as any;assert.equal(status.state,"failed");assert.equal(status.errorCode,"employee_profile_verification_failed");}
  finally{await tc.conn.dispose();store.close();rmSync(root,{recursive:true,force:true});}
});

test("DEs share one owned native profile without sharing Sessions, workspaces or document writes",async()=>{
  const root=realpathSync(mkdtempSync(join(tmpdir(),"phonon-shared-profile-"))),store=new PhononStore(join(root,"state.db")),registry=new AdapterRegistry(),adapter=new EmployeeAdapter();registry.register(adapter);
  const tc=new TestConn({store,registry,workspaceRoot:root,tenantId:"owner",policy:{allowEmployeeProfiles:true}});
  try{
    const source=spec(),first=await tc.call("employee.profile.apply",source) as any;
    const alias={...source,employeeId:randomUUID(),name:"Reviewer",profileBinding:{kind:"employee",employeeId:source.employeeId},documents:{soul:"Review independently",agents:"",user:"",tools:""}};
    const second=await tc.call("employee.profile.apply",alias) as any;
    assert.equal(second.state,"ready");assert.equal(second.runtimeProfile,first.runtimeProfile);
    assert.notEqual(second.privateWorkspace.path,first.privateWorkspace.path);
    assert.notEqual(second.privateWorkspace.projectId,first.privateWorkspace.projectId);
    assert.equal(second.privateWorkspace.employeeId,alias.employeeId);assert.equal(adapter.targets.size,1);
    assert.equal(readFileSync(join(first.privateWorkspace.path,"SOUL.md"),"utf8"),docs({input:source} as EmployeeProfileTarget)["SOUL.md"]);
    const session=await tc.call("session.create",{project:second.privateWorkspace.projectId,agent:source.agent,model:source.model,agentConfig:{employee:{id:alias.employeeId,revision:1}}}) as any;
    assert.equal(adapter.created.at(-1)?.employee?.employeeId,alias.employeeId);
    assert.equal(adapter.created.at(-1)?.employee?.home,first.privateWorkspace.path);
    assert.ok(adapter.created.at(-1)?.initialContext?.some(item=>item.content.includes("Reviewer")));
    const sent=await tc.call("session.send",{sessionId:session.sessionId,input:"Review"}) as any;
    assert.equal(store.employeeBusy("owner",source.employeeId),true);
    await assert.rejects(tc.call("employee.profile.apply",{...source,revision:2}));
    await tc.waitTurnEnd(sent.turnId);await new Promise(resolve=>setTimeout(resolve,10));
    const updated=await tc.call("employee.profile.apply",{...source,revision:2,documents:{...source.documents,agents:"Shared instruction update"}}) as any;
    assert.equal(updated.state,"ready");assert.equal((await tc.call("employee.profile.status",{employeeId:alias.employeeId}) as any).state,"ready");
    await tc.call("employee.profile.apply",{...alias,revision:2,documents:{...alias.documents,soul:"Updated per-DE identity"}});
    assert.equal(readFileSync(join(first.privateWorkspace.path,"AGENTS.md"),"utf8"),"Shared instruction update");
    assert.equal(adapter.targets.get(first.runtimeProfile)?.input.employeeId,source.employeeId);
    await assert.rejects(tc.call("employee.profile.apply",{...alias,employeeId:randomUUID(),profileBinding:{kind:"employee",employeeId:alias.employeeId}}));
    const foreign=new TestConn({store,registry,workspaceRoot:root,tenantId:"other",policy:{allowEmployeeProfiles:true}});
    try{await assert.rejects(foreign.call("employee.profile.apply",{...alias,employeeId:randomUUID()}));}finally{await foreign.conn.dispose();}
  }finally{await tc.conn.dispose();store.close();rmSync(root,{recursive:true,force:true});}
});

test("binding a discovered native profile is read-only, repeatable and retains each DE's private workspace",async()=>{
  const root=realpathSync(mkdtempSync(join(tmpdir(),"phonon-native-profile-binding-"))),store=new PhononStore(join(root,"state.db")),registry=new AdapterRegistry();
  const nativeHome=join(root,"native");mkdirSync(nativeHome);writeFileSync(join(nativeHome,"SOUL.md"),"Existing native identity");
  class ExistingAdapter extends EmployeeAdapter {
    home=nativeHome;
    async inspectHarnessProfile(){return {home:this.home,nativeIdentity:this.home,documentHashes:{"SOUL.md":hash(readFileSync(join(nativeHome,"SOUL.md"),"utf8"))},memoryBytes:0,runtimeProfile:"base"};}
  }
  const adapter=new ExistingAdapter();registry.register(adapter);
  const tc=new TestConn({store,registry,workspaceRoot:root,tenantId:"owner",policy:{allowEmployeeProfiles:true}});
  try{
    const input={...spec(),profileBinding:{kind:"harness"},documents:{soul:"Per-DE identity",agents:"",user:"",tools:""}};
    await assert.rejects(tc.call("employee.profile.apply",{...input,documents:{...input.documents,agents:"Must not be silently ignored"}}));
    const first=await tc.call("employee.profile.apply",input) as any,second=await tc.call("employee.profile.apply",{...input,employeeId:randomUUID(),name:"Second"}) as any;
    assert.equal(first.state,"ready");assert.equal(second.state,"ready");assert.equal(first.runtimeProfile,"base");
    assert.notEqual(first.privateWorkspace.path,second.privateWorkspace.path);assert.equal(adapter.targets.size,0);
    assert.equal(readFileSync(join(nativeHome,"SOUL.md"),"utf8"),"Existing native identity");
    writeFileSync(join(nativeHome,"SOUL.md"),"Native operator update");
    assert.equal((await tc.call("employee.profile.status",{employeeId:input.employeeId}) as any).state,"ready");
    adapter.home=join(root,"replacement");
    assert.equal((await tc.call("employee.profile.status",{employeeId:input.employeeId}) as any).state,"failed");
    await assert.rejects(tc.call("employee.profile.apply",{...input,revision:2,profileBinding:undefined}));
  }finally{await tc.conn.dispose();store.close();rmSync(root,{recursive:true,force:true});}
});

test("existing OpenClaw binding only reads the selected native agent and preserves its documents",async()=>{
  const root=realpathSync(mkdtempSync(join(tmpdir(),"phonon-openclaw-bind-"))),calls:string[]=[];
  const adapter=new OpenClawGatewayAdapter({gateway:{baseUrl:"ws://127.0.0.1:1",token:"test"}});
  (adapter as any).gw={connect:async()=>{},rpc:async(method:string,params:any)=>{
    calls.push(method);
    if(method==="agents.list")return {agents:[{id:"existing",workspace:root}]};
    if(method==="agents.files.get"){assert.equal(params.agentId,"existing");return {workspace:root,file:{content:params.name==="MEMORY.md"?"Shared native memory":"Native document"}};}
    throw new Error("must not mutate existing native profile");
  }};
  try{
    const result=await adapter.inspectHarnessProfile("openclaw:existing");
    assert.equal(result.home,root);assert.equal(result.runtimeProfile,"existing");assert.equal(result.memoryBytes,Buffer.byteLength("Shared native memory"));
    assert.ok(calls.every(method=>["agents.list","agents.files.get"].includes(method)));
    await assert.rejects(adapter.inspectHarnessProfile("openclaw:missing"));
  }finally{rmSync(root,{recursive:true,force:true});}
});

test("installed Hermes existing-profile inspection does not create profiles or rewrite native identity",async t=>{
  const bin=process.env.PHONON_TEST_HERMES_BIN;
  if(!bin||process.platform==="win32"){t.skip("Explicit installed POSIX Hermes runtime required");return;}
  const root=realpathSync(mkdtempSync(join(tmpdir(),"phonon-hermes-existing-"))),old=process.env.HERMES_HOME;process.env.HERMES_HOME=root;
  try{
    writeFileSync(join(root,"config.yaml"),"model:\n  default: m1\n");writeFileSync(join(root,"SOUL.md"),"Native identity, not DE identity");
    mkdirSync(join(root,"memories"));writeFileSync(join(root,"memories","MEMORY.md"),"Shared native memory");
    const adapter=new HermesAdapter({env:{binPath:bin}}),result=await adapter.inspectHarnessProfile("hermes:default");
    assert.equal(result.home,root);assert.equal(result.runtimeProfile,"default");assert.equal(result.memoryBytes,Buffer.byteLength("Shared native memory"));
    assert.equal(result.documentHashes["SOUL.md"],hash("Native identity, not DE identity"));assert.equal(existsSync(join(root,"profiles")),false);
    rmSync(join(root,"SOUL.md"));symlinkSync(join(root,"config.yaml"),join(root,"SOUL.md"));
    await assert.rejects(adapter.inspectHarnessProfile("hermes:default"));
  }finally{if(old===undefined)delete process.env.HERMES_HOME;else process.env.HERMES_HOME=old;rmSync(root,{recursive:true,force:true});}
});
