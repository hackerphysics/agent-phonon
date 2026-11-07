import test,{mock} from "node:test";
import assert from "node:assert/strict";
import {mkdirSync} from "node:fs";
import {join} from "node:path";
import {withPeerFixture} from "./testing/peer-fixture.js";
import {AdapterRegistry,SessionEngine} from "./session-engine.js";
import {PhononStore} from "./store.js";
import {PhononError} from "./rpc.js";
import type {AgentAdapter,AdapterRuntimeContext} from "./adapter.js";
import {AgentInteractionBridge} from "./agent-interaction-bridge.js";

function deferred(){let release!:()=>void;const promise=new Promise<void>(r=>release=r);return {promise,release};}
const tick=()=>new Promise<void>(r=>setImmediate(r));

for(const phase of ["queue-finally","queue-interrupt","skills","coordination","employee","create","insertion","compress","inject","switch","refresh","recover","cwd-replacement","executor-error"]){
  test(`project authority fences ${phase} after revocation`,()=>withPeerFixture("session-project-authority",async scope=>{
    const cwd=join(scope.root,"project");mkdirSync(cwd);
    const store=new PhononStore(join(scope.root,"state.db"));scope.defer(()=>store.close());
    const gate=deferred(),entered=deferred(),sent=deferred();let allowed=true,currentCwd=cwd;
    const effects:string[]=[],events:any[]=[];
    if(phase==="coordination"){
      const listen=mock.method(AgentInteractionBridge.prototype,"listen",async()=>({}));scope.defer(()=>listen.mock.restore());
    }
    const block=async()=>{entered.release();await gate.promise;};
    const employee={id:"11111111-1111-4111-8111-111111111111",revision:1};
    let delay=false;
    const runtime={
      prepareSkills:()=>({}),loadSkills:async()=>{await block();return {context:"",names:[],bindings:[]};},
      resolveEmployee:async()=>{if(delay)await block();return {...employee,context:[]};},useEmployee:()=>()=>{},
      projectCoordination:async()=>{await block();throw new Error("optional unavailable");},
    } as unknown as AdapterRuntimeContext;
    const adapter:AgentAdapter={name:"codex",capabilities:{interrupt:true,injectMidTurn:true,modelSwitch:true,nativeCompression:true} as any,
      async discoverAgents(){return [];},async createSession(){if(phase==="create")effects.push("create");return {
        sessionId:"fake",model:"fake",async send(input){effects.push(input);sent.release();if(phase==="executor-error")throw new Error("original executor error");if(phase.startsWith("queue")||phase==="insertion")await block();},
        async interrupt(){effects.push("interrupt");},async terminate(){effects.push("terminate");},
        async inject(){effects.push("inject");},async insertAtToolGap(){effects.push("insert");},async switchModel(){effects.push("switch");return {};},
        async describe(){if(delay&&phase==="compress")await block();return {usedTokens:1};},
        async compressNative(){effects.push("compress");return {applied:true};},
      };}} as AgentAdapter;
    const registry=new AdapterRegistry();registry.register(adapter);
    const engine=new SessionEngine(registry,e=>events.push(e),undefined,store,runtime,"alice");scope.defer(()=>engine.dispose());
    scope.defer(()=>{gate.release();entered.release();sent.release();});
    engine.resolveCwdForReattach=()=>{if(!allowed)throw new PhononError("errPolicyDenied","revoked");return currentCwd;};
    const params={tenantId:"alice",project:"p",cwd,agent:"codex",model:"fake",verbosity:"messages" as const,
      ...(["employee","refresh","recover","create"].includes(phase)?{agentConfig:{employee}}:{}),
      ...(phase==="coordination"?{workflowAttr:{workflowId:"w",nodeId:"n",devRunId:"d"}}:{})};
    try{
      if(phase==="create"){
        delay=true;const pending=engine.create(params);await entered.promise;allowed=false;gate.release();
        await assert.rejects(pending,/revoked/);assert.deepEqual(effects,[]);return;
      }
      const {sessionId}=await engine.create(params);delay=true;
      if(phase.startsWith("queue")){
        const first=await engine.send("alice",sessionId,"first",{});await sent.promise;
        assert.equal((await engine.send("alice",sessionId,"forbidden",{})).disposition,"queued");allowed=false;
        if(phase==="queue-interrupt")await engine.interrupt("alice",sessionId);
        gate.release();await engine.settleTurn("alice",sessionId,first.turnId);await tick();
        assert.deepEqual(effects.filter(x=>!["interrupt","terminate"].includes(x)),["first"]);
        await assert.rejects(engine.send("alice",sessionId,"direct",{}),/revoked/);
      }else if(["skills","coordination","employee"].includes(phase)){
        const first=await engine.send("alice",sessionId,"forbidden",phase==="skills"?{skills:[{name:"test"} as any]}:{});
        await entered.promise;allowed=false;gate.release();await engine.settleTurn("alice",sessionId,first.turnId);
        assert.deepEqual(effects,[]);assert.ok(events.some(e=>e.appCode==="errPolicyDenied"));
      }else if(phase==="insertion"){
        const first=await engine.send("alice",sessionId,"first",{});await sent.promise;
        const insert=engine.send("alice",sessionId,"forbidden",{whenBusy:"inject",skills:[{name:"test"} as any]});
        await entered.promise;allowed=false;gate.release();await assert.rejects(insert,/revoked/);
        await engine.settleTurn("alice",sessionId,first.turnId);assert.equal(effects.includes("insert"),false);
      }else if(phase==="cwd-replacement"){
        currentCwd=join(scope.root,"other");mkdirSync(currentCwd);
        await assert.rejects(engine.send("alice",sessionId,"forbidden",{}),/workspace changed/);assert.deepEqual(effects,[]);
      }else if(phase==="executor-error"){
        const first=await engine.send("alice",sessionId,"first",{});await engine.settleTurn("alice",sessionId,first.turnId);
        assert.ok(events.some(e=>e.message==="original executor error"&&e.final));
      }else if(phase==="compress"){
        const pending=engine.compress("alice",sessionId,"native");await entered.promise;allowed=false;gate.release();await pending;
        assert.equal(effects.includes("compress"),false);
      }else if(phase==="refresh"||phase==="recover"){
        const pending=phase==="refresh"?engine.refreshEmployee("alice",sessionId,{...employee,revision:2}):engine.recover("alice",sessionId,{project:"p",agent:"codex",model:"fake"});
        await entered.promise;allowed=false;gate.release();await assert.rejects(pending,/revoked/);assert.deepEqual(effects,[]);
      }else{
        allowed=false;await assert.rejects(phase==="inject"?engine.inject("alice",sessionId,[]):engine.switchModel("alice",sessionId,"new"),/revoked/);assert.deepEqual(effects,[]);
      }
      // Stopping is still available; revocation is not native stop evidence.
      await engine.terminate("alice",sessionId);assert.ok(effects.includes("terminate"));
    }finally{gate.release();entered.release();sent.release();}
  }));
}
