import { z } from "zod";
import { AgentId, ProjectId, SessionId, TenantId } from "./common.js";
import { WorkflowId, WorkflowPlan } from "./workflow.js";

/**
 * L4 Scheduling Protocol (schedule.* / run.*)
 *
 * Design draft 2026-06-30 (see docs/L4_SCHEDULING.md).
 *
 * 核心原则：
 * - **调度真相源在 device**：daemon 本地持 schedule 表 + 本地时钟触发；server 只是镜像视图 + 管理面。
 *   server 断连时定时任务照跑、跑完缓存、重连按同意协议补推。
 * - **不重复发明 run**：一个 run = 一次 L1 session（或 L3 workflow）。run 的 event stream 直接是
 *   该 session 的 stream.event；run 的持久化直接复用 v0.8.7 的 session JSONL transcript 快照。
 * - **webhook 是 trigger 的一种**，与 cron（定时）、manual（手动）并列，最终收敛到同一条
 *   「发起一次 run」的内部路径，只是 triggerSource 不同。
 * - **默认安全**：webhook 是「外部能打进来触发本地 agent」的最高风险入口，每 schedule 独立 token、
 *   server 验签、且 webhook 触发的 run 同样过 device consent/policy 门。
 */

export const ScheduleId = z.string().min(1).brand<"ScheduleId">();
export type ScheduleId = z.infer<typeof ScheduleId>;

export const RunId = z.string().min(1).brand<"RunId">();
export type RunId = z.infer<typeof RunId>;

// ---------------------------------------------------------------------------
// Trigger（三态：cron / webhook / manual）
// ---------------------------------------------------------------------------

/** 定时触发：本地时钟按 cron 表达式触发。tz 缺省取设备时区。 */
export const CronTrigger = z.object({
  kind: z.literal("cron"),
  /** 标准 5 段 cron 表达式：分 时 日 月 周。限长 200，恰好 5 段（防 DoS/畸形输入）。 */
  expr: z
    .string()
    .min(1)
    .max(200)
    .refine((s) => s.trim().split(/\s+/).length === 5, {
      message: "cron expr must have exactly 5 fields (minute hour day month weekday)",
    }),
  /** IANA 时区名，如 "Asia/Shanghai"。缺省用设备本地时区。 */
  tz: z.string().max(64).optional(),
});
export type CronTrigger = z.infer<typeof CronTrigger>;

/** Webhook 触发：外部 POST /hooks/<token> 命中后由 server 转成一次内部 trigger 下发。 */
export const WebhookTrigger = z.object({
  kind: z.literal("webhook"),
  /**
   * 该 schedule 专属密钥。创建时由 device 生成并返回一次；
   * schedule.get/list 默认脱敏（与 secrets redaction 一致），仅 reveal 时返回。
   */
  webhookToken: z.string().optional(),
});
export type WebhookTrigger = z.infer<typeof WebhookTrigger>;

/** 手动触发：仅能由 schedule.trigger 显式发起。 */
export const ManualTrigger = z.object({
  kind: z.literal("manual"),
});
export type ManualTrigger = z.infer<typeof ManualTrigger>;

export const ScheduleTrigger = z.discriminatedUnion("kind", [
  CronTrigger,
  WebhookTrigger,
  ManualTrigger,
]);
export type ScheduleTrigger = z.infer<typeof ScheduleTrigger>;

// ---------------------------------------------------------------------------
// Target（到点后要发起的 run 的「配方」）
// ---------------------------------------------------------------------------

export const ScheduleTarget = z.object({
  /** 复用 L1 session 还是 L3 workflow。 */
  runKind: z.enum(["session", "workflow"]).default("session"),
  /** 必须绑定 project（与 session.create 一致）。 */
  project: ProjectId,
  /** runKind=session：用哪个 agent。 */
  agent: AgentId.optional(),
  model: z.string().optional(),
  /** runKind=session：任务文本（webhook body 可注入，见实现）。 */
  prompt: z.string().optional(),
  /** runKind=workflow：L3 plan。 */
  plan: WorkflowPlan.optional(),
  agentConfig: z.record(z.unknown()).optional(),
  skills: z.array(z.string()).optional(),
});
export type ScheduleTarget = z.infer<typeof ScheduleTarget>;

// ---------------------------------------------------------------------------
// Consent（同意协议：run 结束后主动推送的粒度）
// ---------------------------------------------------------------------------

/**
 * full        = 推完整 event stream（transcript 引用 + 关键事件），server 可完整回放。
 * summary     = 只推 resultText + status + usage。
 * status-only = 只推 status + 起止时间，零内容外泄（高敏任务：跑归跑，内容不出设备）。
 */
export const SchedulePushConsent = z.enum(["full", "summary", "status-only"]);
export type SchedulePushConsent = z.infer<typeof SchedulePushConsent>;

export const ScheduleConsent = z.object({
  push: SchedulePushConsent.default("summary"),
});
export type ScheduleConsent = z.infer<typeof ScheduleConsent>;

// ---------------------------------------------------------------------------
// Policy（执行策略，全部可选，默认安全）
// ---------------------------------------------------------------------------

export const SchedulePolicy = z.object({
  /** 单次 run 超时（毫秒）。 */
  timeoutMs: z.number().int().positive().optional(),
  /** 上次 run 还在跑时，新触发如何处理。默认 skip。 */
  overlap: z.enum(["skip", "queue", "allow"]).default("skip"),
  /** 失败重试次数。默认 0。 */
  maxRetries: z.number().int().min(0).default(0),
  /** 错过的 cron 触发点是否补跑（默认 false，避免离线后重连补跑风暴）。 */
  catchUp: z.boolean().default(false),
});
export type SchedulePolicy = z.infer<typeof SchedulePolicy>;

// ---------------------------------------------------------------------------
// Schedule（定时任务定义）
// ---------------------------------------------------------------------------

export const Schedule = z.object({
  id: ScheduleId,
  tenantId: TenantId,
  name: z.string().min(1),
  enabled: z.boolean(),
  trigger: ScheduleTrigger,
  target: ScheduleTarget,
  consent: ScheduleConsent,
  policy: SchedulePolicy.optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  lastRunAt: z.string().optional(),
  /** cron 下次触发的预计算时间（仅 cron）。 */
  nextRunAt: z.string().optional(),
});
export type Schedule = z.infer<typeof Schedule>;

// ---------------------------------------------------------------------------
// Run（每次执行记录）
// ---------------------------------------------------------------------------

export const RunStatus = z.enum([
  "pending",
  "running",
  "success",
  "failed",
  "timeout",
  "cancelled",
  "skipped",
]);
export type RunStatus = z.infer<typeof RunStatus>;

export const RunTriggerSource = z.enum(["cron", "webhook", "manual"]);
export type RunTriggerSource = z.infer<typeof RunTriggerSource>;

export const Run = z.object({
  id: RunId,
  scheduleId: ScheduleId,
  tenantId: TenantId,
  triggerSource: RunTriggerSource,
  status: RunStatus,
  /** runKind=session：对应的 L1 session。 */
  sessionId: SessionId.optional(),
  /** runKind=workflow：对应的 L3 workflow。 */
  workflowId: WorkflowId.optional(),
  startedAt: z.string().optional(),
  finishedAt: z.string().optional(),
  exitReason: z.string().optional(),
  error: z.string().optional(),
  /** 复用 v0.8.7 session JSONL 快照路径。 */
  transcriptPath: z.string().optional(),
  /** 终态产物文本（summary 推送用）。 */
  resultText: z.string().optional(),
  usage: z.record(z.unknown()).optional(),
});
export type Run = z.infer<typeof Run>;

// ===========================================================================
// 方法 params / result
// ===========================================================================

// ---- schedule.create ----
export const ScheduleCreateParams = z.object({
  name: z.string().min(1),
  trigger: ScheduleTrigger,
  target: ScheduleTarget,
  consent: ScheduleConsent.optional(),
  policy: SchedulePolicy.optional(),
  enabled: z.boolean().optional(),
  clientRequestId: z.string().optional(),
});
export type ScheduleCreateParams = z.infer<typeof ScheduleCreateParams>;

export const ScheduleCreateResult = z.object({
  schedule: Schedule,
  /** kind=webhook 时返回一次明文 token（之后默认脱敏）。 */
  webhookToken: z.string().optional(),
});
export type ScheduleCreateResult = z.infer<typeof ScheduleCreateResult>;

// ---- schedule.update ----
export const ScheduleUpdateParams = z.object({
  scheduleId: ScheduleId,
  name: z.string().min(1).optional(),
  enabled: z.boolean().optional(),
  trigger: ScheduleTrigger.optional(),
  target: ScheduleTarget.optional(),
  consent: ScheduleConsent.optional(),
  policy: SchedulePolicy.optional(),
  clientRequestId: z.string().optional(),
});
export type ScheduleUpdateParams = z.infer<typeof ScheduleUpdateParams>;

export const ScheduleUpdateResult = z.object({ schedule: Schedule });
export type ScheduleUpdateResult = z.infer<typeof ScheduleUpdateResult>;

// ---- schedule.delete ----
export const ScheduleDeleteParams = z.object({
  scheduleId: ScheduleId,
  clientRequestId: z.string().optional(),
});
export type ScheduleDeleteParams = z.infer<typeof ScheduleDeleteParams>;

export const ScheduleDeleteResult = z.object({
  scheduleId: ScheduleId,
  deleted: z.boolean(),
});
export type ScheduleDeleteResult = z.infer<typeof ScheduleDeleteResult>;

// ---- schedule.list ----
export const ScheduleListParams = z.object({
  enabled: z.boolean().optional(),
  triggerKind: z.enum(["cron", "webhook", "manual"]).optional(),
  /** 是否返回明文 webhookToken（默认脱敏）。 */
  reveal: z.boolean().optional(),
  limit: z.number().int().positive().optional(),
});
export type ScheduleListParams = z.infer<typeof ScheduleListParams>;

export const ScheduleListResult = z.object({
  schedules: z.array(Schedule),
});
export type ScheduleListResult = z.infer<typeof ScheduleListResult>;

// ---- schedule.get ----
export const ScheduleGetParams = z.object({
  scheduleId: ScheduleId,
  reveal: z.boolean().optional(),
});
export type ScheduleGetParams = z.infer<typeof ScheduleGetParams>;

export const ScheduleGetResult = z.object({ schedule: Schedule });
export type ScheduleGetResult = z.infer<typeof ScheduleGetResult>;

// ---- schedule.enable / schedule.disable ----
export const ScheduleEnableParams = z.object({
  scheduleId: ScheduleId,
  clientRequestId: z.string().optional(),
});
export type ScheduleEnableParams = z.infer<typeof ScheduleEnableParams>;

export const ScheduleEnableResult = z.object({ schedule: Schedule });
export type ScheduleEnableResult = z.infer<typeof ScheduleEnableResult>;

// ---- schedule.trigger（手动触发一次 run）----
export const ScheduleTriggerParams = z.object({
  scheduleId: ScheduleId,
  /** 触发来源标记（manual / 测试 cron / 重放 webhook）。默认 manual。 */
  source: RunTriggerSource.optional(),
  /** 可选：注入到 target.prompt 的输入变量（webhook body 等）。 */
  input: z.record(z.unknown()).optional(),
  clientRequestId: z.string().optional(),
});
export type ScheduleTriggerParams = z.infer<typeof ScheduleTriggerParams>;

export const ScheduleTriggerResult = z.object({
  scheduleId: ScheduleId,
  runId: RunId,
  status: RunStatus,
});
export type ScheduleTriggerResult = z.infer<typeof ScheduleTriggerResult>;

// ---- schedule.runs.list ----
export const ScheduleRunsListParams = z.object({
  scheduleId: ScheduleId,
  status: RunStatus.optional(),
  limit: z.number().int().positive().optional(),
});
export type ScheduleRunsListParams = z.infer<typeof ScheduleRunsListParams>;

export const ScheduleRunsListResult = z.object({
  runs: z.array(Run),
});
export type ScheduleRunsListResult = z.infer<typeof ScheduleRunsListResult>;

// ---- run.get ----
export const RunGetParams = z.object({
  runId: RunId,
});
export type RunGetParams = z.infer<typeof RunGetParams>;

export const RunGetResult = z.object({ run: Run });
export type RunGetResult = z.infer<typeof RunGetResult>;

// ---- run.events.subscribe / unsubscribe ----
export const RunEventsSubscribeParams = z.object({
  runId: RunId,
});
export type RunEventsSubscribeParams = z.infer<typeof RunEventsSubscribeParams>;

export const RunEventsSubscribeResult = z.object({
  runId: RunId,
  subscribed: z.boolean(),
  /** 若 run 已绑定 session，回显其 sessionId，便于 server 关联 stream.event。 */
  sessionId: SessionId.optional(),
});
export type RunEventsSubscribeResult = z.infer<typeof RunEventsSubscribeResult>;

export const RunEventsUnsubscribeParams = z.object({
  runId: RunId,
});
export type RunEventsUnsubscribeParams = z.infer<typeof RunEventsUnsubscribeParams>;

export const RunEventsUnsubscribeResult = z.object({
  runId: RunId,
  subscribed: z.boolean(),
});
export type RunEventsUnsubscribeResult = z.infer<typeof RunEventsUnsubscribeResult>;

// ---- run.cancel ----
export const RunCancelParams = z.object({
  runId: RunId,
  reason: z.string().optional(),
  clientRequestId: z.string().optional(),
});
export type RunCancelParams = z.infer<typeof RunCancelParams>;

export const RunCancelResult = z.object({
  runId: RunId,
  status: RunStatus,
});
export type RunCancelResult = z.infer<typeof RunCancelResult>;

// ===========================================================================
// phonon → server 通知（镜像 + 推送）
// ===========================================================================

/** device 本地 schedule 变化主动同步给 server（含 cron 算出的新 nextRunAt）。 */
export const ScheduleChangedParams = z.object({
  schedule: Schedule.optional(),
  /** 删除场景：只带 scheduleId + deleted。 */
  scheduleId: ScheduleId.optional(),
  deleted: z.boolean().optional(),
});
export type ScheduleChangedParams = z.infer<typeof ScheduleChangedParams>;

/** run 开始。 */
export const RunStartedParams = z.object({
  run: Run,
});
export type RunStartedParams = z.infer<typeof RunStartedParams>;

/**
 * run 过程事件（订阅了才推）。本质是带 runId 标记的 session stream.event 转发。
 * 单调 seq + ack 复用 outbox 思路。
 */
export const RunEventParams = z.object({
  runId: RunId,
  scheduleId: ScheduleId,
  seq: z.number().int().nonnegative(),
  /** 原始 session stream.event（透传）。 */
  event: z.record(z.unknown()),
});
export type RunEventParams = z.infer<typeof RunEventParams>;

/** run 终态 + 按 consent.push 决定的 payload。 */
export const RunFinishedParams = z.object({
  run: Run,
  /** 推送粒度（回显，便于 server 知道拿到的是哪一档）。 */
  push: SchedulePushConsent,
});
export type RunFinishedParams = z.infer<typeof RunFinishedParams>;

/** server 确认收到 run.finished / run.event，phonon 清推送 outbox。 */
export const ScheduleAckParams = z.object({
  runId: RunId,
  /** 确认已收 seq≤lastSeq（run.event 流）。 */
  lastSeq: z.number().int().nonnegative().optional(),
  /** 确认 run.finished 已落库。 */
  finished: z.boolean().optional(),
});
export type ScheduleAckParams = z.infer<typeof ScheduleAckParams>;
