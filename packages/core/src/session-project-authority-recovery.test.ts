import test from "node:test";
import assert from "node:assert/strict";
import {mkdirSync,renameSync} from "node:fs";
import {join} from "node:path";
import {withPeerFixture} from "./testing/peer-fixture.js";
import {AdapterRegistry,SessionEngine} from "./session-engine.js";
import {PhononStore} from "./store.js";
import {PhononError} from "./rpc.js";
import {directoryIdentity} from "./directory-identity.js";
import type {AgentAdapter,AdapterRuntimeContext} from "./adapter.js";

for(const phase of ["observe","recover-prep","recover-late","identity-reopen","standalone"]){
  test(`project authority recovery ${phase}`,()=>withPeerFixture("project-authority-recovery",async scope=>{
    const cwd=join(scope.root,"project");mkdirSync(cwd);
    const store=new PhononStore(join(scope.root,"state.db"));scope.defer(()=>store.close());
    let allowed=true,release!:()=>void,entered!:()=>void;
    const gate=new Promise<void>(r=>release=r),started=new Promise<void>(r=>entered=r);
    const effects:string[]=[];
    const runtime={resolveEmployee:async()=>{if(phase==="recover-prep"){entered();await gate;}return {id:"e",revision:2,context:[]};},useEmployee:()=>()=>{}} as unknown as AdapterRuntimeContext;
    const session={sessionId:"s",model:"fake",send:async()=>{effects.push("send");},terminate:async()=>{effects.push("terminate");},inject:async()=>{effects.push("inject");}};
    const registry=new AdapterRegistry();registry.register({name:"codex",capabilities:{},discoverAgents:async()=>[],createSession:async()=>session,
      observeSessionCheckpoint:async()=>{effects.push("observe");entered();await gate;return {id:"native"};},
      recoverSession:async()=>{effects.push("recover");if(phase==="recover-late"){entered();await gate;}return session;},
    } as unknown as AgentAdapter);
    const at=new Date().toISOString(),employee=phase==="recover-prep"||phase==="recover-late";
    store.upsertSession({sessionId:"s-owned",tenantId:"alice",projectId:"p",agent:"codex",model:"fake",status:"idle",verbosity:"messages",createdAt:at,
      cwd,cwdIdentity:directoryIdentity(cwd),...(employee?{employeeId:"e",employeeRevision:1}:{}),
      ...(phase!=="observe"?{recoveryJSON:JSON.stringify({version:1,adapter:"codex",agent:"codex",model:"fake",project:"p",cwd,settled:true,state:{id:"native"}})}:{})});
    const engine=new SessionEngine(registry,()=>{},undefined,store,runtime,"alice");scope.defer(()=>engine.dispose());scope.defer(()=>release());
    if(phase!=="standalone")engine.resolveCwdForReattach=()=>{if(!allowed)throw new PhononError("errPolicyDenied","revoked");return cwd;};
    try{
      if(phase==="standalone"){
        const created=await engine.create({tenantId:"alice",project:"fixture",cwd:"/standalone-fixture",agent:"codex",model:"fake",verbosity:"messages"});
        await engine.send("alice",created.sessionId,"fixture",{});return;
      }
      if(phase==="identity-reopen"){
        renameSync(cwd,cwd+"-old");mkdirSync(cwd);
        await engine.recover("alice","s-owned",{project:"p",agent:"codex",model:"fake"});assert.deepEqual(effects,["recover"]);return;
      }
      const pending=engine.recover("alice","s-owned",{project:"p",agent:"codex",model:"fake"});
      const rejected=assert.rejects(pending,/revoked/);await started;allowed=false;release();await rejected;
      assert.equal(effects.includes("inject"),false);assert.equal(effects.includes("send"),false);
      if(phase!=="recover-late")assert.equal(effects.includes("recover"),false);
      else assert.ok(effects.includes("terminate"));
    }finally{release();}
  }));
}

test("native stop does not resurrect revoked queued sends after re-admission",()=>withPeerFixture("project-authority-native-stop",async scope=>{
  const cwd=join(scope.root,"project");mkdirSync(cwd);
  let allowed=true,release!:()=>void,entered!:()=>void;
  const gate=new Promise<void>(r=>release=r),started=new Promise<void>(r=>entered=r),inputs:string[]=[];
  const registry=new AdapterRegistry();registry.register({name:"codex",capabilities:{interrupt:true},discoverAgents:async()=>[],createSession:async()=>({
    sessionId:"fake",model:"fake",send:async(input:string)=>{inputs.push(input);entered();if(input==="first")await gate;},interrupt:async()=>{},terminate:async()=>{},observeNativeStop:async()=>"native_terminal",
  })} as unknown as AgentAdapter);
  const engine=new SessionEngine(registry,()=>{});scope.defer(()=>engine.dispose());scope.defer(()=>release());
  engine.resolveCwdForReattach=()=>{if(!allowed)throw new PhononError("errPolicyDenied","revoked");return cwd;};
  try{
    const {sessionId}=await engine.create({tenantId:"alice",project:"p",cwd,agent:"codex",model:"fake",verbosity:"messages",workflowAttr:{workflowId:"w",nodeId:"n",nativeRunId:"native"}});
    const first=await engine.send("alice",sessionId,"first",{});await started;
    assert.equal((await engine.send("alice",sessionId,"revoked queue",{})).disposition,"queued");allowed=false;
    const stopping=engine.stopNative("alice",sessionId,first.turnId);release();assert.equal((await stopping).state,"confirmed");
    allowed=true;
    const fresh=await engine.send("alice",sessionId,"fresh",{});await engine.settleTurn("alice",sessionId,fresh.turnId);
    for(let i=0;i<4;i++)await new Promise<void>(r=>setImmediate(r));
    assert.deepEqual(inputs,["first","fresh"]);
  }finally{release();}
}));
