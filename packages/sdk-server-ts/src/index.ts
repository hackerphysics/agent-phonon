/**
 * @agent-phonon/server-sdk
 *
 * 让任何项目一键成为 agent-phonon 服务端：管理多设备、编排其上的 agent。
 */
export { PhononServer, PhononDevice, PhononSession } from "./server.js";
export type {
  PhononServerOptions, HookDecider, SendResult,
  // L3 workflow 宝松输入类型（免 branded AgentId/SessionId 型约）
  WorkflowNodeInput,
  WorkflowEdgeInput,
  WorkflowCommunicationGraphInput,
  WorkflowDiscussionTerminationInput,
  WorkflowPlanInput,
} from "./server.js";
export { RpcPeer } from "./rpc.js";
export type { Transport } from "./rpc.js";

// 重导出 L3 workflow 运行时/事件/策略类型，让 SDK 用户不需颍外装 @agent-phonon/protocol。
export type {
  WorkflowPolicy,
  WorkflowSharedContext,
  WorkflowResumeFrom,
  WorkflowRunResult,
  WorkflowStatus,
  WorkflowNodeStatus,
  WorkflowNodeResult,
  WorkflowNodeRuntime,
  WorkflowStatusResult,
  WorkflowListParams,
  WorkflowListResult,
  WorkflowEvent,
  WorkflowAckParams,
  WorkflowRoutingDirective,
  WorkflowRouteDirective,
  WorkflowFeedbackDirective,
  WorkflowReplyDirective,
  WorkflowDoneDirective,
} from "@agent-phonon/protocol";
