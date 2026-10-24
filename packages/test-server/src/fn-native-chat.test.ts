import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync,realpathSync,rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { AdapterRegistry,PhononStore } from "@agent-phonon/core";
import { MockAdapter,TestConn } from "./harness.js";
import { PhononDevice } from "@agent-phonon/server-sdk";

async function setup(delay=0){
  const root=realpathSync(mkdtempSync(join(tmpdir(),"phonon-native-chat-"))),store=new PhononStore(join(root,"state.db"));
  const registry=new AdapterRegistry();registry.register(new MockAdapter({sendDelayMs:delay,reply:input=>"reply:"+input}));
  const tc=new TestConn({registry,store,workspaceRoot:root,tenantId:"native-owner"});
  const project=(await tc.call("project.create",{name:"native",git:false}) as {project:{projectId:string}}).project.projectId;
  const finish=async()=>{await tc.conn.dispose();store.close();rmSync(root,{recursive:true,force:true});};
  return {tc,project,finish,store,registry,root};
}
async function completed(tc:TestConn,id:string){
  for(let i=0;i<200;i++){const result=await tc.call("workflow.status",{workflowId:id}) as any;if(result.status==="completed")return result;await new Promise(resolve=>setTimeout(resolve,10));}
  throw new Error("native workflow did not finish");
}
test("native chat keeps its Session across turns and stamps run identity before the reply",async()=>{
  const {tc,project,finish}=await setup();
  try{
    const firstID=randomUUID(),request={project,clientRequestId:"native-"+firstID,metadata:{native_run_id:firstID,native_chat:true},plan:{mode:"dag",finalNodeId:"reply",nodes:[{nodeId:"reply",agent:"mock:default",model:"m1",input:"one"}]}};
    const ack=await tc.call("workflow.run",request) as any,first=await completed(tc,ack.workflowId);
    const session=first.nodes[0].sessionId;
    assert.equal(first.finalText,first.nodes[0].result.text);
    assert.match(first.finalText,/\n\none$/);
    assert.equal((await tc.call("session.status",{sessionId:session}) as any).status,"idle");
    assert.ok(tc.streamEvents.some(event=>event.nativeRunId===firstID&&event.workflowId===ack.workflowId));
    const secondID=randomUUID(),second=await tc.call("workflow.run",{...request,clientRequestId:"native-"+secondID,metadata:{native_run_id:secondID,native_chat:true},plan:{mode:"dag",nodes:[{nodeId:"reply",agent:"mock:default",model:"m1",input:"two",sessionId:session}]}}) as any;
    const result=await completed(tc,second.workflowId);
    assert.equal(result.nodes[0].sessionId,session);
    assert.ok(tc.streamEvents.some(event=>event.nativeRunId===secondID&&event.text==="reply:two"));
    assert.equal((await tc.call("workflow.run",request) as any).workflowId,ack.workflowId);
    const cancelled=await tc.call("workflow.dispatch.cancel",{dispatchKey:request.clientRequestId,project}) as any;
    assert.equal(cancelled.status,"completed");assert.equal(cancelled.cancelledBeforeStart,false);
  }finally{await finish();}
});
test("a durable cancellation tombstone prevents a later model start",async()=>{
  const {tc,project,finish,store,registry,root}=await setup();
  let restarted:TestConn|undefined;
  try{
    const id=randomUUID(),dispatchKey="native-"+id;
    const cancelled=await tc.call("workflow.dispatch.cancel",{dispatchKey,project}) as any;
    assert.equal(cancelled.cancelledBeforeStart,true);assert.equal(cancelled.status,"cancelled");
    await tc.conn.dispose();
    restarted=new TestConn({store,registry,workspaceRoot:root,tenantId:"native-owner"});
    await assert.rejects(restarted.call("workflow.run",{project,clientRequestId:dispatchKey,metadata:{native_run_id:id,native_chat:true},plan:{mode:"dag",nodes:[{nodeId:"reply",agent:"mock:default",model:"m1",input:"never"}]}}));
    assert.equal(tc.streamEvents.length,0);
    assert.equal((await restarted.call("session.list",{}) as any).sessions.length,0);
  }finally{await restarted?.conn.dispose();await finish();}
});

test("TypeScript SDK forwards bounded replay and durable dispatch cancellation",async()=>{
  const calls:Array<{method:string;params:unknown}>=[];
  const device=new PhononDevice("device","tenant",{async request(method:string,params:unknown){calls.push({method,params});return {};}} as never);
  await device.replayStream("session",{fromSeq:7,limit:20});
  await device.workflow.cancelDispatch({dispatchKey:"native-one",project:"owned",reason:"Stop"});
  assert.deepEqual(calls,[{method:"stream.replay",params:{sessionId:"session",fromSeq:7,limit:20}},
    {method:"workflow.dispatch.cancel",params:{dispatchKey:"native-one",project:"owned",reason:"Stop"}}]);
});
test("replay is bounded, Session-scoped and leaves acknowledgement to the consumer",async()=>{
  const {tc,project,finish}=await setup();
  try{
    const session=await tc.call("session.create",{project,agent:"mock:default",model:"m1"}) as any;
    const sent=await tc.call("session.send",{sessionId:session.sessionId,input:"history"}) as any;
    await tc.waitTurnEnd(sent.turnId);const before=tc.streamEvents.length,backlog=tc.conn.outboxSize;
    const page=await tc.call("stream.replay",{sessionId:session.sessionId,fromSeq:0,limit:1}) as any;
    assert.equal(page.replayed,1);assert.equal(page.nextSeq,1);assert.equal(tc.streamEvents.length,before+1);assert.equal(tc.conn.outboxSize,backlog);
    await assert.rejects(tc.call("stream.replay",{sessionId:"foreign-session",fromSeq:0}));
    await assert.rejects(tc.call("stream.replay",{sessionId:session.sessionId,limit:1001}));
  }finally{await finish();}
});
