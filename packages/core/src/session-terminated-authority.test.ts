import test from "node:test";
import assert from "node:assert/strict";
import {withPeerFixture} from "./testing/peer-fixture.js";
import {AdapterRegistry,SessionEngine} from "./session-engine.js";
import {PhononError} from "./rpc.js";
import type {AgentAdapter} from "./adapter.js";

test("terminated sessions reject send and recovery before looking up a removed project",()=>withPeerFixture("terminated-authority",async scope=>{
  const registry=new AdapterRegistry();let sent=0,lookups=0;
  registry.register({name:"mock",capabilities:{nativeSession:false,nativeCompression:false,contextInjection:false,proactiveOutput:false,
    modelSwitch:false,interrupt:false,injectMidTurn:false,skillManagement:false,hooks:[],streaming:false,workflowRoles:[]},
  async discoverAgents(){return [];},async createSession(){return {
    sessionId:"native",model:"m1",async send(){sent++;},async terminate(){},
  };}} satisfies AgentAdapter);
  const engine=new SessionEngine(registry,()=>{});scope.defer(()=>engine.dispose());
  const cwd=scope.root;
  const {sessionId}=await engine.create({tenantId:"alice",project:"p",cwd,agent:"mock:default",model:"m1",verbosity:"messages"});
  await engine.terminate("alice",sessionId);
  engine.resolveCwdForReattach=()=>{lookups++;throw new PhononError("errProjectNotFound");};
  const terminated=(error:unknown)=>error instanceof PhononError&&error.appCode==="errSessionTerminated";
  await assert.rejects(engine.send("alice",sessionId,"must not execute",{}),terminated);
  await assert.rejects(engine.recover("alice",sessionId,{project:"p",agent:"mock:default",model:"m1"}),terminated);
  await assert.rejects(engine.send("bob",sessionId,"foreign",{}),error=>error instanceof PhononError&&error.appCode==="errSessionNotInTenant");
  assert.equal(lookups,0);assert.equal(sent,0);
}));
