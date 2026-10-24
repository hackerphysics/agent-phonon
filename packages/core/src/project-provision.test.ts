import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,realpathSync,mkdirSync,readFileSync,writeFileSync,rmSync,renameSync,existsSync,lstatSync,symlinkSync,chmodSync,linkSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {randomUUID,createHash} from "node:crypto";
import {DatabaseSync} from "node:sqlite";
import {ProjectProvisionParams,ProjectProvisionStatusResult,TenantPolicy} from "@agent-phonon/protocol";
import {PhononConnection,PhononStore,AdapterRegistry} from "./index.js";
import {NativeFileBroker,NativeFileBrokerError,type NativeFileRequest} from "./native-file-broker.js";
import {PolicyEnforcer} from "./policy.js";
import {ProjectProvisionLedger} from "./project-provision-ledger.js";
import {requestFingerprint} from "./idempotency.js";
import {workspacePathKey} from "./workspace-paths.js";

const binary=process.env.PHONON_EXCLUSIVE_MKDIR_TEST_BINARY;
const localTest=(name:string,fn:()=>Promise<void>)=>test(name,{skip:!binary?"Prepared local directory-only C helper required":false},fn);
function fixture(){
  const base=realpathSync(mkdtempSync(join(tmpdir(),"phonon-project-provision-test-"))),root=join(base,"work"),database=join(base,"native.db");
  mkdirSync(root);writeFileSync(join(base,"owner.json"),JSON.stringify({pid:process.pid,purpose:"project-provision"}));
  if(binary)assert.equal(createHash("sha256").update(readFileSync(binary)).digest("hex"),process.env.PHONON_EXCLUSIVE_MKDIR_TEST_SHA256);
  const broker=new NativeFileBroker("test-only-no-runtime-manifest");Object.defineProperty(broker,"binary",{value:async()=>binary});
  const stores=[new PhononStore(database)],connections:PhononConnection[]=[],calls:Array<NativeFileRequest>=[];
  const original=broker.call.bind(broker);broker.call=async value=>{calls.push(structuredClone(value));return original(value);};let sequence=0;
  function actor(tenant="account-a",policy:Record<string,unknown>={allowProjectProvision:true},store=stores[0]!){
    const replies:Array<Record<string,any>>=[];
    const connection=new PhononConnection({tenantId:tenant,store,registry:new AdapterRegistry(),workspaceRoot:root,nativeFileBroker:broker,policy,
      transport:{send:text=>replies.push(JSON.parse(text)),close:()=>{}}});connections.push(connection);
    return {connection,async call(method:string,params:unknown){const id=++sequence;await connection.handle(JSON.stringify({jsonrpc:"2.0",id,method,params}));const reply=replies.find(value=>value.id===id);assert.ok(reply);return reply;},
      async input(){const info=(await this.call("device.info",{})).result;assert.ok(info.capabilities.includes("project_provision_v1"));return {clientRequestId:randomUUID(),name:"Managed test workspace",expectedReceiverID:info.projectProvisionReceiverID};}};
  }
  return {base,root,database,broker,calls,actor,store:stores[0]!,reopen(){const store=new PhononStore(database);stores.push(store);return store;},
    async close(){for(const connection of connections)await connection.dispose();for(const store of stores)store.close();const owner=JSON.parse(readFileSync(join(base,"owner.json"),"utf8"));assert.equal(owner.pid,process.pid);rmSync(base,{recursive:true,force:true});}};
}
test("controlled provisioning accepts exact references only and is never implied by local trust",()=>{
  const input={clientRequestId:randomUUID(),name:"Owned workspace",expectedReceiverID:randomUUID()};assert.deepEqual(ProjectProvisionParams.parse(input),input);
  for(const patch of[{path:"/other"},{remote:"https://example.test/repo"},{git:true},{owner:"other"},{approve:true}])assert.equal(ProjectProvisionParams.safeParse({...input,...patch}).success,false);
  assert.equal(TenantPolicy.parse({}).allowProjectProvision,false);
  assert.throws(()=>new PolicyEnforcer({trustLocal:true}).assertProjectProvision(),/explicit local permission/);
});
localTest("one exact operation creates one private owned project and survives reopen without new filesystem mutation",async()=>{
  const f=fixture();try{
    const a=f.actor(),input=await a.input(),reply=await a.call("project.provision",input);assert.ok(reply.result,JSON.stringify(reply));
    const result=ProjectProvisionStatusResult.parse(reply.result);assert.equal(result.state,"confirmed");if(result.state!=="confirmed")return;
    assert.equal(result.project.namespace,"account-a");assert.equal(result.project.git,false);assert.ok(result.project.path.startsWith(f.root+"/managed-"));assert.equal(existsSync(join(result.project.path,".git")),false);
    writeFileSync(join(result.project.path,"keep.txt"),"Actual user work");
    assert.deepEqual((await a.call("project.provision",input)).result,result);
    await a.connection.dispose();const next=f.actor("account-a",{allowProjectProvision:true},f.reopen());
    assert.deepEqual((await next.call("project.provision.status",{clientRequestId:input.clientRequestId,expectedReceiverID:input.expectedReceiverID})).result,result);
    assert.deepEqual((await next.call("project.provision",input)).result,result);
    assert.equal(f.calls.filter(value=>value.operation==="mkdir_new").length,1);assert.equal(readFileSync(join(result.project.path,"keep.txt"),"utf8"),"Actual user work");
  }finally{await f.close();}
});
localTest("two controllers claim a single dispatch for one request while retaining the original directory",async()=>{
  const f=fixture();try{
    const a=f.actor(),b=f.actor(),input=await a.input();const result=await Promise.all([a.call("project.provision",input),b.call("project.provision",input)]);
    assert.ok(result.every(value=>value.result),JSON.stringify(result));assert.ok(result.some(value=>value.result.state==="confirmed"));
    assert.equal(f.calls.filter(value=>value.operation==="mkdir_new").length,1);
    assert.equal((await a.call("project.provision.status",{clientRequestId:input.clientRequestId,expectedReceiverID:input.expectedReceiverID})).result.state,"confirmed");
  }finally{await f.close();}
});
localTest("only an identical still-prepared operation may claim its original target after restart; status does not create it",async()=>{
  const f=fixture();try{
    const a=f.actor(),input=await a.input(),projectID="managed-"+randomUUID(),path=join(f.root,projectID),rootStat=lstatSync(f.root,{bigint:true}),native=await f.broker.call({operation:"root",root:f.root});
    assert.ok("identity" in native);
    const ledger=new ProjectProvisionLedger(f.database+".projects.sqlite");
    try{ledger.prepare({tenant:"account-a",request_id:input.clientRequestId,request_hash:requestFingerprint(input),receiver_id:input.expectedReceiverID,name:input.name,project_id:projectID,
      root:f.root,root_identity:native.identity,root_node_identity:`${rootStat.dev.toString(16)}:${rootStat.ino.toString(16)}`,path,path_key:workspacePathKey(path),created_at:new Date().toISOString()});}finally{ledger.close();}
    await a.connection.dispose();const b=f.actor("account-a",{allowProjectProvision:true},f.reopen());
    assert.equal((await b.call("project.provision.status",{clientRequestId:input.clientRequestId,expectedReceiverID:input.expectedReceiverID})).result.state,"prepared");
    assert.equal(existsSync(path),false);assert.equal((await b.call("project.provision",{...input,name:"different"})).error?.data?.appCode,"errInvalidParams");
    const result=(await b.call("project.provision",input)).result;assert.equal(result.state,"confirmed");assert.equal(result.project.projectId,projectID);assert.equal(result.project.path,path);
    assert.equal(f.calls.filter(value=>value.operation==="mkdir_new").length,1);
  }finally{await f.close();}
});
localTest("same IDs and receiver references cannot lend another account an operation, project or physical directory",async()=>{
  const f=fixture();try{
    const a=f.actor(),b=f.actor("account-b"),input=await a.input(),created=(await a.call("project.provision",input)).result,other=await b.input();
    assert.notEqual(other.expectedReceiverID,input.expectedReceiverID);
    assert.equal((await b.call("project.provision.status",{clientRequestId:input.clientRequestId,expectedReceiverID:input.expectedReceiverID})).error?.data?.appCode,"errProjectProvisionChanged");
    assert.equal((await b.call("project.provision.status",{clientRequestId:input.clientRequestId,expectedReceiverID:other.expectedReceiverID})).result.state,"not_found");
    assert.equal((await b.call("project.get",{projectId:created.project.projectId})).error?.data?.appCode,"errProjectNotFound");
    assert.ok((await b.call("project.create",{name:"Steal",path:created.project.path,git:false})).error);
    assert.equal((await a.call("project.provision",{...input,name:"Changed retry"})).error?.data?.appCode,"errInvalidParams");
  }finally{await f.close();}
});
localTest("policy withdrawal, receiver replacement and method denial block cached and new operations",async()=>{
  const f=fixture();try{
    const a=f.actor(),input=await a.input();assert.equal((await a.call("project.provision",input)).result.state,"confirmed");
    const denied=f.actor("account-a",{});assert.equal((await denied.call("project.provision",input)).error?.data?.appCode,"errPolicyDenied");
    assert.equal((await denied.call("project.provision.status",{clientRequestId:input.clientRequestId,expectedReceiverID:input.expectedReceiverID})).error?.data?.appCode,"errPolicyDenied");
    const readOnly=f.actor("account-a",{allowProjectProvision:true,allowedMethods:["device.info","project.provision.status"]});
    assert.equal((await readOnly.call("project.provision",input)).error?.data?.appCode,"errPolicyDenied");
    assert.equal((await a.call("project.provision",{...input,expectedReceiverID:randomUUID()})).error?.data?.appCode,"errProjectProvisionChanged");
    assert.equal(f.calls.filter(value=>value.operation==="mkdir_new").length,1);
  }finally{await f.close();}
});
localTest("a lost mkdir acknowledgement keeps uncertainty across reconnect without registration, replay or adoption",async()=>{
  const f=fixture();try{
    const a=f.actor(),input=await a.input(),call=f.broker.call.bind(f.broker);let path="";
    f.broker.call=async value=>{if(value.operation==="mkdir_new"){await call(value);path=join(value.root!,value.path!);throw new NativeFileBrokerError("transport_unconfirmed",true);}return call(value);};
    assert.ok((await a.call("project.provision",input)).error);assert.ok(existsSync(path));writeFileSync(join(path,"unknown.txt"),"Preserve uncertain contents");
    await a.connection.dispose();const next=f.actor("account-a",{allowProjectProvision:true},f.reopen());
    assert.equal((await next.call("project.provision.status",{clientRequestId:input.clientRequestId,expectedReceiverID:input.expectedReceiverID})).result.state,"unknown");
    assert.equal((await next.call("project.provision",input)).result.state,"unknown");
    assert.ok((await next.call("project.create",{name:"Adopt unknown",path,git:false})).error);
    assert.ok((await next.call("project.create",{name:"Adopt ancestor",path:f.root,git:false})).error);
    assert.equal(f.store.loadProjects().length,0);assert.equal(f.calls.filter(value=>value.operation==="mkdir_new").length,1);
    assert.equal(readFileSync(join(path,"unknown.txt"),"utf8"),"Preserve uncertain contents");
  }finally{await f.close();}
});
localTest("only an observed original receipt can recover metadata registration without another mkdir",async()=>{
  const f=fixture();try{
    const a=f.actor(),input=await a.input(),projects=(a.connection as any).projects,original=projects.registerPrepared.bind(projects);
    projects.registerPrepared=()=>{throw Error("Controlled metadata commit failure");};assert.ok((await a.call("project.provision",input)).error);projects.registerPrepared=original;
    const result=(await a.call("project.provision.status",{clientRequestId:input.clientRequestId,expectedReceiverID:input.expectedReceiverID})).result;
    assert.equal(result.state,"confirmed");assert.equal(f.store.loadProjects().length,1);assert.equal(f.calls.filter(value=>value.operation==="mkdir_new").length,1);
  }finally{await f.close();}
});
localTest("competing preexisting targets fail known-refused and remain preserved without claiming a project",async()=>{
  const f=fixture();try{
    const a=f.actor(),input=await a.input(),call=f.broker.call.bind(f.broker);let path="";
    f.broker.call=async value=>{if(value.operation==="mkdir_new"){path=join(value.root!,value.path!);mkdirSync(path);writeFileSync(join(path,"keep.txt"),"Competing human directory");}return call(value);};
    assert.ok((await a.call("project.provision",input)).error);
    assert.equal((await a.call("project.provision.status",{clientRequestId:input.clientRequestId,expectedReceiverID:input.expectedReceiverID})).result.state,"failed");
    assert.equal((await a.call("project.provision",input)).result.state,"failed");assert.equal(readFileSync(join(path,"keep.txt"),"utf8"),"Competing human directory");assert.equal(f.store.loadProjects().length,0);
  }finally{await f.close();}
});
localTest("confirmed directory replacement is refused by status, ordinary project reads and new project adoption",async()=>{
  const f=fixture();try{
    const a=f.actor(),input=await a.input(),created=(await a.call("project.provision",input)).result;
    renameSync(created.project.path,created.project.path+"-original");mkdirSync(created.project.path);writeFileSync(join(created.project.path,"keep.txt"),"Replacement human tree");
    assert.ok((await a.call("project.provision.status",{clientRequestId:input.clientRequestId,expectedReceiverID:input.expectedReceiverID})).error);
    assert.ok((await a.call("project.get",{projectId:created.project.projectId})).error);
    assert.ok((await a.call("project.create",{name:"Adopt replaced",path:created.project.path,git:false})).error);
    assert.equal(readFileSync(join(created.project.path,"keep.txt"),"utf8"),"Replacement human tree");
  }finally{await f.close();}
});
localTest("missing provision metadata after restart cannot turn a retained managed directory into a new ordinary project",async()=>{
  const f=fixture();try{
    const a=f.actor(),input=await a.input(),created=(await a.call("project.provision",input)).result;
    await a.connection.dispose();renameSync(f.database+".projects.sqlite",f.database+".projects.sqlite-preserved");
    const next=f.actor("account-a",{allowProjectProvision:true},f.reopen());
    assert.equal((await next.call("project.get",{projectId:created.project.projectId})).error?.data?.appCode,"errProjectProvisionChanged");
    assert.equal((await next.call("project.create",{name:"Borrow missing history",path:created.project.path,git:false})).error?.data?.appCode,"errProjectProvisionChanged");
    const info=(await next.call("device.info",{})).result;assert.notEqual(info.projectProvisionReceiverID,input.expectedReceiverID);
    assert.equal((await next.call("project.provision.status",{clientRequestId:input.clientRequestId,expectedReceiverID:input.expectedReceiverID})).error?.data?.appCode,"errProjectProvisionChanged");
    assert.ok(existsSync(created.project.path));
  }finally{await f.close();}
});
localTest("SQLite immutable identities and monotonic dispatch evidence cannot be reset for automatic replay",async()=>{
  const f=fixture();try{
    const a=f.actor(),input=await a.input();assert.equal((await a.call("project.provision",input)).result.state,"confirmed");
    const db=new DatabaseSync(f.database+".projects.sqlite");try{
      for(const sql of["UPDATE operations SET state='prepared',claim=NULL","UPDATE operations SET path='/other'","UPDATE operations SET workspace_identity='p:1:2'","DELETE FROM operations","DELETE FROM receivers","UPDATE roots SET identity='p:1:2'"])
        assert.throws(()=>db.exec(sql),/immutable|replay|retained/);
    }finally{db.close();}
  }finally{await f.close();}
});
localTest("a configured root already covered by an ordinary Project is never implicitly nested or adopted",async()=>{
  const f=fixture();try{
    f.store.upsertProject({projectId:"existing-root",name:"Existing user workspace",path:f.root,namespace:"account-a",git:false,createdAt:new Date().toISOString()});
    const a=f.actor();assert.ok((await a.call("project.get",{projectId:"existing-root"})).result);
    const input=await a.input();assert.equal((await a.call("project.provision",input)).error?.data?.appCode,"errProjectExists");assert.equal(f.calls.filter(value=>value.operation==="mkdir_new").length,0);
  }finally{await f.close();}
});
localTest("removing a confirmed project does not allow the old request or status to recreate its registry metadata",async()=>{
  const f=fixture();try{
    const a=f.actor(),input=await a.input(),created=(await a.call("project.provision",input)).result;
    const removed=await a.call("project.remove",{projectId:created.project.projectId,deleteFiles:false});assert.ok(removed.result,JSON.stringify(removed));
    assert.equal((await a.call("project.provision",input)).error?.data?.appCode,"errProjectNotFound");
    assert.equal((await a.call("project.provision.status",{clientRequestId:input.clientRequestId,expectedReceiverID:input.expectedReceiverID})).error?.data?.appCode,"errProjectNotFound");
    assert.ok(existsSync(created.project.path));assert.equal(f.store.loadProjects().length,0);assert.equal(f.calls.filter(value=>value.operation==="mkdir_new").length,1);
  }finally{await f.close();}
});
localTest("filesystem writes that outlive controller disposal remain unregistered unknown results",async()=>{
  const f=fixture();let release!:()=>void,work:Promise<any>|undefined;try{
    const a=f.actor(),input=await a.input(),call=f.broker.call.bind(f.broker);let entered!:()=>void;
    const ready=new Promise<void>(done=>entered=done),gate=new Promise<void>(done=>release=done);
    f.broker.call=async request=>{const result=await call(request);if(request.operation==="mkdir_new"){entered();await gate;}return result;};
    work=a.call("project.provision",input);await ready;const closed=a.connection.dispose();release();await closed;assert.ok((await work).error);
    const next=f.actor("account-a",{allowProjectProvision:true},f.reopen());
    assert.equal((await next.call("project.provision.status",{clientRequestId:input.clientRequestId,expectedReceiverID:input.expectedReceiverID})).result.state,"unknown");
    assert.equal(f.store.loadProjects().length,0);assert.equal(f.calls.filter(value=>value.operation==="mkdir_new").length,1);
  }finally{release?.();await work?.catch(()=>{});await f.close();}
});
localTest("a capability probe that finishes after disposal cannot reopen or create a provision ledger",async()=>{
  const f=fixture();let release!:()=>void,work:Promise<any>|undefined;try{
    const a=f.actor(),call=f.broker.call.bind(f.broker);let entered!:()=>void;
    const ready=new Promise<void>(done=>entered=done),gate=new Promise<void>(done=>release=done);
    f.broker.call=async request=>{const result=await call(request);if(request.operation==="probe"&&request.extendedProbe){entered();await gate;}return result;};
    work=a.call("device.info",{});await ready;await a.connection.dispose();release();await work;
    assert.equal(existsSync(f.database+".projects.sqlite"),false);
  }finally{release?.();await work?.catch(()=>{});await f.close();}
});
test("provision ledgers refuse symbolic links and replaced persistent files instead of lending a stale receiver identity",{skip:process.platform==="win32"},()=>{
  const base=realpathSync(mkdtempSync(join(tmpdir(),"phonon-provision-ledger-"))),path=join(base,"ledger.sqlite");let ledger:ProjectProvisionLedger|undefined;
  try{
    ledger=new ProjectProvisionLedger(path);const receiver=ledger.receiver("owner");assert.ok(receiver);
    renameSync(path,path+"-original");writeFileSync(path,"Replacement file");assert.throws(()=>ledger!.receiver("owner"),/ledger was replaced/);ledger.close();ledger=undefined;
    rmSync(path);symlinkSync(path+"-original",path);assert.throws(()=>new ProjectProvisionLedger(path),/privately owned/);
    assert.equal(readFileSync(path+"-original").subarray(0,6).toString(),"SQLite");
  }finally{ledger?.close();rmSync(base,{recursive:true,force:true});}
});
test("provision ledgers reject linked SQLite auxiliary files before opening their contents",{skip:process.platform==="win32"},()=>{
  const base=realpathSync(mkdtempSync(join(tmpdir(),"phonon-provision-sidecar-"))),path=join(base,"ledger.sqlite"),foreign=join(base,"keep.txt");
  try{
    writeFileSync(foreign,"Original foreign bytes");symlinkSync(foreign,path+"-wal");
    assert.throws(()=>new ProjectProvisionLedger(path),/auxiliary file is not privately owned/);
    assert.equal(readFileSync(foreign,"utf8"),"Original foreign bytes");
  }finally{rmSync(base,{recursive:true,force:true});}
});
test("provision ledgers recheck private permissions during access and cannot resume a compromised controller",{skip:process.platform==="win32"},()=>{
  const base=realpathSync(mkdtempSync(join(tmpdir(),"phonon-provision-permissions-"))),path=join(base,"ledger.sqlite");let ledger:ProjectProvisionLedger|undefined;
  try{
    ledger=new ProjectProvisionLedger(path);const receiver=ledger.receiver("owner");chmodSync(path,0o644);
    assert.throws(()=>ledger!.receiver("owner"),/not privately owned/);chmodSync(path,0o600);
    assert.throws(()=>ledger!.get("owner",randomUUID()),/ledger security changed/);ledger.close();ledger=undefined;
    ledger=new ProjectProvisionLedger(path);assert.equal(ledger.receiver("owner"),receiver);
  }finally{if(existsSync(path))chmodSync(path,0o600);ledger?.close();rmSync(base,{recursive:true,force:true});}
});
for(const suffix of["-wal","-shm","-journal"])test(`provision ledgers recheck private permissions on a late ${suffix} file`,{skip:process.platform==="win32"},()=>{
  const base=realpathSync(mkdtempSync(join(tmpdir(),"phonon-provision-sidecar-mode-"))),path=join(base,"ledger.sqlite"),side=path+suffix;let ledger:ProjectProvisionLedger|undefined;
  try{
    ledger=new ProjectProvisionLedger(path);ledger.receiver("owner");
    if(!existsSync(side))writeFileSync(side,"",{mode:0o600});chmodSync(side,0o644);
    assert.throws(()=>ledger!.project("owner","unknown"),/auxiliary file is not privately owned/);chmodSync(side,0o600);
    assert.throws(()=>ledger!.receiver("owner"),/ledger security changed/);
  }finally{if(existsSync(side))chmodSync(side,0o600);ledger?.close();rmSync(base,{recursive:true,force:true});}
});
for(const suffix of["-wal","-shm","-journal"])test(`provision ledgers refuse a late linked ${suffix} file before any receipt access`,{skip:process.platform==="win32"},()=>{
  const base=realpathSync(mkdtempSync(join(tmpdir(),"phonon-provision-sidecar-runtime-"))),path=join(base,"ledger.sqlite"),foreign=join(base,"keep.txt"),side=path+suffix,saved=side+"-saved";
  let ledger:ProjectProvisionLedger|undefined;
  try{
    ledger=new ProjectProvisionLedger(path);ledger.receiver("owner");writeFileSync(foreign,"Unrelated retained contents",{mode:0o600});
    if(existsSync(side))renameSync(side,saved);symlinkSync(foreign,side);
    assert.throws(()=>ledger!.get("owner",randomUUID()),/auxiliary file is not privately owned/);
    assert.equal(readFileSync(foreign,"utf8"),"Unrelated retained contents");
    rmSync(side);if(existsSync(saved))renameSync(saved,side);
    assert.throws(()=>ledger!.receiver("owner"),/ledger security changed/);
  }finally{if(existsSync(saved)){rmSync(side,{force:true});renameSync(saved,side);}ledger?.close();rmSync(base,{recursive:true,force:true});}
});
test("provision ledgers refuse a late hardlink without changing unrelated contents",{skip:process.platform==="win32"},()=>{
  const base=realpathSync(mkdtempSync(join(tmpdir(),"phonon-provision-hardlink-"))),path=join(base,"ledger.sqlite"),alias=join(base,"ledger-alias");let ledger:ProjectProvisionLedger|undefined;
  try{
    ledger=new ProjectProvisionLedger(path);ledger.receiver("owner");linkSync(path,alias);
    assert.throws(()=>ledger!.overlapping("/unrelated"),/not privately owned/);rmSync(alias);
    assert.throws(()=>ledger!.receiver("owner"),/ledger security changed/);
  }finally{rmSync(alias,{force:true});ledger?.close();rmSync(base,{recursive:true,force:true});}
});
if(process.platform==="win32")test("Windows unqualified ledger refuses before creating a file even through direct construction",()=>{
  const base=realpathSync(mkdtempSync(join(tmpdir(),"phonon-provision-unsupported-"))),path=join(base,"ledger.sqlite");
  try{
    assert.throws(()=>new ProjectProvisionLedger(path),/ACL handling is not yet qualified/);assert.equal(existsSync(path),false);
  }finally{rmSync(base,{recursive:true,force:true});}
});
