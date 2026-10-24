import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { AgentWorkflowInput } from "../schemas/conversation-workflow.js";

test("workflow files preserve explicit scoped references and reject invalid handoff graphs",()=>{
  const first={id:"producer",title:"Produce",agentID:randomUUID(),bindingID:randomUUID(),input:"Produce"};
  const second={...first,id:"review",dependsOn:["producer"],artifactSources:["producer"],attachmentIDs:["native-file:"+randomUUID()]};
  const request={operation:"execute",requestId:randomUUID(),delivery:"detached",plan:{projectID:randomUUID(),title:"Plan",goal:"Goal",review:"request",nodes:[first,second]}};
  const accepted=AgentWorkflowInput.parse(request);assert.equal(accepted.operation,"execute");
  if(accepted.operation==="execute"){assert.deepEqual(accepted.plan.nodes[1]!.attachmentIDs,second.attachmentIDs);assert.deepEqual(accepted.plan.nodes[1]!.artifactSources,["producer"]);}
  for(const change of [{artifactSources:["review"]},{artifactSources:["producer","producer"]},{attachmentIDs:[...second.attachmentIDs,...second.attachmentIDs]},{attachmentIDs:["/etc/passwd"]}])assert.equal(AgentWorkflowInput.safeParse({...request,plan:{...request.plan,nodes:[first,{...second,...change}]}}).success,false);
});
