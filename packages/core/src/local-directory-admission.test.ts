import test,{mock} from "node:test";
import {DatabaseSync} from "node:sqlite";
import assert from "node:assert/strict";
import {mkdirSync,writeFileSync,readFileSync,renameSync,symlinkSync,chmodSync,readdirSync} from "node:fs";
import {join,dirname} from "node:path";
import {withPeerFixture, type PeerFixture} from "./testing/peer-fixture.js";
import {PhononStore} from "./store.js";
import {PhononConnection} from "./index.js";
import {AdapterRegistry,type SessionEngine} from "./session-engine.js";
import {directoryIdentity} from "./directory-identity.js";

const binding={url:"wss://source.example.test/phonon",deviceKey:"synthetic",expectedTenantId:"alice"};
async function fixture(scope:PeerFixture){
  const state=join(scope.root,"state"),root=join(scope.root,"workspace"),path=join(scope.root,"SocietasApp");
  for(const p of [state,root,path,join(path,"child"),join(path,".git")])mkdirSync(p,{mode:0o700});
  writeFileSync(join(path,"source.txt"),"original source\n");writeFileSync(join(path,".git","HEAD"),"ref: refs/heads/original\n");
  writeFileSync(join(path,".git","config"),"[core]\n\tbare = false\n[remote \"origin\"]\n\turl = synthetic-original\n");
  const db=join(state,"phonon.db"),store=new PhononStore(db);scope.defer(()=>store.close());
  const admissions=()=>(store as any).localDirectoryAdmissions();
  let seq=0;const registry=new AdapterRegistry();
  registry.register({name:"codex",capabilities:{},discoverAgents:async()=>[],createSession:async()=>({model:"fake",send:async()=>{},terminate:async()=>{}})} as any);
  const connect=(source:any=binding,tenant="alice",data=store,trustLocal=false)=>{
    const messages:any[]=[],connection=new PhononConnection({tenantId:tenant,store:data,registry,workspaceRoot:root,localDirectorySource:source,trustLocal,
      transport:{send:(s:string)=>messages.push(JSON.parse(s)),close:()=>{}}} as any);scope.defer(()=>connection.dispose());
    return Object.assign(async(method:string,params:any={})=>{const id=++seq;await connection.handle(JSON.stringify({jsonrpc:"2.0",id,method,params}));return messages.find(x=>x.id===id);},{connection});
  };
  const params={name:"SocietasApp",path,git:false,existingDirectoryIdentity:directoryIdentity(path),clientRequestId:"registration"};
  return {state,root,path,db,store,admissions,connect,params,registry,admit(){admissions().observe(binding,"alice");return admissions().admit(binding,path,root,store);}};
}

function deferred(){let release!:()=>void;const promise=new Promise<void>(r=>release=r);return {promise,release};}
const ticks=async()=>{for(let i=0;i<20;i++)await new Promise<void>(r=>setImmediate(r));};

for(const phase of ["finally","interrupt","native-stop","idempotent","mixed"]){
  test(`admission generation real connection queue ${phase}`,()=>withPeerFixture("admission-generation-queue",async scope=>{
    const f=await fixture(scope);f.admit();const call=f.connect(),engine=(call.connection as any).engine as SessionEngine;
    const project=(await call("project.create",f.params)).result.project;
    const gate=deferred(),entered=deferred(),inputs:string[]=[];
    scope.defer(()=>{gate.release();entered.release();});
    f.registry.register({name:"codex",capabilities:{interrupt:true},discoverAgents:async()=>[],createSession:async()=>({model:"fake",
      send:async(input:string)=>{inputs.push(input);if(input==="first"){entered.release();await gate.promise;}},
      interrupt:async()=>{},terminate:async()=>{},observeNativeStop:async()=>"native_terminal",
    })} as any);
    try{
      const {sessionId}=(await call("session.create",{project:project.projectId,agent:"codex",model:"fake"})).result;
      if(phase==="native-stop"){
        (engine as any).runtimeContext=undefined;
        engine.assertTenant(sessionId,"alice").workflowAttr={workflowId:"w",nodeId:"n",nativeRunId:"native"};
      }
      const first=(await call("session.send",{sessionId,input:"first"})).result;await entered.promise;
      const old={sessionId,input:"old-queued-input",clientRequestId:"old-queued"};
      const queued=(await call("session.send",old)).result;assert.equal(queued.disposition,"queued");
      assert.equal((await call("session.send",old)).result.turnId,queued.turnId);
      if(phase!=="idempotent")f.admissions().revoke(binding,f.path);
      f.admissions().admit(binding,f.path,f.root,f.store);
      if(phase!=="idempotent")assert.ok((await call("session.send",old)).error,"old queued receipt must not confirm a new grant");
      if(phase==="mixed")assert.equal((await call("session.send",{sessionId,input:"fresh-queued"})).result.disposition,"queued");
      if(phase==="interrupt")await call("session.interrupt",{sessionId});
      if(phase==="native-stop"){
        const stopping=engine.stopNative("alice",sessionId,first.turnId);gate.release();assert.equal((await stopping).state,"confirmed");
      }else gate.release();
      await engine.settleTurn("alice",sessionId,first.turnId);await ticks();
      assert.deepEqual(inputs,phase==="idempotent"?["first","old-queued-input"]:phase==="mixed"?["first","fresh-queued"]:["first"]);
      const fresh=(await call("session.send",{sessionId,input:"fresh"})).result;
      assert.ok(fresh);await engine.settleTurn("alice",sessionId,fresh.turnId);assert.equal(inputs.at(-1),"fresh");
      f.admissions().revoke(binding,f.path);assert.ok((await call("session.terminate",{sessionId})).result);
    }finally{gate.release();entered.release();}
  }));
}

for(const phase of ["create","create-late","recover","recover-observe","recover-prep","recover-late","skills","insertion","compress","refresh","send-admission"]){
  test(`admission generation real connection preparation ${phase}`,()=>withPeerFixture("admission-generation-prep",async scope=>{
    const f=await fixture(scope);f.admit();const call=f.connect(),engine=(call.connection as any).engine as SessionEngine;
    const project=(await call("project.create",f.params)).result.project;
    const gate=deferred(),entered=deferred(),sent=deferred(),effects:string[]=[];
    scope.defer(()=>{gate.release();entered.release();sent.release();});
    let delay=false;
    const block=async()=>{entered.release();await gate.promise;};
    const employee={id:"11111111-1111-4111-8111-111111111111",revision:1};
    Object.assign((engine as any).runtimeContext,{
      prepareSkills:()=>({}),loadSkills:async()=>{await block();return {context:"",names:[],bindings:[]};},
      resolveEmployee:async()=>{if(delay&&["create","recover","recover-prep","refresh"].includes(phase))await block();return {...employee,revision:delay?2:1,context:[]};},useEmployee:()=>()=>{},
    });
    const native={model:"fake",send:async(input:string)=>{effects.push(input);sent.release();if(phase==="insertion")await gate.promise;},
      interrupt:async()=>{},terminate:async()=>{effects.push("terminate");},inject:async()=>{effects.push("inject");},insertAtToolGap:async()=>{effects.push("insert");},
      describe:async()=>{if(delay&&phase==="compress")await block();return {usedTokens:1};},compressNative:async()=>{effects.push("compress");return {applied:true};},
    };
    f.registry.register({name:"codex",capabilities:{interrupt:true,injectMidTurn:true,nativeCompression:true},discoverAgents:async()=>[],
      createSession:async()=>{effects.push("create");if(phase==="create-late")await block();return native;},
      observeSessionCheckpoint:async()=>{effects.push("observe");await block();return {id:"native"};},
      recoverSession:async()=>{effects.push("recover");if(phase==="recover-late")await block();return native;},
    } as any);
    const params={tenantId:"alice",project:project.projectId,cwd:f.path,agent:"codex",model:"fake",verbosity:"messages" as const,
      ...(["create","recover","refresh"].includes(phase)?{agentConfig:{employee}}:{})};
    try{
      let sessionId:string,pending:Promise<unknown>;
      if(phase==="create"||phase==="create-late"){
        delay=true;pending=engine.create(params);sessionId="unused";
      }else if(phase.startsWith("recover-")){
        sessionId="s-generation-recovery";
        f.store.upsertSession({sessionId,tenantId:"alice",projectId:project.projectId,agent:"codex",model:"fake",status:"idle",verbosity:"messages",createdAt:new Date().toISOString(),
          cwd:f.path,cwdIdentity:directoryIdentity(f.path),...(phase==="recover-prep"?{employeeId:employee.id,employeeRevision:1}:{}),
          ...(phase!=="recover-observe"?{recoveryJSON:JSON.stringify({version:1,adapter:"codex",agent:"codex",model:"fake",project:project.projectId,cwd:f.path,settled:true,state:{id:"native"}})}:{})});
        const recoveryCall=f.connect(),recoveryEngine=(recoveryCall.connection as any).engine as SessionEngine;
        Object.assign((recoveryEngine as any).runtimeContext,(engine as any).runtimeContext);
        delay=true;pending=recoveryEngine.recover("alice",sessionId,{project:project.projectId,agent:"codex",model:"fake"});
      }else{
        ({sessionId}=await engine.create(params));effects.length=0;delay=true;
        if(phase==="recover")pending=engine.recover("alice",sessionId,{project:project.projectId,agent:"codex",model:"fake"});
        else if(phase==="send-admission"){
          const status=engine.status.bind(engine);
          const delayed=mock.method(engine,"status",async(...args:Parameters<typeof engine.status>)=>{await block();return status(...args);});
          scope.defer(()=>delayed.mock.restore());
          pending=call("session.send",{sessionId,input:"forbidden"});
        }
        else if(phase==="refresh")pending=engine.refreshEmployee("alice",sessionId,{...employee,revision:2});
        else if(phase==="compress")pending=engine.compress("alice",sessionId,"native");
        else if(phase==="insertion"){
          await engine.send("alice",sessionId,"first",{});await sent.promise;
          pending=engine.send("alice",sessionId,"forbidden",{whenBusy:"inject",skills:[{name:"synthetic"} as any]});
        }else{
          const first=await engine.send("alice",sessionId,"forbidden",{skills:[{name:"synthetic"} as any]});
          pending=engine.settleTurn("alice",sessionId,first.turnId);
        }
      }
      // Attach rejection handling before releasing any async preparation.
      const outcome=pending.then(value=>({value,error:undefined}),error=>({value:undefined,error}));
      await entered.promise;f.admissions().revoke(binding,f.path);f.admissions().admit(binding,f.path,f.root,f.store);gate.release();
      const result=await outcome;await ticks();
      const permitted=phase==="recover-observe"?["observe"]:phase==="recover-late"?["recover","terminate"]:phase==="create-late"?["create","terminate"]:phase==="insertion"?["first"]:[];
      assert.deepEqual(effects,permitted);
      if(phase==="compress")assert.equal((result.value as any).errorCode,"compression_not_dispatched");
      else if(phase==="send-admission")assert.equal((result.value as any).error?.data?.appCode,"errPolicyDenied");
      else if(phase!=="skills")assert.equal(result.error?.appCode,"errPolicyDenied");
    }finally{gate.release();entered.release();sent.release();}
  }));
}

test("admission generation is durable and idempotent only for a current grant",()=>withPeerFixture("admission-generation-durable",async scope=>{
  const f=await fixture(scope),first=f.admit();assert.equal(typeof first.generation,"string");
  assert.equal(f.admit().generation,first.generation);
  const reopened=new PhononStore(f.db);scope.defer(()=>reopened.close());
  assert.equal((reopened.localDirectoryAdmissions().list(binding)[0] as any).generation,first.generation);
  f.admissions().revoke(binding,f.path);const second=f.admit();assert.notEqual(second.generation,first.generation);
  assert.equal((reopened.localDirectoryAdmissions().list(binding)[0] as any).generation,second.generation);
  assert.equal(f.admit().generation,second.generation);
  f.admissions().observe({...binding,url:"wss://other.example.test/phonon"},"alice");
  assert.throws(()=>f.admissions().admit({...binding,url:"wss://other.example.test/phonon"},f.path,f.root,f.store));
  f.admissions().observe({...binding,expectedTenantId:"bob"},"bob");
  assert.throws(()=>f.admissions().admit({...binding,expectedTenantId:"bob"},f.path,f.root,f.store));
  f.admissions().revoke(binding,f.path);renameSync(f.path,f.path+"-original");mkdirSync(f.path,{mode:0o700});
  assert.throws(()=>f.admit(),/identity changed/);
}));

test("admission generation migrates legacy local grants without guessing old authority",()=>withPeerFixture("admission-generation-legacy",async scope=>{
  const f=await fixture(scope);f.admit();const db=new DatabaseSync(f.admissions().path);
  try{db.exec("ALTER TABLE admissions DROP COLUMN generation");}finally{db.close();}
  assert.throws(()=>f.admissions().allows(f.path,binding,"alice"),/no current local admission/);
  f.admissions().observe(binding,"alice");
  const generation=f.admissions().generation(f.path,binding,"alice");assert.equal(typeof generation,"string");
  assert.equal(f.admit().generation,generation);
}));

for(const method of ["project.create","project.exec"]){
  test(`admission generation fences pending directory ${method}`,()=>withPeerFixture("admission-generation-directory",async scope=>{
    const f=await fixture(scope);f.admit();const call=f.connect(binding,"alice",f.store,method==="project.exec");
    const params=method==="project.create"?f.params:{projectId:(await call("project.create",f.params)).result.project.projectId,command:process.execPath,args:["-e","process.exit(0)"]};
    const pending=call(method,params);
    f.admissions().revoke(binding,f.path);f.admit();
    const result=await pending;assert.equal(result.error?.data?.appCode,"errPolicyDenied",JSON.stringify(result));
    if(method==="project.create")assert.equal(f.store.loadProjects().length,0);
  }));
}

for(const method of ["project.create","session.create","session.send","session.compress"]){
  test(`admission generation cached ${method} receipt cannot cross re-admission`,()=>withPeerFixture("admission-generation-receipt",async scope=>{
    const f=await fixture(scope);f.admit();const call=f.connect(),engine=(call.connection as any).engine as SessionEngine;
    let sends=0,compressions=0;
    f.registry.register({name:"codex",capabilities:{nativeCompression:true},discoverAgents:async()=>[],createSession:async()=>({model:"fake",send:async()=>{sends++;},terminate:async()=>{},describe:async()=>({usedTokens:1}),compressNative:async()=>{compressions++;return {applied:true};}})} as any);
    const project=(await call("project.create",f.params)).result.project;
    const {sessionId}=(await call("session.create",{project:project.projectId,agent:"codex",model:"fake"})).result;
    const params=method==="project.create"?f.params:method==="session.create"?{project:project.projectId,agent:"codex",model:"fake",clientRequestId:"old-create"}:
      method==="session.send"?{sessionId,input:"once",clientRequestId:"old-send"}:{sessionId,mode:"native",clientRequestId:"old-compress"};
    const first=await call(method,params);assert.ok(first.result,JSON.stringify(first));
    if(method==="session.send")await engine.settleTurn("alice",sessionId,first.result.turnId);
    assert.ok((await call(method,params)).result,"same generation retry");
    f.admissions().revoke(binding,f.path);f.admit();
    const retried=await call(method,params);assert.ok(retried.error,JSON.stringify(retried));
    const other=f.connect();assert.ok((await other(method,params)).error,"reopened connection must fence persisted receipt");
    const fresh=await call(method,{...params,clientRequestId:"fresh"});assert.ok(fresh.result,JSON.stringify(fresh));
    if(method==="session.send"){await engine.settleTurn("alice",sessionId,fresh.result.turnId);assert.equal(sends,2);}
    if(method==="session.compress")assert.equal(compressions,2);
  }));
}
for(const scenario of ["preserve-reopen","no-consent","isolation","revoke-cache","replacement","private-provenance","ownership","durable-queue","foreign-descendant","employee-home","admit-internal"]){
  test(`local directory admission ${scenario}`,()=>withPeerFixture("local-directory-admission",async scope=>{
    const f=await fixture(scope),call=f.connect();
    if(scenario==="no-consent"){
      assert.equal((await call("project.create",f.params)).error?.data?.appCode,"errPolicyDenied");
      f.admissions().observe(binding,"alice");assert.equal((await call("project.create",f.params)).error?.data?.appCode,"errPolicyDenied");return;
    }
    if(scenario==="ownership"){
      f.admissions().observe(binding,"alice");
      f.store.upsertProject({projectId:"legacy",name:"Legacy",path:f.path,git:false,createdAt:new Date().toISOString()});
      assert.throws(()=>f.admit());return;
    }
    if(scenario==="employee-home"){
      f.store.upsertProject({projectId:"employee",name:"Employee",path:join(f.path,"child"),namespace:"alice",employeeId:"private",git:false,createdAt:new Date().toISOString()});
      assert.throws(()=>f.admit());return;
    }
    if(scenario==="admit-internal"){
      f.admissions().observe(binding,"alice");
      for(const path of [f.state,scope.root])assert.throws(()=>f.admissions().admit(binding,path,f.root,f.store));return;
    }
    if(scenario==="foreign-descendant"){
      f.store.upsertProject({projectId:"foreign",name:"Foreign",path:join(f.path,"child"),namespace:"bob",git:false,createdAt:new Date().toISOString()});
      assert.throws(()=>f.admit());return;
    }
    f.admit();const created=await call("project.create",f.params);assert.ok(created.result,JSON.stringify(created));const project=created.result.project;
    if(scenario==="durable-queue"){
      let release!:()=>void,started!:()=>void;const gate=new Promise<void>(r=>release=r),entered=new Promise<void>(r=>started=r),inputs:string[]=[];
      f.registry.register({name:"codex",capabilities:{interrupt:true},discoverAgents:async()=>[],createSession:async()=>({model:"fake",
        send:async(input:string)=>{inputs.push(input);started();await gate;},interrupt:async()=>{},terminate:async()=>{},
      })} as any);scope.defer(()=>release());
      try{
        const session=(await call("session.create",{project:project.projectId,agent:"codex",model:"fake"})).result;
        assert.ok(session);await call("session.send",{sessionId:session.sessionId,input:"first"});await entered;
        assert.equal((await call("session.send",{sessionId:session.sessionId,input:"forbidden"})).result.disposition,"queued");
        f.admissions().revoke(binding,f.path);release();
        for(let i=0;i<20;i++)await new Promise<void>(r=>setImmediate(r));
        assert.deepEqual(inputs,["first"]);assert.equal((await call("session.status",{sessionId:session.sessionId})).result.status,"idle");
        assert.equal((await call("session.send",{sessionId:session.sessionId,input:"direct"})).error?.data?.appCode,"errPolicyDenied");
        assert.ok((await call("session.terminate",{sessionId:session.sessionId})).result);
      }finally{release();}
    }else if(scenario==="preserve-reopen"){
      assert.equal((await call("project.create",{...f.params,clientRequestId:"again"})).result.project.projectId,project.projectId);
      assert.equal(f.store.loadProjects().length,1);assert.equal(readFileSync(join(f.path,"source.txt"),"utf8"),"original source\n");
      assert.equal(readFileSync(join(f.path,".git","HEAD"),"utf8"),"ref: refs/heads/original\n");assert.deepEqual(readdirSync(join(f.path,".git")),["HEAD","config"]);
      assert.equal(readFileSync(join(f.path,".git","config"),"utf8"),"[core]\n\tbare = false\n[remote \"origin\"]\n\turl = synthetic-original\n");
      const reopened=new PhononStore(f.db);scope.defer(()=>reopened.close());const other=f.connect(binding,"alice",reopened);
      assert.equal((await other("project.list")).result.projects.length,1);assert.ok((await other("project.get",{projectId:project.projectId})).result);
      const session=await other("session.create",{project:project.projectId,agent:"codex",model:"fake"});assert.ok(session.result,JSON.stringify(session));
      assert.ok((await other("session.send",{sessionId:session.result.sessionId,input:"synthetic"})).result);
      assert.ok((await other("device.fs.list",{projectCandidates:true,directoryInput:f.path+"/"})).result);
      assert.equal((await other("device.fs.list",{projectCandidates:true,directoryInput:f.path})).result.directoryMatch.path,f.path);
    }else if(scenario==="isolation"){
      for(const other of [f.connect({...binding,url:"wss://other.example.test/phonon"}),f.connect({...binding,expectedTenantId:"bob"},"bob")]){
        assert.equal((await other("project.create",f.params)).error?.data?.appCode,"errPolicyDenied");assert.deepEqual((await other("project.list")).result.projects,[]);
        assert.ok((await other("project.get",{projectId:project.projectId})).error);
      }
      for(const path of [dirname(f.path),f.path+"-sibling",f.state])assert.ok((await call("project.create",{name:"Forbidden",path,git:false})).error);
    }else if(scenario==="revoke-cache"){
      const session=(await call("session.create",{project:project.projectId,agent:"codex",model:"fake"})).result;
      f.admissions().revoke(binding,f.path);
      assert.equal((await call("project.create",f.params)).error?.data?.appCode,"errPolicyDenied");
      assert.equal((await call("session.send",{sessionId:session.sessionId,input:"forbidden"})).error?.data?.appCode,"errPolicyDenied");
      assert.ok((await call("session.terminate",{sessionId:session.sessionId})).result);
    }else if(scenario==="replacement"){
      renameSync(f.path,f.path+"-old");mkdirSync(f.path);assert.ok((await call("project.get",{projectId:project.projectId})).error);
      renameSync(f.path,f.path+"-replacement");symlinkSync(f.path+"-old",f.path);assert.ok((await call("project.get",{projectId:project.projectId})).error);
    }else{
      chmodSync(f.admissions().path,0o644);assert.ok((await call("project.get",{projectId:project.projectId})).error);
    }
  }));
}
