import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync,rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentMessageInput } from "@agent-phonon/protocol";
import { AdapterRegistry,PhononStore } from "@agent-phonon/core";
import { PhononDevice } from "@agent-phonon/server-sdk";
import { MockAdapter,TestConn } from "./harness.js";

test("group message input names explicit DE recipients and mode, never caller-owned routes",()=>{
  const input={operation:"send",requestId:randomUUID(),text:"Review this result",mentionIDs:[randomUUID()],mode:"queue"};
  assert.ok(AgentMessageInput.safeParse(input).success);
  const file="native-file:"+randomUUID();
  assert.ok(AgentMessageInput.safeParse({...input,attachmentIDs:[file]}).success);
  assert.ok(AgentMessageInput.safeParse({...input,text:"",attachmentIDs:[file]}).success);
  for(const attachmentIDs of [[file,file],["/private/file"],["https://files.invalid/file"],Array.from({length:6},()=>"native-file:"+randomUUID())])assert.equal(AgentMessageInput.safeParse({...input,attachmentIDs}).success,false);
  for(const extra of [{ownerID:randomUUID()},{conversationID:randomUUID()},{senderID:randomUUID()},{nativeRunId:randomUUID()},{relayDepth:0}])assert.equal(AgentMessageInput.safeParse({...input,...extra}).success,false);
  for(const changed of [{...input,mode:undefined},{...input,mentionIDs:[]},{...input,mentionIDs:[input.mentionIDs[0],input.mentionIDs[0]]},{...input,text:" "}])assert.equal(AgentMessageInput.safeParse(changed).success,false);
});

test("embedded and loopback message calls are stamped by the active turn and expire with it",async()=>{
  const root=mkdtempSync(join(tmpdir(),"phonon-message-channel-")),store=new PhononStore(join(root,"state.db")),registry=new AdapterRegistry();
  const adapter=new MockAdapter(),original=adapter.createSession.bind(adapter),calls:any[]=[];let retained:any;
  const conversationID=randomUUID(),senderID=randomUUID(),projectID=randomUUID(),recipient=randomUUID();
  adapter.createSession=async params=>{const session=await original(params);session.send=async(_input,opts)=>{
    retained=opts.conversationMessage;
    assert.equal((await opts.conversationMessage!({operation:"members"})).status,"members");
    await assert.rejects(opts.conversationMessage!({operation:"members",conversationID:randomUUID()} as never));
    const url=opts.environment!.AGENT_PHONON_MESSAGE_URL!,headers={Authorization:"Bearer "+opts.environment!.AGENT_PHONON_INTERACTION_TOKEN,"Content-Type":"application/json"};
    assert.equal((await fetch(url,{method:"POST",headers:{...headers,Origin:"https://untrusted.invalid"},body:'{"operation":"members"}'})).status,403);
    const requestId=randomUUID(),result=await fetch(url,{method:"POST",headers,body:JSON.stringify({operation:"send",requestId,text:"Check the evidence",mentionIDs:[recipient],mode:"wait",attachmentIDs:["native-file:"+recipient]})});
    assert.equal(result.status,200);assert.deepEqual(await result.json(),{status:"not_accepted",requestId,errorCode:"de_mentions_disabled"});
    opts.emit({type:"result",sessionId:params.sessionId,turnId:opts.turnId,seq:0,at:new Date().toISOString(),text:"verified message channel",status:"completed",final:true} as never);
  };return session;};
  registry.register(adapter);const tc=new TestConn({registry,store,workspaceRoot:root,tenantId:"owner"});
  tc.setRequestResponder("conversation.message",raw=>{const input=raw as any;calls.push(input);return input.operation==="members"
    ?{status:"members",conversationID,projectID,senderID,enabled:false,members:[{id:senderID,name:"Lead"},{id:recipient,name:"Reviewer"}],limits:{maxHops:6,maxDeliveries:24,maxRecipients:8,maxRoots:64}}
    :{status:"not_accepted",requestId:input.requestId,errorCode:"de_mentions_disabled"};});
  try{
    const project=(await tc.call("project.create",{name:"messages",git:false}) as any).project.projectId,nativeRunId=randomUUID();
    const run=await tc.call("workflow.run",{project,metadata:{native_chat:true,native_run_id:nativeRunId},plan:{mode:"dag",nodes:[{nodeId:"reply",agent:"mock:default",model:"m1",input:"channel"}],finalNodeId:"reply"}}) as any;
    let finished=false;
    for(let i=0;i<100;i++){const value=await tc.call("workflow.status",{workflowId:run.workflowId}) as any;if(value.status==="completed"){finished=true;break;}await new Promise(resolve=>setTimeout(resolve,10));}
    assert.ok(finished);assert.equal(calls.length,2);assert.ok(calls.every(call=>call.nativeRunId===nativeRunId&&call.workflowId===run.workflowId&&call.sessionId&&call.turnId));
    assert.deepEqual(calls[1].attachmentIDs,["native-file:"+recipient]);
    await assert.rejects(retained({operation:"members"}));assert.equal(calls.length,2);
  }finally{await tc.conn.dispose();store.close();rmSync(root,{recursive:true,force:true});}
});

test("TypeScript message handler is explicit and awaited without a successful fallback",async()=>{
  const device=new PhononDevice("device","owner",{} as never);
  await assert.rejects(device._handleInbound("conversation.message",{}));
  let done=false;device.setConversationMessageHandler(async()=>{await Promise.resolve();done=true;return {status:"not_found",requestId:"request"};});
  const attachmentIDs=["native-file:"+randomUUID()];let captured:any;
  device.setConversationMessageHandler(async params=>{captured=params;await Promise.resolve();done=true;return {status:"not_found",requestId:"request"};});
  const result=await device._handleInbound("conversation.message",{operation:"send",attachmentIDs}) as any;
  assert.equal(done,true);assert.equal(result.status,"not_found");
  assert.deepEqual(captured.attachmentIDs,attachmentIDs);
});
