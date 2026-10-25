import test from "node:test";
import assert from "node:assert/strict";
import {randomUUID,createHash} from "node:crypto";
import {mkdtempSync,realpathSync,rmSync,writeFileSync,readFileSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {AdapterRegistry,PhononStore,OpenClawGatewayAdapter,type EmployeeProfileTarget,type CreateSessionParams} from "@agent-phonon/core";
import {MockAdapter,TestConn} from "./harness.js";
import {qualifyOpenClawTestGateway} from "./openclaw-policy-fixture.js";

const hash=(text:string)=>createHash("sha256").update(text).digest("hex");
class ProactiveAdapter extends MockAdapter{
  records:CreateSessionParams[]=[];
  constructor(){super({name:"employee",agentIds:["employee:base"],caps:{employeeProfiles:true,proactiveOutput:true}});}
  override async createSession(params:CreateSessionParams){this.records.push(params);const session=await super.createSession(params);session.proactiveOutputReady=()=>true;return session;}
  async provisionEmployee(target:EmployeeProfileTarget){for(const[name,body]of Object.entries({"SOUL.md":`# ${target.input.name}\n\n${target.input.responsibility}\n\n${target.input.documents.soul}`,"AGENTS.md":target.input.documents.agents,"USER.md":target.input.documents.user,"TOOLS.md":target.input.documents.tools}))writeFileSync(join(target.workspace,name),body);return this.inspectEmployee(target);}
  async inspectEmployee(target:EmployeeProfileTarget){return {home:target.workspace,documentHashes:Object.fromEntries(["SOUL.md","AGENTS.md","USER.md","TOOLS.md"].map(name=>[name,hash(readFileSync(join(target.workspace,name),"utf8"))])),memoryBytes:0};}
}
test("native proactive output is controller-scoped, independently journaled and does not reuse ended task tools",async()=>{
  const root=realpathSync(mkdtempSync(join(tmpdir(),"phonon-native-proactive-"))),store=new PhononStore(join(root,"state.db")),registry=new AdapterRegistry(),adapter=new ProactiveAdapter();registry.register(adapter);
  const tc=new TestConn({store,registry,tenantId:"owner",workspaceRoot:root,policy:{allowEmployeeProfiles:true,allowedAgents:["employee:base"] as never}});
  try{
    const employee=randomUUID(),applied=await tc.call("employee.profile.apply",{employeeId:employee,revision:1,agent:"employee:base",model:"m1",profileId:"worker",name:"Worker",responsibility:"Updates",documents:{soul:"Report actual observations",agents:"Respect source scope",user:"",tools:""}}) as any;
    const anchor=randomUUID(),started=await tc.call("workflow.run",{project:applied.privateWorkspace.projectId,clientRequestId:"native-"+anchor,metadata:{native_run_id:anchor,native_chat:true},plan:{mode:"dag",nodes:[{nodeId:"reply",agent:"employee:base",model:"m1",input:"Hello",agentConfig:{employee:{id:employee,revision:1}}}],finalNodeId:"reply"}}) as any;
    let status:any;for(let i=0;i<200;i++){status=await tc.call("workflow.status",{workflowId:started.workflowId});if(status.status==="completed")break;await new Promise(resolve=>setTimeout(resolve,10));}assert.equal(status.status,"completed");
    const native=adapter.lastSession!;const before=tc.streamEvents.length;
    const emit=(id:string,text="Native scheduled report")=>(native as any).unsolicited?.({type:"message",sessionId:"spoofed",turnId:"ignored",seq:999,at:new Date().toISOString(),origin:"unsolicited",source:"cron",sourceEventId:id,role:"assistant",text,delta:false});
    emit("scheduled-one");emit("scheduled-one");
    const event:any=tc.streamEvents.at(-1)!;assert.equal(tc.streamEvents.length,before+1);assert.equal(event.nativeProactive?.employeeId,employee);assert.equal(event.nativeProactive?.anchorRunId,anchor);assert.equal(event.sessionId,adapter.records[0]!.sessionId);assert.equal(event.nativeRunId,undefined);assert.equal(event.workflowId,undefined);
    const meta=await tc.call("session.status",{sessionId:event.sessionId}) as any;assert.equal(meta.status,"idle");assert.equal(meta.proactive.ready,true);assert.equal(meta.streamNextSeq,event.seq+1);
    emit("scheduled-one","conflicting text");assert.equal(tc.streamEvents.length,before+1);assert.equal((await tc.call("session.status",{sessionId:event.sessionId}) as any).proactive.errorCode,"proactive_identity_changed");
    assert.equal(store.proactiveEventHash("owner",event.sessionId,"scheduled-one"),hash(JSON.stringify([event.text,"cron"])));
  }finally{await tc.conn.dispose();store.close();rmSync(root,{recursive:true,force:true});}
});

test("Gateway reports have stable native identities and late solicited finals cannot become proactive",async()=>{
  const adapter=new OpenClawGatewayAdapter({gateway:{baseUrl:"ws://127.0.0.1:1",token:"synthetic"}}),owned=new Set<string>();let session:any,epoch=1;
  (adapter as any).gw={connect:async()=>{},isConnected:()=>true,connectionEpoch:()=>epoch,rpc:async(method:string,params:any)=>{if(method==="chat.send")queueMicrotask(()=>session.handleEvent("chat",{state:"final",runId:params.idempotencyKey,finalText:"reply"}));return {};}};
  qualifyOpenClawTestGateway((adapter as any).gw,{cwd:tmpdir(),model:"m1",agent:"main"});
  session=await adapter.createSession({sessionId:"session",agentId:"openclaw:main",model:"m1",cwd:tmpdir(),upstreamRuns:{remember:id=>owned.add(id),owns:id=>owned.has(id)}});
  const outputs:any[]=[];session.setUnsolicitedSink((event:any)=>outputs.push(event));
  await session.send("Task",{turnId:"turn",verbosity:"final",emit:()=>{}});
  session.handleEvent("chat",{state:"final",runId:[...owned][0],finalText:"late duplicate"});assert.equal(outputs.length,0);
  session.handleEvent("chat",{state:"final",runId:"cron-real-id",source:"cron",finalText:"independent"});assert.equal(outputs.length,1);assert.equal(outputs[0].sourceEventId,"cron-real-id");assert.equal(session.proactiveOutputReady(),true);
  epoch++;assert.equal(session.proactiveOutputReady(),false);
});
