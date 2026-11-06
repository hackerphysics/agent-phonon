import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { AdapterRegistry, PhononStore } from "@agent-phonon/core";
import { PeerFixture } from "../../core/dist/testing/peer-fixture.js";
import { TestConn } from "./harness.js";

test("message transport persists through unknown stop, controller replacement and exact retry without execution",async()=>{
  const scope=new PeerFixture("message-delivery"),registry=new AdapterRegistry();
  let sends=0;
  registry.register({name:"inbox",capabilities:{nativeSession:true} as never,discoverAgents:async()=>[],
    createSession:async params=>({sessionId:params.sessionId,model:params.model,send:async()=>{sends++;},terminate:async()=>{}})});
  const database=join(scope.root,"state.db");
  let store=new PhononStore(database),tc=new TestConn({store,registry,workspaceRoot:scope.root,tenantId:"owner"});
  scope.defer(()=>store.close());scope.defer(()=>tc.conn.dispose());
  try{
    const project=(await tc.call("project.create",{name:"work",git:false}) as any).project.projectId;
    const session=(await tc.call("session.create",{project,agent:"inbox:worker",model:"m1"}) as any).sessionId;
    await tc.conn.dispose();
    const row=store.nativeSessionSnapshot("owner",session)!;
    store.upsertSession({sessionId:session,tenantId:"owner",projectId:project,agent:"inbox:worker",model:"m1",
      status:"paused",verbosity:"messages",createdAt:String(row.created_at),
      nativeStopJSON:JSON.stringify({version:1,sessionId:session,turnId:"old",state:"unknown",observedAt:new Date().toISOString(),reasonCode:"controller_disposed"})});
    tc=new TestConn({store,registry,workspaceRoot:scope.root,tenantId:"owner"});
    const input={messageId:randomUUID(),recipientId:randomUUID(),conversationId:randomUUID(),position:"1",
      project,agent:"inbox:worker",model:"m1",sessionId:session,document:{text:{en:"new input"}}};
    const first=await tc.call("message.receive",input) as any;
    assert.equal(first.state,"received");assert.equal(first.messageId,input.messageId);assert.equal(sends,0);
    assert.deepEqual(await tc.call("message.receive",input),first);
    await tc.conn.dispose();store.close();store=new PhononStore(database);
    tc=new TestConn({store,registry,workspaceRoot:scope.root,tenantId:"owner"});
    assert.deepEqual(await tc.call("message.receive",input),first);
    await assert.rejects(tc.call("message.receive",{...input,document:{text:{en:"changed"}}}));
    await assert.rejects(tc.call("message.receive",{...input,project:"foreign"}));
    assert.equal(sends,0);
    assert.equal(JSON.parse(String(store.nativeSessionSnapshot("owner",session)!.native_stop_json)).state,"unknown");
  }finally{await scope.dispose();}
});

for(const matchingTurn of [true,false])test(`durable recovery binds the original turn after all old controllers are gone (${matchingTurn})`,async()=>{
  const scope=new PeerFixture("message-recovery"),registry=new AdapterRegistry();
  let probes=0,sends=0;
  registry.register({name:"inbox",capabilities:{nativeSession:true} as never,discoverAgents:async()=>[],
    createSession:async params=>({sessionId:params.sessionId,model:params.model,send:async()=>{sends++;},terminate:async()=>{}}),
    observeSessionRecovery:async(_params,hint)=>{probes++;assert.equal(hint.turnId,"original");return {nativeID:"original-native"};},
    recoverSession:async params=>({sessionId:params.sessionId,model:params.model,send:async()=>{sends++;},terminate:async()=>{}})});
  const database=join(scope.root,"state.db");
  let store=new PhononStore(database),tc=new TestConn({store,registry,workspaceRoot:scope.root,tenantId:"owner"});
  scope.defer(()=>store.close());scope.defer(()=>tc.conn.dispose());
  try{
    const project=(await tc.call("project.create",{name:"work",git:false}) as any).project.projectId;
    const sessionId=(await tc.call("session.create",{project,agent:"inbox:worker",model:"m1"}) as any).sessionId;
    await tc.conn.dispose();
    (store as any).db.prepare(`UPDATE sessions SET status='paused',recovery_json=NULL,native_stop_json=?,recovery_hint_json=?
      WHERE session_id=?`).run(JSON.stringify({version:1,sessionId,turnId:"original",state:"unknown",observedAt:new Date().toISOString(),reasonCode:"controller_disposed"}),
      JSON.stringify({version:1,sessionId,turnId:matchingTurn?"original":"earlier"}),sessionId);
    store.close();store=new PhononStore(database);
    tc=new TestConn({store,registry,workspaceRoot:scope.root,tenantId:"owner"});
    assert.equal(store.pendingNativeStops.size,0);
    const status=await tc.call("session.status",{sessionId}) as any;
    assert.equal(probes,matchingTurn?1:0);assert.equal(sends,0);
    assert.equal(status.nativeStop.state,matchingTurn?"confirmed":"unknown");
    if(matchingTurn){
      assert.equal(status.recovery.canAttempt,true);
      await tc.call("session.recover",{sessionId,project,agent:"inbox:worker",model:"m1"});
      await tc.call("session.send",{sessionId,input:"only new message"});
      assert.equal(sends,1);
    }
  }finally{await scope.dispose();}
});
