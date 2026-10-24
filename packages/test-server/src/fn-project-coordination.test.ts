import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { AgentCoordinationInput, CoordinationReceiveReport, ProjectCoordinationParams } from "@agent-phonon/protocol";
import { AdapterRegistry, PhononStore } from "@agent-phonon/core";
import { PhononDevice } from "@agent-phonon/server-sdk";
import { MockAdapter, TestConn } from "./harness.js";
import { withPeerFixture } from "../../core/dist/testing/peer-fixture.js";

test("coordination input cannot forge source identity or request execution", () => {
  const send={operation:"send",requestId:randomUUID(),recipientId:randomUUID(),kind:"notice",text:"Changed API"};
  assert.ok(AgentCoordinationInput.safeParse(send).success);
  for(const field of ["senderId","projectId","ownerID","deviceId","sourceKind","runId","sessionId","turnId","wake","mode","receive","receiveReporting","evidenceVersion","deliveryId"]){
    assert.equal(AgentCoordinationInput.safeParse({...send,[field]:randomUUID()}).success,false);
  }
  assert.equal(AgentCoordinationInput.safeParse({...send,text:"x".repeat(4001)}).success,false);
});

test("receive metadata is versioned, bounded and not a model action", () => {
  const receive={version:1,mode:"runtime_checkpoint",boundary:"after_tools",evidence:"context_hook",visibility:"collapsed"};
  assert.ok(CoordinationReceiveReport.safeParse(receive).success);
  for(const extra of [{version:2},{nativeSessionId:"private"},{read:true},{completed:true}])
    assert.equal(CoordinationReceiveReport.safeParse({...receive,...extra}).success,false);
  assert.equal(CoordinationReceiveReport.safeParse({version:1,mode:"tool_polling",evidence:"provider_payload"}).success,false);
  assert.ok(ProjectCoordinationParams.safeParse({sourceKind:"native",runId:randomUUID(),workflowId:"w",sessionId:"s",turnId:"t",action:{operation:"presence"},receive}).success);
  assert.equal(AgentCoordinationInput.safeParse({operation:"presence",receive}).success,false);
});

for(const sourceKind of ["native","dev"] as const)test(`${sourceKind} coordination uses a current-turn embedded and loopback capability`,()=>withPeerFixture("coordination",async scope=>{
  const root=scope.root,store=new PhononStore(join(root,"state.db")),registry=new AdapterRegistry();scope.defer(()=>store.close());
  const adapter=new MockAdapter(),original=adapter.createSession.bind(adapter),calls:any[]=[];
  let retained:any,channel="",headers:Record<string,string>={};
  const self={id:randomUUID(),position:"1",projectId:randomUUID(),ownerId:"owner",deviceId:randomUUID(),agentId:randomUUID(),agentKind:"agent",sourceKind,sessionId:"test-session",label:"Controlled worker",activity:{summary:"",phase:"idle",impact:[],dependencies:""},activityRevision:0,lastSeenAt:new Date().toISOString(),presence:"active"};
  adapter.createSession=async params=>{
    const session=await original(params);
    session.send=async(input,opts)=>{
      assert.match(input,/separate from human chat/);
      retained=opts.projectCoordination;assert.ok(retained);
      await retained({operation:"inbox"});
      await assert.rejects(retained({operation:"peers",sourceKind:"native"}));
      channel=opts.environment!.AGENT_PHONON_COORDINATION_URL!;
      headers={authorization:"Bearer "+opts.environment!.AGENT_PHONON_INTERACTION_TOKEN,"content-type":"application/json"};
      assert.equal((await fetch(channel,{method:"POST",headers:{...headers,origin:"https://untrusted.invalid"},body:'{"operation":"inbox"}'})).status,403);
      const response=await fetch(channel,{method:"POST",headers,body:'{"operation":"inbox"}'});
      assert.equal(response.status,200);assert.deepEqual(await response.json(),{self,messages:[],next:null});
      opts.emit({type:"result",sessionId:params.sessionId,turnId:opts.turnId,seq:0,at:new Date().toISOString(),text:"Assigned task completed",status:"completed",final:true} as never);
    };
    return session;
  };
  registry.register(adapter);const tc=new TestConn({registry,store,workspaceRoot:root,tenantId:"owner"});
  scope.defer(()=>tc.conn.dispose());
  tc.setRequestResponder("project.coordination",raw=>{const input=raw as any;self.sessionId=input.sessionId;calls.push(input);
    if(sourceKind==="native"&&input.receive)return {unsupported:"receive reporting"};
    return input.action.operation==="peers"?{self,participants:[],next:null}:{self,messages:[],next:null};});
  try{
    const project=(await tc.call("project.create",{name:"coordination",git:false}) as any).project.projectId,runId=randomUUID();
    const run=await tc.call("workflow.run",{project,metadata:sourceKind==="native"?{native_chat:true,native_run_id:runId}:{dev_chat:true,dev_run_id:runId},
      plan:{mode:"dag",nodes:[{nodeId:"reply",agent:"mock:default",model:"m1",input:"Complete the assigned task"}],finalNodeId:"reply"}}) as any;
    let done=false;
    for(let i=0;i<200;i++){const state=await tc.call("workflow.status",{workflowId:run.workflowId}) as any;if(state.status==="completed"){done=true;break;}await new Promise(resolve=>setTimeout(resolve,10));}
    assert.ok(done);assert.equal(calls.length,5);
    assert.ok(calls.every(call=>call.sourceKind===sourceKind&&call.runId===runId&&call.workflowId===run.workflowId&&call.sessionId&&call.turnId));
    assert.deepEqual(calls.map(c=>c.action.operation),["presence","peers","inbox","inbox","inbox"]);
    assert.deepEqual(calls[0].receive,{version:1,mode:"tool_polling"});
    assert.ok(calls.slice(1).every(call=>call.receive===undefined),"legacy server did not negotiate receive reporting");
    await assert.rejects(retained({operation:"inbox"}));
    await assert.rejects(fetch(channel,{method:"POST",headers,body:'{"operation":"inbox"}'}));
    assert.equal(calls.length,5);
    assert.ok(tc.streamEvents.filter(event=>event.type==="message"||event.type==="result").every(event=>!JSON.stringify(event).includes("coordination")));
  }finally{await tc.conn.dispose();}
}));

test("SDK coordination delivery has no synthetic success fallback",async()=>{
  const device=new PhononDevice("device","owner",{} as never);
  await assert.rejects(device._handleInbound("project.coordination",{}));
  await assert.rejects(device._handleInbound("project.coordination.evidence",{}));
  let called=false;
  device.setProjectCoordinationHandler(async input=>{await Promise.resolve();called=true;return input;});
  const input={sourceKind:"dev",runId:randomUUID(),action:{operation:"inbox"},receive:{version:1,mode:"tool_polling"}};
  assert.deepEqual(await device._handleInbound("project.coordination",input),input);assert.ok(called);
  const report={version:1,reports:[{deliveryId:randomUUID(),boundaryId:randomUUID(),contentHash:"a".repeat(64),state:"context_hook"}]};
  device.setProjectCoordinationEvidenceHandler(async params=>{await Promise.resolve();return params;});
  assert.deepEqual(await device._handleInbound("project.coordination.evidence",report),report);
});
