import type {
  AgentCapabilities,
  AgentDescriptor,
  ContextItem,
  StreamEvent,
  CompressMode,
} from "@agent-phonon/protocol";

/**
 * Adapter 接口（design D8）。
 *
 * 每种 agent（OpenClaw / Claude Code / Codex …）实现一个 adapter。
 * adapter 不假装统一，而是声明 capabilities，core 据此补齐缺口。
 *
 * 铁律：adapter 只处理「单个 agent 的单个 session」，不感知 tenant、不感知协议传输。
 */

/** 一个 adapter 管理的活动 session 句柄。 */
export interface AdapterSession {
  /** phonon 侧 sessionId。 */
  readonly sessionId: string;
  /** 绑定的 model（可被 switchModel 改）。 */
  model: string;

  /**
   * 发一轮输入，流式产出事件。
   * adapter 通过 emit 回调把 StreamEvent 推回 core（core 再转 server）。
   * 返回的 promise 在本轮结束（terminal event 已 emit）后 resolve。
   */
  send(input: string, opts: SendOptions): Promise<void>;

  /** 打断当前正在跑的 turn（D18）。adapter 无原生支持时由 core 兜底（kill 子进程等）。 */
  interrupt?(reason?: string): Promise<void>;

  /** 注入上下文（D8 contextInjection）。 */
  inject?(context: ContextItem[]): Promise<void>;

  /** 压缩上下文（native）。 */
  compressNative?(): Promise<{ summary?: string }>;

  /** 自定义压缩（如 dropToolIO）。adapter 能定位/编辑自身 session 存储时实现。 */
  compressCustom?(strategy?: string, options?: { keepRecentToolCalls?: number }): Promise<{ summary?: string; filesChanged?: number; recordsChanged?: number; blocksRemoved?: number; bytesBefore?: number; bytesAfter?: number; backups?: string[] }>;

  /** 中途换模型（D17）。 */
  switchModel?(model: string): Promise<{ warnings?: string[] }>;

  /** 结束并清理。 */
  terminate(): Promise<void>;

  /** 可选：返回上下文信息（context 窗口/已用 token 等，D33）。 */
  describe?(): Promise<{ contextWindow?: number; usedTokens?: number; usagePercent?: number; compactions?: number }>;

  /**
   * 可选：设置「自发输出」水槽（D16 unsolicited）。
   * core 在 createSession 后调用；agent 在无 active turn 时的输出（OpenClaw cron/心跳）
   * 通过这个 sink 推成 origin:unsolicited 的 stream.event。
   */
  setUnsolicitedSink?(sink: (event: StreamEvent) => void): void;
}

export interface SendOptions {
  /** 本轮 turnId（core 生成或透传）。 */
  turnId: string;
  /** 详细度（决定 emit 哪些事件）。 */
  verbosity: "final" | "messages" | "tools" | "trace";
  /** 本轮指定的 skill 名（core 已确保就位 + 注入加载指令）。 */
  skills?: string[];
  /** 本轮执行环境变量（global < project < skill 合并后）。 */
  environment?: Record<string, string>;
  /** 推流式事件给 core 的回调。 */
  emit: (event: StreamEvent) => void;
  /** 取消信号（interrupt 时 core 触发）。 */
  signal?: AbortSignal;
}

/** adapter 创建 session 的参数。 */
export interface CreateSessionParams {
  sessionId: string;
  /** discover 返回的完整 agentId（多 agent runtime 带前缀，如 openclaw:phonon）。 */
  agentId: string;
  model: string;
  /** 项目工作目录（绝对路径；session 必绑项目 D23）。 */
  cwd: string;
  /** 透传的 agent 私有配置。 */
  agentConfig?: Record<string, unknown>;
  initialContext?: ContextItem[];
}

/**
 * Adapter 顶层接口。
 *
 * runtime vs agent（design D32）：
 * - 单 agent runtime（Codex/Claude Code/OpenCode）：runtime 本身就是一个 agent。
 * - 多 agent runtime（OpenClaw/Hermes）：一个 runtime 里多个 agent（按 workspace 分），
 *   discover 要枚举出多个 AgentDescriptor，agentId 形如 `openclaw:main` / `openclaw:phonon`。
 */
export interface AgentAdapter {
  /** runtime 内部名，如 "openclaw"。 */
  readonly name: string;

  /** 能力声明（D8）。同一 runtime 下所有 sub-agent 共享。 */
  readonly capabilities: AgentCapabilities;

  /**
   * 发现：枚举该 runtime 下**所有可用 agent**（design §5）。
   * 单 agent runtime 返回长度 1；多 agent runtime（OpenClaw）返回多个。
   * 不可用时返回空数组或 available=false 的项。
   */
  discoverAgents(): Promise<AgentDescriptor[]>;

  /**
   * 创建一个 session。agentId 是 discover 返回的完整 id（可能带 runtime 前缀）。
   */
  createSession(params: CreateSessionParams): Promise<AdapterSession>;

  /**
   * global skill 安装目录（design D24 + 安全边界规则）。
   * 只有 adapter 知道自己 runtime 的 skill 目录（OpenClaw=对应 sub-agent workspace/skills）。
   * 返回 undefined = 该 runtime 不支持 global skill。project scope 不走这里。
   */
  globalSkillDir?(agentId: string): string | undefined;
}

export type { AgentCapabilities, CompressMode };
