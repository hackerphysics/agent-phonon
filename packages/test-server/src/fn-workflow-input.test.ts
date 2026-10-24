import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,realpathSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {randomUUID} from "node:crypto";
import {AdapterRegistry,PhononStore} from "@agent-phonon/core";
import {PhononDevice} from "@agent-phonon/server-sdk";
import {TestConn} from "./harness.js";

function gate(){let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return{promise,resolve};}
async function until(check:()=>boolean|Promise<boolean>){const end=Date.now()+8000;while(Date.now()<end){if(await check())return;await new Promise(resolve=>setTimeout(resolve,10));}throw Error("owned workflow input condition not observed");}
async function fixture(options:{capable?:boolean;uncertain?:boolean}={}){
  const root=realpathSync(mkdtempSync(join(tmpdir(),"phonon-workflow-input-"))),store=new PhononStore(join(root,"state.db")),finish=gate(),gap=gate(),entered=gate(),inputs:string[]=[],inserted:string[]=[];
  const registry=new AdapterRegistry();registry.register({name:"input-worker",capabilities:{nativeSession:true,nativeCompression:false,contextInjection:true,proactiveOutput:false,modelSwitch:false,interrupt:false,injectMidTurn:options.capable!==false,skillManagement:false,hooks:[],streaming:true,workflowRoles:["worker"]},discoverAgents:async()=>[],createSession:async params=>({sessionId:params.sessionId,model:params.model,
    send:async(input,opts)=>{inputs.push(input);await finish.promise;opts.emit({type:"result",sessionId:params.sessionId as never,turnId:opts.turnId,seq:0,at:new Date().toISOString(),origin:"solicited",status:"completed",text:"original done",final:true});},
    insertAtToolGap:async(input,opts)=>{entered.resolve();await gap.promise;if(opts.signal.aborted)throw Error("original gap ended");inserted.push(input);if(options.uncertain)throw Error("accepted but acknowledgement lost");},terminate:async()=>{}})});
  let tc=new TestConn({registry,store,tenantId:"owner",workspaceRoot:root});const project=(await tc.call("project.create",{name:"Owned input",git:false}) as any).project.projectId;
  const run=await tc.call("workflow.run",{project,plan:{mode:"dag",nodes:[{nodeId:"worker",agent:"input-worker:main",model:"fixture",input:"original"}],finalNodeId:"worker"},metadata:{dev_run_id:randomUUID(),dev_chat:true}}) as any;
  let node:any;await until(async()=>{node=(await tc.call("workflow.status",{workflowId:run.workflowId}) as any).nodes[0];return !!node?.turnId;});
  await until(()=>inputs.length===1);
  const request={workflowId:run.workflowId,nodeId:node.nodeId,sessionId:node.sessionId,turnId:node.turnId,inputId:randomUUID(),input:"exact steering input"};
  return{root,store,registry,finish,gap,entered,inputs,inserted,project,request,get tc(){return tc;},async restart(){await tc.conn.dispose();tc=new TestConn({registry,store,tenantId:"owner",workspaceRoot:root});},async close(){gap.resolve();finish.resolve();await tc.conn.dispose();store.close();rmSync(root,{recursive:true,force:true});}};
}

test("workflow insertion reserves an exact durable target, acknowledges only a real gap and never duplicates on read or retry",async()=>{
  const f=await fixture();try{
    const sent=f.tc.call("workflow.input",f.request);await f.entered.promise;
    const pending=await f.tc.call("workflow.input.status",{workflowId:f.request.workflowId,inputId:f.request.inputId}) as any;assert.equal(pending.receipt.state,"inserting");
    assert.equal((await f.tc.call("workflow.input",f.request) as any).state,"inserting");assert.deepEqual(f.inputs,["original"]);assert.deepEqual(f.inserted,[]);
    const stored=f.store.workflowInputGet("owner",f.request.workflowId,f.request.inputId)!;assert.equal(JSON.stringify(stored).includes(f.request.input),false);
    f.gap.resolve();const receipt=await sent as any;assert.equal(receipt.state,"inserted");assert.equal(receipt.turnId,f.request.turnId);assert.equal(receipt.sessionId,f.request.sessionId);
    assert.deepEqual(await f.tc.call("workflow.input",f.request),receipt);assert.deepEqual(f.inserted,[f.request.input]);
    f.finish.resolve();await until(async()=>(await f.tc.call("workflow.status",{workflowId:f.request.workflowId}) as any).status==="completed");
    assert.deepEqual(await f.tc.call("workflow.input",f.request),receipt);await f.restart();
    assert.equal((await f.tc.call("workflow.input.status",{workflowId:f.request.workflowId,inputId:f.request.inputId}) as any).receipt.state,"inserted");assert.deepEqual(f.inputs,["original"]);assert.deepEqual(f.inserted,[f.request.input]);
  }finally{await f.close();}
});
test("uncertain adapter delivery remains unknown across retries and connection recreation without reinsertion",async()=>{
  const f=await fixture({uncertain:true});try{
    f.gap.resolve();assert.equal((await f.tc.call("workflow.input",f.request) as any).state,"unknown");
    assert.equal((await f.tc.call("workflow.input",f.request) as any).state,"unknown");assert.deepEqual(f.inserted,[f.request.input]);
    f.finish.resolve();await until(async()=>(await f.tc.call("workflow.status",{workflowId:f.request.workflowId}) as any).status==="completed");await f.restart();
    assert.equal((await f.tc.call("workflow.input",f.request) as any).state,"unknown");assert.deepEqual(f.inputs,["original"]);assert.deepEqual(f.inserted,[f.request.input]);
  }finally{await f.close();}
});
test("wrong or stale node/session/turn bindings and unsupported adapters cannot dispatch or queue replacement work",async()=>{
  const f=await fixture();try{
    for(const patch of [{nodeId:"foreign"},{sessionId:"foreign"},{turnId:"foreign"}])await assert.rejects(f.tc.call("workflow.input",{...f.request,...patch}));
    f.finish.resolve();await until(async()=>(await f.tc.call("workflow.status",{workflowId:f.request.workflowId}) as any).status==="completed");
    await assert.rejects(f.tc.call("workflow.input",f.request));assert.deepEqual(f.inputs,["original"]);assert.deepEqual(f.inserted,[]);
  }finally{await f.close();}
  const unsupported=await fixture({capable:false});try{await assert.rejects(unsupported.tc.call("workflow.input",unsupported.request));assert.equal(unsupported.store.workflowInputGet("owner",unsupported.request.workflowId,unsupported.request.inputId),undefined);assert.deepEqual(unsupported.inserted,[]);}finally{await unsupported.close();}
});
test("a closed active window produces an uncertain receipt, never an input in a later turn",async()=>{
  const f=await fixture();try{
    const sent=f.tc.call("workflow.input",f.request);await f.entered.promise;f.finish.resolve();
    assert.equal((await sent as any).state,"unknown");f.gap.resolve();await new Promise(resolve=>setTimeout(resolve,20));
    assert.deepEqual(f.inputs,["original"]);assert.deepEqual(f.inserted,[]);assert.equal((await f.tc.call("workflow.input",f.request) as any).state,"unknown");
  }finally{await f.close();}
});
test("connection replacement fences an in-flight insertion and retains its unknown receipt without another adapter call",async()=>{
  const f=await fixture();try{
    const original=f.tc,sent=original.call("workflow.input",f.request);await f.entered.promise;
    await f.restart();
    assert.equal((await sent as any).state,"unknown");
    const proof=await f.tc.call("workflow.input.status",{workflowId:f.request.workflowId,inputId:f.request.inputId}) as any;
    assert.equal(proof.receipt.state,"unknown");assert.equal(proof.receipt.turnId,f.request.turnId);
    assert.equal((await f.tc.call("workflow.input",f.request) as any).state,"unknown");
    f.gap.resolve();f.finish.resolve();await new Promise(resolve=>setImmediate(resolve));
    assert.deepEqual(f.inputs,["original"]);assert.deepEqual(f.inserted,[]);
    assert.equal((await f.tc.call("workflow.input.status",{workflowId:f.request.workflowId,inputId:f.request.inputId}) as any).receipt.state,"unknown");
  }finally{await f.close();}
});
test("a reused input ID cannot change bytes or target, and another tenant or read-only controller cannot write",async()=>{
  const f=await fixture();let outsider:TestConn|undefined,readonly:TestConn|undefined;try{
    f.gap.resolve();await f.tc.call("workflow.input",f.request);
    for(const patch of [{input:"changed"},{turnId:"changed"},{nodeId:"changed"}])await assert.rejects(f.tc.call("workflow.input",{...f.request,...patch}));
    outsider=new TestConn({registry:f.registry,store:f.store,tenantId:"outsider",workspaceRoot:f.root});await assert.rejects(outsider.call("workflow.input.status",{workflowId:f.request.workflowId,inputId:f.request.inputId}));await assert.rejects(outsider.call("workflow.input",f.request));
    readonly=new TestConn({registry:f.registry,store:f.store,tenantId:"owner",workspaceRoot:f.root,policy:{allowedMethods:["workflow.input.status"]}});await assert.rejects(readonly.call("workflow.input",f.request));
    assert.deepEqual(f.inputs,["original"]);assert.deepEqual(f.inserted,[f.request.input]);
  }finally{await readonly?.conn.dispose();await outsider?.conn.dispose();await f.close();}
});
test("TypeScript workflow input wrappers preserve source identity and expose read-only reconciliation",async()=>{
  const calls:any[]=[];const device=new PhononDevice("device","owner",{request:async(method:string,params:any)=>{calls.push({method,params});return{};}} as never);
  const request={workflowId:"workflow",nodeId:"worker",sessionId:"session",turnId:"turn",inputId:"message",input:"unchanged"};
  await device.workflow.input(request);await device.workflow.inputStatus(request.workflowId,request.inputId);
  assert.deepEqual(calls,[{method:"workflow.input",params:request},{method:"workflow.input.status",params:{workflowId:"workflow",inputId:"message"}}]);
});
