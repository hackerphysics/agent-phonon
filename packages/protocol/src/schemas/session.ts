import { z } from "zod";
import { AgentId, ProjectId, SessionId, Timestamp, Verbosity } from "./common.js";

/**
 * L1 Session 协议原语（design §4）。
 *
 * 铁律：session 必须绑定 agent（D15）。每条 session 天生属于某个 agent + model，
 * 这是 session 的一等身份，不是可选配置。发任务 = 在 session 里对话。
 */

/** session 状态。 */
/**
 * session 状态（design D19）。
 * - idle       : 活着、空闲、就绪可接 send（create 后初始态；turn 结束/interrupt 后回到这）
 * - running    : agent 正在执行一个 turn
 * - paused     : 挂起（重启后从 DB 恢复、原生 ref 尚未 re-attach；或被显式暂停），需恢复才能用
 * - terminated : 已结束销毁
 */
export const SessionStatus = z.enum(["idle", "running", "paused", "terminated"]);
export type SessionStatus = z.infer<typeof SessionStatus>;

/**
 * 上下文条目 —— 用于 initialContext / inject。
 * 设计成「角色 + 文本」的最小通用形态，具体 adapter 自行翻译成原生格式。
 */
export const ContextItem = z.object({
  role: z.enum(["system", "user", "assistant"]),
  content: z.string(),
});
export type ContextItem = z.infer<typeof ContextItem>;

// ---------------------------------------------------------------------------
// session.create
// ---------------------------------------------------------------------------
export const SessionCreateParams = z.object({
  /** 可选：幂等键（P0-3，断线重发去重）。 */
  clientRequestId: z.string().optional(),
  /** 必填：绑定的项目（所有 session 必须有项目目录，D23）。 */
  project: ProjectId,
  /** 可选：跑在哪个 worktree（缺省用项目主工作区，D25）。 */
  worktreeId: z.string().optional(),
  /** 必填：绑定的 agent（来自 discovery 的 agentId）。 */
  agent: AgentId,
  /** 必填：绑定的模型（必须在该 agent 的可用模型列表内）。 */
  model: z.string().min(1),
  /** 透传给 adapter 的 agent 私有配置（cwd、工具白名单、thinking 等）。 */
  agentConfig: z.record(z.unknown()).optional(),
  /** 初始上下文设置（system prompt / 预置对话）。 */
  initialContext: z.array(ContextItem).optional(),
  /** 默认返回详细度，send 可覆盖。默认 messages。 */
  verbosity: Verbosity.default("messages"),
  /** 可选：调用方自带的标签，便于服务端侧对账（phonon 原样回显）。 */
  clientTag: z.string().optional(),
});
export type SessionCreateParams = z.infer<typeof SessionCreateParams>;

export const SessionCreateResult = z.object({
  sessionId: SessionId,
  /** 回显绑定身份，方便调用方确认。 */
  project: ProjectId,
  agent: AgentId,
  model: z.string(),
  status: SessionStatus,
  createdAt: Timestamp,
});
export type SessionCreateResult = z.infer<typeof SessionCreateResult>;

// ---------------------------------------------------------------------------
// session.send  —— 发任务 = 对话；结果以流式 events 异步返回（见 stream.ts）
// ---------------------------------------------------------------------------

/**
 * 忙碌处理模式（D18）—— 新消息进来时上一轮还没结束怎么办：
 * - queue    ：等待，上一轮结束后自动发送积压消息（默认，最安全）。
 * - interrupt：中断当前 turn（session 存活），再发新消息；需 capability.interrupt。
 * - inject   ：不中断，在下一次 tool call 边界插入输入让 agent 接着处理；
 *              需 capability.injectMidTurn（agent 原生接口或通过 hook 实现）。
 * 不论哪种模式，**消息不丢**：要么按序送达、要么明确拒绝并告知原因。
 */
export const WhenBusy = z.enum(["queue", "interrupt", "inject"]);
export type WhenBusy = z.infer<typeof WhenBusy>;

export const SessionSendParams = z.object({
  sessionId: SessionId,
  /** 用户输入 / 任务内容。 */
  input: z.string(),
  /**
   * 可选：幂等键（P0-3）。服务端断线重发同一 send 时带相同值，
   * phonon 去重，避免 agent 收两遍同样消息；重复回 `errDuplicateRequest` 或原 turnId。
   */
  clientRequestId: z.string().optional(),
  /**
   * 可选：本轮指定要用的 skill（D26）。每项可是简单名字（string），
   * 或结构体 {name,version?,scope?,force?}（P2-12，消除同名 global/project 歧义）。
   * phonon 保证：(1) skill 在 agent 能访问到的位置；(2) 上下文注入强制加载指令。
   * 优先级：send 指定 > project skill > global skill。
   */
  skills: z
    .array(
      z.union([
        z.string(),
        z.object({
          name: z.string().min(1),
          version: z.string().optional(),
          scope: z.enum(["global", "project"]).optional(),
          force: z.boolean().optional(),
        }),
      ]),
    )
    .optional(),
  /** 可选：覆盖本轮详细度。 */
  verbosity: Verbosity.optional(),
  /**
   * 忙碌时的处理模式（D18）。缺省 queue。
   * 若选的模式该 agent 不支持（看 capability）且未设 fallback → errCapabilityUnsupported。
   */
  whenBusy: WhenBusy.default("queue"),
  /**
   * 可选：降级模式（P1-11）。当 whenBusy 该 agent 不支持时，不报错而自动降级为它，
   * 保证自动化编排连贯。如 whenBusy="inject", fallback="queue"。
   */
  fallback: WhenBusy.optional(),
  /**
   * 可选：本轮关联 id。phonon 会把该轮所有 stream.event 标上同一 turnId，
   * 调用方据此聚合流式输出。缺省由 phonon 生成并在 ack 中返回。
   */
  turnId: z.string().optional(),
});
export type SessionSendParams = z.infer<typeof SessionSendParams>;

/** send 的同步 ack（真正的内容走 stream.event 异步推）。 */
export const SessionSendAck = z.object({
  sessionId: SessionId,
  turnId: z.string(),
  accepted: z.literal(true),
  /**
   * 本次 send 的实际处由：
   * - started   ：立即开始执行（session 空闲）
   * - queued    ：已排队（whenBusy=queue 且正忙）
   * - interrupted：已中断上一轮并开始本轮（whenBusy=interrupt）
   * - injected  ：将在下一 tool call 边界插入（whenBusy=inject）
   */
  disposition: z.enum(["started", "queued", "interrupted", "injected"]),
  /** queued 时的队列位置（从 1 起）。 */
  queuePosition: z.number().int().positive().optional(),
});
export type SessionSendAck = z.infer<typeof SessionSendAck>;

// ---------------------------------------------------------------------------
// session.interrupt —— 打断当前正在进行的 turn（session 存活，D18）
// 区别于 session.terminate（销毁整个 session）。
// P0-2：interrupt 后 phonon 必须为被打断的 turn 发一条终态 stream.event
//   { type:"result", final:true, status:"interrupted" }，服务端状态机才不悬空。
// ---------------------------------------------------------------------------
export const SessionInterruptParams = z.object({
  sessionId: SessionId,
  /** 可选：中断原因（传给 agent / 记录）。 */
  reason: z.string().optional(),
});
export type SessionInterruptParams = z.infer<typeof SessionInterruptParams>;

export const SessionInterruptResult = z.object({
  sessionId: SessionId,
  /** 被中断的 turn（若当时有在跑的）。 */
  interruptedTurnId: z.string().optional(),
  /** 中断后 session 状态（通常回到 active 空闲）。 */
  status: SessionStatus,
});
export type SessionInterruptResult = z.infer<typeof SessionInterruptResult>;

// ---------------------------------------------------------------------------
// session.inject —— 上下文注入
// ---------------------------------------------------------------------------
export const SessionInjectParams = z.object({
  sessionId: SessionId,
  context: z.array(ContextItem),
});
export type SessionInjectParams = z.infer<typeof SessionInjectParams>;

export const SessionInjectResult = z.object({
  sessionId: SessionId,
  injected: z.number().int().nonnegative(),
});
export type SessionInjectResult = z.infer<typeof SessionInjectResult>;

// ---------------------------------------------------------------------------
// session.compress —— 压缩双模（design §4 / D7）
// ---------------------------------------------------------------------------
export const CompressMode = z.enum(["native", "custom"]);
export type CompressMode = z.infer<typeof CompressMode>;

export const SessionCompressParams = z.object({
  sessionId: SessionId,
  /** native = 透传 agent 原生压缩；custom = phonon 自有压缩引擎。 */
  mode: CompressMode,
  /**
   * custom 模式下的策略名（P2-15）。**server-private：phonon 不做协议层枚举校验**，
   * 透传给 adapter/压缩引擎自行解释（如 summary / truncate_keep_recent）。
   */
  strategy: z.string().optional(),
  /** dropToolIO 策略：保留最近 N 个 tool call 及其 result，默认 3。 */
  keepRecentToolCalls: z.number().int().nonnegative().optional(),
});
export type SessionCompressParams = z.infer<typeof SessionCompressParams>;

export const SessionCompressResult = z.object({
  sessionId: SessionId,
  mode: CompressMode,
  /** 压缩前后的 token 估算（若可得）。 */
  tokensBefore: z.number().int().nonnegative().optional(),
  tokensAfter: z.number().int().nonnegative().optional(),
  /** 简短摘要/说明。 */
  summary: z.string().optional(),
});
export type SessionCompressResult = z.infer<typeof SessionCompressResult>;

// ---------------------------------------------------------------------------
// session.terminate
// ---------------------------------------------------------------------------
export const SessionTerminateParams = z.object({
  sessionId: SessionId,
  /**
   * 可选：销毁会话时顺手清理其专用 worktree（P1-10）。
   * 仅当该 session 跑在一个专为它建的 worktree 上才生效；主工作区不清。
   */
  cleanWorktree: z.boolean().default(false),
});
export type SessionTerminateParams = z.infer<typeof SessionTerminateParams>;

export const SessionTerminateResult = z.object({
  sessionId: SessionId,
  status: z.literal("terminated"),
  /** 若 cleanWorktree 且确实清了，返回被清理的 worktreeId。 */
  cleanedWorktreeId: z.string().optional(),
});
export type SessionTerminateResult = z.infer<typeof SessionTerminateResult>;

// ---------------------------------------------------------------------------
// session.switchModel —— 同会话中途切换模型（design D16）
// agent 绑定不可变，但 model 可换：某模型不行了就换另一个。
// ---------------------------------------------------------------------------
export const SessionSwitchModelParams = z.object({
  sessionId: SessionId,
  /** 新模型，必须在该 session 绑定 agent 的可用模型列表内。 */
  model: z.string().min(1),
  /**
   * running 时的策略（P1-8）：
   * - reject（默认）     ：running 时拒绝切换，避免 adapter 状态不一致
   * - afterCurrentTurn：等当前 turn 结束后再切
   * - interrupt        ：打断当前 turn 立即切
   * idle 时忽略此参数，直接切。
   */
  whenRunning: z.enum(["reject", "afterCurrentTurn", "interrupt"]).default("reject"),
});
export type SessionSwitchModelParams = z.infer<typeof SessionSwitchModelParams>;

export const SessionSwitchModelResult = z.object({
  sessionId: SessionId,
  /** 切换前的模型（便于调用方记录/回滚）。 */
  previousModel: z.string(),
  model: z.string(),
  /**
   * 可选警告（P1-8 / Minimax）：adapter 发现潜在不兼容（系统提示格式/tool schema 变化）
   * 时填入，server 据此决定是否继续。
   */
  warnings: z.array(z.string()).optional(),
  /** 若 whenRunning=afterCurrentTurn 且当时 running，表示已排期未立即生效。 */
  deferred: z.boolean().optional(),
});
export type SessionSwitchModelResult = z.infer<typeof SessionSwitchModelResult>;

// ---------------------------------------------------------------------------
// session.status / session.list  —— 始终携带 agent 身份
// ---------------------------------------------------------------------------
export const SessionMeta = z.object({
  sessionId: SessionId,
  /** 绑定的项目（一等身份，D23）。 */
  project: ProjectId,
  /** 绑定的 agent 身份，全程携带。 */
  agent: AgentId,
  model: z.string(),
  status: SessionStatus,
  /** 当 status=running 时，正在执行的 turnId（服务端据此知道「在跑哪一轮」）。 */
  currentTurnId: z.string().optional(),
  /** 队列中等待的 send 数（whenBusy=queue 积压，D18）。 */
  queuedCount: z.number().int().nonnegative().optional(),
  /**
   * 上下文信息（D33）——adapter 能提供时填，便于 server 监控上下文压力。
   */
  context: z
    .object({
      /** 上下文窗口总容量（token）。 */
      contextWindow: z.number().int().nonnegative().optional(),
      /** 已用上下文（token，若可估）。 */
      usedTokens: z.number().int().nonnegative().optional(),
      /** 已用上下文占比 0-100。 */
      usagePercent: z.number().min(0).max(100).optional(),
      /** 已发生的压缩次数。 */
      compactions: z.number().int().nonnegative().optional(),
    })
    .optional(),
  verbosity: Verbosity,
  clientTag: z.string().optional(),
  createdAt: Timestamp,
  lastActiveAt: Timestamp.optional(),
  /** phonon 自存的会话快照 JSONL 路径（可观测/审计；device 本地路径）。 */
  transcriptPath: z.string().optional(),
});
export type SessionMeta = z.infer<typeof SessionMeta>;

export const SessionStatusParams = z.object({
  sessionId: SessionId,
});
export type SessionStatusParams = z.infer<typeof SessionStatusParams>;

export const SessionStatusResult = SessionMeta;
export type SessionStatusResult = z.infer<typeof SessionStatusResult>;

export const SessionListParams = z.object({
  /** 可选：按项目过滤。 */
  project: ProjectId.optional(),
  /** 可选：按 agent 过滤。 */
  agent: AgentId.optional(),
  /** 可选：按状态过滤。 */
  status: SessionStatus.optional(),
  /** 可选：分页上限（P2-14）。 */
  limit: z.number().int().positive().max(500).optional(),
  /** 可选：分页游标（上一页返回的 nextCursor）。 */
  cursor: z.string().optional(),
});
export type SessionListParams = z.infer<typeof SessionListParams>;

export const SessionListResult = z.object({
  sessions: z.array(SessionMeta),
  /** 下一页游标；缺省/null 表示已到末尾。 */
  nextCursor: z.string().optional(),
});
export type SessionListResult = z.infer<typeof SessionListResult>;
