import { EventEmitter } from "node:events";
import { WebSocketServer, WebSocket } from "ws";
import { RpcPeer, type Transport, newId } from "./rpc.js";
import type {
  AgentDescriptor,
  SessionMeta,
  StreamEvent,
  HookFiredParams,
  HookAction,
  WorkflowPolicy,
  WorkflowSharedContext,
  WorkflowResumeFrom,
  WorkflowEvent,
  WorkflowStatusResult,
  WorkflowCancelResult,
  WorkflowDispatchCancelResult,
  WorkflowListResult,
  WorkflowListParams,
  WorkflowRunResult,
  Schedule,
  ScheduleTrigger,
  ScheduleConsent,
  SchedulePolicy,
  SchedulePushConsent,
  ScheduleListParams,
  ScheduleListResult,
  ScheduleCreateResult,
  Run,
  RunStatus,
  RunTriggerSource,
  ConversationArchiveScope,
  ConversationArchiveAppendParams,
  ConversationArchiveAppendResult,
  ConversationArchiveReadParams,
  ConversationArchiveReadResult,
  ConversationArchiveStatusResult,
  ConversationArchiveEntitiesParams, ConversationArchiveEntitiesResult,
  ConversationArchiveBlob, ConversationArchiveBlobWriteParams, ConversationArchiveBlobStatusResult,
  ConversationArchiveBlobReadResult,
} from "@agent-phonon/protocol";

/** Schedule target 宽松型（SDK 使用面，避免调用方手动 cast 品牌类型）。 */
export interface ScheduleTargetInput {
  runKind?: "session" | "workflow" | "dispatch";
  project: string;
  agent?: string;
  model?: string;
  prompt?: string;
  plan?: WorkflowPlanInput;
  agentConfig?: Record<string, unknown>;
  skills?: SkillSelectionInput[];
  dispatch?: import("@agent-phonon/protocol").ScheduleDispatch;
}
export type RunResolveInput = Omit<import("@agent-phonon/protocol").RunResolveParams, "runId"> & { runId: string };
export type SkillSelectionInput=string|{name:string;version?:string;scope?:"global"|"project";force?:boolean;revision?:string;installationId?:string};

/**
 * Workflow plan 宝松型（SDK 使用面）。
 *
 * 不用 protocol 内部的 branded AgentId、SessionId 等 zod 品牌类型，以免调用方
 * 要手动 cast "mock:a" 为品牌类型。字段语义与协议一致，phonon 端进入后会
 * 走 zod 校验。
 */
export interface WorkflowNodeInput {
  nodeId: string;
  agent: string;
  model: string;
  role?: string;
  input?: string;
  systemPrompt?: string;
  skills?: SkillSelectionInput[];
  sessionId?: string;
  dependsOn?: string[];
  agentConfig?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  // v0.6: per-node 执行环境覆写
  project?: string;
  worktreeId?: string;
  branch?: string;
}
export interface WorkflowEdgeInput {
  edgeId?: string;
  from: string;
  to: string;
  label?: string;
  condition?: string;
  metadata?: Record<string, unknown>;
}
export interface WorkflowCommunicationGraphInput {
  edges?: WorkflowEdgeInput[];
  allowSelfLoop?: boolean;
  maxIterations?: number;
}
export interface WorkflowDiscussionTerminationInput {
  chairmanSignal?: string;
  maxRounds?: number;
  consensusSignal?: string;
}
export type WorkflowPlanInput =
  | { mode: "dag"; nodes: WorkflowNodeInput[]; edges?: WorkflowEdgeInput[]; finalNodeId?: string }
  | { mode: "graph"; executor: WorkflowNodeInput; workers: WorkflowNodeInput[]; communicationGraph: WorkflowCommunicationGraphInput }
  | {
      mode: "discussion";
      topic: string;
      participants: WorkflowNodeInput[];
      chairman: string;
      termination?: WorkflowDiscussionTerminationInput;
    };

function workflowSkills(plan:WorkflowPlanInput):SkillSelectionInput[]{
  const nodes=plan.mode==="dag"?plan.nodes:plan.mode==="graph"?[plan.executor,...plan.workers]:plan.participants;
  return nodes.flatMap(node=>{
    if(node.skills!==undefined&&!Array.isArray(node.skills))throw Error("invalid_workflow_skill_selection");
    return node.skills??[];
  });
}
function pinnedSkills(skills:SkillSelectionInput[]){
  return skills.some(value=>typeof value==="object"&&value!==null&&(value.revision!==undefined||value.installationId!==undefined));
}
async function requireSkillCapabilities(device:Pick<PhononDevice,"info">,skills:SkillSelectionInput[],workflow:boolean){
  const required=[...(workflow&&skills.length?["workflow_skill_selection_v1"]:[]),...(pinnedSkills(skills)?["pinned_skill_selection_v1"]:[])];
  if(!required.length)return;
  const info=await device.info() as {capabilities?:unknown};
  const capabilities=info?.capabilities;
  if(!Array.isArray(capabilities)||required.some(flag=>!capabilities.includes(flag)))throw Error("skill_selection_device_update_required");
}
function skillTarget(target?:ScheduleTargetInput){
  const direct=target?.skills??[];
  if(!Array.isArray(direct))throw Error("invalid_skill_selection");
  const workflow=target?.plan?workflowSkills(target.plan):[];
  return {skills:[...direct,...workflow],workflow:workflow.length>0};
}
const wireSnapshot=<T>(value:T):T=>JSON.parse(JSON.stringify(value)) as T;

/**
 * agent-phonon Server SDK。
 *
 * 让任何项目「一键成为 phonon 服务端」：导入 SDK → 配鉴权 → 监听 device →
 * 用干净接口（discover / createSession / send / onStream / onHook）编排
 * 多台设备上的 agent。协议帧/握手/ack/HITL 路由全由 SDK 处理。
 *
 * 支持多设备：一个 PhononServer 同时连多个 phonon。
 */

// ---------------------------------------------------------------------------
// PhononSession：一个会话，流式事件用 EventEmitter
// ---------------------------------------------------------------------------
export interface SendResult {
  turnId: string;
  disposition: string;
}

export class PhononSession extends EventEmitter {
  readonly sessionId: string;
  readonly device: PhononDevice;
  private lastSeq = -1;

  constructor(device: PhononDevice, sessionId: string) {
    super();
    this.device = device;
    this.sessionId = sessionId;
  }

  /** Send input; inject resolves only after application to the current turn.
   * Unsupported modes reject unless an explicit supported fallback is given. */
  async send(input: string, opts?: { verbosity?: "final" | "messages" | "tools" | "trace"; skills?: SkillSelectionInput[]; whenBusy?: "queue" | "interrupt" | "inject"; fallback?: "queue" | "interrupt" | "inject"; turnId?: string; clientRequestId?: string; reasoning?: {level:"low"|"standard"|"high"|"xhigh"|"max"|null} }): Promise<SendResult> {
    const payload={sessionId:this.sessionId,input,...opts};
    if(pinnedSkills(payload.skills??[])){
      const frozen=wireSnapshot(payload);await requireSkillCapabilities(this.device,frozen.skills??[],false);
      return this.device.call("session.send",frozen) as Promise<SendResult>;
    }
    return this.device.call("session.send",payload) as Promise<SendResult>;
  }

  /** Verify/reopen the same native Session without sending model input. */
  recover(expected: {project:string;agent:string;model:string}): Promise<SessionMeta> {
    return this.device.call("session.recover", {...expected, sessionId:this.sessionId}) as Promise<SessionMeta>;
  }

  inject(context: Array<{ role: "system" | "user" | "assistant"; content: string }>): Promise<unknown> {
    return this.device.call("session.inject", { sessionId: this.sessionId, context });
  }
  interrupt(reason?: string): Promise<unknown> {
    return this.device.call("session.interrupt", { sessionId: this.sessionId, reason });
  }
  switchModel(model: string): Promise<unknown> {
    return this.device.call("session.switchModel", { sessionId: this.sessionId, model });
  }
  compress(mode: "native" | "custom" = "native",opts?:{clientRequestId?:string;strategy?:string;keepRecentToolCalls?:number;background?:boolean}): Promise<unknown> {
    return this.device.call("session.compress", { sessionId: this.sessionId, mode,...opts });
  }
  compressionStatus(operationId:string):Promise<unknown>{return this.device.call("session.compression.status",{sessionId:this.sessionId,operationId});}
  status(): Promise<SessionMeta> {
    return this.device.call("session.status", { sessionId: this.sessionId }) as Promise<SessionMeta>;
  }
  terminate(): Promise<unknown> {
    return this.device.call("session.terminate", { sessionId: this.sessionId });
  }

  /** 内部：收到本 session 的 stream.event。 */
  _onStream(ev: StreamEvent): void {
    const seq = (ev as { seq: number }).seq;
    this.emit("stream", ev);
    if ((ev as { final?: boolean }).final) this.emit("end", ev);
    if (seq > this.lastSeq) this.lastSeq = seq;
  }
  /** 本 session 已收到的最大 seq（device 用于 ack）。 */
  get _lastSeq(): number {
    return this.lastSeq;
  }

  // 类型化 on
  override on(event: "stream", listener: (ev: StreamEvent) => void): this;
  override on(event: "end", listener: (ev: StreamEvent) => void): this;
  override on(event: string, listener: (...args: never[]) => void): this {
    return super.on(event, listener as (...args: unknown[]) => void);
  }
}

// ---------------------------------------------------------------------------
// PhononDevice：一台连入的设备
// ---------------------------------------------------------------------------
export type HookDecider = (hook: HookFiredParams, session: PhononSession | undefined) => HookAction | { action: HookAction; reason?: string } | Promise<HookAction | { action: HookAction; reason?: string }>;

export class PhononDevice extends EventEmitter {
  readonly deviceId: string;
  readonly tenantId: string;
  private peer: RpcPeer;
  private sessions = new Map<string, PhononSession>();
  private hookDecider?: HookDecider;
  private interactionHandler?: (params: unknown) => Promise<unknown> | unknown;
  private conversationBoardHandler?: (params: unknown) => Promise<unknown> | unknown;
  private conversationWorkflowHandler?: (params:unknown)=>Promise<unknown>|unknown;
  private conversationMessageHandler?: (params: unknown) => Promise<unknown> | unknown;
  private projectCoordinationHandler?: (params: unknown) => Promise<unknown> | unknown;
  private projectCoordinationEvidenceHandler?: (params: unknown) => Promise<unknown> | unknown;
  private documentHandler?: (params: unknown) => Promise<unknown> | unknown;
  private prepareUploadHandler?: (params: unknown) => Promise<unknown> | unknown;
  private streamEventHandler?: (ev: StreamEvent) => Promise<boolean | {ackSeq:number}> | boolean | {ackSeq:number};
  private workflowEventHandler?: (ev: WorkflowEvent) => Promise<unknown> | unknown;
  private runFinishedHandler?: (params: { run: Run; push: SchedulePushConsent }) => Promise<unknown> | unknown;
  /** 自发输出（无对应 session 时）回调。 */
  private onUnsolicited?: (ev: StreamEvent) => void;

  constructor(deviceId: string, tenantId: string, peer: RpcPeer) {
    super();
    this.deviceId = deviceId;
    this.tenantId = tenantId;
    this.peer = peer;
  }

  /** A deadline only bounds the reply wait; it does not cancel remote execution. */
  call(method: string, params: unknown, timeoutMs?: number): Promise<unknown> {
    return this.peer.request(method, params, timeoutMs);
  }
  readonly mcp = {
    configure: (params: import("@agent-phonon/protocol").ManagedMcpConfigureParams) => this.peer.request("mcp.configure", params) as Promise<import("@agent-phonon/protocol").ManagedMcpStatusResult>,
    status: () => this.peer.request("mcp.status", {}) as Promise<import("@agent-phonon/protocol").ManagedMcpStatusResult>,
  };

  readonly conversationArchive = {
    blob: {
      write: (params: ConversationArchiveBlobWriteParams) => this.peer.request("conversation.archive.blob.write", params) as Promise<ConversationArchiveBlobStatusResult>,
      status: (params: ConversationArchiveBlob) => this.peer.request("conversation.archive.blob.status", params) as Promise<ConversationArchiveBlobStatusResult>,
      read: (params: ConversationArchiveBlob & {offset?: number}) => this.peer.request("conversation.archive.blob.read", params) as Promise<ConversationArchiveBlobReadResult>,
    },
    entities: (params: Omit<ConversationArchiveEntitiesParams, "limit"> & Partial<Pick<ConversationArchiveEntitiesParams, "limit">>) => this.peer.request("conversation.archive.entities", params) as Promise<ConversationArchiveEntitiesResult>,
    append: (params: ConversationArchiveAppendParams) => this.peer.request("conversation.archive.append", params) as Promise<ConversationArchiveAppendResult>,
    read: (params: Omit<ConversationArchiveReadParams, "afterSequence" | "limit"> & Partial<Pick<ConversationArchiveReadParams, "afterSequence" | "limit">>) => this.peer.request("conversation.archive.read", params) as Promise<ConversationArchiveReadResult>,
    status: (params: ConversationArchiveScope) => this.peer.request("conversation.archive.status", params) as Promise<ConversationArchiveStatusResult>,
  };

  /** 确定性宿主机维护面：不依赖任何外部 Agent/LLM。 */
  readonly maintenance = {
    targets: () => this.peer.request("maintenance.targets", {}),
    diagnose: (targetId?: string) => this.peer.request("maintenance.diagnose", targetId ? { targetId } : {}),
    configGet: (targetId: string, configId: string) => this.peer.request("maintenance.config.get", { targetId, configId }),
    configEdit: (p: { targetId: string; configId: string; expectedSha256: string; edits: Array<{ oldText: string; newText: string }>; reason?: string; clientRequestId?: string }) => this.peer.request("maintenance.config.edit", p),
    configPatch: (p: { targetId: string; configId: string; expectedSha256: string; patch: Record<string, unknown>; reason?: string; clientRequestId?: string }) => this.peer.request("maintenance.config.patch", p),
    rollback: (backupId: string, expectedCurrentSha256: string, opts?: { reason?: string; clientRequestId?: string }) => this.peer.request("maintenance.rollback", { backupId, expectedCurrentSha256, ...opts }),
    packageUpdate: (targetId: string, opts?: { version?: string; clientRequestId?: string }) => this.peer.request("maintenance.package.update", { targetId, ...opts }),
    serviceStatus: (targetId: string, serviceId: string) => this.peer.request("maintenance.service.status", { targetId, serviceId }),
    serviceRestart: (targetId: string, serviceId: string, clientRequestId?: string) => this.peer.request("maintenance.service.restart", { targetId, serviceId, ...(clientRequestId ? { clientRequestId } : {}) }),
  };

  /** 列设备上可用 agent。 */
  async discover(): Promise<AgentDescriptor[]> {
    const r = (await this.peer.request("discovery.list", {})) as { agents: AgentDescriptor[] };
    return r.agents;
  }

  /** 获取单个 agent 发现条目。 */
  async getAgent(agentId: string): Promise<AgentDescriptor> {
    const r = (await this.peer.request("discovery.get", { agentId })) as { agent: AgentDescriptor };
    return r.agent;
  }

  /** 建会话。 */
  async createSession(params: { project: string; agent: string; model: string; worktreeId?: string; verbosity?: "final" | "messages" | "tools" | "trace"; clientRequestId?: string; clientTag?: string; agentConfig?: Record<string, unknown>; initialContext?: Array<{ role: "system" | "user" | "assistant"; content: string }> }): Promise<PhononSession> {
    const r = (await this.peer.request("session.create", { verbosity: "messages", ...params })) as { sessionId: string };
    const s = new PhononSession(this, r.sessionId);
    this.sessions.set(r.sessionId, s);
    return s;
  }

  /** 列会话。 */
  async listSessions(filter?: { project?: string; agent?: string; status?: string; limit?: number; cursor?: string }): Promise<{ sessions: SessionMeta[]; nextCursor?: string }> {
    return this.peer.request("session.list", filter ?? {}) as Promise<{ sessions: SessionMeta[]; nextCursor?: string }>;
  }

  /** OS metadata plus optional ssh hints (username, port and public/private/Tailscale IPs).
   * Hints contain no credentials and do not assert SSH reachability. Older devices may omit ssh. */
  info(): Promise<unknown> {
    return this.peer.request("device.info", {});
  }

  /** 设备资源快照（CPU/内存/磁盘/进程/GPU best-effort）。 */
  resources(): Promise<unknown> {
    return this.peer.request("device.resources", {});
  }

  /** Device-level browsable filesystem roots. */
  fsRoots(): Promise<unknown> {
    return this.peer.request("device.fs.roots", {});
  }

  /** Device-level directory listing under safe roots or absolute root paths. */
  async fsList(params?: { root?: string; path?: string; absolutePath?: string; includeHidden?: boolean; limit?: number;projectCandidates?:boolean;directoryInput?:string }): Promise<unknown> {
    if(params?.directoryInput!==undefined&&params.projectCandidates!==true)throw Error("directory_mode_required");
    if(params?.projectCandidates){const info=await this.info() as {capabilities?:unknown}|null;
      if(!info||!Array.isArray(info.capabilities)||!info.capabilities.includes("workspace_directory_picker_v1"))throw Error("workspace_directory_device_update_required");}
    return this.peer.request("device.fs.list", params ?? {});
  }

  // ---- project / file / skill 便捷封装 ----
  project = {
    provision: async (input: import("@agent-phonon/protocol").ProjectProvisionParams) => {
      const frozen=structuredClone(input),info=await this.info() as {capabilities?:unknown;projectProvisionReceiverID?:unknown}|null;
      if(!info||!Array.isArray(info.capabilities)||!info.capabilities.includes("project_provision_v1")||info.projectProvisionReceiverID!==frozen.expectedReceiverID)throw Error("project_provision_device_update_required");
      return this.peer.request("project.provision",frozen) as Promise<import("@agent-phonon/protocol").ProjectProvisionStatusResult>;
    },
    provisionStatus: (input: import("@agent-phonon/protocol").ProjectProvisionStatusParams) => this.peer.request("project.provision.status",input) as Promise<import("@agent-phonon/protocol").ProjectProvisionStatusResult>,
    create: async (p: { name: string; path?: string; git?: boolean; remote?: string; clientRequestId?: string;existingDirectoryIdentity?:string }):Promise<{project:import("@agent-phonon/protocol").ProjectDescriptor}> => {
      if(p.existingDirectoryIdentity!==undefined){const info=await this.info() as {capabilities?:unknown}|null;
        if(!info||!Array.isArray(info.capabilities)||!info.capabilities.includes("workspace_directory_picker_v1"))throw Error("workspace_directory_device_update_required");}
      const result=await this.peer.request("project.create",p) as {project:import("@agent-phonon/protocol").ProjectDescriptor};
      if(p.existingDirectoryIdentity!==undefined&&result.project.directoryIdentity!==p.existingDirectoryIdentity)throw Error("workspace_directory_unconfirmed");
      return result;
    },
    list: () => this.peer.request("project.list", {}) as Promise<{ projects: unknown[] }>,
    get: (projectId: string) => this.peer.request("project.get", { projectId }),
    remove: (projectId: string, opts?: { deleteFiles?: boolean; whenActiveSessions?: "reject" | "cascade" }) => this.peer.request("project.remove", { projectId, ...opts }),
    worktree: {
      create: (p: { projectId: string; baseBranch: string; newBranch?: string; path?: string }) => this.peer.request("project.worktree.create", p),
      list: (projectId: string) => this.peer.request("project.worktree.list", { projectId }),
      remove: (p: { projectId: string; worktreeId: string; force?: boolean }) => this.peer.request("project.worktree.remove", p),
    },
    deleteBranch: (p: { projectId: string; branch: string; force?: boolean }) => this.peer.request("project.git.deleteBranch", p),
    // v0.7: 6 个底层 git 操作（嵌套在 project.git 命名空间下）
    git: {
      commit: (p: { projectId: string; worktreeId?: string; message: string; files?: string[]; allowEmpty?: boolean; author?: { name: string; email: string } }) => this.peer.request("project.git.commit", p),
      merge: (p: { projectId: string; sourceBranch: string; targetBranch?: string; strategy?: "merge"|"squash"|"rebase"|"ff-only"; message?: string; abortOnConflict?: boolean }) => this.peer.request("project.git.merge", p),
      diff: (p: { projectId: string; worktreeId?: string; ref1?: string; ref2?: string; paths?: string[]; contextLines?: number; statOnly?: boolean; maxBytes?: number }) => this.peer.request("project.git.diff", p),
      log: (p: { projectId: string; worktreeId?: string; branch?: string; limit?: number; since?: string; until?: string; paths?: string[] }) => this.peer.request("project.git.log", p),
      push: (p: { projectId: string; worktreeId?: string; branch: string; remote?: string; force?: boolean; setUpstream?: boolean }) => this.peer.request("project.git.push", p),
      status: (p: { projectId: string; worktreeId?: string }) => this.peer.request("project.git.status", p),
      origin: (p:{projectId:string})=>this.peer.request("project.git.origin",p),
      deleteBranch: (p: { projectId: string; branch: string; force?: boolean }) => this.peer.request("project.git.deleteBranch", p),
    },
    exec: (p: { projectId: string; worktreeId?: string; command: string; args?: string[]; cwd?: string; env?: Record<string, string>; timeoutMs?: number; maxOutputBytes?: number }) => this.peer.request("project.exec", p),
  };

  env = {
    set: (p: { scope: "global" | "project" | "skill"; projectId?: string; agent?: string; skillName?: string; name: string; value: string; secret?: boolean; clientRequestId?: string }) => this.peer.request("env.set", p),
    list: (p?: { scope?: "global" | "project" | "skill"; projectId?: string; agent?: string; skillName?: string; reveal?: boolean }) => this.peer.request("env.list", p ?? {}),
    delete: (p: { scope: "global" | "project" | "skill"; projectId?: string; agent?: string; skillName?: string; name: string; clientRequestId?: string }) => this.peer.request("env.delete", p),
  };

  file = {
    read: (p: { projectId: string; worktreeId?: string; path: string; encoding?: "utf8" | "base64"; maxBytes?: number }) => this.peer.request("file.read", p),
    write: (p: { projectId: string; worktreeId?: string; path: string; encoding?: "utf8" | "base64"; data: string; overwrite?: boolean; createDirs?: boolean; clientRequestId?: string }) => this.peer.request("file.write", p),
    list: (p: { projectId: string; worktreeId?: string; path?: string; recursive?: boolean; limit?: number }) => this.peer.request("file.list", p),
    stat: (p: { projectId: string; worktreeId?: string; path: string }) => this.peer.request("file.stat", p),
    mkdir: (p: { projectId: string; worktreeId?: string; path: string; recursive?: boolean; clientRequestId?: string }) => this.peer.request("file.mkdir", p),
  };

  skill = {
    install: (p: { agent: string; name: string; scope: "global" | "project"; projectId?: string; source: unknown; clientRequestId?: string }) => this.peer.request("skill.install", p),
    installStatus: (p: {clientRequestId:string;agent:string;name:string;scope:"global"|"project";projectId?:string;includeReceiverIdentity?:true;includeRecoveryContext?:true}) => this.peer.request("skill.install.status",p),
    fence:(p:{clientRequestId:string;originalRequestId:string;agent:string;name:string;projectId:string;scope?:"project";expectedReceiverID:string;baseRecoveryRevision:string})=>this.peer.request("skill.install.fence",p),
    publish:(p:{clientRequestId:string;agent:string;name:string;projectId:string;scope?:"project";baseRevision:string|null;expectedReceiverID?:string;source:unknown})=>this.peer.request("skill.publish",p),
    unpublish:(p:{clientRequestId:string;agent:string;name:string;projectId:string;scope?:"project";baseRevision:string})=>this.peer.request("skill.unpublish",p),
    uninstall: (p: { agent: string; name: string; scope: "global" | "project"; projectId?: string; clientRequestId?: string }) => this.peer.request("skill.uninstall", p),
    list: (filter?: { agent?: string; scope?: "global" | "project"; projectId?: string }) => this.peer.request("skill.list", filter ?? {}),
    dirs: (filter?: { agent?: string; scope?: "global" | "project"; projectId?: string }) => this.peer.request("skill.dirs", filter ?? {}),
  };

  /**
   * L3 workflow orchestration。
   * 传入 typed plan/policy/sharedContext/resumeFrom；SDK 原样透传 phonon，
   * `device.on("workflowEvent", ...)` 订阅元事件（SDK 自动 ack）。
   *
   * 示例：
   *   const run = await device.workflow.run({
   *     project,
   *     plan: { mode: "dag", nodes: [...] },
   *     policy: { onNodeFailure: "skip_dependents", maxParallel: 3 },
   *     sharedContext: { text: "..." },
   *   });
   *   const status = await device.workflow.status(run.workflowId);
   */
  workflow = {
    cancelDispatch:(params:{dispatchKey:string;project:string;reason?:string})=>this.peer.request("workflow.dispatch.cancel",params) as Promise<WorkflowDispatchCancelResult>,
    run: async (params: {
      project?: string;
      worktreeId?: string;
      branch?: string;
      plan: WorkflowPlanInput;
      input?: string;
      policy?: WorkflowPolicy;
      sharedContext?: WorkflowSharedContext;
      resumeFrom?: WorkflowResumeFrom;
      clientRequestId?: string;
      metadata?: Record<string, unknown>;
    }) => {
      if(workflowSkills(params.plan).length){const frozen=wireSnapshot(params);await requireSkillCapabilities(this,workflowSkills(frozen.plan),true);return this.peer.request("workflow.run",frozen) as Promise<WorkflowRunResult>;}
      return this.peer.request("workflow.run",params) as Promise<WorkflowRunResult>;
    },
    status: (workflowId: string) =>
      this.peer.request("workflow.status", { workflowId }) as Promise<WorkflowStatusResult>,
    result: (params: import('@agent-phonon/protocol').WorkflowResultParams) =>
      this.peer.request("workflow.result", params) as Promise<import('@agent-phonon/protocol').WorkflowResultPage>,
    input:(params:Omit<import('@agent-phonon/protocol').WorkflowInputParams,'sessionId'>&{sessionId:string})=>this.peer.request("workflow.input",params) as Promise<import('@agent-phonon/protocol').WorkflowInputReceipt>,
    inputStatus:(workflowId:string,inputId:string)=>this.peer.request("workflow.input.status",{workflowId,inputId}) as Promise<import('@agent-phonon/protocol').WorkflowInputStatusResult>,
    cancel: (workflowId: string, reason?: string) =>
      this.peer.request("workflow.cancel", { workflowId, reason }) as Promise<WorkflowCancelResult>,
    pause: (workflowId: string, reason?: string) =>
      this.peer.request("workflow.pause", { workflowId, reason }) as Promise<{ workflowId: string; status: "paused" }>,
    list: (filter?: WorkflowListParams & {dispatchKey?:string}) =>
      this.peer.request("workflow.list", filter ?? {}) as Promise<WorkflowListResult>,
    /** v0.7: 独立 resume 入口。推荐使用，比 run({resumeFrom}) 语义更明确。 */
    resume: (params: {
      workflowId: string;
      strategy?: "continue" | "last_success_dependents" | "failed_node" | `node:${string}`;
      rerunNodes?: string[];
      feedback?: string;
      sharedContextPatch?: WorkflowSharedContext;
    }) => this.peer.request("workflow.resume", params) as Promise<WorkflowRunResult>,
    /** 手动 ack workflow.event seq≤lastSeq（平时不需调用，SDK 自动 ack）。 */
    ack: (workflowId: string, lastSeq: number) =>
      this.peer.notify("workflow.ack", { workflowId, lastSeq }),
    events: {
      list: (p: { workflowId: string; afterSeq?: number; limit?: number }) => this.peer.request("workflow.events.list", p) as Promise<{ events: WorkflowEvent[]; nextSeq?: number }>,
    },
    artifact: {
      register: (p: { workflowId: string; nodeId?: string; kind: "report" | "diff" | "spec" | "log" | "patch" | "image" | "binary" | "other"; path: string; title?: string; mimeType?: string; metadata?: Record<string, unknown> }) => this.peer.request("workflow.artifact.register", p),
    },
    artifacts: {
      list: (workflowId: string) => this.peer.request("workflow.artifacts.list", { workflowId }),
    },
  };

  /**
   * L4 scheduling（定时任务 / Automation）。
   *
   * 调度真相源在 device；server 只是控制+观测面。
   * - schedule.create/update/delete/list/get/enable/disable/trigger：管理
   * - schedule.runs.list / run.get / run.events.subscribe / run.cancel：观测
   * - `device.on("scheduleChanged" | "runStarted" | "runEvent" | "runFinished", ...)`：订阅推送
   *
   * 示例：
   *   const { schedule, webhookToken } = await device.schedule.create({
   *     name: "nightly",
   *     trigger: { kind: "cron", expr: "0 3 * * *", tz: "Asia/Shanghai" },
   *     target: { runKind: "session", project, agent, model, prompt: "..." },
   *     consent: { push: "summary" },
   *   });
   */
  schedule = {
    create: async (params: {
      name: string;
      trigger: ScheduleTrigger;
      target: ScheduleTargetInput;
      consent?: ScheduleConsent;
      policy?: SchedulePolicy;
      enabled?: boolean;
      clientRequestId?: string;
    }): Promise<ScheduleCreateResult> => {
      const selected=skillTarget(params.target);
      if(selected.workflow||pinnedSkills(selected.skills)){const frozen=wireSnapshot(params),bound=skillTarget(frozen.target);await requireSkillCapabilities(this,bound.skills,bound.workflow);return this.peer.request("schedule.create",frozen) as Promise<ScheduleCreateResult>;}
      return this.peer.request("schedule.create",params) as Promise<ScheduleCreateResult>;
    },
    update: async (params: {
      scheduleId: string;
      name?: string;
      enabled?: boolean;
      trigger?: ScheduleTrigger;
      target?: ScheduleTargetInput;
      consent?: ScheduleConsent;
      policy?: SchedulePolicy;
      clientRequestId?: string;
    }): Promise<{schedule:Schedule}> => {
      const selected=skillTarget(params.target);
      if(selected.workflow||pinnedSkills(selected.skills)){const frozen=wireSnapshot(params),bound=skillTarget(frozen.target);await requireSkillCapabilities(this,bound.skills,bound.workflow);return this.peer.request("schedule.update",frozen) as Promise<{schedule:Schedule}>;}
      return this.peer.request("schedule.update",params) as Promise<{schedule:Schedule}>;
    },
    delete: (scheduleId: string, clientRequestId?: string) =>
      this.peer.request("schedule.delete", { scheduleId, clientRequestId }) as Promise<{ scheduleId: string; deleted: boolean }>,
    list: (filter?: ScheduleListParams) =>
      this.peer.request("schedule.list", filter ?? {}) as Promise<ScheduleListResult>,
    get: (scheduleId: string, reveal?: boolean) =>
      this.peer.request("schedule.get", { scheduleId, reveal }) as Promise<{ schedule: Schedule }>,
    enable: (scheduleId: string, clientRequestId?: string) =>
      this.peer.request("schedule.enable", { scheduleId, clientRequestId }) as Promise<{ schedule: Schedule }>,
    disable: (scheduleId: string, clientRequestId?: string) =>
      this.peer.request("schedule.disable", { scheduleId, clientRequestId }) as Promise<{ schedule: Schedule }>,
    /** 手动触发一次 run（manual / 测试 cron / 重放 webhook 都走它）。 */
    trigger: (params: { scheduleId: string; source?: RunTriggerSource; input?: string | Record<string, unknown>; clientRequestId?: string }) =>
      this.peer.request("schedule.trigger", params) as Promise<{ scheduleId: string; runId: string; status: RunStatus }>,
    runs: {
      list: (params: { scheduleId: string; status?: RunStatus; limit?: number; unackedOnly?: boolean }) =>
        this.peer.request("schedule.runs.list", params) as Promise<{ runs: Run[] }>,
    },
    /** 手动 ack 终态 run（平时不需调用，SDK 在 run.finished 入口自动 ack）。 */
    ack: (runId: string, opts?: { lastSeq?: number; finished?: boolean }) =>
      this.peer.notify("schedule.ack", { runId, ...opts }),
  };

  /** L4 run 观测。 */
  run = {
    get: (runId: string) => this.peer.request("run.get", { runId }) as Promise<{ run: Run }>,
    resolve: (params: RunResolveInput) =>
      this.peer.request("run.resolve", params) as Promise<import("@agent-phonon/protocol").RunResolveResult>,
    events: {
      subscribe: (runId: string) =>
        this.peer.request("run.events.subscribe", { runId }) as Promise<{ runId: string; subscribed: boolean; sessionId?: string }>,
      unsubscribe: (runId: string) =>
        this.peer.request("run.events.unsubscribe", { runId }) as Promise<{ runId: string; subscribed: boolean }>,
    },
    cancel: (runId: string, reason?: string, clientRequestId?: string) =>
      this.peer.request("run.cancel", { runId, reason, clientRequestId }) as Promise<{ runId: string; status: RunStatus }>,
  };

  /**
   * Reliable run.finished consumer. 若设置，SDK 在 ack 前 await 该 handler，
   * 便于调用方先落库/转发再 ack。
   */
  setRunFinishedHandler(fn: (params: { run: Run; push: SchedulePushConsent }) => Promise<unknown> | unknown): void {
    this.runFinishedHandler = fn;
  }

  /**
   * Reliable workflow.event consumer. If set, SDK awaits this handler before
   * sending workflow.ack, so callers can persist/forward the event first.
   */
  setWorkflowEventHandler(fn: (ev: WorkflowEvent) => Promise<unknown> | unknown): void {
    this.workflowEventHandler = fn;
  }

  /** 流式订阅 workflow.event（不使用 EventEmitter 字符串名的 typed 参数版本）。 */
  onWorkflowEvent(handler: (ev: WorkflowEvent) => void): () => void {
    const wrapper = (params: unknown) => handler(params as WorkflowEvent);
    this.on("workflowEvent", wrapper);
    return () => this.off("workflowEvent", wrapper);
  }

  /** 设置 HITL 裁决器（device 级，所有 session 共用）。 */
  setHookDecider(fn: HookDecider): void {
    this.hookDecider = fn;
  }
  /**
   * v0.7: 设置 interaction.request 回调（HITL / workflow.human_review 走这里）。
   * 回调返回值会同步作为 phonon 侧 RPC 响应。可以是 async。
   * 不设置时，SDK 默认回 { action: "cancel" }，phonon 端会按 rejected 处理。
   * 推荐返回 `{ values: { approved: boolean, feedback?: string, reviewer?: string } }`。
   */
  /** Native/Dev requests retain nativeRunId/devRunId and their original workflow/turn attribution. */
  setInteractionHandler(fn: (params: unknown) => Promise<unknown> | unknown): void {
    this.interactionHandler = fn;
  }
  /** Handle controller-stamped conversation board reads/writes; absent is unsupported. */
  setConversationBoardHandler(fn: (params: unknown) => Promise<unknown> | unknown): void {
    this.conversationBoardHandler = fn;
  }
  setConversationWorkflowHandler(fn:(params:unknown)=>Promise<unknown>|unknown):void{this.conversationWorkflowHandler=fn;}
  /** Controller-owned group messages, including explicit immutable attachmentIDs.
   * Recorded receipts do not establish verified recipient file delivery. */
  setConversationMessageHandler(fn: (params: unknown) => Promise<unknown> | unknown): void { this.conversationMessageHandler = fn; }
  /** Preserve device-owned receive/workspaceVersion negotiation outside action; old hosts omit runtime workspace facts. */
  setProjectCoordinationHandler(fn: (params: unknown) => Promise<unknown> | unknown): void { this.projectCoordinationHandler = fn; }
  /** Device-only historical runtime observations; absent handlers never fabricate receipts. */
  setProjectCoordinationEvidenceHandler(fn:(params:unknown)=>Promise<unknown>|unknown):void{this.projectCoordinationEvidenceHandler=fn;}
  /** v0.7: 设置 document.send 处理器（不设则默认 delivered=[]）。 */
  setDocumentHandler(fn: (params: unknown) => Promise<unknown> | unknown): void {
    this.documentHandler = fn;
  }
  /** v0.7: 设置 document.prepare_upload 处理器（不设则默认空 stub）。 */
  setPrepareUploadHandler(fn: (params: unknown) => Promise<unknown> | unknown): void {
    this.prepareUploadHandler = fn;
  }
  /** Consumer must prove the whole cumulative prefix, not just this frame.
   * Return {ackSeq} from a durable contiguous cursor (possibly beyond ev.seq
   * after filling a gap), or true only when the prefix through ev.seq is safe.
   * False retains ordinary SDK routing; rejection sends no ACK. */
  setStreamEventHandler(fn: (ev: StreamEvent) => Promise<boolean | {ackSeq:number}> | boolean | {ackSeq:number}): void { this.streamEventHandler=fn; }
  /** Resend unacknowledged frames without reconnecting/restarting a model. */
  replayStream(sessionId: string, options?: { fromSeq?: number; limit?: number }): Promise<{ sessionId: string; replayed: number; nextSeq?: number }> {
    return this.peer.request("stream.replay", { sessionId, ...options }) as Promise<{ sessionId: string; replayed: number; nextSeq?: number }>;
  }
  interactionStatus(requestId:string):Promise<import("@agent-phonon/protocol").InteractionStatusResult>{
    return this.peer.request("interaction.status",{requestId}) as Promise<import("@agent-phonon/protocol").InteractionStatusResult>;
  }
  employeeProfiles={
    apply:(params:import("@agent-phonon/protocol").EmployeeProfileApplyParams)=>this.peer.request("employee.profile.apply",params) as Promise<import("@agent-phonon/protocol").EmployeeProfileStatusResult>,
    status:(employeeId:string)=>this.peer.request("employee.profile.status",{employeeId}) as Promise<import("@agent-phonon/protocol").EmployeeProfileStatusResult>,
  };
  /** 设置自发输出回调。 */
  setUnsolicitedHandler(fn: (ev: StreamEvent) => void): void {
    this.onUnsolicited = fn;
  }

  /** Close this device's owned transport and reject outstanding requests. */
  disconnect():void { this.peer.disconnect(); }

  /** 内部：处理 phonon → server 的请求/通知。 */
  async _handleInbound(method: string, params: unknown): Promise<unknown> {
    if (method === "stream.event") {
      const ev = params as StreamEvent;
      if(this.streamEventHandler){
        const consumed=await this.streamEventHandler(ev);
        if(consumed===true||(consumed&&typeof consumed==="object")){
          const ackSeq=consumed===true?ev.seq:consumed.ackSeq;
          if(!Number.isSafeInteger(ackSeq)||ackSeq<ev.seq)throw new Error("invalid cumulative stream ACK cursor");
          this.peer.notify("stream.ack",{sessionId:ev.sessionId,lastSeq:ackSeq});return null;
        }
      }
      if(ev.nativeProactive!==undefined)return null;
      const s = this.sessions.get((ev as { sessionId: string }).sessionId);
      if (s) {
        s._onStream(ev);
        // 自动 ack
        this.peer.notify("stream.ack", { sessionId: (ev as { sessionId: string }).sessionId, lastSeq: s._lastSeq });
      } else if ((ev as { origin?: string }).origin === "unsolicited" && this.onUnsolicited) {
        this.onUnsolicited(ev);
      }
      return null;
    }
    if (method === "hook.fired") {
      const fired = params as HookFiredParams;
      const s = this.sessions.get((fired as { sessionId?: string }).sessionId ?? "");
      if (!this.hookDecider) return { applied: true }; // 默认放行
      const d = await this.hookDecider(fired, s);
      const action = typeof d === "string" ? d : d.action;
      const reason = typeof d === "string" ? undefined : d.reason;
      return { action, reason };
    }
    if (method === "discovery.changed") { this.emit("discoveryChanged", params); return null; }
    if (method === "workflow.event") {
      const ev = params as WorkflowEvent;
      if (this.workflowEventHandler) await this.workflowEventHandler(ev);
      this.emit("workflowEvent", params);
      // auto-ack after reliable handler succeeds（与 stream.event 一致，避免 outbox 胀大）
      if (ev?.workflowId && typeof ev.seq === "number") {
        this.peer.notify("workflow.ack", { workflowId: ev.workflowId, lastSeq: ev.seq });
      }
      return null;
    }
    if (method === "document.send") {
      this.emit("document", params);
      if (this.documentHandler) return await this.documentHandler(params);
      return { delivered: [] };
    }
    if (method === "document.prepare_upload") {
      this.emit("prepareUpload", params);
      if (this.prepareUploadHandler) return await this.prepareUploadHandler(params);
      return { uploadRef: newId(), uploadUrl: "", method: "PUT" };
    }
    if (method === "conversation.board") {
      if (!this.conversationBoardHandler) throw new Error("Conversation boards are not supported by this server");
      return await this.conversationBoardHandler(params);
    }
    if (method === "conversation.message") {
      if (!this.conversationMessageHandler) throw new Error("Conversation messages are not supported by this server");
      return await this.conversationMessageHandler(params);
    }
    if (method === "project.coordination") {
      if (!this.projectCoordinationHandler) throw new Error("Project coordination is not supported by this server");
      return await this.projectCoordinationHandler(params);
    }
    if(method==="project.coordination.evidence"){
      if(!this.projectCoordinationEvidenceHandler)throw new Error("Project coordination evidence is not supported by this server");
      return await this.projectCoordinationEvidenceHandler(params);
    }
    if(method==="conversation.workflow"){
      if(!this.conversationWorkflowHandler)throw new Error("Conversation workflows are not supported by this server");
      return await this.conversationWorkflowHandler(params);
    }
    if (method === "interaction.request") {
      this.emit("interaction", params);
      if (this.interactionHandler) return await this.interactionHandler(params);
      // v0.7: 默认没注册 handler 时，engine 会按 rejected 处理（进 进 欢迎改进。返回 cancel 动作）。
      return { requestId: (params as { requestId?: string })?.requestId, action: "cancel" };
    }
    // ---- L4 scheduling p2s（镜像同步 + 推送）----
    if (method === "schedule.changed") { this.emit("scheduleChanged", params); return null; }
    if (method === "run.started") { this.emit("runStarted", params); return null; }
    if (method === "run.event") {
      this.emit("runEvent", params);
      // 订阅流自动 ack（与 stream.event 一致）
      const ev = params as { runId?: string; seq?: number };
      if (ev?.runId && typeof ev.seq === "number") {
        this.peer.notify("schedule.ack", { runId: ev.runId, lastSeq: ev.seq });
      }
      return null;
    }
    if (method === "run.finished") {
      const ev = params as { run: Run; push: SchedulePushConsent };
      if (this.runFinishedHandler) await this.runFinishedHandler(ev);
      this.emit("runFinished", params);
      // Controller dispatches must remain replayable until a durable consumer
      // or the polling controller explicitly acknowledges the occurrence.
      if (ev?.run?.id && (!(ev.run.controllerDispatch || ev.run.dispatch) || this.runFinishedHandler)) {
        this.peer.notify("schedule.ack", { runId: ev.run.id, finished: true });
      }
      return null;
    }
    return null;
  }

  _onClose(): void {
    this.peer.rejectAll("device disconnected");
    this.emit("disconnect");
  }
}

// ---------------------------------------------------------------------------
// PhononServer：监听 ws，管理多设备
// ---------------------------------------------------------------------------
export interface PhononServerOptions {
  port?: number;
  /** Bind address; omitted host binds to 127.0.0.1, never wildcard. */
  host?: string;
  /** 鉴权：返回 tenantId 表示通过，返回 null 拒绝。缺省仅在 loopback 放行（本地测试）。 */
  authenticate?: (deviceId: string, deviceKey: string | undefined) => { tenantId: string } | null | Promise<{ tenantId: string } | null>;
  /**
   * A5: 显式允许非 loopback 绑定时无 authenticate 匿名放行（默认 false）。
   * 不设 authenticate 且绑非 loopback 又不设 allowAnonymous=true → listen 报错。
   */
  allowAnonymous?: boolean;
}

export class PhononServer extends EventEmitter {
  private wss?: WebSocketServer;
  private opts: PhononServerOptions;
  private devices = new Map<string, PhononDevice>();
  private actualPort = 0;
  private closing?: Promise<void>;

  constructor(opts: PhononServerOptions = {}) {
    super();
    this.opts = opts;
  }

  listen(): Promise<number> {
    // A5: 非 loopback 绑定 + 无 authenticate + 未显式 allowAnonymous → 拒绝启动
    const host = this.opts.host ?? "127.0.0.1";
    const isLoopback = host === "127.0.0.1" || host === "::1" || host === "localhost";
    if (!this.opts.authenticate && this.opts.allowAnonymous !== true && !isLoopback) {
      throw new Error(
        `PhononServer refuses to listen on non-loopback host "${host}" without authenticate(); ` +
        `provide authenticate or set allowAnonymous=true (A5)`,
      );
    }
    return new Promise((resolve) => {
      const wss = new WebSocketServer({ port: this.opts.port ?? 0, host });
      this.wss = wss;
      wss.on("connection", (ws: WebSocket) => this.onConnection(ws));
      wss.on("listening", () => {
        const addr = wss.address();
        this.actualPort = typeof addr === "object" && addr ? addr.port : (this.opts.port ?? 0);
        resolve(this.actualPort);
      });
    });
  }

  get port(): number { return this.actualPort; }

  /** 当前连接的设备列表。 */
  listDevices(): PhononDevice[] { return [...this.devices.values()]; }
  getDevice(deviceId: string): PhononDevice | undefined { return this.devices.get(deviceId); }

  private onConnection(ws: WebSocket): void {
    const transport: Transport = { send: (d) => ws.send(d), close: () => ws.close() };
    let device: PhononDevice | undefined;

    const peer = new RpcPeer(transport, async (method, params) => {
      if (method === "connect.hello") {
        const p = params as { deviceId: string; auth?: { deviceKey?: string } };
        const auth = this.opts.authenticate
          ? await this.opts.authenticate(p.deviceId, p.auth?.deviceKey)
          : { tenantId: `tenant-${p.deviceId}` };
        if (!auth) throw new Error("unauthorized");
        // Authentication may complete after shutdown or peer disconnect.
        if (this.closing || ws.readyState !== ws.OPEN) throw new Error("connection closed");
        device = new PhononDevice(p.deviceId, auth.tenantId, peer);
        this.devices.set(p.deviceId, device);
        this.emit("device", device); // 用户监听这个
        return { protocolVersion: "0.1.0", tenantId: auth.tenantId, features: [], at: new Date().toISOString() };
      }
      if (!device) throw new Error("not connected");
      return device._handleInbound(method, params);
    });

    ws.on("message", (raw: Buffer) => peer.handle(raw.toString()));
    ws.on("close", () => {
      if (device) {
        if (this.devices.get(device.deviceId) === device) this.devices.delete(device.deviceId);
        device._onClose();
      }
    });
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    if (!this.wss) return Promise.resolve();
    const wss = this.wss;
    // WebSocketServer's close callback can precede each socket's close handler.
    // Wait for those handlers too, so no device remains visible after shutdown.
    this.closing = Promise.resolve().then(async () => {
      const socketsClosed = [...wss.clients].map(client => new Promise<void>(resolve => {
        if (client.readyState === client.CLOSED) { resolve(); return; }
        client.once("close", () => resolve());
        client.terminate();
      }));
      const serverClosed = new Promise<void>(resolve => wss.close(() => resolve()));
      await Promise.all([...socketsClosed, serverClosed]);
      this.devices.clear();
      this.wss = undefined;
    });
    return this.closing;
  }
}
