import { z } from "zod";
import { SessionId, Timestamp } from "./common.js";
import { HookType } from "./capabilities.js";
import { ContextItem } from "./session.js";

/**
 * Hook / 人在回路 HITL（design §8）。
 *
 * 核心：phonon 自己不实现人在回路，只做事件中转 + 阻塞等裁决。
 *   phonon → server : hook.fired   （到 hook 点抛事件）
 *   server → phonon : hook.resolve （裁决；服务端决定是否问真人、怎么问、等多久）
 */

/** hook 触发载荷（phonon → server）。 */
export const HookFiredParams = z.object({
  sessionId: SessionId,
  /** 本次 hook 的唯一 id，hook.resolve 用它配对。 */
  hookId: z.string().min(1),
  hookType: HookType,
  /** 触发上下文：被拦截的操作详情（命令、工具名、参数、文件路径等）。 */
  payload: z
    .object({
      toolName: z.string().optional(),
      command: z.string().optional(),
      filePath: z.string().optional(),
      url: z.string().optional(),
      /** 其余 adapter 特定字段。 */
      extra: z.record(z.unknown()).optional(),
    })
    .default({}),
  /** 该 turn 的关联 id（若在某轮对话内触发）。 */
  turnId: z.string().optional(),
  at: Timestamp,
});
export type HookFiredParams = z.infer<typeof HookFiredParams>;

/**
 * 裁决动作（server → phonon）。
 * - continue : 放行，照常执行
 * - inject   : 先注入上下文再继续（用 context 字段）
 * - modify   : 用修改后的参数继续（用 patch 字段，如改写命令）
 * - abort    : 中止该操作（可带原因）
 */
export const HookAction = z.enum(["continue", "inject", "modify", "abort"]);
export type HookAction = z.infer<typeof HookAction>;

export const HookResolveParams = z.object({
  sessionId: SessionId,
  /** 必须与对应 hook.fired 的 hookId 一致。 */
  hookId: z.string().min(1),
  action: HookAction,
  /** action=inject 时：要注入的上下文。 */
  context: z.array(ContextItem).optional(),
  /** action=modify 时：对被拦截操作的修改（结构与该 hook 的 payload 对应）。 */
  patch: z.record(z.unknown()).optional(),
  /** action=abort 时：可选原因，会回传给 agent / 记录。 */
  reason: z.string().optional(),
});
export type HookResolveParams = z.infer<typeof HookResolveParams>;

export const HookResolveResult = z.object({
  sessionId: SessionId,
  hookId: z.string(),
  applied: z.boolean(),
});
export type HookResolveResult = z.infer<typeof HookResolveResult>;
