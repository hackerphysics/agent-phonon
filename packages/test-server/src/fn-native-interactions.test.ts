import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync,realpathSync,rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AdapterRegistry,PhononStore,type AgentAdapter } from "@agent-phonon/core";
import { PhononDevice } from "@agent-phonon/server-sdk";
import { TestConn,MockAdapter } from "./harness.js";

function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(r=>resolve=r);return {promise,resolve};}
const form={title:"Confirm release",fields:[{key:"approved",label:"Approve?",type:"boolean",required:true}]};
async function setup(source:'native'|'dev'='native'){
  const root=realpathSync(mkdtempSync(join(tmpdir(),"phonon-native-interactions-"))),store=new PhononStore(join(root,"state.db"));
  const channel=deferred<Record<string,string>>(),turnEnd=deferred<void>();
  const registry=new AdapterRegistry();
  const adapter:AgentAdapter={name:"forms",capabilities:{nativeSession:true,nativeCompression:false,contextInjection:false,proactiveOutput:false,modelSwitch:false,interrupt:true,injectMidTurn:false,skillManagement:false,hooks:[],streaming:true,workflowRoles:[]},
    async discoverAgents(){return [];},async createSession(params){return {sessionId:params.sessionId,model:params.model,async terminate(){},
      async send(_input,options){channel.resolve(options.environment!);await turnEnd.promise;options.emit({type:"result",sessionId:params.sessionId as never,turnId:options.turnId,seq:0,at:new Date().toISOString(),origin:"solicited",text:"done",status:"completed",final:true});}};}};
  registry.register(adapter);const tc=new TestConn({registry,store,tenantId:"owner",workspaceRoot:root});
  const project=(await tc.call("project.create",{name:"forms",git:false}) as any).project.projectId;
  const runID=randomUUID(),ack=await tc.call("workflow.run",{project,metadata:source==='native'?{native_chat:true,native_run_id:runID}:{dev_run_id:runID},plan:{mode:"dag",nodes:[{nodeId:"reply",agent:"forms:main",model:"m1",input:"ask"}],finalNodeId:"reply"}}) as any;
  const environment=await channel.promise;
  async function close(){turnEnd.resolve();await tc.conn.dispose();store.close();rmSync(root,{recursive:true,force:true});}
  const post=(path:string,body:unknown,token=environment.AGENT_PHONON_INTERACTION_TOKEN,headers:Record<string,string>={})=>fetch(environment[path]!,{method:"POST",headers:{Authorization:"Bearer "+token,"Content-Type":"application/json",...headers},body:JSON.stringify(body)});
  return {tc,store,registry,root,runID,ack,environment,turnEnd,post,close};
}

test("native forms carry trusted lineage, survive duplicate reads and distinguish delivered from agent acknowledgement",async()=>{
  const state=await setup(),received=deferred<any>(),decision=deferred<any>();let requests=0;
  state.tc.setRequestResponder("interaction.request",params=>{requests++;received.resolve(params);return decision.promise;});
  try{
    const sending=state.post("AGENT_PHONON_INTERACTION_URL",{requestId:"release",form,presentation:{kind:"approval",decisionField:"approved"}});
    const raw=await received.promise;assert.equal(raw.nativeRunId,state.runID);assert.equal(raw.workflowId,state.ack.workflowId);assert.ok(raw.sessionId);assert.ok(raw.turnId);
    const pending=await state.tc.call("interaction.status",{requestId:"release"}) as any;assert.equal(pending.state,"pending");
    const repeated=state.post("AGENT_PHONON_INTERACTION_URL",{requestId:"release",form,presentation:{kind:"approval",decisionField:"approved"}});
    decision.resolve({requestId:"release",action:"submit",values:{approved:false}});
    const response=await (await sending).json() as any;await repeated;assert.equal(requests,1);
    assert.equal((await state.tc.call("interaction.status",{requestId:"release"}) as any).state,"delivered");
    assert.equal((await state.post("AGENT_PHONON_INTERACTION_RECEIPT_URL",{requestId:"release",decisionHash:"0".repeat(64)})).status,409);
    assert.equal((await state.post("AGENT_PHONON_INTERACTION_RECEIPT_URL",{requestId:"release",decisionHash:response.decisionHash})).status,200);
    const applied=await state.tc.call("interaction.status",{requestId:"release"}) as any;assert.equal(applied.state,"applied");assert.equal(applied.decisionHash,response.decisionHash);
    assert.equal((await state.post("AGENT_PHONON_INTERACTION_URL",{requestId:"release",form:{...form,title:"Changed"}})).status,409);
    const foreign=new TestConn({registry:state.registry,store:state.store,tenantId:"other",workspaceRoot:state.root});
    try{await assert.rejects(foreign.call("interaction.status",{requestId:"release"}));}finally{await foreign.conn.dispose();}
  }finally{await state.close();}
  await assert.rejects(state.post("AGENT_PHONON_INTERACTION_URL",{form}));
});
test('Dev native tools retain a distinct source identity, durable response and application receipt',async()=>{
  const state=await setup('dev');let requests=0;
  state.tc.setRequestResponder('interaction.request',params=>{requests++;const raw=params as any;assert.equal(raw.devRunId,state.runID);assert.equal(raw.nativeRunId,undefined);assert.equal(raw.workflowId,state.ack.workflowId);return {requestId:raw.requestId,action:'submit',values:{approved:false}};});
  try{
    const payload={requestId:'dev-native',form};
    const first=await(await state.post('AGENT_PHONON_INTERACTION_URL',payload)).json() as any;
    assert.equal(first.values.approved,false);assert.equal((await state.tc.call('interaction.status',{requestId:'dev-native'}) as any).devRunId,state.runID);
    await state.post('AGENT_PHONON_INTERACTION_URL',payload);assert.equal(requests,1);
    assert.equal((await state.post('AGENT_PHONON_INTERACTION_RECEIPT_URL',{requestId:'dev-native',decisionHash:first.decisionHash})).status,200);
    assert.equal((await state.tc.call('interaction.status',{requestId:'dev-native'}) as any).state,'applied');
    assert.equal((await state.post('AGENT_PHONON_INTERACTION_URL',{...payload,devRunId:randomUUID()})).status,409);
    await assert.rejects(state.tc.call('workflow.run',{project:state.ack.project,metadata:{native_run_id:randomUUID(),dev_run_id:randomUUID()},plan:{mode:'dag',nodes:[{nodeId:'x',agent:'forms:main',model:'m1',input:'must not run'}]}}),(error:any)=>/source domains/.test(error.message));
  }finally{await state.close();}
});
test('a Dev native form cannot receive a late approval after its owning turn is interrupted',async()=>{
  const state=await setup('dev');
  state.tc.setRequestResponder('interaction.request',async params=>{const raw=params as any;await state.tc.call('session.interrupt',{sessionId:raw.sessionId,reason:'Dev stop'});return {requestId:raw.requestId,action:'submit',values:{approved:true}};});
  try{await state.post('AGENT_PHONON_INTERACTION_URL',{requestId:'dev-late',form}).catch(()=>undefined);const proof=await state.tc.call('interaction.status',{requestId:'dev-late'}) as any;assert.equal(proof.devRunId,state.runID);assert.equal(proof.state,'cancelled');}finally{await state.close();}
});

test("the scoped loopback channel rejects foreign tokens, browser origins, oversized input and caller-controlled identities",async()=>{
  const state=await setup();
  try{
    assert.equal((await state.post("AGENT_PHONON_INTERACTION_URL",{form},"wrong")).status,403);
    assert.equal((await state.post("AGENT_PHONON_INTERACTION_URL",{form},undefined,{Origin:"https://untrusted.example"})).status,403);
    assert.equal((await state.post("AGENT_PHONON_INTERACTION_URL",{form,sessionId:"foreign"})).status,409);
    assert.equal((await state.post("AGENT_PHONON_INTERACTION_URL",{form:{title:"x".repeat(65537)}})).status,413);
  }finally{await state.close();}
});

test("a turn interruption cancels an unanswered form instead of approving it",async()=>{
  const state=await setup(),received=deferred<any>();
  state.tc.setRequestResponder("interaction.request",params=>{received.resolve(params);return new Promise(()=>{});});
  try{
    // Abort can close HTTP while the native stop remains unconfirmed. Observe
    // that expected rejection immediately, before awaiting bounded interrupt.
    const sending=state.post("AGENT_PHONON_INTERACTION_URL",{requestId:"waiting",form}).catch(()=>undefined);
    const raw=await received.promise;
    await state.tc.call("session.interrupt",{sessionId:raw.sessionId,reason:"Stop"});
    await sending;
    const receipt=await state.tc.call("interaction.status",{requestId:"waiting"}) as any;
    assert.equal(receipt.state,"cancelled");
    await assert.rejects(state.post("AGENT_PHONON_INTERACTION_URL",{form}));
    await assert.rejects(state.tc.call("interaction.status",{requestId:"missing"}));
  }finally{await state.close();}
});

test("TypeScript SDK exposes durable interaction status",async()=>{
  const calls:any[]=[];const device=new PhononDevice("device","owner",{async request(method:string,params:unknown){calls.push({method,params});return {};}} as never);
  await device.interactionStatus("review");assert.deepEqual(calls,[{method:"interaction.status",params:{requestId:"review"}}]);
});
test('TypeScript SDK preserves Dev attribution and exact decisions on both callback and receipt reads',async()=>{
  const raw={requestId:'dev-sdk',devRunId:randomUUID(),workflowId:'original-workflow',sessionId:'original-session',turnId:'original-turn',form};
  const proof={requestId:raw.requestId,devRunId:raw.devRunId,state:'applied'};
  const device=new PhononDevice('device','owner',{async request(){return proof;}} as never);
  device.setInteractionHandler(params=>{assert.equal(params,raw);return {requestId:raw.requestId,action:'submit',values:{approved:false,count:0}};});
  assert.deepEqual((await device._handleInbound('interaction.request',raw) as any).values,{approved:false,count:0});
  assert.equal((await device.interactionStatus(raw.requestId)).devRunId,raw.devRunId);
});

test("a late approval cannot cross an interrupted turn boundary",async()=>{
  const state=await setup();
  state.tc.setRequestResponder("interaction.request",async params=>{
    const request=params as any;
    await state.tc.call("session.interrupt",{sessionId:request.sessionId,reason:"Stop before decision delivery"});
    return {requestId:request.requestId,action:"submit",values:{approved:true}};
  });
  try{
    await state.post("AGENT_PHONON_INTERACTION_URL",{requestId:"late",form}).catch(()=>undefined);
    const receipt=await state.tc.call("interaction.status",{requestId:"late"}) as any;
    assert.equal(receipt.state,"cancelled");
    assert.equal(JSON.parse(String(state.store.interactionReceipt("owner","late")!.response_json)).action,"cancel");
  }finally{await state.close();}
});

test("native workflow human review acknowledges only after the controller consumes the explicit decision",async()=>{
  const root=realpathSync(mkdtempSync(join(tmpdir(),"phonon-native-review-"))),store=new PhononStore(join(root,"state.db")),registry=new AdapterRegistry();
  let round=0,requestId="";
  registry.register(new MockAdapter({reply:()=>++round===1?'```phonon.workflow.human_review\n{"title":"Review","summary":"Check scope","timeoutSeconds":30}\n```':'```phonon.workflow.done\n{"finalSummary":"review considered"}\n```'}));
  const tc=new TestConn({store,registry,workspaceRoot:root,tenantId:"review-owner"});
  tc.setRequestResponder("interaction.request",params=>{
    const request=params as any;requestId=request.requestId;
    assert.equal(request.presentation.decisionField,"approved");
    return {requestId,action:"submit",values:{approved:false,feedback:"Need more evidence"}};
  });
  try{
    const project=(await tc.call("project.create",{name:"review",git:false}) as any).project.projectId;
    const run=await tc.call("workflow.run",{project,metadata:{native_run_id:randomUUID(),native_chat:true},plan:{mode:"graph",executor:{nodeId:"exec",agent:"mock:default",model:"m1",role:"executor"},workers:[{nodeId:"worker",agent:"mock:default",model:"m1",role:"worker"}],communicationGraph:{edges:[{from:"exec",to:"worker"}],maxIterations:3}}}) as any;
    for(let i=0;i<200;i++){if((await tc.call("workflow.status",{workflowId:run.workflowId}) as any).status==="completed")break;await new Promise(resolve=>setTimeout(resolve,10));}
    const final=await tc.call("workflow.status",{workflowId:run.workflowId}) as any;
    assert.equal(final.status,"completed",JSON.stringify(final));
    assert.ok(requestId);assert.equal((await tc.call("interaction.status",{requestId}) as any).state,"applied");
    assert.equal(round,2);
  }finally{await tc.conn.dispose();store.close();rmSync(root,{recursive:true,force:true});}
});
