import test from "node:test";
import assert from "node:assert/strict";
import {mkdirSync,writeFileSync,readdirSync,renameSync,readFileSync} from "node:fs";
import {join} from "node:path";
import {withPeerFixture} from "./testing/peer-fixture.js";
import {PolicyEnforcer} from "./policy.js";
import {ProjectManager} from "./project-manager.js";
import {PhononStore} from "./store.js";
import {directoryIdentity} from "./directory-identity.js";
import {directoryInputParts,workspaceDirectorySuggestions} from "./workspace-directories.js";
import {ProjectCreateParams,DeviceFsListParams} from "@agent-phonon/protocol";

test("directory input is interpreted using device-native POSIX, drive and UNC paths without a shell",()=>{
  assert.deepEqual(directoryInputParts("/work/al","/work","/home/owner","posix"),{parent:"/work",prefix:"al",current:"/work/al"});
  assert.deepEqual(directoryInputParts("~/code/","/work","/home/owner","posix"),{parent:"/home/owner/code",prefix:"",current:"/home/owner/code"});
  assert.deepEqual(directoryInputParts("C:\\Users\\Ow","C:\\work","C:\\Users\\Owner","windows"),{parent:"C:\\Users",prefix:"Ow",current:"C:\\Users\\Ow"});
  assert.equal(directoryInputParts("\\\\host\\share\\code\\","C:\\work","C:\\Users\\Owner","windows").parent,"\\\\host\\share\\code");
  assert.throws(()=>directoryInputParts("relative","/work","/home","posix"));
  assert.throws(()=>directoryInputParts("/work/\0private","/work","/home","posix"));
});
test("strict registration and directory query schemas do not silently initialize Git or mix path modes",()=>{
  const input={name:"Work",path:"/work",git:false,existingDirectoryIdentity:"dir:1:2"};
  assert.equal(ProjectCreateParams.safeParse(input).success,true);
  for(const changed of [{...input,git:true},{...input,remote:"https://example.com/a.git"},{...input,path:undefined}])assert.equal(ProjectCreateParams.safeParse(changed).success,false);
  assert.equal(DeviceFsListParams.safeParse({projectCandidates:true,directoryInput:"/work/"}).success,true);
  assert.equal(DeviceFsListParams.safeParse({directoryInput:"/work/"}).success,false);
  assert.equal(DeviceFsListParams.safeParse({projectCandidates:true,absolutePath:"/private"}).success,false);
});
test("one-level native suggestions filter by prefix before the limit and hide foreign/private directories",()=>withPeerFixture("directory-suggestions",async scope=>{
  const root=join(scope.root,"work");mkdirSync(root);
  const policy=new PolicyEnforcer({workspaceRoot:root,trustLocal:true}),store=new PhononStore(join(scope.root,"state.db"));scope.defer(()=>store.close());
  const manager=new ProjectManager(()=>[],{namespace:"alice",workspaceRoot:root,store,assertProjectPath:path=>policy.assertProjectPath(path)});
  for(const name of ["alpha","alpine","beta",".hidden","foreign","private"]){mkdirSync(join(root,name));}
  writeFileSync(join(root,"also-file"),"not a directory");
  store.upsertProject({projectId:"foreign",path:join(root,"foreign"),name:"Foreign",namespace:"bob",git:false,createdAt:new Date().toISOString()});
  store.upsertProject({projectId:"private",path:join(root,"private"),name:"Private",namespace:"alice",employeeId:"11111111-1111-4111-8111-111111111111",git:false,createdAt:new Date().toISOString()});
  const limited=await workspaceDirectorySuggestions(root+"/al",1,policy,manager,()=>{});
  assert.deepEqual(limited.entries.map(entry=>entry.name),["alpha"]);assert.equal(limited.truncated,true);
  const all=await workspaceDirectorySuggestions(root+"/",100,policy,manager,()=>{});
  assert.deepEqual(all.entries.map(entry=>entry.name),["alpha","alpine","beta"]);
  assert.equal(all.directoryMatch?.selectable,false);
  await assert.rejects(workspaceDirectorySuggestions(join(root,"foreign")+"/",100,policy,manager,()=>{}));
  await assert.rejects(workspaceDirectorySuggestions(scope.root+"/outside/",100,policy,manager,()=>{}));
}));
test("existing-directory registration preserves bytes, persists the identity and reuses one reference",()=>withPeerFixture("directory-registration",async scope=>{
  const root=join(scope.root,"work"),path=join(root,"Existing directory");mkdirSync(root);mkdirSync(path);writeFileSync(join(path,"source.txt"),"Original bytes\n");
  const policy=new PolicyEnforcer({workspaceRoot:root,trustLocal:true}),store=new PhononStore(join(scope.root,"state.db"));scope.defer(()=>store.close());
  const manager=new ProjectManager(()=>[],{namespace:"alice",workspaceRoot:root,store,assertProjectPath:path=>policy.assertProjectPath(path)});
  const identity=directoryIdentity(path),before=readdirSync(path),params={name:"Existing",path,git:false,existingDirectoryIdentity:identity};
  const [first,second]=await Promise.all([manager.create(params),manager.create(params)]);
  assert(first.projectId.startsWith("dir-"));assert.equal(first.projectId,second.projectId);assert.equal(manager.list().length,1);
  assert.deepEqual(readdirSync(path),before);assert.equal(readFileSync(join(path,"source.txt"),"utf8"),"Original bytes\n");
  const reopened=new ProjectManager(()=>[],{namespace:"alice",workspaceRoot:root,store,assertProjectPath:path=>policy.assertProjectPath(path)});
  assert.equal(reopened.get(first.projectId).directoryIdentity,identity);
  renameSync(path,path+"-old");mkdirSync(path);
  assert.throws(()=>reopened.get(first.projectId));assert.equal(reopened.list().length,0);
  await assert.rejects(reopened.create(params));
}));
