import type { MaintenanceRuntime } from "./maintenance.js";
import type {
  AgentCapabilities,
  AgentDescriptor,
  ContextItem,
  StreamEvent,
  CompressMode,
  InteractionRequestResult,
  AgentBoardInput, ConversationBoardParams, ConversationBoardResult,
  TurnReasoning,
  AgentWorkflowInput,ConversationWorkflowParams,ConversationWorkflowResult,
  AgentMessageInput, ConversationMessageParams, ConversationMessageResult,
  NativeDocumentInput, DocumentSendResult,
  AgentCoordinationInput, ProjectCoordinationParams, ProjectCoordinationResult,
} from "@agent-phonon/protocol";
import type { AgentInteractionInput } from "./agent-interaction-bridge.js";
import type { EmployeeProfileApplyParams } from "@agent-phonon/protocol";
import type { PeerContextAccess, PeerContextCapability } from "./peer-context.js";

export interface EmployeeRuntimeBinding {
  employeeId:string;revision:number;runtimeProfile:string;provider:string;home:string;context:ContextItem[];
}
export interface EmployeeProfileTarget {
  input:EmployeeProfileApplyParams;runtimeProfile:string;workspace:string;nonce:string;previousHashes?:Record<string,string>;
  workspaceIdentity?:string;
  previousNativeIdentity?:string;
}
export interface EmployeeProfileObservation {documentHashes:Record<string,string>;memoryBytes:number;home:string;nativeIdentity?:string;}

export interface InsertionOptions {
  turnId: string;
  signal: AbortSignal;
  /** Revalidate controller authority at the native effect, not just inbox admission. */
  beforeApply?: () => void;
}

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
  /** Optional read-only readiness assessment before an authorized coordination turn. */
  preparePeerContext?(environment?: Record<string,string>, signal?: AbortSignal): Promise<void>;
  /** Separate peer-data path; ordinary user steering is not equivalent. */
  peerContextCapability?(environment?: Record<string, string>): PeerContextCapability | undefined;
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

  /** Resolve only after current-turn model input is applied at a tool gap.
   * Reject on abort/closed turn; never store this as next-turn context or restart.
   * Advertise injectMidTurn only when this operation is genuinely implemented. */
  insertAtToolGap?(input: string, options: InsertionOptions): Promise<void>;

  /** 压缩上下文（native）。 */
  compressNative?(): Promise<{ applied?: boolean; summary?: string }>;
  compressionModes?(): { native: boolean; custom: boolean };

  /** 自定义压缩（如 dropToolIO）。adapter 能定位/编辑自身 session 存储时实现。 */
  compressCustom?(strategy?: string, options?: { keepRecentToolCalls?: number }): Promise<{ summary?: string; filesChanged?: number; recordsChanged?: number; blocksRemoved?: number; bytesBefore?: number; bytesAfter?: number; backups?: string[] }>;

  /** 中途换模型（D17）。 */
  switchModel?(model: string): Promise<{ warnings?: string[] }>;

  /** 结束并清理。 */
  terminate(): Promise<void>;

  /** 可选：返回上下文信息（context 窗口/已用 token 等，D33）。 */
  describe?(): Promise<{ contextWindow?: number; usedTokens?: number; usagePercent?: number; compactions?: number }>;
  /** Cached context reading for session metadata, which is built synchronously. */
  contextSnapshot?(): { contextWindow?: number; usedTokens?: number } | undefined;

  /**
   * 可选：设置「自发输出」水槽（D16 unsolicited）。
   * core 在 createSession 后调用；agent 在无 active turn 时的输出（OpenClaw cron/心跳）
   * 通过这个 sink 推成 origin:unsolicited 的 stream.event。
   */
  setUnsolicitedSink?(sink: (event: StreamEvent) => void): void;
  /** Actual native subscription acknowledgement, not just static harness support. */
  proactiveOutputReady?():boolean;
  /** Device-local native identity/context, not a transcript or executable command. */
  recoveryCheckpoint?(): Record<string, unknown> | undefined;
  /** Passive native evidence for the exact turn; abort acknowledgement alone
   * is not proof that the supervised tree/native run ended. */
  observeNativeStop?(turnId:string):Promise<"process_tree_exit"|"native_terminal"|undefined>;
}

export interface SendOptions {
  /** Repeatable controller guard immediately before native effects after async work. */
  beforeNativeEffect?: () => void;
  /** Controller-owned current-turn checkpoints; never a new prompt or an approval answer. */
  peerContext?: PeerContextAccess;
  /** Best-effort native preference; settings evidence is separate from task outcome. */
  reasoning?: TurnReasoning;
  /** Actual native value only; the controller may leave the preference unconfirmed. */
  acknowledgeReasoning?: (nativeValue: string | null) => void;
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
  /** Embedded harnesses can request a form without a shell/HTTP tool. */
  requestInteraction?: (input: AgentInteractionInput) => Promise<InteractionRequestResult>;
  acknowledgeInteraction?: (requestId: string, decisionHash: string) => void;
  conversationBoard?: (input: AgentBoardInput) => Promise<ConversationBoardResult>;
  conversationWorkflow?: (input:AgentWorkflowInput)=>Promise<ConversationWorkflowResult>;
  conversationMessage?: (input: AgentMessageInput) => Promise<ConversationMessageResult>;
  projectCoordination?: (input: AgentCoordinationInput) => Promise<ProjectCoordinationResult>;
  publishDocument?: (input: NativeDocumentInput) => Promise<DocumentSendResult>;
}

/** adapter 创建 session 的参数。 */
/** Device-local HITL gate an adapter may enforce in-process, when the harness supports blocking hooks. */
export interface AdapterHitlContext {
  /** hook-bridge base URL, e.g. http://127.0.0.1:4318 */
  bridgeUrl: string;
  /** Optional bearer token for the bridge. */
  token?: string;
  /** How long to wait for a human decision. */
  timeoutMs?: number;
  /** Behaviour when the bridge is configured but unreachable. Defaults to closed. */
  failMode?: "open" | "closed";
}

export interface AdapterRuntimeContext {
  prepareSkills?:(tenant:string,project:string,agent:string,selections:import("@agent-phonon/protocol").SkillSelection[])=>import("./skill-execution.js").FrozenSkillSet;
  loadSkills?:(tenant:string,project:string,agent:string,selected:import("./skill-execution.js").FrozenSkillSet)=>Promise<import("./skill-execution.js").LoadedSkillSet>;
  /** Tenant-bound, policy-enforced deterministic host-maintenance broker. */
  maintenance?: MaintenanceRuntime;
  /** Device policy re-check for internal/scheduled session creation. */
  assertAgentAllowed?: (agentId: string) => void;
  /** Device-local human-in-the-loop gate; absent means the harness declares no HITL. */
  hitl?: AdapterHitlContext;
  requestInteraction?: (params: unknown, signal?: AbortSignal) => Promise<InteractionRequestResult>;
  conversationBoard?: (params: ConversationBoardParams) => Promise<ConversationBoardResult>;
  conversationWorkflow?: (params:ConversationWorkflowParams)=>Promise<ConversationWorkflowResult>;
  conversationMessage?: (params: ConversationMessageParams) => Promise<ConversationMessageResult>;
  projectCoordination?: (params: ProjectCoordinationParams) => Promise<ProjectCoordinationResult>;
  coordinationEvidenceAuthority?:string;
  coordinationEvidenceChanged?:()=>void;
  publishDocument?: (params: NativeDocumentInput & {nativeRunId:string;workflowId:string;sessionId:string;turnId:string;projectId:string;worktreeId?:string}) => Promise<DocumentSendResult>;
  acknowledgeInteraction?: (requestId: string, decisionHash: string) => void;
  resolveEmployee?: (tenant:string,id:string,revision:number|undefined,agent:string)=>Promise<EmployeeRuntimeBinding>;
  useEmployee?: (tenant:string,id:string)=>()=>void;
}

export interface CreateSessionParams {
  upstreamRuns?:{remember:(id:string)=>void;owns:(id:string)=>boolean};
  sessionId: string;
  /** discover 返回的完整 agentId（多 agent runtime 带前缀，如 openclaw:phonon）。 */
  agentId: string;
  model: string;
  /** 项目工作目录（绝对路径；session 必绑项目 D23）。 */
  cwd: string;
  /** 透传的 agent 私有配置。 */
  agentConfig?: Record<string, unknown>;
  initialContext?: ContextItem[];
  /** Core is rebuilding a persisted session after daemon restart. */
  reattach?: boolean;
  /** Internal-only device capabilities; never accepted from the wire. */
  runtimeContext?: AdapterRuntimeContext;
  /** Controller-resolved identity, never copied directly from agentConfig. */
  employee?:EmployeeRuntimeBinding;
}

/**
 * 把 createSession 的 initialContext（含 workflow systemPrompt / 角色定义 / 预置上下文）
 * 转成可拼进首轮 message 的文本行。
 *
 * 背景：spawn 类 adapter（OpenClaw / Claude Code / Codex / Hermes / OpenCode）没有独立的
 * system-prompt 通道，之前 createSession 直接丢弃了 initialContext，导致 workflow 给 executor/
 * worker 设的 systemPrompt 根本没传给模型。统一通过这个 helper 把它们拼进 pendingInject，
 * 首轮 send 自动带上（复用各 adapter 已有的 pendingInject 机制，不额外起 turn）。
 */
export function formatInitialContextLines(initialContext?: ContextItem[]): string[] {
  if (!initialContext || initialContext.length === 0) return [];
  return initialContext.map((c) => {
    const tag = c.role === "system" ? "[SYSTEM]" : c.role === "assistant" ? "[ASSISTANT]" : "[CONTEXT]";
    return `${tag}\n${c.content}`;
  });
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
  discoverAgents(signal?: AbortSignal): Promise<AgentDescriptor[]>;

  /**
   * 创建一个 session。agentId 是 discover 返回的完整 id（可能带 runtime 前缀）。
   */
  createSession(params: CreateSessionParams): Promise<AdapterSession>;
  /** Verify and reopen the original native session without sending model input.
   * Must reject missing/mismatched state; never fall back to createSession. */
  recoverSession?(params: CreateSessionParams, checkpoint: Record<string, unknown>): Promise<AdapterSession>;
  /** Read the original device-owned native history when an older controller did
   * not persist a checkpoint. Must not launch, create, repair or replay work. */
  observeSessionCheckpoint?(params: CreateSessionParams): Promise<Record<string, unknown> | undefined>;
  provisionEmployee?(target:EmployeeProfileTarget):Promise<EmployeeProfileObservation>;
  inspectEmployee?(target:EmployeeProfileTarget):Promise<EmployeeProfileObservation>;

  /**
   * global skill 安装目录（design D24 + 安全边界规则）。
   * 只有 adapter 知道自己 runtime 的 skill 目录（OpenClaw=对应 sub-agent workspace/skills）。
   * 返回 undefined = 该 runtime 不支持 global skill。project scope 不走这里。
   */
  globalSkillDir?(agentId: string): string | undefined;
}

export type { AgentCapabilities, CompressMode };
