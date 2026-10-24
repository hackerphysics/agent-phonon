import { z } from "zod";
import { TurnReasoning } from "./reasoning.js";
import { SessionId } from "./common.js";
import { SkillSelection } from "./skill.js";

export const ConversationWorkflowSkill=SkillSelection.options[1].pick({name:true,version:true,revision:true,installationId:true})
  .required({revision:true,installationId:true});
export const ConversationWorkflowSkills=z.array(ConversationWorkflowSkill).min(1).max(16)
  .refine(values=>new Set(values.map(value=>value.name)).size===values.length,"Duplicate skill name");
const skillTarget=z.object({agentID:z.string().uuid(),bindingID:z.string().uuid()}).strict();
const canvasSkill=z.object({productID:z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),deviceBindingID:z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  baseBindingRevision:z.string().uuid(),operationID:z.string().uuid()}).strict();

export const ConversationWorkflowNode=z.object({
  id:z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/),title:z.string().min(1).max(240),
  agentID:z.string().uuid(),roleID:z.string().uuid().optional(),bindingID:z.string().uuid(),
  input:z.string().min(1).max(12000),dependsOn:z.array(z.string().max(64)).max(16).default([]),
  attachmentIDs:z.array(z.string().regex(/^native-file:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)).max(5).optional().describe("Explicit existing input file IDs from this conversation and execution project, never device paths. Files are verified on the actual worker device before dispatch."),
  artifactSources:z.array(z.string().max(64)).max(16).optional().describe("Direct dependency node IDs whose published files must be transferred to this worker. No implicit forwarding. Combined inputs are capped at five files and 25 MiB."),
  reasoning:TurnReasoning.optional(),
  skills:ConversationWorkflowSkills.optional().describe("Exact immutable Project skill selections from catalog skillTarget. No global scope, device path or permission override. Pins are part of the frozen plan and human review."),
  canvasSkill:canvasSkill.optional().describe("Current Canvas product/association and recorded installation references. Uses the post-install binding revision. The controller checks fresh business authority and receipt/source identity; no credentials, source paths or approvals are accepted."),
}).strict();
export const ConversationWorkflowPlan=z.object({
  projectID:z.string().uuid(),title:z.string().min(1).max(240),goal:z.string().min(1).max(4000),
  review:z.enum(["request","not_requested"]),maxParallel:z.number().int().min(1).max(4).default(2),
  nodes:z.array(ConversationWorkflowNode).min(1).max(16),
}).strict().superRefine((plan,ctx)=>{
  const nodes=new Map(plan.nodes.map(node=>[node.id,node]));
  if(nodes.size!==plan.nodes.length){ctx.addIssue({code:"custom",message:"Duplicate node"});return;}
  const visited=new Set<string>(),active=new Set<string>();
  const visit=(id:string):boolean=>{
    if(active.has(id)||!nodes.has(id))return false;
    if(visited.has(id))return true;
    active.add(id);
    const node=nodes.get(id)!;
    if(node.canvasSkill&&(node.skills?.length===16||node.skills?.some(skill=>skill.name==="product-intent-canvas")))return false;
    if(new Set(node.attachmentIDs).size!==(node.attachmentIDs?.length??0)||new Set(node.artifactSources).size!==(node.artifactSources?.length??0)||node.artifactSources?.some(source=>!node.dependsOn.includes(source)))return false;
    if(new Set(node.dependsOn).size!==node.dependsOn.length||node.dependsOn.some(dependency=>!visit(dependency)))return false;
    active.delete(id);visited.add(id);return true;
  };
  if(plan.nodes.some(node=>!visit(node.id)))ctx.addIssue({code:"custom",message:"Dependencies must form a DAG"});
});
export type ConversationWorkflowPlan=z.infer<typeof ConversationWorkflowPlan>;
export const AgentWorkflowInput=z.discriminatedUnion("operation",[
  z.object({operation:z.literal("catalog"),projectID:z.string().uuid().optional(),offset:z.number().int().nonnegative().safe().optional(),skillTarget:skillTarget.optional()}).strict(),
  z.object({operation:z.literal("execute"),requestId:z.string().uuid(),replacesRequestId:z.string().uuid().optional(),delivery:z.enum(["wait","detached"]).optional(),plan:ConversationWorkflowPlan}).strict(),
  z.object({operation:z.literal("status"),requestId:z.string().uuid(),nodeID:z.string().max(64).optional(),offset:z.number().int().nonnegative().safe().optional()}).strict(),
]);
export type AgentWorkflowInput=z.infer<typeof AgentWorkflowInput>;
const source={nativeRunId:z.string().uuid(),workflowId:z.string().min(1).max(255),sessionId:SessionId,turnId:z.string().min(1).max(255)};
export const ConversationWorkflowParams=z.discriminatedUnion("operation",[
  AgentWorkflowInput.options[0].extend(source),AgentWorkflowInput.options[1].extend(source),AgentWorkflowInput.options[2].extend(source),
]);
export type ConversationWorkflowParams=AgentWorkflowInput & {nativeRunId:string;workflowId:string;sessionId:string;turnId:string};
export const ConversationWorkflowResult=z.object({
  status:z.enum(["catalog","status","finished","unknown"]),
  // Resource catalogs and execution results are control-plane-owned JSON, not
  // a caller-selected RPC method or device path.
  data:z.record(z.unknown()),
}).strict();
export type ConversationWorkflowResult=z.infer<typeof ConversationWorkflowResult>;
