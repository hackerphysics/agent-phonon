import { z } from "zod";

/**
 * Hook 类型 — 归一化的拦截点（design §8）。
 * adapter 负责把各家原生 hook 点（Codex hooks / Claude Code PreToolUse /
 * OpenClaw 审批…）映射成这些归一化类型。
 */
export const HookType = z.enum([
  "pre_tool", // 工具调用前
  "post_tool", // 工具调用后
  "pre_command", // 执行 shell/命令前（rm/git push 等危险操作）
  "pre_file_write", // 写文件前
  "pre_network", // 发起网络/外部请求前
  "session_start", // 会话开始
  "session_end", // 会话结束
  "notification", // agent 主动通知（无需裁决，纯告知）
]);
export type HookType = z.infer<typeof HookType>;

/**
 * Adapter 能力声明（design §7）。
 * adapter 不假装统一，而是声明自己原生支持什么，phonon core 据此补齐缺口。
 * 这份能力随 discovery 一起暴露给服务端，服务端先知能力再决定怎么用。
 */
export const AgentCapabilities = z.object({
  /** 原生 session / resume（无则由 core 用注册表模拟）。 */
  nativeSession: z.boolean(),
  /** 原生上下文压缩（决定 session.compress mode=native 是否可用）。 */
  nativeCompression: z.boolean(),
  /** 原生上下文注入。 */
  contextInjection: z.boolean(),
  /**
   * 是否会**主动/非请求触发地输出**（design 订阅模型）。
   * OpenClaw 这类有 cron/心跳/定时任务，同一 session 内会不定期自发冲泡 → true；
   * Codex 这类一次性，流到结果就结束 → false。
   * server 据此判断哪些 session 需要长期保持监听。
   */
  proactiveOutput: z.boolean(),
  /** 是否支持同会话中途切换模型（design D16）。 */
  modelSwitch: z.boolean(),
  /** 是否支持打断正在进行的 turn（session.interrupt / whenBusy=interrupt，D18）。 */
  interrupt: z.boolean(),
  /** 是否支持中途插入输入（下一次 tool call 边界，whenBusy=inject，D18）。 */
  injectMidTurn: z.boolean(),
  /** 是否支持给该 agent 安装/卸载 skill（skill.* 接口，D24）。 */
  skillManagement: z.boolean(),
  /** 原生支持的 hook 点（其余由 core 尽力补齐或不支持）。 */
  hooks: z.array(HookType),
  /** 是否支持流式输出。 */
  streaming: z.boolean(),
  /**
   * L3 编排中可承担的角色（P2-9，2026-06-23 review）。
   * executor 需要长话话/多轮决策能力（OpenClaw/Claude Code/Hermes 适合）；
   * worker 一般单轮执行即可（Codex/OpenCode 也能干）。
   * 不申明默认两者都不推荐。
   */
  workflowRoles: z.array(z.enum(["executor", "worker"])).default([]),
  /**
   * 可选调度限制（P2-13）：server 据此做调度/背压。
   */
  limits: z
    .object({
      maxConcurrentSessions: z.number().int().positive().optional(),
      maxContextTokens: z.number().int().positive().optional(),
      maxMessageBytes: z.number().int().positive().optional(),
    })
    .optional(),
});
export type AgentCapabilities = z.infer<typeof AgentCapabilities>;
