import test from "node:test";
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {AdapterRegistry,PhononStore} from "@agent-phonon/core";
import {MockAdapter,TestConn} from "./harness.js";

test("history/read survive embedded and HTTP channels, retain lineage and expire with their native turn",async()=>{
  const root=mkdtempSync(join(tmpdir(),"phonon-group-history-"));let store:PhononStore|undefined,tc:TestConn|undefined;
  const calls:any[]=[],conversationID=randomUUID(),projectID=randomUUID(),messageID=randomUUID();let retained:any,wrong=false;
  const message={id:messageID,historyOrder:"5",author:"assistant",senderID:randomUUID(),senderName:"DE",createdAt:new Date().toISOString(),text:"Shared background",textLength:17,isExcerpt:false,mentionIDs:[],attachmentIDs:[]};
  try{
    store=new PhononStore(join(root,"state.db"));const registry=new AdapterRegistry(),adapter=new MockAdapter(),original=adapter.createSession.bind(adapter);
    adapter.createSession=async params=>{const session=await original(params);session.send=async(_input,options)=>{
      retained=options.conversationMessage;
      const history=await options.conversationMessage!({operation:"history",throughOrder:"9",beforeOrder:"8",limit:2});assert.equal(history.status,"history");
      const result=await options.conversationMessage!({operation:"read",messageID,offset:0});assert.equal(result.status,"message");
      const response=await fetch(options.environment!.AGENT_PHONON_MESSAGE_URL!,{method:"POST",headers:{authorization:"Bearer "+options.environment!.AGENT_PHONON_INTERACTION_TOKEN,"content-type":"application/json"},body:JSON.stringify({operation:"history"})});
      assert.equal(response.status,200);assert.equal((await response.json() as any).status,"history");
      wrong=true;await assert.rejects(options.conversationMessage!({operation:"read",messageID,offset:0}),/identity mismatch/);
      await assert.rejects(options.conversationMessage!({operation:"history",throughOrder:"9"}),/identity mismatch/);wrong=false;
      options.emit({type:"result",sessionId:params.sessionId,turnId:options.turnId,seq:0,at:new Date().toISOString(),text:"Read shared background",status:"completed",final:true} as never);
    };return session;};
    registry.register(adapter);tc=new TestConn({registry,store,workspaceRoot:root,tenantId:"owner"});
    tc.setRequestResponder("conversation.message",raw=>{
      const input=raw as any;calls.push(input);
      return input.operation==="history"?{status:"history",conversationID,projectID,throughOrder:wrong?"8":input.throughOrder??"9",messages:[message]}
        :{status:"message",conversationID,projectID,message:{...message,id:wrong?randomUUID():messageID},offset:input.offset??0};
    });
    const project=(await tc.call("project.create",{name:"group-history",git:false}) as any).project.projectId,nativeRunId=randomUUID();
    const run=await tc.call("workflow.run",{project,metadata:{native_chat:true,native_run_id:nativeRunId},plan:{mode:"dag",nodes:[{nodeId:"reply",agent:"mock:default",model:"m1",input:"Read"}],finalNodeId:"reply"}}) as any;
    let completed=false;
    for(let i=0;i<200;i++){const status=await tc.call("workflow.status",{workflowId:run.workflowId}) as any;if(status.status==="completed"){completed=true;break;}await new Promise(resolve=>setTimeout(resolve,10));}
    assert.ok(completed);assert.equal(calls.length,5);assert.ok(calls.every(call=>call.nativeRunId===nativeRunId&&call.workflowId===run.workflowId&&call.sessionId&&call.turnId));
    await assert.rejects(retained({operation:"history"}));await assert.rejects(retained({operation:"read",messageID}));assert.equal(calls.length,5);
  }finally{await tc?.conn.dispose();store?.close();rmSync(root,{recursive:true,force:true});}
});
