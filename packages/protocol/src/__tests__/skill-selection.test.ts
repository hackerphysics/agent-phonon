import test from "node:test";
import assert from "node:assert/strict";
import {parseParams,WorkflowNode,SkillSelection,AgentWorkflowInput} from "../index.js";

const pin={name:"selected",scope:"project" as const,revision:"a".repeat(64),installationId:"11111111-1111-4111-8111-111111111111"};
test("protocol keeps exact skill identity in session/workflow/schedule inputs without turning it into a grant",()=>{
  assert.deepEqual(parseParams("session.send",{sessionId:"s",input:"Owned",skills:[pin]}).skills,[pin]);
  const node={nodeId:"n",agent:"mock:a",model:"m",skills:[pin]};assert.deepEqual(WorkflowNode.parse(node).skills,[pin]);
  const target=parseParams("schedule.create",{name:"Owned",trigger:{kind:"manual"},target:{project:"p",runKind:"workflow",plan:{mode:"dag",nodes:[node]}}}).target;
  assert.ok(target.plan?.mode==="dag");assert.deepEqual(target.plan.nodes[0]!.skills,[pin]);
});
for(const patch of[{revision:"short"},{revision:"A".repeat(64)},{installationId:"not-an-installation"},{ownerID:"other"},{force:"true"},{scope:"tenant"}])test(`protocol rejects invalid or authority-bearing selectors ${JSON.stringify(patch)}`,()=>{
  assert.throws(()=>SkillSelection.parse({...pin,...patch}));
});
test("workflow skill selection retains the same bounded maximum and strict selector shape",()=>{
  const node={nodeId:"n",agent:"mock:a",model:"m"};assert.equal(WorkflowNode.parse({...node,skills:Array.from({length:16},()=>pin)}).skills?.length,16);
  assert.throws(()=>WorkflowNode.parse({...node,skills:Array.from({length:17},()=>pin)}));assert.throws(()=>WorkflowNode.parse({...node,skills:"selected"}));
  assert.deepEqual(SkillSelection.parse("legacy-name"),"legacy-name");assert.deepEqual(SkillSelection.parse({name:"legacy-name",scope:"project",force:false}),{name:"legacy-name",scope:"project",force:false});
});
test("canonical employee workflows catalog exact Project skill pins and keep them in the frozen plan input",()=>{
  const uuid="11111111-1111-4111-8111-111111111111",{scope:ignored,...skill}=pin;
  assert.deepEqual(AgentWorkflowInput.parse({operation:"catalog",projectID:uuid,skillTarget:{agentID:uuid,bindingID:uuid}}).operation,"catalog");
  const input={operation:"execute",requestId:uuid,plan:{projectID:uuid,title:"Work",goal:"Original source",review:"request",nodes:[{id:"n",title:"Node",agentID:uuid,bindingID:uuid,input:"Work",skills:[skill]}]}};
  const parsed=AgentWorkflowInput.parse(input);assert.ok(parsed.operation==="execute");assert.deepEqual(parsed.plan.nodes[0]!.skills,[skill]);
  for(const choices of [[pin],["selected"],[{name:"selected"}],[skill,skill],[],Array.from({length:17},(_,i)=>({...skill,name:"skill-"+i}))])
    assert.throws(()=>AgentWorkflowInput.parse({...input,plan:{...input.plan,nodes:[{...input.plan.nodes[0],skills:choices}]}}));
});
test("canonical Canvas workflow references carry post-install identity, never a source credential or caller approval",()=>{
  const uuid="11111111-1111-4111-8111-111111111111",canvasSkill={productID:"product",deviceBindingID:"association",baseBindingRevision:uuid,operationID:uuid};
  const node={id:"work",title:"Canvas",agentID:uuid,bindingID:uuid,input:"Work",canvasSkill};
  const input={operation:"execute",requestId:uuid,plan:{projectID:uuid,title:"Canvas",goal:"Current source",review:"request",nodes:[node]}};
  assert.ok(AgentWorkflowInput.safeParse(input).success);
  for(const extra of[{token:"secret"},{path:"/other"},{sourceHash:"a".repeat(64)},{ownerID:uuid},{approve:true}])
    assert.equal(AgentWorkflowInput.safeParse({...input,plan:{...input.plan,nodes:[{...node,canvasSkill:{...canvasSkill,...extra}}]}}).success,false);
  const {scope:ignored,...selected}=pin;
  assert.equal(AgentWorkflowInput.safeParse({...input,plan:{...input.plan,nodes:[{...node,skills:[{...selected,name:"product-intent-canvas"}]}]}}).success,false);
});
