import { z } from "zod";
import { SessionId, Timestamp } from "./common.js";

/**
 * 流式事件（design §4 / §6 / 订阅模型）——phonon → server 异步推送。
 *
 * 关键：session 不只是「请求-响应」，还是一条**可订阅的持续输出流**。
 * 输出分两种来源（origin）：
 *   - solicited  ：某次 session.send 触发的响应（用 send 返回的 turnId）。
 *   - unsolicited：agent 自发输出（OpenClaw 的 cron/定时/心跳），无 send 触发；
 *                  turnId 由 phonon 生成，source 标明冲泡来源。
 *
 * “create 即订阅”：server 拥有的 session 的**所有** stream.event（含自发）都自动
 * 推给该 tenant 连接，无需显式 subscribe。Codex 一次性 session 流到 result final 就停；
 * OpenClaw 持久 session 即使不 send 也会持续往上冒。
 *
 * 不同事件对应不同 verbosity 档位：
 *   final    → 只会收到 result
 *   messages → message + result
 *   tools    → message + tool_call + tool_result + result
 *   trace    → 以上 + thinking + token delta
 */

/** 输出来源：请求触发 vs agent 自发。 */
export const StreamOrigin = z.enum(["solicited", "unsolicited"]);
export type StreamOrigin = z.infer<typeof StreamOrigin>;

/** 事件种类。 */
export const StreamEventType = z.enum([
  "message", // 一条完整/增量消息文本
  "thinking", // 思考过程（trace 档）
  "tool_call", // agent 发起工具调用
  "tool_result", // 工具返回
  "token", // 增量 token（流式打字机，trace/可选）
  "result", // 本轮最终结果（终止事件）
  "error", // 本轮出错（终止事件）
]);
export type StreamEventType = z.infer<typeof StreamEventType>;

const StreamEventBase = z.object({
  sessionId: SessionId,
  /**
   * 本轮关联 id。solicited 事件用 send 返回的 turnId；
   * unsolicited（自发）事件由 phonon 生成，server 从事件中首次见到。
   */
  turnId: z.string(),
  /** 输出来源：默认 solicited；agent 自发为 unsolicited。 */
  origin: StreamOrigin.default("solicited"),
  /** unsolicited 时的冲泡来源标签，如 "cron" / "scheduled" / "heartbeat"。 */
  source: z.string().optional(),
  /** 单调递增序号（按 session），保证调用方可排序/去重。 */
  seq: z.number().int().nonnegative(),
  at: Timestamp,
});

export const StreamMessageEvent = StreamEventBase.extend({
  type: z.literal("message"),
  role: z.enum(["assistant", "user", "system"]).default("assistant"),
  text: z.string(),
  /** 是否为增量分片（true 表示需要与同 turn 的后续 message 拼接）。 */
  delta: z.boolean().default(false),
});

export const StreamThinkingEvent = StreamEventBase.extend({
  type: z.literal("thinking"),
  text: z.string(),
  delta: z.boolean().default(false),
});

export const StreamToolCallEvent = StreamEventBase.extend({
  type: z.literal("tool_call"),
  toolName: z.string(),
  /** 工具入参（原样透传，结构由 agent/工具决定）。 */
  args: z.unknown().optional(),
  /** 工具调用 id，用于和 tool_result 配对。 */
  toolCallId: z.string().optional(),
});

export const StreamToolResultEvent = StreamEventBase.extend({
  type: z.literal("tool_result"),
  toolName: z.string(),
  toolCallId: z.string().optional(),
  ok: z.boolean(),
  /** 工具输出（可能被截断，取决于 verbosity/大小限制）。 */
  output: z.unknown().optional(),
});

export const StreamTokenEvent = StreamEventBase.extend({
  type: z.literal("token"),
  text: z.string(),
});

export const StreamResultEvent = StreamEventBase.extend({
  type: z.literal("result"),
  /** 本轮最终文本结果。 */
  text: z.string(),
  /** 可选 usage 统计。 */
  usage: z
    .object({
      inputTokens: z.number().int().nonnegative().optional(),
      outputTokens: z.number().int().nonnegative().optional(),
    })
    .optional(),
  /**
   * 本轮终态（P0-2）——每个 turn 必须有明确终态，服务端状态机才不会悬空：
   * completed   正常完成
   * interrupted 被 session.interrupt 打断
   * aborted     被 hook abort / 主动中止
   * failed      出错终止（详情另见 error 事件）
   * timeout     超时
   */
  status: z.enum(["completed", "interrupted", "aborted", "failed", "timeout"]).default("completed"),
  /** 标记本轮结束。 */
  final: z.literal(true),
});

export const StreamErrorEvent = StreamEventBase.extend({
  type: z.literal("error"),
  message: z.string(),
  /** 可选应用错误码（与 common.PhononErrorCode 对齐）。 */
  appCode: z.string().optional(),
  /** 终态（与 result.status 对齐，错误场景通常 failed/aborted/timeout）。 */
  status: z.enum(["failed", "aborted", "timeout", "interrupted"]).default("failed"),
  final: z.literal(true),
});

// ---------------------------------------------------------------------------
// stream.ack —— server → phonon，确认已收到 seq <= lastSeq（P0-4）
// 让 phonon 能清理 outbox / 控制背压；可按 session 粒度或全局。
// ---------------------------------------------------------------------------
export const StreamAckParams = z.object({
  /** 按 session 确认；缺省表示该连接全局。 */
  sessionId: SessionId.optional(),
  /** 已收到的最大连续 seq（含）；phonon 可清理 <= 此值的 outbox。 */
  lastSeq: z.number().int().nonnegative(),
});
export type StreamAckParams = z.infer<typeof StreamAckParams>;

/** 流式事件联合体（phonon → server，方法名 stream.event）。 */
export const StreamEvent = z.discriminatedUnion("type", [
  StreamMessageEvent,
  StreamThinkingEvent,
  StreamToolCallEvent,
  StreamToolResultEvent,
  StreamTokenEvent,
  StreamResultEvent,
  StreamErrorEvent,
]);
export type StreamEvent = z.infer<typeof StreamEvent>;
