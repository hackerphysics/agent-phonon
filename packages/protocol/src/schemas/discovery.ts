import { z } from "zod";
import { AgentId, Timestamp } from "./common.js";
import { AgentCapabilities } from "./capabilities.js";

/**
 * Agent / 模型发现（design §5 / D14）。
 *
 * 发现 = 内部扫描机制（非协议）+ 对外暴露接口（属协议）。本文件只定义
 * **对外接口**的数据形状：服务端借此感知「这台设备上哪些 agent 可用、
 * 各自哪些模型可用」。
 */

/** 单个模型的可用性描述。 */
export const ModelInfo = z.object({
  /** 模型 id，session.create 的 `model` 入参取自这里。 */
  id: z.string().min(1),
  /** 展示名（可选）。 */
  displayName: z.string().optional(),
  /** 上下文窗口（token，若已知）。注意：以 phonon 实测/配置为准，不盲信后端返回。 */
  contextWindow: z.number().int().positive().optional(),
  /** 该模型当前是否可用（如鉴权过期会变 false）。 */
  available: z.boolean().default(true),
});
export type ModelInfo = z.infer<typeof ModelInfo>;

/** 单个 agent 的发现条目。 */
export const AgentDescriptor = z.object({
  agentId: AgentId,
  /** 展示名，如 "Claude Code" / "OpenClaw"。 */
  displayName: z.string().min(1),
  /** 适配器内部名，如 "openclaw" / "claude-code"。 */
  adapter: z.string().min(1),
  /** 整体是否可用（已安装 + 可执行 + 凭证就绪）。 */
  available: z.boolean(),
  /** 不可用时的原因（如 "not_installed" / "not_logged_in" / "no_credentials"）。 */
  unavailableReason: z.string().optional(),
  /** agent 自身版本（若可探测）。 */
  version: z.string().optional(),
  /** 可用模型列表。 */
  models: z.array(ModelInfo),
  /** 能力声明（随 discovery 暴露，见 §7）。 */
  capabilities: AgentCapabilities,
  /** 最近一次扫描时间。 */
  scannedAt: Timestamp.optional(),
});
export type AgentDescriptor = z.infer<typeof AgentDescriptor>;

// --- discovery.list ---
export const DiscoveryListParams = z.object({
  /** 可选：只看可用的。 */
  availableOnly: z.boolean().optional(),
});
export type DiscoveryListParams = z.infer<typeof DiscoveryListParams>;

export const DiscoveryListResult = z.object({
  agents: z.array(AgentDescriptor),
});
export type DiscoveryListResult = z.infer<typeof DiscoveryListResult>;

// --- discovery.get ---
export const DiscoveryGetParams = z.object({
  agentId: AgentId,
});
export type DiscoveryGetParams = z.infer<typeof DiscoveryGetParams>;

export const DiscoveryGetResult = z.object({
  agent: AgentDescriptor,
});
export type DiscoveryGetResult = z.infer<typeof DiscoveryGetResult>;

// --- discovery.changed (phonon -> server 主动推送，notification) ---
export const DiscoveryChangedParams = z.object({
  /** 变更类型：agent 上/下线、模型增减、能力变化。 */
  kind: z.enum(["agent_added", "agent_removed", "agent_updated", "models_changed"]),
  agentId: AgentId,
  /** 变更后的完整快照（可选，便于服务端直接更新缓存）。 */
  snapshot: AgentDescriptor.optional(),
  at: Timestamp,
});
export type DiscoveryChangedParams = z.infer<typeof DiscoveryChangedParams>;
