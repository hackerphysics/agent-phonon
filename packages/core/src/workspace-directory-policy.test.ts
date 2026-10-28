import test from "node:test";
import assert from "node:assert/strict";
import {mkdirSync,writeFileSync,readFileSync} from "node:fs";
import {join} from "node:path";
import {PhononConnection} from "./index.js";
import {PhononStore} from "./store.js";
import {AdapterRegistry} from "./session-engine.js";
import {withPeerFixture} from "./testing/peer-fixture.js";

test("restricted project completion works with full filesystem browsing disabled without widening path or account access",()=>withPeerFixture("directory-policy",async scope=>{
  const root=join(scope.root,"allowed"),outside=join(scope.root,"outside");
  for(const path of [root,outside,join(root,"ProjectAlpha"),join(root,"foreign"),join(root,"private")])mkdirSync(path);
  writeFileSync(join(root,"ProjectAlpha","source.txt"),"Original source\n");
  const store=new PhononStore(join(scope.root,"native.db"));scope.defer(()=>store.close());
  store.upsertProject({projectId:"foreign",name:"Foreign",path:join(root,"foreign"),namespace:"bob",git:false,createdAt:new Date().toISOString()});
  store.upsertProject({projectId:"private",name:"Private",path:join(root,"private"),namespace:"alice",employeeId:"private-employee",git:false,createdAt:new Date().toISOString()});
  const messages:any[]=[],connection=new PhononConnection({tenantId:"alice",registry:new AdapterRegistry(),store,workspaceRoot:root,
    policy:{allowedProjectRoots:[root],allowDeviceFsBrowse:false},transport:{send:value=>messages.push(JSON.parse(value)),close:()=>{}}});
  scope.defer(()=>connection.dispose());let sequence=0;
  const call=async(method:string,params:unknown)=>{const id=++sequence;await connection.handle(JSON.stringify({jsonrpc:"2.0",id,method,params}));return messages.find(row=>row.id===id);};
  for(const params of [{absolutePath:root},{root:"home",path:""}])assert.equal((await call("device.fs.list",params)).error?.data?.appCode,"errPolicyDenied");
  assert.equal((await call("device.fs.roots",{})).error?.data?.appCode,"errPolicyDenied");
  const response=await call("device.fs.list",{projectCandidates:true,directoryInput:root+"/Pro"});
  assert.ok(response.result,JSON.stringify(response));assert.deepEqual(response.result.entries.map((row:any)=>row.name),["ProjectAlpha"]);
  assert.equal(response.result.entries[0].selectable,true);
  for(const path of [outside,join(root,"foreign"),join(root,"private")]){
    assert.equal((await call("device.fs.list",{projectCandidates:true,directoryInput:path+"/"})).error?.data?.appCode,"errPolicyDenied");
  }
  const registered=await call("project.create",{name:"Alpha",path:join(root,"ProjectAlpha"),git:false,existingDirectoryIdentity:response.result.entries[0].directoryIdentity});
  assert.ok(registered.result,JSON.stringify(registered));assert.equal(readFileSync(join(root,"ProjectAlpha","source.txt"),"utf8"),"Original source\n");
}));

test("method-level filesystem deny still blocks restricted project completion",()=>withPeerFixture("directory-method-deny",async scope=>{
  const store=new PhononStore(join(scope.root,"native.db"));scope.defer(()=>store.close());
  const messages:any[]=[],connection=new PhononConnection({tenantId:"alice",registry:new AdapterRegistry(),store,workspaceRoot:scope.root,
    policy:{allowedProjectRoots:[scope.root],allowDeviceFsBrowse:false,allowedMethods:["device.info"]},transport:{send:value=>messages.push(JSON.parse(value)),close:()=>{}}});
  scope.defer(()=>connection.dispose());
  await connection.handle(JSON.stringify({jsonrpc:"2.0",id:1,method:"device.fs.list",params:{projectCandidates:true,directoryInput:scope.root+"/"}}));
  assert.equal(messages.find(row=>row.id===1).error?.data?.appCode,"errPolicyDenied");
}));
