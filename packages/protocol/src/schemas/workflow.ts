import { z } from "zod";
import { AgentId, ProjectId, SessionId, Timestamp } from "./common.js";

/**
 * L3 Orchestration Protocol (workflow.*)
 *
 * Design rules (locked in 2026-06-23 review):
 * - L3 编排是 L1 session 的 wrapper，不重新发明 session 概念。
 * - Node 创建出来的 L1 session 的所有 stream.event 自动带 workflowId / nodeId / role
 *   字段（见 stream.ts 的 StreamEventBase 扩展），服务端按这些字段筛选/区分。
 *   workflow.event **不重复承载** session 流，只负责工作流级元事件（status / route / decision）。
 * - Executor 通过 `RoutingDirective`（agent emit → phonon 解析 → 升级成路由）告诉 phonon 把
 *   下一条消息送给哪个 worker，参考 D22 “skill 教格式”的设计原则。
 */

const ModelId = z.string().min(1);
const TurnId = z.string().min(1);
const ClientRequestId = z.string().min(1);

export const WorkflowId = z.string().min(1);
export const WorkflowNodeId = z.string().min(1);
export const WorkflowEdgeId = z.string().min(1);
export const WorkflowRoleId = z.string().min(1);

// ---------------------------------------------------------------------------
// Node / Edge / Plan
// ---------------------------------------------------------------------------

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

/**
 * Graph 模式的 executor 节点 — 用 WorkflowNode.extend 复用字段
 * （review P1-4：避免和 WorkflowNode 漂移）。
 */
export const WorkflowExecutorNode = WorkflowNode.extend({
  role: z.literal("executor").default("executor"),
});
export type WorkflowExecutorNode = z.infer<typeof WorkflowExecutorNode>;

export const WorkflowGraphPlan = z.object({
  mode: z.literal("graph"),
  executor: WorkflowExecutorNode,
  workers: z.array(WorkflowNode).min(1),
  communicationGraph: WorkflowCommunicationGraph,
});
export type WorkflowGraphPlan = z.infer<typeof WorkflowGraphPlan>;

export const WorkflowPlan = z.discriminatedUnion("mode", [WorkflowDagPlan, WorkflowGraphPlan]);
export type WorkflowPlan = z.infer<typeof WorkflowPlan>;

// ---------------------------------------------------------------------------
// Status enums
// ---------------------------------------------------------------------------

export const WorkflowStatus = z.enum([
  "queued",
  "running",
  "completed",
  "failed",
  "cancelled",
  "timeout",
]);
export type WorkflowStatus = z.infer<typeof WorkflowStatus>;

export const WorkflowNodeStatus = z.enum([
  "pending",
  "ready",
  "running",
  "completed",
  "failed",
  "skipped",
  "cancelled",
]);
export type WorkflowNodeStatus = z.infer<typeof WorkflowNodeStatus>;

// ---------------------------------------------------------------------------
// Execution policy (review P1-6)
// ---------------------------------------------------------------------------

/**
 * 工作流执行策略 — 全部可选，给服务端调度旋钮，不强制理解。
 * - timeoutSeconds        : 整个 workflow 超时；超时后 workflow 走 timeout 终态。
 * - perNodeTimeoutSeconds : 每个 node 单独超时；超时后该 node failed/timeout。
 * - onNodeFailure         : 单 node 失败的传播策略，默认 fail_workflow。
 *                           skip_dependents 跳过依赖该 node 的下游；continue 完全忽略并继续。
 * - maxParallel           : DAG 内同时 running 的 node 上限，未设默认无限。
 */
export const WorkflowPolicy = z
  .object({
    timeoutSeconds: z.number().int().positive().optional(),
    perNodeTimeoutSeconds: z.number().int().positive().optional(),
    onNodeFailure: z.enum(["fail_workflow", "skip_dependents", "continue"]).default("fail_workflow"),
    maxParallel: z.number().int().positive().optional(),
  })
  .partial();
export type WorkflowPolicy = z.infer<typeof WorkflowPolicy>;

// ---------------------------------------------------------------------------
// workflow.run
// ---------------------------------------------------------------------------

export const WorkflowRunParams = z.object({
  project: ProjectId,
  worktreeId: z.string().optional(),
  plan: WorkflowPlan,
  input: z.string().optional(),
  /** 执行策略；不传走全默认。 */
  policy: WorkflowPolicy.optional(),
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

// ---------------------------------------------------------------------------
// Node runtime state (review P0-2: 加 result 字段，下游能拿到上游产物)
// ---------------------------------------------------------------------------

/**
 * Node 终态产物 — 给 DAG 依赖节点 / executor 决策提供数据通道。
 * text 来自 L1 StreamResultEvent.text；status 与之对齐；usage 透传 token 统计。
 */
export const WorkflowNodeResult = z.object({
  text: z.string().optional(),
  status: z.enum(["completed", "interrupted", "aborted", "failed", "timeout"]),
  usage: z
    .object({
      inputTokens: z.number().int().nonnegative().optional(),
      outputTokens: z.number().int().nonnegative().optional(),
    })
    .optional(),
});
export type WorkflowNodeResult = z.infer<typeof WorkflowNodeResult>;

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
  /** 终态产物（P0-2）。pending/running 节点为 undefined。 */
  result: WorkflowNodeResult.optional(),
});
export type WorkflowNodeRuntime = z.infer<typeof WorkflowNodeRuntime>;

// ---------------------------------------------------------------------------
// workflow.status / list / cancel
// ---------------------------------------------------------------------------

export const WorkflowStatusParams = z.object({ workflowId: WorkflowId });
export type WorkflowStatusParams = z.infer<typeof WorkflowStatusParams>;

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
  /**
   * 最终结果引用 — DAG 模式下若 plan.finalNodeId 命中，则为该 node 的 result.text；
   * graph 模式下为 executor 的 result.text（如果 executor 已完成）。
   */
  finalText: z.string().optional(),
});
export type WorkflowStatusResult = z.infer<typeof WorkflowStatusResult>;

export const WorkflowCancelParams = z.object({ workflowId: WorkflowId, reason: z.string().optional() });
export type WorkflowCancelParams = z.infer<typeof WorkflowCancelParams>;
export const WorkflowCancelResult = z.object({ workflowId: WorkflowId, status: z.literal("cancelled") });
export type WorkflowCancelResult = z.infer<typeof WorkflowCancelResult>;

export const WorkflowListParams = z.object({
  status: WorkflowStatus.optional(),
  projectId: ProjectId.optional(),
  /** ISO 时间窗：含 since、不含 until。 */
  since: Timestamp.optional(),
  until: Timestamp.optional(),
  limit: z.number().int().positive().max(100).default(50).optional(),
  cursor: z.string().optional(),
});
export type WorkflowListParams = z.infer<typeof WorkflowListParams>;
export const WorkflowListResult = z.object({
  workflows: z.array(WorkflowStatusResult),
  nextCursor: z.string().optional(),
});
export type WorkflowListResult = z.infer<typeof WorkflowListResult>;

// ---------------------------------------------------------------------------
// workflow.event (P0-1: 只承载工作流级元事件；session 流走 stream.event)
// P0-3: 复用 stream.ack 机制 — 元事件挂 sessionId 时随 ack 自动清理；
//       不挂 session 的纯 workflow 状态事件由 workflow.ack 单独 ack（见 methods.ts）。
// ---------------------------------------------------------------------------

export const WorkflowEvent = z.object({
  workflowId: WorkflowId,
  seq: z.number().int().nonnegative(),
  type: z.enum([
    "workflow.status", // 工作流整体状态变化（queued/running/completed/failed/cancelled/timeout）
    "node.status", // 单个 node 状态变化（含终态时的 result）
    "edge.route", // executor 路由到某个 worker（实际触发）
    "executor.decision", // executor 给出路由决策（解析自 RoutingDirective）
    // 注：原 "node.stream" 已删除（P0-1）。session 输出走 stream.event 并自带 workflowId/nodeId。
  ]),
  nodeId: WorkflowNodeId.optional(),
  sessionId: SessionId.optional(),
  turnId: TurnId.optional(),
  agent: AgentId.optional(),
  model: ModelId.optional(),
  role: WorkflowRoleId.optional(),
  status: z.union([WorkflowStatus, WorkflowNodeStatus]).optional(),
  /** 终态时的产物（与 WorkflowNodeRuntime.result 同形）。 */
  result: WorkflowNodeResult.optional(),
  payload: z.record(z.unknown()).optional(),
  timestamp: Timestamp,
});
export type WorkflowEvent = z.infer<typeof WorkflowEvent>;

// ---------------------------------------------------------------------------
// workflow.ack — server → phonon 确认 workflow 元事件（P0-3）
// 与 stream.ack 平行；元事件不一定有 sessionId（如 workflow.status），所以
// 单独按 workflowId + seq 确认，phonon 据此清理 workflow 维度的 outbox。
// ---------------------------------------------------------------------------

export const WorkflowAckParams = z.object({
  workflowId: WorkflowId,
  lastSeq: z.number().int().nonnegative(),
});
export type WorkflowAckParams = z.infer<typeof WorkflowAckParams>;

// ---------------------------------------------------------------------------
// Routing directive (P1-5)
// Executor agent 在输出里 emit 一段 fenced JSON / structured block，由 phonon 解析后
// 升级成内部路由动作。adapter 配套的 executor skill 教 agent 这个格式。
// 协议层只定义形态；具体解析器（fenced block prefix / json-only / etc.）由 phonon 实现选择。
// ---------------------------------------------------------------------------

export const WorkflowRoutingDirective = z.object({
  kind: z.literal("workflow.route"),
  /** 目标 worker nodeId；可单播或广播。 */
  to: z.union([WorkflowNodeId, z.array(WorkflowNodeId).min(1)]),
  /** 发给目标 worker 的消息内容。 */
  message: z.string(),
  /** 路由理由（可选，进 executor.decision 事件的 payload）。 */
  reason: z.string().optional(),
  /** 宣告流程结束；置 true 时 phonon 停止迭代，本轮 executor 输出作为最终结果。 */
  terminate: z.boolean().default(false),
  /** 透传 metadata。 */
  metadata: z.record(z.unknown()).optional(),
});
export type WorkflowRoutingDirective = z.infer<typeof WorkflowRoutingDirective>;
