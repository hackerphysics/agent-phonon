import { z } from "zod";
import { AgentId, ProjectId, SessionId, Timestamp } from "./common.js";

/**
 * L3 Orchestration Protocol (workflow.*)
 *
 * Locked design (2026-06-23 v0.4 + v0.5 review):
 * - L3 编排是 L1 session 的 wrapper，不重新发明 session 概念。
 * - Node 创建出来的 L1 session 的所有 stream.event 自动带 workflowId / nodeId / role
 *   字段（见 stream.ts），服务端按这些字段筛选/区分。
 *   workflow.event **不重复承载** session 流，只负责工作流级元事件。
 * - phonon 只提供通用底层能力。category / wisdom 这类业务由上层 server 自行实现。
 */

const ModelId = z.string().min(1);
const TurnId = z.string().min(1);
const ClientRequestId = z.string().min(1);

export const WorkflowId = z.string().min(1);
export const WorkflowNodeId = z.string().min(1);
export const WorkflowEdgeId = z.string().min(1);

/**
 * Role 字段说明（review v0.5）：
 *   role 是这个 agent 在当前 workflow 中扮演的角色，由调用方自由定义。
 *   phonon 只做透传 + 在 stream.event / workflow.event 里回显，不解析其语义。
 *   常见示例："executor" / "worker" / "reviewer" / "coder" / "planner" / "chairman" / "participant"
 *   上层服务可以把 role 映射到 category / system prompt / 模型选择，phonon 不感知。
 */
export const WorkflowRoleId = z.string().min(1);

// ---------------------------------------------------------------------------
// Node / Edge / Plan
// ---------------------------------------------------------------------------

export const WorkflowNode = z.object({
  nodeId: WorkflowNodeId,
  agent: AgentId,
  model: ModelId,
  /** 该节点在 workflow 中扮演的角色（由调用方定义，phonon 仅回显）。 */
  role: WorkflowRoleId.optional(),
  input: z.string().optional(),
  systemPrompt: z.string().optional(),
  dependsOn: z.array(WorkflowNodeId).optional(),
  sessionId: SessionId.optional(),
  agentConfig: z.record(z.unknown()).optional(),
  metadata: z.record(z.unknown()).optional(),

  // ===== 执行环境（v0.6 改造。62026-06-23。不兼容旧 worktreeId 句柄语义）=====
  /**
   * 此节点跑在哪个 project。不传默认继承 workflow 级 project。
   * project + workflow 级都没传，phonon 拒接。
   */
  project: ProjectId.optional(),
  /**
   * 隔离 key。调用方自定义的任意字符串。
   * - 不传  → 该节点跑在 project 主目录
   * - 传了 → phonon 按 (projectId, worktreeId) 复合键维护隔离 worktree：
   *           • 同一 workflow 内首次看到 → 创建 worktree（branch 名 phonon 自动生成）
   *           • 同一 workflow 内后续节点用同一 key → 复用同一 worktree
   *           • 不跨 workflow 复用（下次 workflow.run 同名 key 是新 worktree）
   * - workflow 终态时 phonon 尝试自动清理：git status 干净则 worktree remove；dirty 则保留
   *   且发 workflow.status payload warn。创出的 branch 一律不删。
   */
  worktreeId: z.string().optional(),
  /**
   * Git branch。意义联动 worktreeId：
   * - 不传 worktreeId 传 branch → 在 project 主目录先 `git checkout <branch>` 再跑（对主目录有副作用，法定调用方负责）
   * - 传 worktreeId 首次传 branch → 作为新 worktree 的 base branch（从它检出）
   * - 传 worktreeId 未传 branch 首次 → 从 project 当前 branch 检出
   * - worktreeId 复用时 branch 被忽略（worktree 已存在）
   */
  branch: z.string().optional(),
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

// ---------------------------------------------------------------------------
// Discussion plan (review v0.5 借鉴 4，对应 Foreman _run_discuss_rounds)
//
// N 个 agent 平等参与多轮讨论，chairman 控场决定何时终止。
// 与 graph 模式根本区别：没有路由 + 没有主从；所有 participant 每轮并行发言。
// ---------------------------------------------------------------------------

export const WorkflowDiscussionPlan = z.object({
  mode: z.literal("discussion"),
  /** 主题（initial input） — 所有 participant 第一轮收到这个。 */
  topic: z.string(),
  /** 参与者列表（无主从）。 */
  participants: z.array(WorkflowNode).min(2),
  /** Chairman 必须是 participants 之一的 nodeId，每轮所有 participant 发完它再 review + 决定续/停。 */
  chairman: WorkflowNodeId,
  termination: z
    .object({
      /** chairman 输出含该信号则终止。 */
      chairmanSignal: z.string().default("[DISCUSS_END]"),
      /** 硬上限。 */
      maxRounds: z.number().int().positive().default(10),
      /** 自然达成共识的检测字符串（任一 participant 输出含此则终止，可选）。 */
      consensusSignal: z.string().optional(),
    })
    .default({}),
});
export type WorkflowDiscussionPlan = z.infer<typeof WorkflowDiscussionPlan>;

export const WorkflowPlan = z.discriminatedUnion("mode", [
  WorkflowDagPlan,
  WorkflowGraphPlan,
  WorkflowDiscussionPlan,
]);
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
// Execution policy
// ---------------------------------------------------------------------------

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
// Shared context (review v0.5 借鉴 3：通用共享上下文，不是 SSOT)
//
// phonon 在每个 node create 时把 sharedContext 注入到 systemPrompt（追加形式）。
// 文件路径会被 phonon 解析为 workspace 内绝对路径（受 policy 沙箱保护）。
// 文件不存在则跳过该文件，不阻塞 workflow。
// ---------------------------------------------------------------------------

export const WorkflowSharedContext = z.object({
  /** 直接文本：phonon 原样追加到每个 node 的 systemPrompt。 */
  text: z.string().optional(),
  /** workspace 相对路径列表（受 policy 沙箱）；phonon 读取后拼成 markdown 段追加到 systemPrompt。 */
  files: z.array(z.string()).optional(),
  /** 注入位置：prepend 在最前，append 在最后，默认 append。 */
  placement: z.enum(["prepend", "append"]).default("append"),
});
export type WorkflowSharedContext = z.infer<typeof WorkflowSharedContext>;

// ---------------------------------------------------------------------------
// Resume (review v0.5 借鉴 2：checkpoint + 断点续跑)
// ---------------------------------------------------------------------------

export const WorkflowResumeFrom = z.object({
  /** 要恢复的 workflowId（必须先前 run 过，并有 checkpoint）。 */
  workflowId: WorkflowId,
  /**
   * 起点策略：
   * - "last_success_dependents" : 从最后成功节点的下游开始（DAG 默认）
   * - "failed_node"              : 重跑失败的那个 node（其他成功 node 不重做）
   * - "node:<nodeId>"            : 显式指定从某 node 开始
   */
  strategy: z.union([
    z.literal("last_success_dependents"),
    z.literal("failed_node"),
    z.string().regex(/^node:/),
  ]).default("failed_node"),
  /** 可选：重置某些 node 的状态（让它们重跑），覆盖默认策略。 */
  rerunNodes: z.array(WorkflowNodeId).optional(),
});
export type WorkflowResumeFrom = z.infer<typeof WorkflowResumeFrom>;

/**
 * workflow.resume：独立 method（v0.7），取代之前用 workflow.run.resumeFrom 偷渡的方式。
 * resumeFrom 字段保留向后兼容，但 SDK 优先使用 workflow.resume。
 */
export const WorkflowResumeParams = z.object({
  workflowId: WorkflowId,
  strategy: z.union([
    z.literal("last_success_dependents"),
    z.literal("failed_node"),
    z.string().regex(/^node:/),
  ]).default("failed_node"),
  rerunNodes: z.array(WorkflowNodeId).optional(),
  /** 可选：附加给 executor 的反馈文本（HITL 后特别有用） */
  feedback: z.string().optional(),
  /** 可选：恢复时调整 sharedContext */
  sharedContextPatch: WorkflowSharedContext.optional(),
});
export type WorkflowResumeParams = z.infer<typeof WorkflowResumeParams>;


// ---------------------------------------------------------------------------
// workflow.run
// ---------------------------------------------------------------------------

export const WorkflowRunParams = z.object({
  /**
   * 默认 project。可以省略，但如果某个 node 也没传 project，phonon 会拒接。
   * v0.6 起改为可选，支持每个 node 跳不同 project 的跨项目编排场景。
   */
  project: ProjectId.optional(),
  /** 默认隔离 key；node 未传 worktreeId 时继承该值。含义及复用规则同 WorkflowNode.worktreeId。 */
  worktreeId: z.string().optional(),
  /** 默认 branch；node 未传 branch 时继承。含义同 WorkflowNode.branch。 */
  branch: z.string().optional(),
  plan: WorkflowPlan,
  input: z.string().optional(),
  policy: WorkflowPolicy.optional(),
  /** 共享上下文（v0.5 新增）。 */
  sharedContext: WorkflowSharedContext.optional(),
  /** 断点续跑（v0.5 新增）。传入则跳过 plan 重新规划，从 checkpoint 恢复。 */
  resumeFrom: WorkflowResumeFrom.optional(),
  clientRequestId: ClientRequestId.optional(),
  metadata: z.record(z.unknown()).optional(),
});
export type WorkflowRunParams = z.infer<typeof WorkflowRunParams>;

export const WorkflowRunResult = z.object({
  workflowId: WorkflowId,
  status: WorkflowStatus,
  createdAt: Timestamp,
  /** 是否走的 resume 路径。 */
  resumed: z.boolean().default(false),
});
export type WorkflowRunResult = z.infer<typeof WorkflowRunResult>;

// ---------------------------------------------------------------------------
// Node runtime state
// ---------------------------------------------------------------------------

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
  result: WorkflowNodeResult.optional(),
  /** 该节点完成的轮次计数（discussion 用；DAG/Graph 一次执行 = 1）。 */
  iterations: z.number().int().nonnegative().optional(),
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
  /** workflow 默认 project；v0.6 起可选。 */
  project: ProjectId.optional(),
  mode: z.enum(["dag", "graph", "discussion"]),
  nodes: z.array(WorkflowNodeRuntime),
  createdAt: Timestamp,
  updatedAt: Timestamp,
  completedAt: Timestamp.optional(),
  error: z.string().optional(),
  finalText: z.string().optional(),
  /** 是否可 resume：phonon 持有该 workflow 的 checkpoint。 */
  resumable: z.boolean().default(false),
});
export type WorkflowStatusResult = z.infer<typeof WorkflowStatusResult>;

export const WorkflowCancelParams = z.object({ workflowId: WorkflowId, reason: z.string().optional() });
export type WorkflowCancelParams = z.infer<typeof WorkflowCancelParams>;
export const WorkflowCancelResult = z.object({ workflowId: WorkflowId, status: z.literal("cancelled") });
export type WorkflowCancelResult = z.infer<typeof WorkflowCancelResult>;

export const WorkflowListParams = z.object({
  status: WorkflowStatus.optional(),
  projectId: ProjectId.optional(),
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
// workflow.event
// v0.5 新增事件类型：round.started / round.completed / discussion.terminated
// （为 Discussion 模式准备；DAG/Graph 不发这些）
// ---------------------------------------------------------------------------

export const WorkflowEvent = z.object({
  workflowId: WorkflowId,
  seq: z.number().int().nonnegative(),
  type: z.enum([
    "workflow.status",
    "node.status",
    "edge.route",
    "executor.decision",
    "round.started", // discussion / graph iteration 轮次开始
    "round.completed", // 一轮所有参与者发完
    "discussion.terminated", // discussion 终止（含理由）
    "human_review.requested", // executor emit workflow.human_review 触发
    "human_review.resolved",  // server 通过 interaction.respond 回复
  ]),
  nodeId: WorkflowNodeId.optional(),
  sessionId: SessionId.optional(),
  turnId: TurnId.optional(),
  agent: AgentId.optional(),
  model: ModelId.optional(),
  role: WorkflowRoleId.optional(),
  status: z.union([WorkflowStatus, WorkflowNodeStatus]).optional(),
  result: WorkflowNodeResult.optional(),
  /** 自由载荷。常见字段：iteration, from, to, reason, terminationReason 等。 */
  payload: z.record(z.unknown()).optional(),
  timestamp: Timestamp,
});
export type WorkflowEvent = z.infer<typeof WorkflowEvent>;

// ---------------------------------------------------------------------------
// workflow.ack
// ---------------------------------------------------------------------------

export const WorkflowAckParams = z.object({
  workflowId: WorkflowId,
  lastSeq: z.number().int().nonnegative(),
});
export type WorkflowAckParams = z.infer<typeof WorkflowAckParams>;

// ---------------------------------------------------------------------------
// Routing directive — v0.5 升级为判别联合（review 借鉴 1）
//
// Executor agent 在输出里 emit fenced JSON / structured block，phonon 解析后
// 升级成内部动作。新增 feedback / reply / done 三种语义，比单一 route 表达力强。
//
// kind 缺省时回退为 workflow.route（向后兼容 0.4 行为）。
// 兼容前缀：```phonon.workflow.* / ```workflow.*。
// ---------------------------------------------------------------------------

/** route：派新任务给目标 worker（v0.4 既有语义）。 */
export const WorkflowRouteDirective = z.object({
  kind: z.literal("workflow.route"),
  to: z.union([WorkflowNodeId, z.array(WorkflowNodeId).min(1)]),
  message: z.string(),
  reason: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
});
export type WorkflowRouteDirective = z.infer<typeof WorkflowRouteDirective>;

/** feedback：让目标 worker 基于上次输出返工修订（显式语义，区分于新任务）。 */
export const WorkflowFeedbackDirective = z.object({
  kind: z.literal("workflow.feedback"),
  to: WorkflowNodeId,
  message: z.string(),
  reason: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
});
export type WorkflowFeedbackDirective = z.infer<typeof WorkflowFeedbackDirective>;

/** reply：模拟键盘输入（应答目标 agent 卡住的交互提示，如 [Y/n]）。 */
export const WorkflowReplyDirective = z.object({
  kind: z.literal("workflow.reply"),
  to: WorkflowNodeId,
  /** 应答内容（通常 1-2 字符："Y"/"n"/"y" 等）。 */
  keystroke: z.string(),
  reason: z.string().optional(),
});
export type WorkflowReplyDirective = z.infer<typeof WorkflowReplyDirective>;

/** done：显式宣告 workflow 完成。 */
export const WorkflowDoneDirective = z.object({
  kind: z.literal("workflow.done"),
  /** 最终总结文本，作为 workflow.finalText。 */
  finalSummary: z.string().optional(),
  reason: z.string().optional(),
});
export type WorkflowDoneDirective = z.infer<typeof WorkflowDoneDirective>;

/**
 * human_review: 请求 server 进行人工审查（v0.7 新增）。
 *
 * Executor emit 这个 directive 后，phonon 暂停 workflow，通过 `interaction.request`
 * 反向问 server；server 返回 { approved, feedback? } 后：
 *   - approved=true   → 当作 workflow.done 处理（finalSummary = feedback ?? executor 文本）
 *   - approved=false  → 把 feedback 文本作为 executor 下一轮的输入（"revise based on review"）
 * phonon 同时 emit workflow.event { type: "human_review.requested" / "human_review.resolved" }。
 *
 * 这是设备侧底层 HITL 机制；UI 渲染、表单字段、文档关联、Feishu 集成等业务由 server 实现。
 */
export const WorkflowHumanReviewDirective = z.object({
  kind: z.literal("workflow.human_review"),
  /** 审查标题（短，给 UI 显示用） */
  title: z.string(),
  /** 审查内容/摘要（长，给 reviewer 看） */
  summary: z.string(),
  /** 关联的产物文件路径（workspace 相对） */
  artifacts: z.array(z.object({
    path: z.string(),
    role: z.enum(["report", "diff", "spec", "log", "other"]).default("other"),
  })).optional(),
  reason: z.string().optional(),
  /** 等待 server 响应的超时秒数，默认 1800 (30min) */
  timeoutSeconds: z.number().int().positive().default(1800),
});
export type WorkflowHumanReviewDirective = z.infer<typeof WorkflowHumanReviewDirective>;

/** server 对 human_review 的响应 schema（通过 interaction.respond 走 form value） */
export const WorkflowHumanReviewResponse = z.object({
  approved: z.boolean(),
  /** 反馈文字。approved=true 时可作 finalSummary；approved=false 时作 executor 下一轮输入 */
  feedback: z.string().optional(),
  reviewer: z.string().optional(),
});
export type WorkflowHumanReviewResponse = z.infer<typeof WorkflowHumanReviewResponse>;

export const WorkflowRoutingDirective = z.discriminatedUnion("kind", [
  WorkflowRouteDirective,
  WorkflowFeedbackDirective,
  WorkflowReplyDirective,
  WorkflowDoneDirective,
  WorkflowHumanReviewDirective,
]);
export type WorkflowRoutingDirective = z.infer<typeof WorkflowRoutingDirective>;
