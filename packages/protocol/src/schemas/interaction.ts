import { z } from "zod";
import { SessionId, Timestamp } from "./common.js";

/**
 * 人机交互协议（design 平面③ / D21）。
 *
 * 场景：HITL 时、或 agent 主动想问人，发一个**可交互卡片/表单**（抽象结构），
 * phonon → server 渲染给人（飞书卡片/网页/TG 按钮…由服务端决定，复用「甩锅服务端」原则），
 * 人填完 → 原路返回 → 注入回 agent。
 *
 * 两个层次：
 *   - InteractionDirective ：agent emit 的表单定义（skill 教，让任何模型都能发）
 *   - interaction.request   ：phonon → server 线协议（带 requestId，阻塞等回填）
 *   - interaction.response  ：server → phonon 线协议（人填完的值）
 *
 * 表单只定义**抽象字段结构**，不绑定任何渲染方式——服务端自由渲染。
 */

/** 字段类型（抽象，渲染由服务端决定）。 */
export const FieldType = z.enum([
  "text", // 单行文本
  "textarea", // 多行文本
  "number",
  "boolean", // 开关/勾选
  "select", // 单选
  "multiselect", // 多选
  "date",
]);
export type FieldType = z.infer<typeof FieldType>;

export const FormFieldOption = z.object({
  label: z.string(),
  value: z.string(),
});
export type FormFieldOption = z.infer<typeof FormFieldOption>;

/**
 * 表单字段——按 type 的 discriminated union（P2-16）。
 * 每种类型携自己的 defaultValue 类型与专属字段，避免「select 该传 string 还是 string[]」的歧义。
 */
const FieldBase = { key: z.string().min(1), label: z.string().min(1), required: z.boolean().default(false), help: z.string().optional() };

export const FormField = z.discriminatedUnion("type", [
  z.object({ ...FieldBase, type: z.literal("text"), placeholder: z.string().optional(), defaultValue: z.string().optional() }),
  z.object({ ...FieldBase, type: z.literal("textarea"), placeholder: z.string().optional(), defaultValue: z.string().optional() }),
  z.object({ ...FieldBase, type: z.literal("number"), defaultValue: z.number().optional() }),
  z.object({ ...FieldBase, type: z.literal("boolean"), defaultValue: z.boolean().optional() }),
  z.object({ ...FieldBase, type: z.literal("select"), options: z.array(FormFieldOption), defaultValue: z.string().optional() }),
  z.object({ ...FieldBase, type: z.literal("multiselect"), options: z.array(FormFieldOption), defaultValue: z.array(z.string()).optional() }),
  z.object({ ...FieldBase, type: z.literal("date"), defaultValue: z.string().optional() }),
]);
export type FormField = z.infer<typeof FormField>;

/** 表单/卡片定义（抽象）。 */
export const InteractionForm = z.object({
  title: z.string().min(1),
  /** 卡片正文/说明（可选）。 */
  description: z.string().optional(),
  fields: z.array(FormField).default([]),
  /** 提交/操作按钮；纯通知类可只放一个「知道了」。 */
  submitLabel: z.string().default("提交"),
  cancelLabel: z.string().optional(),
});
export type InteractionForm = z.infer<typeof InteractionForm>;

/**
 * agent emit 的指令（skill 教）——和 interaction.request 结构基本一致，
 * 但不带 requestId（由 phonon 生成）。
 */
export const InteractionDirective = z.object({
  form: InteractionForm,
  /** 是否阻塞等待人回填（true=问答；false=纯通知不等）。 */
  blocking: z.boolean().default(true),
  /** 关联 hookId（若由 HITL hook 触发，便于和 hook.resolve 合流）。 */
  hookId: z.string().optional(),
});
export type InteractionDirective = z.infer<typeof InteractionDirective>;

// --- interaction.request（phonon → server）---
export const InteractionRequestParams = z.object({
  /** 本次交互唯一 id，response 用它配对。 */
  requestId: z.string().min(1),
  sessionId: SessionId.optional(),
  turnId: z.string().optional(),
  form: InteractionForm,
  blocking: z.boolean().default(true),
  /** 关联 hookId（HITL 场景）。 */
  hookId: z.string().optional(),
  /**
   * 可选超时（秒，P1-5）。超时后 phonon 以 timeout 收尾本次交互，agent 按预设继续。
   * 0 或缺省 = 不超时（人可能去开会/带娃，长期挂起）。
   */
  timeoutSeconds: z.number().int().nonnegative().optional(),
  at: Timestamp,
});
export type InteractionRequestParams = z.infer<typeof InteractionRequestParams>;

/** 人机交互的生命周期状态（P1-5）：pending → submitted | cancelled | timeout。 */
export const InteractionStatus = z.enum(["pending", "submitted", "cancelled", "timeout"]);
export type InteractionStatus = z.infer<typeof InteractionStatus>;

/** 阻塞模式下，request 的最终结果（人填完后服务端回的）。 */
export const InteractionRequestResult = z.object({
  requestId: z.string(),
  /** 结果状态：submit | cancel | timeout。 */
  action: z.enum(["submit", "cancel", "timeout"]),
  /** 提交时各字段值（key → 值）。 */
  values: z.record(z.union([z.string(), z.array(z.string()), z.boolean(), z.number()])).optional(),
});
export type InteractionRequestResult = z.infer<typeof InteractionRequestResult>;

// --- interaction.cancel（server → phonon 或 phonon 内部）：主动取消一个 pending 交互 ---
export const InteractionCancelParams = z.object({
  requestId: z.string().min(1),
  reason: z.string().optional(),
});
export type InteractionCancelParams = z.infer<typeof InteractionCancelParams>;

export const InteractionCancelResult = z.object({
  requestId: z.string(),
  cancelled: z.boolean(),
});
export type InteractionCancelResult = z.infer<typeof InteractionCancelResult>;

/**
 * server → phonon 的回填（非阻塞模式或异步回填走这个 notification；
 * 阻塞模式可直接用 interaction.request 的 result 返回，二选一，实现可都支持）。
 */
export const InteractionResponseParams = z.object({
  requestId: z.string().min(1),
  action: z.enum(["submit", "cancel", "timeout"]),
  values: z.record(z.union([z.string(), z.array(z.string()), z.boolean(), z.number()])).optional(),
  at: Timestamp,
});
export type InteractionResponseParams = z.infer<typeof InteractionResponseParams>;
