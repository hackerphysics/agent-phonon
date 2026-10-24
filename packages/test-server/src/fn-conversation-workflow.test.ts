import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync,rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentWorkflowInput,ConversationWorkflowPlan } from "@agent-phonon/protocol";
import { AdapterRegistry,PhononStore } from "@agent-phonon/core";
import { PhononDevice } from "@agent-phonon/server-sdk";
import { MockAdapter,TestConn } from "./harness.js";

const plan=()=>({projectID:randomUUID(),title:"Delivery",goal:"Verify real outcomes",review:"request" as const,nodes:[{id:"work",title:"Work",agentID:randomUUID(),bindingID:randomUUID(),input:"Implement",dependsOn:[]}]});

test("workflow plans require an explicit review choice, canonical resources and a bounded DAG",()=>{
  const input=plan();assert.equal(ConversationWorkflowPlan.parse(input).maxParallel,2);
  for(const changed of [{...input,review:undefined},{...input,nodes:[{...input.nodes[0],dependsOn:["missing"]}]},{...input,nodes:[{...input.nodes[0],dependsOn:["work"]}]},{...input,nodes:[input.nodes[0],input.nodes[0]]},{...input,nodes:[{...input.nodes[0],cwd:"/uncontrolled"}]},{...input,nodes:[{...input.nodes[0],agentID:"discovered-harness"}]}])assert.equal(ConversationWorkflowPlan.safeParse(changed).success,false);
  assert.equal(AgentWorkflowInput.safeParse({operation:"catalog",nativeRunId:randomUUID()}).success,false);
  const detached=AgentWorkflowInput.parse({operation:"execute",requestId:randomUUID(),delivery:"detached",plan:input});
  assert.ok(detached.operation==="execute");assert.equal(detached.delivery,"detached");
  assert.equal(AgentWorkflowInput.safeParse({operation:"execute",requestId:randomUUID(),delivery:"unknown",plan:input}).success,false);
});

test("embedded and loopback workflow calls carry only the active controller source and reject retained or model-authored routes",async()=>{
  const root=mkdtempSync(join(tmpdir(),"phonon-workflow-channel-")),store=new PhononStore(join(root,"state.db")),registry=new AdapterRegistry();
  const adapter=new MockAdapter(),original=adapter.createSession.bind(adapter),calls:any[]=[];let retained:any;
  adapter.createSession=async params=>{const session=await original(params);session.send=async(_input,opts)=>{
    retained=opts.conversationWorkflow;
    const direct=await opts.conversationWorkflow!({operation:"catalog"});assert.equal(direct.status,"catalog");
    await assert.rejects(opts.conversationWorkflow!({operation:"catalog",nativeRunId:randomUUID()} as never));
    const url=opts.environment!.AGENT_PHONON_WORKFLOW_URL!,headers={Authorization:"Bearer "+opts.environment!.AGENT_PHONON_INTERACTION_TOKEN,"Content-Type":"application/json"};
    assert.equal((await fetch(url,{method:"POST",headers:{...headers,Origin:"https://untrusted.invalid"},body:'{"operation":"catalog"}'})).status,403);
    assert.equal((await fetch(url,{method:"POST",headers,body:JSON.stringify({operation:"execute",requestId:randomUUID(),delivery:"detached",plan:plan()})})).status,200);
    opts.emit({type:"result",sessionId:params.sessionId,turnId:opts.turnId,seq:0,at:new Date().toISOString(),text:"verified channel",status:"completed",final:true} as never);
  };return session;};
  registry.register(adapter);const tc=new TestConn({registry,store,workspaceRoot:root,tenantId:"owner"});
  tc.setRequestResponder("conversation.workflow",raw=>{const input=raw as any;calls.push(input);return {status:input.operation==="catalog"?"catalog":"finished",data:{state:"rejected"}};});
  try{
    const project=(await tc.call("project.create",{name:"workflow",git:false}) as any).project.projectId,nativeRunId=randomUUID();
    const run=await tc.call("workflow.run",{project,metadata:{native_chat:true,native_run_id:nativeRunId},plan:{mode:"dag",nodes:[{nodeId:"reply",agent:"mock:default",model:"m1",input:"channel"}],finalNodeId:"reply"}}) as any;
    for(let i=0;i<100;i++){const value=await tc.call("workflow.status",{workflowId:run.workflowId}) as any;if(value.status==="completed")break;await new Promise(resolve=>setTimeout(resolve,10));}
    assert.equal(calls.length,2);assert.ok(calls.every(call=>call.nativeRunId===nativeRunId&&call.workflowId===run.workflowId&&call.sessionId&&call.turnId));
    assert.equal(calls[1].delivery,"detached");
    await assert.rejects(retained({operation:"catalog"}));assert.equal(calls.length,2);
  }finally{await tc.conn.dispose();store.close();rmSync(root,{recursive:true,force:true});}
});

test("TypeScript workflow handler is explicit and awaited rather than a successful empty fallback",async()=>{
  const device=new PhononDevice("device","owner",{} as never);
  await assert.rejects(device._handleInbound("conversation.workflow",{}));
  let done=false;device.setConversationWorkflowHandler(async input=>{await Promise.resolve();done=true;return {status:"catalog",data:input};});
  const result=await device._handleInbound("conversation.workflow",{operation:"catalog"}) as any;assert.equal(done,true);assert.equal(result.status,"catalog");
});
