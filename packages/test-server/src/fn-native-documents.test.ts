import test from "node:test";
import assert from "node:assert/strict";
import { createHash,randomUUID } from "node:crypto";
import { mkdtempSync,rmSync } from "node:fs";
import { writeFile,symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NativeDocumentInput } from "@agent-phonon/protocol";
import { AdapterRegistry,PhononStore } from "@agent-phonon/core";
import { MockAdapter,TestConn } from "./harness.js";

test("native document directives never accept bytes, identities or external paths",()=>{
  const input={requestId:randomUUID(),path:"output/report.md"};
  assert.ok(NativeDocumentInput.safeParse(input).success);
  for(const extra of [{ownerID:randomUUID()},{conversationID:randomUUID()},{sessionId:"other"},{content:{data:"invented"}}])assert.equal(NativeDocumentInput.safeParse({...input,...extra}).success,false);
  for(const path of ["/etc/passwd","../secret","dir/../../secret","C:\\secret","\\\\host\\secret"])assert.equal(NativeDocumentInput.safeParse({...input,path}).success,false);
});

test("controller publishes actual bounded project bytes with current-turn lineage and refuses retained or escaping directives",{skip:!["linux","darwin"].includes(process.platform)},async()=>{
  const root=mkdtempSync(join(tmpdir(),"phonon-document-")),outside=mkdtempSync(join(tmpdir(),"phonon-document-outside-")),store=new PhononStore(join(root,"state.db")),registry=new AdapterRegistry();
  const adapter=new MockAdapter(),original=adapter.createSession.bind(adapter),calls:any[]=[];let retained:any;
  const bytes=Buffer.from([0,1,2,250,251,252]),serverRef="native-file:"+randomUUID();
  await writeFile(join(outside,"private"),"not allowed");
  adapter.createSession=async params=>{const session=await original(params);session.send=async(_input,options)=>{
    retained=options.publishDocument;
    await writeFile(join(params.cwd,"output.bin"),bytes);await symlink(join(outside,"private"),join(params.cwd,"escape"));
    const result=await options.publishDocument!({requestId:randomUUID(),path:"output.bin",mimeType:"application/octet-stream",caption:"Actual output"});
    assert.equal(result.delivered[0]!.serverRef,serverRef);
    await assert.rejects(options.publishDocument!({requestId:randomUUID(),path:"escape"}));
    await assert.rejects(options.publishDocument!({requestId:randomUUID(),path:"output.bin",content:"invented"}as never));
    const headers={Authorization:"Bearer "+options.environment!.AGENT_PHONON_INTERACTION_TOKEN,"Content-Type":"application/json"};
    const response=await fetch(options.environment!.AGENT_PHONON_DOCUMENT_URL!,{method:"POST",headers,body:JSON.stringify({requestId:randomUUID(),path:"output.bin"})});assert.equal(response.status,200);
    options.emit({type:"result",sessionId:params.sessionId,turnId:options.turnId,seq:0,at:new Date().toISOString(),text:"published",status:"completed",final:true}as never);
  };return session;};
  registry.register(adapter);const tc=new TestConn({registry,store,workspaceRoot:root,tenantId:"owner"});
  tc.setRequestResponder("document.send",raw=>{const value=raw as any;calls.push(value);return {delivered:[{name:value.documents[0].name,ok:true,serverRef}]};});
  try{
    const project=(await tc.call("project.create",{name:"files",git:false})as any).project.projectId,nativeRunId=randomUUID();
    const run=await tc.call("workflow.run",{project,metadata:{native_run_id:nativeRunId,native_chat:true},plan:{mode:"dag",nodes:[{nodeId:"reply",agent:"mock:default",model:"m1",input:"files"}],finalNodeId:"reply"}})as any;
    let status:any;const deadline=Date.now()+10000;do{status=await tc.call("workflow.status",{workflowId:run.workflowId});if(["completed","failed","timeout"].includes(status.status))break;await new Promise(resolve=>setTimeout(resolve,10));}while(Date.now()<deadline);
    assert.equal(status.status,"completed",JSON.stringify(status));assert.equal(calls.length,2);
    for(const call of calls){assert.equal(call.nativeRunId,nativeRunId);assert.equal(call.workflowId,run.workflowId);assert.ok(call.sessionId&&call.turnId);assert.equal(call.documents[0].sha256,createHash("sha256").update(bytes).digest("hex"));assert.deepEqual(Buffer.from(call.documents[0].content.data,"base64"),bytes);}
    await assert.rejects(retained({requestId:randomUUID(),path:"output.bin"}));assert.equal(calls.length,2);
  }finally{await tc.conn.dispose();store.close();rmSync(root,{recursive:true,force:true});rmSync(outside,{recursive:true,force:true});}
});
