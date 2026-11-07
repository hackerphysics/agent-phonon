import {test} from "node:test";
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {AgentWorkflowInput} from "../schemas/conversation-workflow.js";
import {InteractionRequestResult} from "../schemas/interaction.js";

const nodes=["lead","worker"].map(id=>({id,title:id,agentID:randomUUID(),bindingID:randomUUID(),input:"Work"}));
const base={operation:"execute",requestId:randomUUID(),plan:{projectID:randomUUID(),title:"Modes",goal:"Goal",review:"request",nodes}};
test("DE channel accepts every bounded mode and exact historical status",()=>{
  for(const mode of [undefined,"dag","graph","discussion"]){
    const plan={...base.plan,...(mode?{mode}:{}),...(mode==="graph"?{executorID:"lead",communicationGraph:{edges:[{from:"lead",to:"worker"}],maxIterations:3}}:{}),...(mode==="discussion"?{chairmanID:"lead",termination:{maxRounds:2}}:{})};
    assert.equal(AgentWorkflowInput.safeParse({...base,plan}).success,true,mode);
  }
  assert.equal(AgentWorkflowInput.safeParse({operation:"status",requestId:randomUUID(),nodeID:"worker",attempt:3,offset:4096}).success,true);
});
test("mode parameters cannot authorize mixed plans, cycles or foreign routes",()=>{
  for(const fields of [
    {mode:"dag",executorID:"lead"},
    {mode:"graph",executorID:"missing",communicationGraph:{edges:[{from:"missing",to:"worker"}]}},
    {mode:"graph",executorID:"lead",communicationGraph:{edges:[{from:"lead",to:"foreign"}]}},
    {mode:"discussion",chairmanID:"lead",termination:{maxRounds:11}},
    {mode:"discussion",chairmanID:"missing",termination:{maxRounds:2}},
  ])assert.equal(AgentWorkflowInput.safeParse({...base,plan:{...base.plan,...fields}}).success,false);
});
test("creator replies are typed, exact-question bound and retain nonhuman response attribution",()=>{
  const response={operation:"respond",requestId:randomUUID(),requestID:randomUUID(),requestVersion:1,action:"submit",values:{region:"east"}};
  assert.equal(AgentWorkflowInput.safeParse(response).success,true);
  for(const patch of [{requestVersion:0},{requestID:"guessed"},{ownerID:randomUUID()},{humanApproved:true}])assert.equal(AgentWorkflowInput.safeParse({...response,...patch}).success,false);
  const responder={kind:"de",id:randomUUID(),runID:randomUUID()};
  assert.deepEqual(InteractionRequestResult.parse({requestId:"node-question",action:"submit",values:{region:"east"},responder}).responder,responder);
});
