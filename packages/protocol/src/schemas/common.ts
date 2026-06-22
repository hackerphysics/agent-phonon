import { z } from "zod";

/**
 * agent-phonon wire protocol — shared primitives.
 *
 * 设计参考 docs/design.md。本文件定义全协议复用的基础类型：
 * 协议版本、各类 ID、verbosity、错误码。
 */

/** 协议语义版本。device 与 server 握手时比对（见 connect.hello）。 */
export const PROTOCOL_VERSION = "0.1.0" as const;

// ---------------------------------------------------------------------------
// ID 原语（全部是不透明字符串，调用方不应解析其结构）
// ---------------------------------------------------------------------------

/** phonon 侧全局唯一的 session id（归属某一 tenant）。 */
export const SessionId = z.string().min(1).brand<"SessionId">();
export type SessionId = z.infer<typeof SessionId>;

/** discovery 返回的 agent 标识，也是 session.create 的 `agent` 入参。 */
export const AgentId = z.string().min(1).brand<"AgentId">();
export type AgentId = z.infer<typeof AgentId>;

/** 项目标识（项目 = 目录 + Git）。所有 session 必须绑定一个项目。 */
export const ProjectId = z.string().min(1).brand<"ProjectId">();
export type ProjectId = z.infer<typeof ProjectId>;

/** 本地配置赋予的稳定租户 id（= 一条服务端连接，见 design D13）。 */
export const TenantId = z.string().min(1).brand<"TenantId">();
export type TenantId = z.infer<typeof TenantId>;

/** 设备自身标识（一台设备一个，用于服务端区分多设备，但 phonon 不感知其他设备）。 */
export const DeviceId = z.string().min(1).brand<"DeviceId">();
export type DeviceId = z.infer<typeof DeviceId>;

// ---------------------------------------------------------------------------
// Verbosity — 控制 session 返回内容的多少（design §4）
// ---------------------------------------------------------------------------

/**
 * 4 档详细度，create 时设定、send 可覆盖：
 * - final    : 仅最终结果
 * - messages : 每轮消息
 * - tools    : 含工具调用
 * - trace    : 全量（含思考）
 */
export const Verbosity = z.enum(["final", "messages", "tools", "trace"]);
export type Verbosity = z.infer<typeof Verbosity>;

// ---------------------------------------------------------------------------
// 错误码 — JSON-RPC error.data.code 用（design 中提到的归一化错误）
// ---------------------------------------------------------------------------

/**
 * 应用级错误码（区别于 JSON-RPC 传输级 code）。
 * 放在 JSON-RPC error 对象的 `data.appCode` 字段，便于调用方稳定判别。
 */
export const PhononErrorCode = z.enum([
  // 协议/握手
  "errProtocolMismatch", // device 与 server 协议版本不兼容
  "errUnauthorized", // device key 无效（注：终端用户鉴权在 server，不在此）
  // 租户隔离（design §6 / D13）
  "errSessionNotInTenant", // 跨租户访问 session
  "errTenantQuotaExceeded", // 触达 per-tenant 配额
  "errDeviceQuotaExceeded", // 触达全局配额
  // 发现 / agent 绑定（design §5 / D14 / D15）
  "errAgentUnavailable", // 目标 agent 不存在或不可用
  "errModelUnavailable", // 模型不在该 agent 的可用列表内
  // session 生命周期
  "errSessionNotFound",
  "errSessionTerminated", // 操作了已结束的 session
  "errSessionBusy", // session 正忙（如上一轮未结束）
  // 能力
  "errCapabilityUnsupported", // adapter 不支持该操作（如 native 压缩缺失）
  // hook / HITL
  "errHookResolveInvalid", // hook.resolve 的裁决非法
  "errHookTimeout", // 等待服务端裁决超时
  // 项目 / skill（D23-D26）
  "errProjectNotFound",
  "errProjectExists", // 同名/同路径项目已存在
  "errProjectHasActiveSessions", // 项目下还有 active session（remove 拦）
  "errSkillNotFound",
  "errSkillScopeInvalid", // scope=project 但缺 projectId 等
  "errSkillInstallFailed",
  // git / worktree（D25）
  "errWorktreeNotFound",
  "errWorktreeHasChanges", // 未提交变更，非 force 不清
  "errWorktreeInUse", // worktree 还有 active session
  "errBranchNotMerged", // 分支未合并，非 force 不删
  "errBranchInUse", // 分支仍被某 worktree 检出
  // 文档 / 上传（D20）
  "errDocumentTooLarge", // 超 maxUploadBytes
  "errDocumentPathDenied", // 路径不在项目范围 / 命中 deny
  // 本地 policy（D27）
  "errPolicyDenied", // 被设备本地安全策略拦截
  // 幂等
  "errDuplicateRequest", // clientRequestId 重复（已处理过）
  // 通用
  "errInvalidParams",
  "errInternal",
]);
export type PhononErrorCode = z.infer<typeof PhononErrorCode>;

/** 统一附在 JSON-RPC error.data 上的结构。 */
export const PhononErrorData = z.object({
  appCode: PhononErrorCode,
  /** 可选的人类可读补充（不用于程序判别）。 */
  detail: z.string().optional(),
  /** 可选：相关 session/agent/tenant，便于服务端定位。 */
  sessionId: SessionId.optional(),
  agentId: AgentId.optional(),
  tenantId: TenantId.optional(),
});
export type PhononErrorData = z.infer<typeof PhononErrorData>;

/** ISO-8601 时间戳字符串（统一用字符串，避免时区/精度歧义）。 */
export const Timestamp = z.string().datetime({ offset: true });
export type Timestamp = z.infer<typeof Timestamp>;
