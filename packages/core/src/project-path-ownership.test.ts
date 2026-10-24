import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,realpathSync,rmSync,symlinkSync} from "node:fs";
import {tmpdir} from "node:os";
import {join,dirname} from "node:path";
import {PhononConnection} from "./index.js";
import {PhononStore} from "./store.js";
import {AdapterRegistry} from "./session-engine.js";
import {DatabaseSync} from "node:sqlite";
import {spawnSync,execFileSync} from "node:child_process";

function fixture(){
  const root=realpathSync(mkdtempSync(join(tmpdir(),"phonon-project-ownership-"))),db=join(root,"native.db"),store=new PhononStore(db),stores=[store],connections:PhononConnection[]=[];
  let sequence=0;
  const connect=(namespace:string,data=store)=>{
    const messages:Array<Record<string,any>>=[],connection=new PhononConnection({tenantId:namespace,registry:new AdapterRegistry(),store:data,workspaceRoot:root,
      transport:{send:message=>messages.push(JSON.parse(message)),close:()=>{}}});connections.push(connection);
    return {connection,async call(method:string,params:unknown){const id=++sequence;await connection.handle(JSON.stringify({jsonrpc:"2.0",id,method,params}));const response=messages.find(row=>row.id===id);assert.ok(response);return response;}};
  };
  return {root,db,store,connect,reopen(){const opened=new PhononStore(db);stores.push(opened);return opened;},
    async close(){for(const connection of connections)await connection.dispose();for(const opened of stores)opened.close();rmSync(root,{recursive:true,force:true});}};
}

test("same display names in two authenticated namespaces create disjoint physical workspaces",async()=>{
  const f=fixture();try{
    const a=f.connect("account-a"),b=f.connect("account-b"),args={name:"Same display name",git:false};
    const first=(await a.call("project.create",args)).result.project;writeFileSync(join(first.path,"private.txt"),"Account A only");
    const second=(await b.call("project.create",args)).result.project;
    assert.notEqual(first.path,second.path);assert.equal(existsSync(join(second.path,"private.txt")),false);
    assert.equal(first.name,args.name);assert.equal(second.name,args.name);
    assert.equal(readFileSync(join(first.path,"private.txt"),"utf8"),"Account A only");
  }finally{await f.close();}
});

test("an explicit directory, its child, its parent and its symlink alias cannot acquire a second namespace",async()=>{
  const f=fixture();try{
    const a=f.connect("account-a"),b=f.connect("account-b"),path=join(f.root,"explicit","original");
    const first=(await a.call("project.create",{name:"Original",path,git:false})).result.project;writeFileSync(join(first.path,"private.txt"),"Preserved");
    const alias=join(f.root,"alias");symlinkSync(first.path,alias,process.platform==="win32"?"junction":"dir");
    for(const path of [first.path,join(first.path,"child"),dirname(first.path),alias]){
      const result=await b.call("project.create",{name:"Must not adopt",path,git:false});assert.equal(result.error?.data?.appCode,"errPolicyDenied");
    }
    assert.equal(existsSync(join(first.path,"child")),false);assert.equal(readFileSync(join(first.path,"private.txt"),"utf8"),"Preserved");
    assert.equal((await b.call("project.create",{name:"Sibling",path:join(f.root,"explicit-other"),git:false})).result.project.namespace,"account-b");
  }finally{await f.close();}
});

test("removing a Project record does not transfer its remaining files to a new account after store reopen",async()=>{
  const f=fixture();try{
    const a=f.connect("account-a"),path=join(f.root,"retained"),created=(await a.call("project.create",{name:"Retained files",path,git:false})).result.project;
    writeFileSync(join(path,"private.txt"),"Do not adopt");assert.equal((await a.call("project.remove",{projectId:created.projectId})).result.filesDeleted,false);
    const b=f.connect("account-b",f.reopen()),result=await b.call("project.create",{name:"Different account",path,git:false});
    assert.equal(result.error?.data?.appCode,"errPolicyDenied");assert.equal(readFileSync(join(path,"private.txt"),"utf8"),"Do not adopt");
    assert.equal((await a.call("project.create",{name:"Owner reopens",path,git:false})).result.project.namespace,"account-a");
  }finally{await f.close();}
});

test("racing registrations from two namespaces produce one owner, never two aliases",async()=>{
  const f=fixture();try{
    const a=f.connect("account-a"),b=f.connect("account-b",f.reopen()),path=join(f.root,"race");
    const results=await Promise.all([a.call("project.create",{name:"A",path,git:false}),b.call("project.create",{name:"B",path,git:false})]);
    assert.equal(results.filter(row=>row.result).length,1);assert.equal(results.filter(row=>row.error?.data?.appCode==="errPolicyDenied").length,1);
    assert.equal(f.store.loadProjects().filter(row=>row.path===path).length,1);
  }finally{await f.close();}
});

test("namespace administration folders cannot be registered as ordinary Projects",async()=>{
  const f=fixture();try{
    const a=f.connect("account-a"),b=f.connect("account-b"),created=(await a.call("project.create",{name:"Display name",git:false})).result.project;
    for(const [actor,path] of [[a,dirname(created.path)],[b,dirname(created.path)],[b,join(f.root,".namespaces")],[b,f.root]] as const)
      assert.equal((await actor.call("project.create",{name:"Container takeover",path,git:false})).error?.data?.appCode,"errPolicyDenied");
    const odd=(await b.call("project.create",{name:"../Display / arbitrary name",git:false})).result.project;
    assert.equal(odd.name,"../Display / arbitrary name");assert.equal(odd.path.includes("arbitrary name"),false);
  }finally{await f.close();}
});

test("unmapped legacy records and ambiguous historical paths are preserved but not granted to remote accounts",async()=>{
  const f=fixture();try{
    const path=join(f.root,"legacy");mkdirSync(path);writeFileSync(join(path,"private.txt"),"Unmapped content");
    f.store.upsertProject({projectId:"legacy",name:"Unmapped",path,git:false,createdAt:new Date().toISOString()});
    const a=f.connect("account-a"),b=f.connect("account-b");
    for(const actor of [a,b]){
      assert.deepEqual((await actor.call("project.list",{})).result.projects,[]);
      assert.equal((await actor.call("project.get",{projectId:"legacy"})).error?.data?.appCode,"errProjectNotFound");
      assert.equal((await actor.call("project.create",{name:"Do not adopt legacy",path,git:false})).error?.data?.appCode,"errPolicyDenied");
    }
    const metadata=f.store.loadProjects().find(row=>row.projectId==="legacy")!;assert.equal(metadata.namespace,undefined);assert.equal(metadata.path,path);
    const current=(await a.call("project.create",{name:"Actual owner",git:false})).result.project;
    const db=new DatabaseSync(f.db);try{db.prepare("INSERT INTO projects(project_id,name,path,git,created_at,namespace) VALUES('old-conflict','Preserved',?,0,?,'account-b')").run(current.path,new Date().toISOString());}finally{db.close();}
    assert.equal((await a.call("project.get",{projectId:current.projectId})).error?.data?.appCode,"errPolicyDenied");
    assert.equal((await b.call("project.get",{projectId:"old-conflict"})).error?.data?.appCode,"errPolicyDenied");
    assert.equal(readFileSync(join(path,"private.txt"),"utf8"),"Unmapped content");assert.equal(f.store.loadProjects().length,3);
  }finally{await f.close();}
});

test("path reservations are durable before filesystem mutation and failed creation never transfers them",async()=>{
  const f=fixture();try{
    const path=join(f.root,"blocked");writeFileSync(path,"Existing non-directory");
    const a=f.connect("account-a"),failed=await a.call("project.create",{name:"Cannot create",path,git:false});assert.ok(failed.error);
    assert.equal(f.store.loadProjects().length,0);assert.equal(readFileSync(path,"utf8"),"Existing non-directory");
    const inspect=new DatabaseSync(f.db);try{const row=inspect.prepare("SELECT namespace,path FROM project_path_owners WHERE path=?").get(path);assert.deepEqual(row&&{...row},{namespace:"account-a",path});}finally{inspect.close();}
    const b=f.connect("account-b",f.reopen());assert.equal((await b.call("project.create",{name:"Cannot steal partial intent",path,git:false})).error?.data?.appCode,"errPolicyDenied");
    assert.equal(readFileSync(path,"utf8"),"Existing non-directory");
  }finally{await f.close();}
});

test("worktree directories and removal remain bound to the actual owning Project and namespace",{skip:spawnSync("git",["--version"]).status!==0},async()=>{
  const f=fixture();try{
    const a=f.connect("account-a"),b=f.connect("account-b");
    const pa=(await a.call("project.create",{name:"A",path:join(f.root,"git-a"),git:true})).result.project;
    const pb=(await b.call("project.create",{name:"B",git:true})).result.project;
    for(const project of [pa,pb])execFileSync("git",["-C",project.path,"-c","user.name=fixture","-c","user.email=fixture@example.test","-c","commit.gpgSign=false","-c",`core.hooksPath=${join(f.root,"no-hooks")}`,"commit","--allow-empty","-m","Fixture"],{stdio:"ignore"});
    const base=execFileSync("git",["-C",pa.path,"branch","--show-current"],{encoding:"utf8"}).trim();
    const created=await a.call("project.worktree.create",{projectId:pa.projectId,baseBranch:base,newBranch:"owned-a",path:join(f.root,"explicit-worktree")});
    assert.ok(created.result?.worktree,JSON.stringify(created));const wt=created.result.worktree;writeFileSync(join(wt.path,"private.txt"),"Owner A worktree");
    assert.equal((await b.call("project.create",{name:"Not a new Project",path:wt.path,git:false})).error?.data?.appCode,"errPolicyDenied");
    const otherBase=execFileSync("git",["-C",pb.path,"branch","--show-current"],{encoding:"utf8"}).trim();
    assert.equal((await b.call("project.worktree.create",{projectId:pb.projectId,baseBranch:otherBase,newBranch:"must-not-create",path:wt.path})).error?.data?.appCode,"errPolicyDenied");
    assert.equal((await b.call("project.worktree.remove",{projectId:pb.projectId,worktreeId:wt.worktreeId,force:true})).error?.data?.appCode,"errWorktreeNotFound");
    assert.equal(readFileSync(join(wt.path,"private.txt"),"utf8"),"Owner A worktree");
    assert.ok((await a.call("project.worktree.remove",{projectId:pa.projectId,worktreeId:wt.worktreeId,force:true})).result);
    assert.equal((await b.call("project.create",{name:"Removed metadata is not a transfer",path:wt.path,git:false})).error?.data?.appCode,"errPolicyDenied");
  }finally{await f.close();}
});
