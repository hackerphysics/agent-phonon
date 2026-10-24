import test from "node:test";
import assert from "node:assert/strict";
import {PhononDevice,PhononSession,type SkillSelectionInput,type WorkflowPlanInput} from "./server.js";
import {parseParams} from "@agent-phonon/protocol";

test("TypeScript session helpers retain structured skill scope/version/force and original turn identity",async()=>{
  const calls:Array<{method:string;params:unknown}>=[];
  const device=new PhononDevice("device","owner",{request:async(method:string,params:unknown)=>{calls.push({method,params:parseParams("session.send",params)});return {};}} as never);
  const session=new PhononSession(device,"session");
  const skills:SkillSelectionInput[]=["plain",{name:"selected",version:"1.2.3",scope:"project",force:false},{name:"other",scope:"global",force:true}];
  await session.send("Original task",{skills,clientRequestId:"exact-source",turnId:"turn",whenBusy:"queue"});
  assert.deepEqual(calls,[{method:"session.send",params:{sessionId:"session",input:"Original task",skills,clientRequestId:"exact-source",turnId:"turn",whenBusy:"queue"}}]);
});

const pin={name:"selected",scope:"project" as const,version:"1.2.3",revision:"a".repeat(64),installationId:"11111111-1111-4111-8111-111111111111"};
const capabilities=["workflow_skill_selection_v1","pinned_skill_selection_v1"];
function deviceWith(flags:unknown=capabilities){
  const calls:Array<{method:string;params:any}>=[];
  const device=new PhononDevice("device","owner",{request:async(method:string,params:unknown)=>{calls.push({method,params});return method==="device.info"?{capabilities:flags}:{};}} as never);
  return {device,calls};
}
test("TypeScript exact skill selectors retain revision/installation identity after capability confirmation",async()=>{
  const f=deviceWith(),session=new PhononSession(f.device,"session");
  await session.send("Exact task",{skills:[pin],clientRequestId:"original",turnId:"turn"});
  assert.deepEqual(f.calls.map(call=>call.method),["device.info","session.send"]);
  assert.deepEqual(parseParams("session.send",f.calls[1]!.params).skills,[pin]);
});
for(const mode of["dag","graph","discussion"] as const)test(`TypeScript ${mode} workflows retain every node's bounded selectors`,async()=>{
  const f=deviceWith(),node=(nodeId:string)=>({nodeId,agent:"mock:a",model:"m",skills:[pin]});
  const plan:WorkflowPlanInput=mode==="dag"?{mode,nodes:[node("one")]}:mode==="graph"?{mode,executor:node("exec"),workers:[node("worker")],communicationGraph:{edges:[]}}:{mode,topic:"Owned discussion",participants:[node("one"),node("two")],chairman:"one"};
  await f.device.workflow.run({project:"owned",plan,clientRequestId:"fixed"});
  assert.deepEqual(f.calls.map(call=>call.method),["device.info","workflow.run"]);
  assert.deepEqual(f.calls[1]!.params,{project:"owned",plan,clientRequestId:"fixed"});
  const parsed=parseParams("workflow.run",f.calls[1]!.params),nodes=parsed.plan.mode==="dag"?parsed.plan.nodes:parsed.plan.mode==="graph"?[parsed.plan.executor,...parsed.plan.workers]:parsed.plan.participants;
  for(const node of nodes)assert.deepEqual(node.skills,[pin]);
});
for(const flags of[[],["pinned_skill_selection_v1"],["workflow_skill_selection_v1"],"workflow_skill_selection_v1",null])test(`TypeScript fails closed before a legacy/invalid capability target executes: ${JSON.stringify(flags)}`,async()=>{
  const f=deviceWith(flags);
  await assert.rejects(f.device.workflow.run({project:"owned",plan:{mode:"dag",nodes:[{nodeId:"n",agent:"mock:a",model:"m",skills:[pin]}]}}),/device_update_required/);
  assert.deepEqual(f.calls.map(call=>call.method),["device.info"]);
});
test("TypeScript does not infer feature support from an info reply with no capability observation",async()=>{
  const calls:string[]=[];const device=new PhononDevice("device","owner",{request:async(method:string)=>{calls.push(method);return {};}} as never);
  await assert.rejects(new PhononSession(device,"s").send("Owned",{skills:[pin]}),/device_update_required/);assert.deepEqual(calls,["device.info"]);
});
test("TypeScript workflow and pinned session packets are captured before asynchronous capability work",async()=>{
  let release!:(value:unknown)=>void;const calls:Array<{method:string;params:any}>=[];
  const f=new PhononDevice("device","owner",{request:async(method:string,params:unknown)=>{calls.push({method,params});return method==="device.info"?new Promise(resolve=>{release=resolve;}):{};}} as never);
  const selection={...pin},plan:WorkflowPlanInput={mode:"dag",nodes:[{nodeId:"n",agent:"mock:a",model:"m",skills:[selection]}]};
  const work=f.workflow.run({project:"owned",plan,clientRequestId:"fixed"});selection.installationId="22222222-2222-4222-8222-222222222222";release({capabilities});await work;
  assert.deepEqual(calls[1]!.params.plan.nodes[0].skills,[pin]);
  const session=new PhononSession(f,"s"),selected={...pin},sent=session.send("Owned",{skills:[selected]});selected.revision="b".repeat(64);release({capabilities});await sent;
  assert.deepEqual(calls[3]!.params.skills,[pin]);
});
test("TypeScript schedules keep exact skill fields in create/update and gate workflow nodes too",async()=>{
  const f=deviceWith(),target={runKind:"workflow" as const,project:"owned",plan:{mode:"dag" as const,nodes:[{nodeId:"n",agent:"mock:a",model:"m",skills:[pin]}]}};
  await f.device.schedule.create({name:"Owned schedule",trigger:{kind:"manual"},target});
  await f.device.schedule.update({scheduleId:"original",target});
  assert.deepEqual(f.calls.map(call=>call.method),["device.info","schedule.create","device.info","schedule.update"]);assert.deepEqual(f.calls[1]!.params.target,target);assert.deepEqual(f.calls[3]!.params.target,target);
  const legacy=deviceWith([]);await assert.rejects(legacy.device.schedule.create({name:"Owned",trigger:{kind:"manual"},target}),/device_update_required/);assert.deepEqual(legacy.calls.map(call=>call.method),["device.info"]);
});
test("TypeScript legacy unskilled workflows/schedules retain their original zero-probe behavior",async()=>{
  const f=deviceWith([]),plan:WorkflowPlanInput={mode:"dag",nodes:[{nodeId:"n",agent:"mock:a",model:"m"}]};
  await f.device.workflow.run({project:"owned",plan});await f.device.schedule.update({scheduleId:"old",name:"New label"});
  assert.deepEqual(f.calls.map(call=>call.method),["workflow.run","schedule.update"]);
});
test("TypeScript direct pinned schedules need only pin support and info failures never fall back",async()=>{
  const f=deviceWith(["pinned_skill_selection_v1"]);await f.device.schedule.update({scheduleId:"owned",target:{project:"owned",skills:[pin]}});
  assert.deepEqual(f.calls.map(call=>call.method),["device.info","schedule.update"]);
  const calls:string[]=[];const unavailable=new PhononDevice("d","owner",{request:async(method:string)=>{calls.push(method);throw Error("controlled info unavailable");}} as never);
  await assert.rejects(new PhononSession(unavailable,"s").send("Owned",{skills:[pin]}),/info unavailable/);assert.deepEqual(calls,["device.info"]);
});
test("TypeScript name-only workflow nodes require workflow selection support without demanding pin support",async()=>{
  const f=deviceWith(["workflow_skill_selection_v1"]);await f.device.workflow.run({project:"owned",plan:{mode:"dag",nodes:[{nodeId:"n",agent:"mock:a",model:"m",skills:["selected"]}]}});
  assert.deepEqual(f.calls.map(call=>call.method),["device.info","workflow.run"]);
});
test("TypeScript inbound canonical workflow handlers preserve catalog targets and exact Project pins without a mutation probe",async()=>{
  const f=deviceWith(),uuid="11111111-1111-4111-8111-111111111111",{scope:ignored,...selected}=pin;
  f.device.setConversationWorkflowHandler(async input=>({status:"status",data:input}));
  const source={nativeRunId:uuid,workflowId:"original-workflow",sessionId:"original-session",turnId:"original-turn"};
  for(const input of[{...source,operation:"catalog",projectID:uuid,skillTarget:{agentID:uuid,bindingID:uuid}},
    {...source,operation:"execute",requestId:uuid,plan:{projectID:uuid,title:"Work",goal:"Original selection",review:"request",nodes:[{id:"work",title:"Work",agentID:uuid,bindingID:uuid,input:"Work",skills:[selected],
      canvasSkill:{productID:"product",deviceBindingID:"association",baseBindingRevision:uuid,operationID:uuid}}]}}]){
    const parsed=parseParams("conversation.workflow",input);
    assert.deepEqual(await f.device._handleInbound("conversation.workflow",parsed),{status:"status",data:parsed});
  }
  assert.deepEqual(f.calls,[]);
});
