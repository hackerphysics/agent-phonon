import { z } from "zod";
import { AgentId, ProjectId, SessionId, Timestamp } from "./common.js";

const ModelId = z.string().min(1);
const TurnId = z.string().min(1);
const ClientRequestId = z.string().min(1);

export const WorkflowId = z.string().min(1);
export const WorkflowNodeId = z.string().min(1);
export const WorkflowEdgeId = z.string().min(1);
export const WorkflowRoleId = z.string().min(1);

export const WorkflowNode = z.object({
  nodeId: WorkflowNodeId,
  agent: AgentId,
  model: ModelId,
  role: WorkflowRoleId.optional(),
  input: z.string().optional(),
  systemPrompt: z.string().optional(),
  dependsOn: z.array(WorkflowNodeId).optional(),
  sessionId: SessionId.optional(),
  agentConfig: z.record(z.unknown()).optional(),
  metadata: z.record(z.unknown()).optional(),
});
export type WorkflowNode = z.infer<typeof WorkflowNode>;

export const WorkflowEdge = z.object({
  edgeId: WorkflowEdgeId.optional(),
  from: WorkflowNodeId,
  to: WorkflowNodeId,
  label: z.string().optional(),
  condition: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
});
export type WorkflowEdge = z.infer<typeof WorkflowEdge>;

export const WorkflowDagPlan = z.object({
  mode: z.literal("dag"),
  nodes: z.array(WorkflowNode).min(1),
  edges: z.array(WorkflowEdge).optional(),
  finalNodeId: WorkflowNodeId.optional(),
});
export type WorkflowDagPlan = z.infer<typeof WorkflowDagPlan>;

export const WorkflowCommunicationGraph = z.object({
  edges: z.array(WorkflowEdge).default([]),
  allowSelfLoop: z.boolean().default(false),
  maxIterations: z.number().int().positive().default(12),
});
export type WorkflowCommunicationGraph = z.infer<typeof WorkflowCommunicationGraph>;

export const WorkflowGraphPlan = z.object({
  mode: z.literal("graph"),
  executor: z.object({
    nodeId: WorkflowNodeId,
    agent: AgentId,
    model: ModelId,
    role: z.literal("executor").default("executor"),
    systemPrompt: z.string().optional(),
    agentConfig: z.record(z.unknown()).optional(),
  }),
  workers: z.array(WorkflowNode).min(1),
  communicationGraph: WorkflowCommunicationGraph,
});
export type WorkflowGraphPlan = z.infer<typeof WorkflowGraphPlan>;

export const WorkflowPlan = z.discriminatedUnion("mode", [WorkflowDagPlan, WorkflowGraphPlan]);
export type WorkflowPlan = z.infer<typeof WorkflowPlan>;

export const WorkflowStatus = z.enum(["queued", "running", "completed", "failed", "cancelled", "timeout"]);
export type WorkflowStatus = z.infer<typeof WorkflowStatus>;

export const WorkflowNodeStatus = z.enum(["pending", "ready", "running", "completed", "failed", "skipped", "cancelled"]);
export type WorkflowNodeStatus = z.infer<typeof WorkflowNodeStatus>;

export const WorkflowRunParams = z.object({
  project: ProjectId,
  worktreeId: z.string().optional(),
  plan: WorkflowPlan,
  input: z.string().optional(),
  clientRequestId: ClientRequestId.optional(),
  metadata: z.record(z.unknown()).optional(),
});
export type WorkflowRunParams = z.infer<typeof WorkflowRunParams>;

export const WorkflowRunResult = z.object({
  workflowId: WorkflowId,
  status: WorkflowStatus,
  createdAt: Timestamp,
});
export type WorkflowRunResult = z.infer<typeof WorkflowRunResult>;

export const WorkflowStatusParams = z.object({ workflowId: WorkflowId });
export type WorkflowStatusParams = z.infer<typeof WorkflowStatusParams>;

export const WorkflowNodeRuntime = z.object({
  nodeId: WorkflowNodeId,
  status: WorkflowNodeStatus,
  agent: AgentId,
  model: ModelId,
  role: WorkflowRoleId.optional(),
  sessionId: SessionId.optional(),
  turnId: TurnId.optional(),
  startedAt: Timestamp.optional(),
  completedAt: Timestamp.optional(),
  error: z.string().optional(),
});
export type WorkflowNodeRuntime = z.infer<typeof WorkflowNodeRuntime>;

export const WorkflowStatusResult = z.object({
  workflowId: WorkflowId,
  status: WorkflowStatus,
  project: ProjectId,
  mode: z.enum(["dag", "graph"]),
  nodes: z.array(WorkflowNodeRuntime),
  createdAt: Timestamp,
  updatedAt: Timestamp,
  completedAt: Timestamp.optional(),
  error: z.string().optional(),
});
export type WorkflowStatusResult = z.infer<typeof WorkflowStatusResult>;

export const WorkflowCancelParams = z.object({ workflowId: WorkflowId, reason: z.string().optional() });
export type WorkflowCancelParams = z.infer<typeof WorkflowCancelParams>;
export const WorkflowCancelResult = z.object({ workflowId: WorkflowId, status: z.literal("cancelled") });
export type WorkflowCancelResult = z.infer<typeof WorkflowCancelResult>;

export const WorkflowListParams = z.object({
  status: WorkflowStatus.optional(),
  limit: z.number().int().positive().max(100).default(50).optional(),
  cursor: z.string().optional(),
});
export type WorkflowListParams = z.infer<typeof WorkflowListParams>;
export const WorkflowListResult = z.object({ workflows: z.array(WorkflowStatusResult), nextCursor: z.string().optional() });
export type WorkflowListResult = z.infer<typeof WorkflowListResult>;

export const WorkflowEvent = z.object({
  workflowId: WorkflowId,
  seq: z.number().int().nonnegative(),
  type: z.enum(["workflow.status", "node.status", "node.stream", "edge.route", "executor.decision"]),
  nodeId: WorkflowNodeId.optional(),
  sessionId: SessionId.optional(),
  turnId: TurnId.optional(),
  agent: AgentId.optional(),
  model: ModelId.optional(),
  role: WorkflowRoleId.optional(),
  status: z.union([WorkflowStatus, WorkflowNodeStatus]).optional(),
  payload: z.record(z.unknown()).optional(),
  timestamp: Timestamp,
});
export type WorkflowEvent = z.infer<typeof WorkflowEvent>;
