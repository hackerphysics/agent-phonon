import { readdir, lstat, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir, platform } from "node:os";
import { isAbsolute, join, relative, resolve, parse } from "node:path";
import { SessionEngine, AdapterRegistry } from "./session-engine.js";
import { RpcPeer, PhononError, type RpcTransport } from "./rpc.js";
import { ProjectManager, runGit } from "./project-manager.js";
import {workspaceDirectorySuggestions} from "./workspace-directories.js";
import { SkillManager } from "./skill-manager.js";
import { PolicyEnforcer } from "./policy.js";
import { IdempotencyStore } from "./idempotency.js";
import {SkillInstallOperations} from "./skill-install-operations.js";
import {ProjectProvisioner} from "./project-provision.js";
import {PeerContextReporter} from "./peer-context-reporter.js";
import type {DeviceInfoResult,SkillInstallParams,SkillInstallStatusParams,SkillInstallFenceParams,SkillPublishParams,SkillUnpublishParams} from "@agent-phonon/protocol";
import { Outbox } from "./outbox.js";
import { PhononStore } from "./store.js";
import { FileManager } from "./file-manager.js";
import { collectDeviceResources } from "./resources.js";
import { collectDeviceInfo } from "./device-info.js";
import { WorkflowEngine } from "./workflow-engine.js";
import { SchedulerEngine } from "./scheduler-engine.js";
import { EnvManager } from "./env-manager.js";
import { MaintenanceManager, type MaintenanceManagerConfig } from "./maintenance.js";
import { InteractionReceipts, interactionHash } from "./interaction-receipts.js";
import { EmployeeProfiles } from "./employee-profiles.js";
import { conversationArchiveAuthority } from "./conversation-archive.js";
import type { AgentAdapter } from "./adapter.js";
import { PROTOCOL_VERSION, parseParams, METHODS, type StreamEvent, type TenantPolicy, type MethodName, type WorkflowPlan } from "@agent-phonon/protocol";

/** 改状态的方法（幂等适用）。 */
const MUTATING_METHODS = new Set<string>([
  "session.create",
  "session.send",
  "project.create",
  "project.remove",
  "project.worktree.create",
  "project.worktree.remove",
  "project.git.deleteBranch",
  "project.git.commit",
  "project.git.merge",
  "project.git.push",
  "skill.install",
  "skill.install.fence",
  "skill.publish",
  "skill.unpublish",
  "skill.uninstall",
  "file.write",
  "file.mkdir",
  "env.set",
  "env.delete",
  "maintenance.config.patch",
  "maintenance.config.edit",
  "maintenance.rollback",
  "maintenance.package.update",
  "maintenance.service.restart",
  "workflow.run",
  "workflow.pause",
  "workflow.input",
  "workflow.cancel",
  "workflow.resume",
  "schedule.create",
  "schedule.update",
  "schedule.delete",
  "schedule.enable",
  "schedule.disable",
  "schedule.trigger",
  "run.cancel",
  "run.resolve",
]);

/**
 * 设备侧 daemon 的「一条连接处理器」（L2 dispatch，design §6）。
 *
 * 一个 PhononConnection = 一条到某 server 的连接 = 一个 tenant。
 * 它把 server 下发的 session.* 路由到 SessionEngine，并在交给 L1 前做 tenant 校验；
 * 同时把 engine 产出的 stream.event 推回 server。
 *
 * 真实场景：phonon 主动拨出连真 server。
 * 测试场景：test-server 主动连进来，或 phonon 连 test-server——传输无关，靠 RpcTransport 抽象。
 */
export class PhononConnection {
  private directoryRead?:Promise<unknown>;
  private directoryReadRevision?:symbol;
  private readonly managedMcp?: ManagedMcpHandlers;
  private interactionReceipts:InteractionReceipts;
  private employees:EmployeeProfiles;
  readonly tenantId: string;
  private engine: SessionEngine;
  private peer: RpcPeer;
  private peerReporter?:PeerContextReporter;
  private registry: AdapterRegistry;
  private projects: ProjectManager;
  private projectProvision:ProjectProvisioner;
  private skills: SkillManager;
  private skillInstalls:SkillInstallOperations;
  private policy: PolicyEnforcer;
  private idempotency: IdempotencyStore;
  private outbox: Outbox;
  private store: PhononStore;
  private archiveAuthority?: string;
  private files: FileManager;
  private env: EnvManager;
  private maintenance: MaintenanceManager;
  private obs?: import("./observability.js").ObsBus;
  private workflows?: WorkflowEngine;
  private scheduler?: SchedulerEngine;
  private disposed = false;
  private workflowRetryTimer?: ReturnType<typeof setTimeout>;
  private disposePromise?: Promise<void>;
  private releaseInventory: () => void;
  constructor(opts: {
    managedMcp?: ManagedMcpHandlers;
    nativeFileBroker?: import("./native-file-broker.js").NativeFileBroker;
    tenantId: string;
    transport: RpcTransport;
    registry: AdapterRegistry;
    policy?: Partial<TenantPolicy>;
    trustLocal?: boolean;
    workspaceRoot?: string;
    /** sqlite 文件路径（缺省内存库）。 */
    dbPath?: string;
    /** 或直接注入已有 store（多连接共享）。 */
    store?: PhononStore;
    /** Locally configured connection origin, never accepted from RPC params. */
    archiveAuthority?: string;
    /** Local runtime assets for Windows employee workspace operations. */
    employeeProfileFileBrokerRoot?:string;
    /** 可观测事件总线（可选）。 */
    obs?: import("./observability.js").ObsBus;
    /** 设备本地预注册的确定性维护目标。 */
    maintenance?: MaintenanceManagerConfig;
    delivery?: Partial<import("./delivery-capacity.js").DeliveryConfig>;
  }) {
    this.managedMcp = opts.managedMcp;
    this.tenantId = opts.tenantId;
    this.registry = opts.registry;
    this.policy = new PolicyEnforcer({ policy: opts.policy, trustLocal: opts.trustLocal, workspaceRoot: opts.workspaceRoot });
    // 持久化（D6）：projects/skills/worktrees/outbox 落 sqlite；dbPath 缺省内存库
    this.store = opts.store ?? new PhononStore(opts.dbPath ?? ":memory:");
    this.archiveAuthority = conversationArchiveAuthority(opts.archiveAuthority);
    this.interactionReceipts=new InteractionReceipts(this.store,this.tenantId);
    this.store.delivery.configure(opts.delivery, opts.obs);
    this.idempotency = new IdempotencyStore({ store: this.store });
    this.maintenance = new MaintenanceManager(this.policy, opts.maintenance);

    // 先建 engine（ProjectManager 要用它查 active session）
    this.outbox = new Outbox({ store: this.store, tenantId: opts.tenantId });
    this.engine = new SessionEngine(opts.registry, (event: StreamEvent) => {
      // The original stream promise must be durable even if a derived channel fails.
      this.sendStreamEvent(event);
      this.workflows?.onStreamEvent(event);
      this.scheduler?.onStreamEvent(event);
    }, opts.obs, this.store, {
      maintenance: this.maintenance,
      assertAgentAllowed: (agentId) => this.policy.assertAgentAllowed(agentId),
      prepareSkills:(tenant,project,agent,selections)=>{
        if(tenant!==this.tenantId)throw new PhononError("errSessionNotInTenant");
        return this.skills.prepareExecution(project,agent,selections);
      },
      loadSkills:(tenant,project,agent,selected)=>{
        if(tenant!==this.tenantId)throw new PhononError("errSessionNotInTenant");
        return this.skills.loadExecution(project,agent,selected);
      },
      requestInteraction:(params,signal)=>this.requestInteraction(params,signal) as Promise<import("@agent-phonon/protocol").InteractionRequestResult>,
      acknowledgeInteraction:(id,hash)=>this.interactionReceipts.applied(id,hash),
      conversationBoard:async params=>{
        const { ConversationBoardParams, ConversationBoardResult }=await import("@agent-phonon/protocol");
        return ConversationBoardResult.parse(await this.peer.requestRaw("conversation.board",ConversationBoardParams.parse(params),15000));
      },
      conversationWorkflow:async params=>{
        const {ConversationWorkflowParams,ConversationWorkflowResult}=await import("@agent-phonon/protocol");
        return ConversationWorkflowResult.parse(await this.peer.requestRaw("conversation.workflow",ConversationWorkflowParams.parse(params),params.operation==="execute"?0:15000));
      },
      conversationMessage: async params => {
        const { ConversationMessageParams, ConversationMessageResult } = await import("@agent-phonon/protocol");
        return ConversationMessageResult.parse(await this.peer.requestRaw("conversation.message", ConversationMessageParams.parse(params), 15000));
      },
      projectCoordination: async params => {
        const { ProjectCoordinationParams, ProjectCoordinationResult } = await import("@agent-phonon/protocol");
        return ProjectCoordinationResult.parse(await this.peer.requestRaw("project.coordination", ProjectCoordinationParams.parse(params), 15000));
      },
      ...(this.archiveAuthority?{coordinationEvidenceAuthority:this.archiveAuthority,
        coordinationEvidenceChanged:()=>this.kickPeerEvidence()}:{}),
      publishDocument: async params => {
        const { NativeDocumentInput, DocumentSendParams, DocumentSendResult, NATIVE_DOCUMENT_MAX_BYTES } = await import("@agent-phonon/protocol");
        const {projectId,worktreeId,nativeRunId,workflowId,sessionId,turnId,...raw}=params;
        const input=NativeDocumentInput.parse(raw);
        this.policy.assertMethodAllowed("file.read");
        const result=await this.files.read({projectId,...(worktreeId?{worktreeId}:{}),path:input.path,encoding:"base64",maxBytes:NATIVE_DOCUMENT_MAX_BYTES});
        const bytes=Buffer.from(result.data,"base64");
        if(result.truncated||bytes.length!==result.sizeBytes||bytes.length>NATIVE_DOCUMENT_MAX_BYTES)throw new PhononError("errInvalidParams","document file exceeds the limit or could not be read completely");
        const name=input.name??parse(input.path).base;
        const wire=DocumentSendParams.parse({nativeRunId,workflowId,sessionId,turnId,requestId:input.requestId,at:new Date().toISOString(),documents:[{
          name,relativePath:input.path,mimeType:input.mimeType??"application/octet-stream",kind:"file",caption:input.caption,
          sizeBytes:bytes.length,sha256:createHash("sha256").update(bytes).digest("hex"),content:{encoding:"base64",data:bytes.toString("base64")},
        }]});
        const response=DocumentSendResult.parse(await this.peer.requestRaw("document.send",wire,30000));
        if(response.delivered.length!==1||response.delivered[0]?.name!==name||!response.delivered[0]?.ok||!response.delivered[0]?.serverRef)throw new PhononError("errInvalidParams","document publication was not confirmed; reconcile the original request identity");
        return response;
      },
      resolveEmployee:(tenant,id,revision,agent)=>{if(tenant!==this.tenantId)throw new PhononError("errSessionNotInTenant");return this.employees.resolve(id,revision,agent);},
      useEmployee:(tenant,id)=>{if(tenant!==this.tenantId)throw new PhononError("errSessionNotInTenant");return this.employees.use(id);},
    }, opts.tenantId);
    this.obs = opts.obs;

    this.projects = new ProjectManager(
      (projectId) => this.engine.activeSessionsForProject(projectId), // 真实 active 查询（修 P0#8）
      {
        namespace: this.tenantId,
        assertProjectPath: (p) => this.policy.assertProjectPath(p),
        assertDeleteFiles: () => this.policy.assertDeleteFiles(),
        store: this.store,
        workspaceRoot: this.policy.workspaceRoot, // 与 policy 一致，避免路径校验冲突
        hasActiveSessionsForWorktree: (wtId) => this.engine.activeSessionsForWorktree(wtId), // 精确查询（B8）
      },
    );
    this.engine.resolveCwdForReattach = (projectId, worktreeId) => this.projects.resolveCwd(projectId, worktreeId);
    this.projectProvision=new ProjectProvisioner(this.tenantId,this.store.projectProvisionPath(),this.policy,this.projects,opts.nativeFileBroker);
    this.projects.setPreparedIdentityGuard((id,path)=>this.projectProvision.assertProject(id,path));
    this.employees=new EmployeeProfiles(this.tenantId,this.store,this.registry,this.policy,this.projects,opts.employeeProfileFileBrokerRoot);
    this.skills = new SkillManager(
      opts.registry,
      (projectId) => {
        try {
          return this.projects.get(projectId).path;
        } catch(error) {
          if(error instanceof PhononError&&error.appCode==="errProjectNotFound")return undefined;
          throw error;
        }
      },
      this.store,
      {tenantId:this.tenantId,assertAgentAllowed:agent=>this.policy.assertAgentAllowed(agent),nativeFileBroker:opts.nativeFileBroker,
        assertActive:()=>{if(this.disposed)throw new PhononError("errSkillInstallUnconfirmed","skill connection is no longer active");}},
    );
    this.skillInstalls=new SkillInstallOperations(this.tenantId,this.store,this.skills,(input,method)=>{
      this.policy.assertMethodAllowed(method);this.policy.assertAgentAllowed(input.agent);
      if(input.scope==="global")this.policy.assertGlobalSkillInstall();else this.projects.get(input.projectId!);
      if(input.source.kind==="url")this.policy.assertUrlSkillInstall();
      if(input.source.kind==="localPath")this.policy.assertLocalPathSkillInstall();
    });
    this.files = new FileManager({ resolveCwd: (projectId, worktreeId) => this.projects.resolveCwd(projectId, worktreeId), assertPath:(absolutePath,projectRoot)=>this.policy.assertDocumentPath(absolutePath,projectRoot) });
    this.env = new EnvManager(this.tenantId, this.store, { allowReveal: () => this.policy.allowEnvReveal() });

    this.peer = new RpcPeer(opts.transport, (method, params) => this.dispatch(method, params));
    if(this.store.hasPeerContextJournal())this.kickPeerEvidence();
    this.releaseInventory = this.registry.inventory.acquire((event) => this.notifyDiscoveryChanged(event));
    this.workflows = new WorkflowEngine({
      tenantId: this.tenantId,
      engine: this.engine,
      resolveCwd: (projectId, worktreeId) => this.projects.resolveCwd(projectId, worktreeId),
      env: this.env,
      // v0.6: 接入 ProjectManager 给 workflow node 提供 per-node worktree 按需创建/checkout 能力
      projects: {
        worktreeCreate: (params) => this.projects.worktreeCreate(params).then((wt) => ({ worktreeId: wt.worktreeId, path: wt.path, branch: wt.branch })),
        worktreeRemove: (params) => this.projects.worktreeRemove(params),
        runGit: async (projectId, args) => runGit(this.projects.get(projectId).path, args),
        getProjectPath: (projectId) => this.projects.get(projectId).path,
      },
      store: this.store,
      emit: (event) => {
        this.scheduler?.onWorkflowEvent(event);
        this.peer.notifyRaw("workflow.event", event);
      },
      replay: (payload) => {
        if (this.disposed) return;
        // Preserve the persisted event bytes, not a regenerated status/envelope payload.
        opts.transport.send(`{"jsonrpc":"2.0","method":"workflow.event","params":${payload}}`);
      },
      requestInteraction: (params: unknown) => this.requestInteraction(params),
      acknowledgeInteraction:(id,response)=>this.interactionReceipts.applied(id,interactionHash(response)),
    });

    // L4 调度器（device-authoritative）。当前由 PhononConnection 持有：重连会
    // dispose 旧实例、由新实例从 store 重建 cron；在途 run 会明确落为 failed，
    // 避免旧 connection 的 timers/runtime 与新实例并存。
    this.scheduler = new SchedulerEngine({
      tenantId: this.tenantId,
      engine: this.engine,
      store: this.store,
      resolveCwd: (projectId) => this.projects.resolveCwd(projectId),
      workflows: () => this.workflows,
      emit: (method, params) => this.peer.notifyRaw(method, params),
      assertRunAllowed: (schedule) => this.policy.assertMethodAllowed(schedule.target.runKind === "dispatch" ? "schedule.trigger" : schedule.target.runKind === "workflow" ? "workflow.run" : "session.create"),
    });
    this.scheduler.start();
    this.scheduler.replayUnacked();
    this.replayWorkflowEvents();
    // Workflow ownership is tenant-scoped and persisted. Recovery runs only
    // after scheduler/event wiring is complete so resumed events reach the
    // current connection and no replaced connection keeps an executor alive.
    void this.workflows.recover().catch(() => this.store.delivery.backgroundFailed("workflow"));
  }

  /** 喂入收到的文本。 */
  private kickPeerEvidence():void{
    if(this.disposed||!this.archiveAuthority)return;
    this.peerReporter??=new PeerContextReporter(this.store.peerContextJournal(),this.tenantId,this.archiveAuthority,
      params=>this.peer.requestRaw("project.coordination.evidence",params,5000));
    this.peerReporter.kick();
  }

  handle(data: string): Promise<void> {
    return this.peer.handle(data);
  }

  /** 连接断开时永久释放 connection-scoped runtime。 */
  onClose(reason = "connection closed"): Promise<void> {
    return this.dispose(reason);
  }

  /**
   * Idempotent permanent teardown. Because SessionEngine is currently owned by
   * a connection, active turns/runs are interrupted and persisted as
   * paused/failed before a reconnect builds the replacement runtime.
   */
  dispose(reason = "connection disposed"): Promise<void> {
    this.peerReporter?.close();
    if (this.disposePromise) return this.disposePromise;
    this.disposed = true;
    clearTimeout(this.workflowRetryTimer);
    this.workflowRetryTimer = undefined;
    const skillSettlement=this.skillInstalls.dispose();
    const projectSettlement=this.projectProvision.dispose();
    this.releaseInventory();
    this.peer.dispose(reason);
    this.scheduler?.dispose(reason);
    this.disposePromise = (async () => {
      await this.employees.dispose();
      await this.workflows?.dispose(reason);
      await this.engine.dispose();
      await skillSettlement;
      await projectSettlement;
    })();
    return this.disposePromise;
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  /** @internal Start only after authenticated transport publication. Disposal owns the timer. */
  startWorkflowEventRetry(canSend: () => boolean): void {
    if (this.disposed || this.workflowRetryTimer) return;
    this.workflowRetryTimer = setTimeout(() => {
      this.workflowRetryTimer = undefined;
      if (this.disposed) return;
      try { this.replayWorkflowEvents(canSend); }
      catch { this.store.delivery.backgroundFailed("workflow"); }
      this.startWorkflowEventRetry(canSend);
    }, 5_000);
    this.workflowRetryTimer.unref?.();
  }

  private replayWorkflowEvents(canSend?: () => boolean): number {
    if (this.disposed) return 0;
    return this.workflows?.replayUnacked(canSend) ?? 0;
  }

  /** 下行可靠投递：必须先落 outbox；transport 失败只延迟投递，不回滚事件。 */
  private sendStreamEvent(event: StreamEvent): void {
    this.outbox.enqueue(event);
    try {
      this.peer.notifyRaw("stream.event", event);
    } catch (err) {
      this.obs?.emitEvent({
        category: "stream", level: "warn", event: "stream.send_deferred",
        tenantId: this.tenantId, sessionId: (event as { sessionId?: string }).sessionId,
        msg: (err as Error)?.message ?? "stream transport send failed",
      });
    }
  }

  /** 重连后补发未 ack 的 stream.event（D29）。参数保留旧的 exclusive-watermark 兼容语义。 */
  replayPending(resumeFrom?: Array<{ sessionId: string; fromSeq: number }>): number {
    const events = this.outbox.pending(resumeFrom);
    let sent = 0;
    for (const e of events) {
      try {
        this.peer.notifyRaw("stream.event", e);
        sent++;
      } catch {
        // 保留全部未 ACK 记录；同一失效 transport 上继续发送没有收益。
        break;
      }
    }
    return sent;
  }

  /** connect.hello 使用的“每 session 第一条未 ACK seq”。 */
  resumeFrom(): Array<{ sessionId: string; fromSeq: number }> {
    return this.outbox.resumeFrom();
  }

  /** welcome/stream.ack 的唯一入口：单调推进并同步 sqlite。 */
  acknowledgeStream(sessionId: string, lastSeq: number): void {
    this.outbox.ack(sessionId, lastSeq);
  }

  /** Device-wide durable backlog, including disconnected tenants. */
  deliveryStatus(): import("./delivery-capacity.js").DeliverySnapshot {
    return this.store.delivery.snapshot();
  }

  /** outbox 待投递事件数（监控用）。 */
  get outboxSize(): number {
    return this.outbox.size;
  }

  /** 当前 session 实时快照（可观测 /sessions）。 */
  sessionsSnapshot(): Array<Record<string, unknown>> {
    return this.engine.snapshot(this.tenantId);
  }

  // ---- p2s 主动发起（phonon → server，平面③ + HITL）----

  /** document.send RPC helper (D20); generic native directive/read producer is not yet wired. */
  async sendDocument(params: unknown): Promise<unknown> {
    return this.peer.requestRaw("document.send", params);
  }

  /** Upload-credential RPC helper (P1-6), not an HTTP file uploader. */
  async prepareUpload(params: unknown): Promise<unknown> {
    return this.peer.requestRaw("document.prepare_upload", params);
  }

  /** 主动通知 server：agent 可用性变化（discovery.changed，D14）。 */
  notifyDiscoveryChanged(params: unknown): void {
    if (this.disposed) return;
    const event = METHODS["discovery.changed"].params.parse(params);
    try { this.policy.assertAgentAllowed(event.agentId); } catch { return; }
    this.peer.notifyRaw("discovery.changed", event);
  }

  /** 发可交互表单给 server，阻塞等人填（interaction.request，D21/P1-5）。 */
  async requestInteraction(params: unknown,signal?:AbortSignal): Promise<unknown> {
    if((params as {nativeRunId?:string})?.nativeRunId||(params as {devRunId?:string})?.devRunId)return this.interactionReceipts.request(params,
      p=>this.peer.requestRaw("interaction.request",p,0),(id,response)=>{this.peer.resolveRequest("interaction.request",id,response);},signal);
    const timeout = (params as { timeoutSeconds?: number })?.timeoutSeconds;
    return this.peer.requestRaw("interaction.request", params, timeout ? timeout * 1000 + 5000 : 120000);
  }

  /** 报 hook 事件并阻塞等 server 裁决（hook.fired，design §8，HITL）。 */
  async fireHook(params: unknown): Promise<unknown> {
    const p = (params ?? {}) as { sessionId?: string; hookType?: string; payload?: { toolName?: string } };
    this.obs?.emitEvent({
      category: "hitl", level: "info", event: "hitl.fired",
      tenantId: this.tenantId, sessionId: p.sessionId,
      msg: `HITL ${p.hookType} for tool ${p.payload?.toolName ?? "?"}`,
      data: { hookType: p.hookType, toolName: p.payload?.toolName },
    });
    const res = (await this.peer.requestRaw("hook.fired", params)) as { action?: string };
    this.obs?.emitEvent({
      category: "hitl", level: res?.action === "abort" ? "warn" : "info", event: "hitl.resolved",
      tenantId: this.tenantId, sessionId: p.sessionId,
      msg: `HITL decision: ${res?.action ?? "continue"}`, data: { action: res?.action },
    });
    return res;
  }

  /** 某 phonon sessionId 是否属于本连接（tenant）——HookBridge 路由用。 */
  ownsSession(sessionId: string): boolean {
    try {
      this.engine.assertTenant(sessionId, this.tenantId);
      return true;
    } catch {
      return false;
    }
  }

  /** server → phonon 方法分发（L2 dispatch）。 */
  private async dispatch(method: string, params: unknown): Promise<unknown> {
    let p = (params ?? {}) as Record<string, unknown>;
    // 协议级参数校验（bug-bash#2 B6）：s2p 方法过 zod，非法参数 → errInvalidParams
    if (method in METHODS && (METHODS as Record<string, { direction: string }>)[method]?.direction === "s2p") {
      try {
        p = parseParams(method as MethodName, params) as Record<string, unknown>;
      } catch (err) {
        throw new PhononError("errInvalidParams", `invalid params for ${method}: ${(err as Error)?.message?.slice(0, 200)}`);
      }
    }
    // 只读租户 / 方法白名单（policy）
    this.policy.assertMethodAllowed(method);
    // Current scope also applies to cached receipts, not only fresh mutations.
    if(method.startsWith("skill.")){
      if(typeof p.agent==="string")this.policy.assertAgentAllowed(p.agent);
      if(method==="skill.install.fence")this.policy.assertSkillRecovery();
      if((method==="skill.install"||method==="skill.uninstall")&&p.scope==="global")this.policy.assertGlobalSkillInstall();
      if((method==="skill.publish"||method==="skill.install.fence")&&p.expectedReceiverID!==undefined&&p.expectedReceiverID!==this.store.skillReceiverIdentity(this.tenantId,false))
        throw new PhononError("errSkillInstallUnconfirmed","the current skill receiver differs from the prepared receiver");
      if(method==="skill.install"){
        const source=p.source as {kind?:string}|undefined;
        if(source?.kind==="url")this.policy.assertUrlSkillInstall();
        if(source?.kind==="localPath")this.policy.assertLocalPathSkillInstall();
      }
      if(typeof p.projectId==="string"&&(p.scope==="project"||method==="skill.list"||method==="skill.dirs"))this.projects.get(p.projectId);
      if((method==="skill.install"||method==="skill.publish")&&typeof p.clientRequestId==="string")this.store.assertSkillInstallUnfenced(this.tenantId,p.clientRequestId);
    }
    // 幂等：改状态请求带 clientRequestId 则去重（D28 / P0#2）
    const crid = p.clientRequestId as string | undefined;
    if (crid && method!=="workflow.run" && method!=="skill.install.fence" && MUTATING_METHODS.has(method)) {
      return this.idempotency.run(this.tenantId, method, crid, () => this.dispatchInner(method, p),
        (method==="project.create"&&p.existingDirectoryIdentity!==undefined||["session.create", "session.send", "schedule.trigger", "run.resolve", "workflow.resume", "skill.install", "skill.uninstall","skill.publish","skill.unpublish","skill.install.fence"].includes(method)) ? p : undefined);
    }
    return this.dispatchInner(method, p);
  }

  private deviceFsRoots(): { roots: Array<{ root: string; path: string; label?: string }> } {
    const roots: Array<{ root: string; path: string; label?: string }> = [
      { root: "workspaceRoot", path: this.policy.workspaceRoot, label: "agent-phonon workspace root" },
      { root: "home", path: homedir(), label: "user home" },
    ];
    if (platform() === "win32") {
      for (const c of "ABCDEFGHIJKLMNOPQRSTUVWXYZ") {
        const p = `${c}:\\\\`;
        if (existsSync(p)) roots.push({ root: p, path: p, label: `${c}: drive` });
      }
    } else {
      roots.push({ root: "/", path: "/", label: "filesystem root" });
    }
    return { roots };
  }

  private async workspaceDirectories(params:Record<string,unknown>):Promise<unknown>{
    const revision=Symbol();this.directoryReadRevision=revision;
    while(this.directoryRead){await this.directoryRead.catch(()=>{});if(this.directoryReadRevision!==revision)throw new PhononError("errInvalidParams","directory query superseded");}
    const check=()=>{
      if(this.directoryReadRevision!==revision)throw new PhononError("errInvalidParams","directory query superseded");
      if(this.disposed)throw new PhononError("errPolicyDenied","connection is closed");
      this.policy.assertMethodAllowed("device.fs.list");if(!this.policy.allowDeviceFsBrowse())throw new PhononError("errPolicyDenied","directory browsing disabled");
    };
    check();const operation=workspaceDirectorySuggestions(String(params.directoryInput??""),Number(params.limit??100),this.policy,this.projects,check);this.directoryRead=operation;
    try{return await operation;}finally{if(this.directoryRead===operation)this.directoryRead=undefined;}
  }
  private async deviceFsList(params: { root?: string; path?: string; absolutePath?: string; includeHidden?: boolean; limit?: number }): Promise<unknown> {
    const roots = this.deviceFsRoots().roots;
    const root = params.absolutePath ? parse(params.absolutePath).root : (params.root ?? "workspaceRoot");
    const rootPath = params.absolutePath ? parse(params.absolutePath).root : (roots.find((r) => r.root === root)?.path ?? root);
    const relPath = params.absolutePath ? relative(rootPath, params.absolutePath) || "." : (params.path ?? ".");
    if (isAbsolute(relPath)) throw new PhononError("errPolicyDenied", "device.fs.list relative path must not be absolute when using root");
    const target = resolve(rootPath, relPath);
    const rootReal = await realpath(rootPath);
    const targetReal = await realpath(target);
    const rel = relative(rootReal, targetReal);
    if (rel.startsWith("..") || isAbsolute(rel)) throw new PhononError("errPolicyDenied", "device.fs.list path escapes selected root");
    const entriesRaw = await readdir(targetReal, { withFileTypes: true });
    const limit = params.limit ?? 200;
    const filtered = entriesRaw.filter((e) => params.includeHidden || !e.name.startsWith("."));
    const entries = [] as Array<{ name: string; path: string; realPath: string; kind: "file" | "directory" | "symlink" | "other"; size?: number; mtimeMs?: number }>;
    for (const e of filtered.slice(0, limit)) {
      const full = join(targetReal, e.name);
      const st = await lstat(full);
      const kind = e.isDirectory() ? "directory" : e.isFile() ? "file" : e.isSymbolicLink() ? "symlink" : "other";
      entries.push({ name: e.name, path: join(relPath, e.name), realPath: await realpath(full).catch(() => full), kind, size: st.isFile() ? st.size : undefined, mtimeMs: st.mtimeMs });
    }
    return { root, rootPath: rootReal, path: relPath, realPath: targetReal, entries, truncated: filtered.length > limit };
  }

  private async dispatchInner(method: string, p: Record<string, unknown>): Promise<unknown> {
    const maintenanceMutation = method === "maintenance.config.edit" || method === "maintenance.config.patch" || method === "maintenance.rollback" || method === "maintenance.package.update" || method === "maintenance.service.restart";
    if (maintenanceMutation) {
      this.obs?.emitEvent({
        category: "tool", level: "info", event: method, tenantId: this.tenantId,
        msg: `${method} requested`,
        data: {
          targetId: p.targetId,
          configId: p.configId,
          serviceId: p.serviceId,
          backupId: p.backupId,
          version: p.version,
          reason: p.reason,
        },
      });
    }
    switch (method) {
      case "mcp.configure":
      case "mcp.status": {
        if (!this.managedMcp) throw new PhononError("errCapabilityUnsupported", "managed MCP is unavailable");
        const { ManagedMcpConfigureParams, ManagedMcpStatusResult } = await import("@agent-phonon/protocol");
        return ManagedMcpStatusResult.parse(method === "mcp.configure"
          ? await this.managedMcp.configure(ManagedMcpConfigureParams.parse(p)) : await this.managedMcp.status());
      }
      case "device.info": {
        const info:DeviceInfoResult = await collectDeviceInfo();
        const provisionReceiver=await this.projectProvision.capability();
        if(provisionReceiver){info.projectProvisionReceiverID=provisionReceiver;info.capabilities.push("project_provision_v1");}
        info.capabilities.push("pinned_skill_selection_v1","workflow_skill_selection_v1","native_workflow_skill_selection_v1","native_workflow_canvas_skill_v1");
        if(this.store.supportsDurableSkillInstalls)info.capabilities.push("skill_install_receipts_v1","skill_install_fence_v1");
        const receiverID=this.store.skillReceiverIdentity(this.tenantId);
        if(receiverID){info.skillReceiverID=receiverID;info.capabilities.push("skill_install_receiver_identity_v1");}
        if(await this.skills.immutableAvailable())info.capabilities.push("immutable_skill_publication_v1");
        if (this.managedMcp) info.capabilities.push("managed_mcp_v1");
        if (this.archiveAuthority && this.policy.policy.allowConversationArchives && this.store.supportsConversationArchives) info.capabilities.push("conversation_archive_v1", "conversation_archive_entities_v1", "conversation_archive_blobs_v1");
        return info;
      }
      case "conversation.archive.append":
      case "conversation.archive.read":
      case "conversation.archive.entities":
      case "conversation.archive.blob.write":
      case "conversation.archive.blob.read":
      case "conversation.archive.blob.status":
      case "conversation.archive.status": {
        if (!this.policy.policy.allowConversationArchives) throw new PhononError("errPolicyDenied", "conversation archives require allowConversationArchives");
        if (!this.archiveAuthority) throw new PhononError("errArchiveUnavailable", "conversation archive connection identity is unavailable");
        const archive = this.store.conversationArchives();
        if (method === "conversation.archive.blob.write") return archive.writeBlob(this.archiveAuthority, this.tenantId, p, this.policy.policy.maxConversationArchiveBytes);
        if (method === "conversation.archive.blob.read") return archive.readBlob(this.archiveAuthority, this.tenantId, p);
        if (method === "conversation.archive.blob.status") return archive.blobStatus(this.archiveAuthority, this.tenantId, p);
        if (method === "conversation.archive.append") return archive.append(this.archiveAuthority, this.tenantId, p, this.policy.policy.maxConversationArchiveBytes);
        if (method === "conversation.archive.read") return archive.read(this.archiveAuthority, this.tenantId, p);
        if (method === "conversation.archive.entities") return archive.entities(this.archiveAuthority, this.tenantId, p);
        return archive.status(this.archiveAuthority, this.tenantId, p);
      }
      case "device.resources":
        return collectDeviceResources(this.policy.workspaceRoot);
      case "device.fs.roots":
        if (!this.policy.allowDeviceFsBrowse()) throw new PhononError("errPolicyDenied", "device.fs browse disabled by policy (allowDeviceFsBrowse)");
        return this.deviceFsRoots();
      case "device.fs.list":
        if (!this.policy.allowDeviceFsBrowse()) throw new PhononError("errPolicyDenied", "device.fs browse disabled by policy (allowDeviceFsBrowse)");
        if(p.projectCandidates===true)return this.workspaceDirectories(p);
        return this.deviceFsList(p as { root?: string; path?: string; absolutePath?: string; includeHidden?: boolean; limit?: number });
      case "maintenance.targets":
        return this.maintenance.targets();
      case "maintenance.diagnose":
        return this.maintenance.diagnose(p.targetId as string | undefined);
      case "maintenance.config.get":
        return this.maintenance.configGet(p.targetId as string, p.configId as string);
      case "maintenance.config.edit":
        return this.maintenance.configEdit(p as never);
      case "maintenance.config.patch":
        return this.maintenance.configPatch(p as never);
      case "maintenance.rollback":
        return this.maintenance.rollback(p.backupId as string, p.expectedCurrentSha256 as string, p.reason as string | undefined);
      case "maintenance.package.update":
        return this.maintenance.packageUpdate(p.targetId as string, p.version as string | undefined);
      case "maintenance.service.status":
        return this.maintenance.serviceStatus(p.targetId as string, p.serviceId as string);
      case "maintenance.service.restart":
        return this.maintenance.serviceRestart(p.targetId as string, p.serviceId as string);
      case "discovery.list": {
        const agents = await this.registry.inventory.list();
        return { agents: agents.filter((agent) => {
          try { this.policy.assertAgentAllowed(agent.agentId); } catch { return false; }
          return !p.availableOnly || agent.available;
        }) };
      }
      case "discovery.get": {
        this.policy.assertAgentAllowed(p.agentId as string);
        const found = (await this.registry.inventory.list()).find((a) => a.agentId === p.agentId);
        if (!found) throw new PhononError("errAgentUnavailable", `agent ${p.agentId} not found`);
        return { agent: found };
      }
      case "session.create": {
        this.store.delivery.assertNewWork();
        this.policy.assertAgentAllowed(p.agent as string);
        // ProjectManager is the sole project/worktree resolver. Unregistered
        // IDs must never be interpreted as filesystem paths.
        const cwd = this.projects.resolveCwd(p.project as string, p.worktreeId as string | undefined);
        const r = await this.engine.create({
          tenantId: this.tenantId,
          project: p.project as string,
          worktreeId: p.worktreeId as string | undefined,
          cwd,
          agent: p.agent as string,
          model: p.model as string,
          verbosity: (p.verbosity as "messages") ?? "messages",
          agentConfig: p.agentConfig as Record<string, unknown> | undefined,
          initialContext: p.initialContext as never,
        });
        return { sessionId: r.sessionId, project: p.project, agent: p.agent, model: p.model, status: r.status, createdAt: r.createdAt };
      }
      case "session.send": {
        this.store.delivery.assertNewWork();
        const meta = await this.engine.status(this.tenantId, p.sessionId as string);
        const r = await this.engine.send(this.tenantId, p.sessionId as string, p.input as string, {
          verbosity: p.verbosity as never,
          turnId: p.turnId as string | undefined,
          skills: (p.skills as import("@agent-phonon/protocol").SkillSelection[]) ?? undefined,
          environment: this.env.resolveForExecution({ projectId: meta.project, agent: meta.agent, skills: (p.skills as import("@agent-phonon/protocol").SkillSelection[]) ?? undefined }),
          whenBusy: p.whenBusy as never,
          fallback: p.fallback as never,
          reasoning: p.reasoning as never,
        });
        return { sessionId: p.sessionId, turnId: r.turnId, accepted: true, disposition: r.disposition, queuePosition: r.queuePosition };
      }
      case "session.interrupt": {
        const r = await this.engine.interrupt(this.tenantId, p.sessionId as string, p.reason as string | undefined);
        return { sessionId: p.sessionId, interruptedTurnId: r.interruptedTurnId, status: r.status,...(r.nativeStop?{nativeStop:r.nativeStop}:{}) };
      }
      case "session.switchModel": {
        const r = await this.engine.switchModel(this.tenantId, p.sessionId as string, p.model as string);
        return { sessionId: p.sessionId, previousModel: r.previousModel, model: r.model, warnings: r.warnings };
      }
      case "session.inject": {
        const r = await this.engine.inject(this.tenantId, p.sessionId as string, p.context as never);
        return { sessionId: p.sessionId, injected: r.injected };
      }
      case "session.compress": {
        return this.engine.compress(this.tenantId,p.sessionId as string,p.mode as "native"|"custom",p.strategy as string|undefined,
          {keepRecentToolCalls:p.keepRecentToolCalls as number|undefined},p.clientRequestId as string|undefined,p.background===true);
      }
      case "session.compression.status": return this.engine.compressionStatus(this.tenantId,p.sessionId as string,p.operationId as string);
      case "session.terminate": {
        const r = await this.engine.terminate(this.tenantId, p.sessionId as string);
        return { sessionId: p.sessionId, status: r.status };
      }
      case "session.status":
        return this.engine.status(this.tenantId, p.sessionId as string);
      case "session.recover":
        return this.engine.recover(this.tenantId,p.sessionId as string,{project:p.project as string,agent:p.agent as string,model:p.model as string});
      case "session.list":
        return this.engine.list(this.tenantId, p as never);

      // ---- project (D23/D25) ----
      case "project.provision": return this.projectProvision.provision(p);
      case "project.provision.status": return this.projectProvision.status(p);
      case "project.create": {
        const r = await this.projects.create({ name: p.name as string, path: p.path as string | undefined, git: p.git as boolean | undefined, remote: p.remote as string | undefined,existingDirectoryIdentity:p.existingDirectoryIdentity as string|undefined },()=>{
          if(this.disposed)throw new PhononError("errPolicyDenied","connection is closed");this.policy.assertMethodAllowed("project.create");
        });
        return { project: { projectId: r.projectId, namespace: r.namespace, name: r.name, path: r.path, git: r.git, createdAt: r.createdAt,...(r.directoryIdentity?{directoryIdentity:r.directoryIdentity}:{}) } };
      }
      case "project.list":
        return { projects: this.projects.list().map((r) => ({ projectId: r.projectId, namespace: r.namespace, name: r.name, path: r.path, git: r.git, createdAt: r.createdAt,...(r.employeeId?{employeeId:r.employeeId}:{}) })) };
      case "project.get": {
        const r = this.projects.get(p.projectId as string,{readonly:true});
        return { project: { projectId: r.projectId, namespace: r.namespace, name: r.name, path: r.path, git: r.git, createdAt: r.createdAt,...(r.employeeId?{employeeId:r.employeeId}:{}),...(r.directoryIdentity?{directoryIdentity:r.directoryIdentity}:{}) } };
      }
      case "project.remove": {
        const r = await this.projects.remove(p.projectId as string, { deleteFiles: p.deleteFiles as boolean, whenActiveSessions: p.whenActiveSessions as "reject" | "cascade" });
        // cascade：真正 terminate 被级联的 session（修 B8：之前只返回列表不 terminate）
        if (r.terminatedSessions) {
          for (const sid of r.terminatedSessions) {
            await this.engine.terminate(this.tenantId, sid).catch(() => {});
          }
        }
        return { projectId: p.projectId, removed: true, filesDeleted: r.filesDeleted, terminatedSessions: r.terminatedSessions };
      }
      case "project.worktree.create": {
        const r = await this.projects.worktreeCreate({ projectId: p.projectId as string, baseBranch: p.baseBranch as string, newBranch: p.newBranch as string | undefined, path: p.path as string | undefined });
        return { worktree: r };
      }
      case "project.worktree.list":
        return { worktrees: this.projects.worktreeList(p.projectId as string) };
      case "project.worktree.remove": {
        const r = await this.projects.worktreeRemove({ projectId: p.projectId as string, worktreeId: p.worktreeId as string, force: p.force as boolean });
        return { worktreeId: p.worktreeId, removed: true, affectedSessions: r.affectedSessions };
      }
      case "project.git.deleteBranch": {
        const r = await this.projects.deleteBranch({ projectId: p.projectId as string, branch: p.branch as string, force: p.force as boolean });
        return { branch: p.branch, deleted: true, wasMerged: r.wasMerged, affectedWorktrees: r.affectedWorktrees };
      }
      case "project.git.commit":
        return this.projects.gitCommit(p as { projectId: string; worktreeId?: string; message: string; files?: string[]; allowEmpty?: boolean; author?: { name: string; email: string } });
      case "project.git.merge":
        return this.projects.gitMerge(p as { projectId: string; sourceBranch: string; targetBranch?: string; strategy?: "merge"|"squash"|"rebase"|"ff-only"; message?: string; abortOnConflict?: boolean });
      case "project.git.diff":
        return this.projects.gitDiff(p as { projectId: string; worktreeId?: string; ref1?: string; ref2?: string; paths?: string[]; contextLines?: number; statOnly?: boolean; maxBytes?: number });
      case "project.git.log":
        return this.projects.gitLog(p as { projectId: string; worktreeId?: string; branch?: string; limit?: number; since?: string; until?: string; paths?: string[] });
      case "project.git.push":
        return this.projects.gitPush(p as { projectId: string; worktreeId?: string; branch: string; remote?: string; force?: boolean; setUpstream?: boolean });
      case "project.git.status":
        return this.projects.gitStatus(p as { projectId: string; worktreeId?: string });
      case "project.git.origin":
        return this.projects.gitOrigin(p as {projectId:string});
      case "project.exec":
        this.policy.assertExec(); // A2/A3: exec 需独立 gate（默认禁；trustLocal 开）
        return this.projects.exec(p as { projectId: string; worktreeId?: string; command: string; args?: string[]; cwd?: string; env?: Record<string, string>; timeoutMs?: number; maxOutputBytes?: number });

      // ---- file workspace IO (project/worktree scoped) ----
      case "file.read":
        return this.files.read(p as { projectId: string; worktreeId?: string; path: string; encoding?: "utf8" | "base64"; maxBytes?: number });
      case "file.write":
        return this.files.write(p as { projectId: string; worktreeId?: string; path: string; encoding?: "utf8" | "base64"; data: string; overwrite?: boolean; createDirs?: boolean });
      case "file.list":
        return this.files.list(p as { projectId: string; worktreeId?: string; path?: string; recursive?: boolean; limit?: number });
      case "file.stat":
        return this.files.stat(p as { projectId: string; worktreeId?: string; path: string });
      case "file.mkdir":
        return this.files.mkdir(p as { projectId: string; worktreeId?: string; path: string; recursive?: boolean });

      case "env.set":
        this.policy.assertEnvWrite();
        return this.env.set(p as { scope: "global" | "project" | "skill"; projectId?: string; agent?: string; skillName?: string; name: string; value: string; secret?: boolean });
      case "env.list":
        return this.env.list(p as { scope?: "global" | "project" | "skill"; projectId?: string; agent?: string; skillName?: string; reveal?: boolean });
      case "env.delete":
        this.policy.assertEnvWrite();
        return this.env.delete(p as { scope: "global" | "project" | "skill"; projectId?: string; agent?: string; skillName?: string; name: string });

      // ---- skill (D24 + 边界规则) ----
      case "skill.install": {
        return this.skillInstalls.install(p as SkillInstallParams);
      }
      case "skill.install.status":return this.skillInstalls.status(p as SkillInstallStatusParams);
      case "skill.install.fence":return this.store.fenceSkillInstall(this.tenantId,p as SkillInstallFenceParams);
      case "skill.publish":return this.skillInstalls.publish(p as SkillPublishParams);
      case "skill.unpublish":return this.skills.unpublish(p as SkillUnpublishParams);
      case "skill.uninstall": {
        await this.skills.uninstall({ agent: p.agent as string, name: p.name as string, scope: p.scope as "global" | "project", projectId: p.projectId as string | undefined });
        return { agent: p.agent, name: p.name, scope: p.scope, uninstalled: true };
      }
      case "skill.list":
        return { skills: this.skills.list({ agent: p.agent as string | undefined, scope: p.scope as "global" | "project" | undefined, projectId: p.projectId as string | undefined }) };
      case "skill.dirs":
        return { directories: await this.skills.dirs({ agent: p.agent as string | undefined, scope: p.scope as "global" | "project" | undefined, projectId: p.projectId as string | undefined }) };

      // ---- L3 workflow orchestration ----
      case "workflow.run":
        if (p.project) {
          // Workflow worktreeId is an isolation key. WorkflowEngine validates
          // every node project and lazily creates the real worktree handle.
          this.projects.resolveCwd(p.project as string);
        }
        return this.workflows!.run({
          clientRequestId: p.clientRequestId as string | undefined,
          project: p.project as string,
          worktreeId: p.worktreeId as string | undefined,
          branch: p.branch as string | undefined,
          plan: p.plan as WorkflowPlan,
          input: p.input as string | undefined,
          policy: p.policy as never,
          sharedContext: p.sharedContext as never,
          resumeFrom: p.resumeFrom as never,
          metadata: p.metadata as Record<string, unknown> | undefined,
        });
      case "workflow.status":
        return this.workflows!.status(p.workflowId as string);
      case "workflow.result":
        return this.workflows!.resultPage(p as never);
      case "workflow.input":
        this.store.delivery.assertNewWork();
        return this.workflows!.input(p as never);
      case "workflow.input.status":
        return this.workflows!.inputStatus(p as never);
      case "workflow.cancel":
        return this.workflows!.cancel(p.workflowId as string, p.reason as string | undefined);
      case "workflow.dispatch.cancel":
        return this.workflows!.cancelDispatch(p.dispatchKey as string,p.project as string,p.reason as string|undefined);
      case "workflow.pause":
        return this.workflows!.pause(p.workflowId as string, p.reason as string | undefined);
      case "workflow.list":
        return this.workflows!.list(p as { status?: string; projectId?: string; since?: string; until?: string; limit?: number });
      case "workflow.resume":
        return this.workflows!.resume({
          workflowId: p.workflowId as string,
          strategy: (p.strategy as "last_success_dependents" | "failed_node" | `node:${string}` | undefined) ?? "failed_node",
          rerunNodes: p.rerunNodes as string[] | undefined,
          feedback: p.feedback as string | undefined,
          sharedContextPatch: p.sharedContextPatch as never,
        });
      case "workflow.ack": {
        this.workflows?.ack(p.workflowId as string, p.lastSeq as number);
        return null;
      }
      case "workflow.events.list":
        return this.workflows!.eventsList(p as { workflowId: string; afterSeq?: number; limit?: number });
      case "workflow.artifact.register":
        return this.workflows!.artifactRegister(p as { workflowId: string; nodeId?: string; kind: "report" | "diff" | "spec" | "log" | "patch" | "image" | "binary" | "other"; path: string; title?: string; mimeType?: string; metadata?: Record<string, unknown> });
      case "workflow.artifacts.list":
        return this.workflows!.artifactsList(p.workflowId as string);

      // ---- L4 scheduling (cron / webhook / manual; device-authoritative) ----
      case "schedule.create": {
        const target = p.target as { project: string };
        this.projects.resolveCwd(target.project);
        return this.scheduler!.create({
          name: p.name as string,
          trigger: p.trigger as never,
          target: target as never,
          consent: p.consent as never,
          policy: p.policy as never,
          enabled: p.enabled as boolean | undefined,
        });
      }
      case "schedule.update": {
        const target = p.target as { project: string } | undefined;
        if (target) this.projects.resolveCwd(target.project);
        return this.scheduler!.update({
          scheduleId: p.scheduleId as string,
          name: p.name as string | undefined,
          enabled: p.enabled as boolean | undefined,
          trigger: p.trigger as never,
          target: target as never,
          consent: p.consent as never,
          policy: p.policy as never,
        });
      }
      case "schedule.delete":
        return this.scheduler!.delete(p.scheduleId as string);
      case "schedule.list":
        return this.scheduler!.list(p as { enabled?: boolean; triggerKind?: "cron" | "webhook" | "manual"; reveal?: boolean; limit?: number });
      case "schedule.get":
        return this.scheduler!.get(p.scheduleId as string, p.reveal as boolean | undefined);
      case "schedule.enable":
        return this.scheduler!.setEnabled(p.scheduleId as string, true);
      case "schedule.disable":
        return this.scheduler!.setEnabled(p.scheduleId as string, false);
      case "schedule.trigger":
        return this.scheduler!.trigger({
          scheduleId: p.scheduleId as string,
          source: p.source as never,
          input: p.input as string | Record<string, unknown> | undefined,
        });
      case "schedule.runs.list":
        return this.scheduler!.runsList(p.scheduleId as string, { status: p.status as string | undefined, limit: p.limit as number | undefined, unackedOnly: p.unackedOnly as boolean | undefined });
      case "run.get":
        return this.scheduler!.runGet(p.runId as string);
      case "run.resolve":
        return this.scheduler!.resolve(p as never);
      case "run.events.subscribe":
        return this.scheduler!.subscribe(p.runId as string);
      case "run.events.unsubscribe":
        return this.scheduler!.unsubscribe(p.runId as string);
      case "run.cancel":
        return this.scheduler!.cancel(p.runId as string, p.reason as string | undefined);
      case "schedule.ack": {
        this.scheduler?.ack(p.runId as string, { lastSeq: p.lastSeq as number | undefined, finished: p.finished as boolean | undefined });
        return null;
      }

      // ---- 连接/可靠性（s2p） ----
      case "stream.ack": {
        // server 确认已收 seq≤lastSeq → phonon 清 outbox（D29 / P0-4）。
        this.acknowledgeStream(p.sessionId as string, p.lastSeq as number);
        return null;
      }
      case "stream.replay": {
        const sessionId = p.sessionId as string;
        this.engine.assertTenant(sessionId, this.tenantId);
        const limit = p.limit as number;
        const events = this.outbox.pending([{ sessionId, fromSeq: p.fromSeq as number }]).filter(event => event.sessionId === sessionId);
        const page = events.slice(0, limit);
        for (const event of page) this.peer.notifyRaw("stream.event", event);
        return { sessionId, replayed: page.length, ...(events.length > limit ? { nextSeq: page[page.length - 1]!.seq + 1 } : {}) };
      }
      case "interaction.response": {
        // server 回填人机交互结果（P1-5）→ 路由回对应 session/turn。v0 记录即可。
        if (!this.peer.resolveRequest("interaction.request", p.requestId as string, p)) {
          this.engine.resolveInteraction(p.requestId as string, p);
        }
        return null;
      }
      case "interaction.status": return this.interactionReceipts.status(p.requestId as string);
      case "employee.profile.apply": return this.employees.apply(p);
      case "employee.profile.status": return this.employees.status(p.employeeId as string);
      case "interaction.cancel": {
        // server 主动取消一个 pending 交互（P1-5）。
        const response = { action: "cancel", requestId: p.requestId };
        const cancelled = this.peer.resolveRequest("interaction.request", p.requestId as string, response)
          || this.engine.resolveInteraction(p.requestId as string, response);
        return { requestId: p.requestId, cancelled };
      }
      case "hook.resolve": {
        // server 主动下发裁决（异步路径；同步路径是 hook.fired 的 RPC 响应）。
        return { sessionId: p.sessionId, hookId: p.hookId, applied: true };
      }
      default:
        throw new PhononError("errInvalidParams", `method not implemented in v0 core: ${method}`);
    }
  }
}

export { SessionEngine, AdapterRegistry, RpcPeer, PhononError, PROTOCOL_VERSION };
export { DiscoveryInventory, discoveryOptions } from "./discovery-inventory.js";
export type { DiscoveryOptions } from "./discovery-inventory.js";
export type { AgentAdapter, RpcTransport };
export * from "./adapter.js";
export { OpenClawAdapter } from "./adapters/openclaw.js";
export { OpenClawGatewayAdapter } from "./adapters/openclaw-gateway.js";
export { GatewayClient } from "./gateway-client.js";
export type { GatewayConfig } from "./gateway-client.js";
export { PhononClient } from "./client.js";
export { assertSecureServerUrl } from "./client.js";
export { HookBridge } from "./hook-bridge.js";
export type { HookRouteResolver } from "./hook-bridge.js";
export { ProjectManager } from "./project-manager.js";
export { SkillManager } from "./skill-manager.js";
export { PolicyEnforcer } from "./policy.js";
export { IdempotencyStore } from "./idempotency.js";
export { Outbox } from "./outbox.js";
export { WorkflowEngine } from "./workflow-engine.js";
export { SchedulerEngine } from "./scheduler-engine.js";
export { parseCron, nextCronAfter } from "./cron.js";
export { PhononStore } from "./store.js";
export { ConversationArchive, conversationArchiveAuthority } from "./conversation-archive.js";
export { SecretBox } from "./secret-box.js";
export { FileManager } from "./file-manager.js";
export {NativeFileBroker} from "./native-file-broker.js";
export { EnvManager } from "./env-manager.js";
export { DANGEROUS_CHILD_ENV_NAMES, isDangerousChildEnvName, sanitizeRemoteEnvironment, buildChildProcessEnvironment } from "./child-env.js";
export { ProcessSupervisor, spawnSupervised, spawnSupervisedAgent } from "./process-supervisor.js";
export type { ProcessSupervisorOptions } from "./process-supervisor.js";
export { dropToolIOFromJsonlFiles, dropToolIOFromValue, computeKeepToolBlocks } from "./custom-compress.js";
export { dropToolIORowsSqlite } from "./sqlite-compress.js";
export { resolveCodexSessionFile } from "./adapters/codex.js";
export { resolveOpenCodeDbPath } from "./adapters/opencode.js";
export { resolveHermesDbPath, resolveHermesSessionByTitle } from "./adapters/hermes.js";
export { collectDeviceResources } from "./resources.js";
export { collectDeviceInfo } from "./device-info.js";
export { ObsBus, StructuredLogger, Metrics, AuditSink } from "./observability.js";
export type { ObsEvent, ObsCategory, ObsLevel } from "./observability.js";
export { ClaudeCodeAdapter } from "./adapters/claude-code.js";
export type { ClaudeCodeEnv } from "./adapters/claude-code.js";
export { CodexAdapter } from "./adapters/codex.js";
export type { CodexEnv } from "./adapters/codex.js";
export { HermesAdapter } from "./adapters/hermes.js";
export { HERMES_BRIDGE } from "./adapters/hermes-bridge.js";
export type { HermesEnv } from "./adapters/hermes.js";
export { OpenCodeAdapter } from "./adapters/opencode.js";
export type { OpenCodeEnv } from "./adapters/opencode.js";
export { CopilotAdapter, parseCopilotEvent, parseCopilotModelsHelp } from "./adapters/copilot.js";
export type { CopilotEnv, ParsedCopilotEvent } from "./adapters/copilot.js";
export { PiAdapter, parsePiEvent, parsePiModels, parsePiVersion, toPiSessionId,
  parsePiSessionFlags, probePiSessionFlags } from "./adapters/pi.js";
export type { PiEnv, ParsedPiEvent, PiSessionFlags } from "./adapters/pi.js";
export { observePiSession, rescuePiSession, verifyPiSession } from "./adapters/pi-recovery.js";
export type { PiNativeObservation } from "./adapters/pi-recovery.js";
export { PI_HITL_EXTENSION_SOURCE, materializePiHitlExtension, piHitlExtensionHash, piHitlExtensionPath, piHitlStateDir } from "./pi-hitl-extension.js";
export { RescueAdapter } from "./adapters/rescue.js";
export type { RescueAdapterOptions } from "./adapters/rescue.js";
export { spawnAgent, spawnSyncAgent, quoteWinArg } from "./proc.js";
export { TranscriptWriter } from "./transcript.js";
export { MaintenanceManager, applyJsonMergePatch } from "./maintenance.js";
export type { MaintenanceRuntime, MaintenanceManagerConfig, MaintenanceTargetConfig, MaintenanceConfigTarget, MaintenancePackageTarget, MaintenanceServiceTarget } from "./maintenance.js";

export { validateRescueEndpoint, resolveRescueConnection } from "./rescue-config.js";
export type { RescueConnectionOptions } from "./rescue-config.js";

export { createRescueModel, rescueProviderOptions } from "./rescue-model.js";

export { DeliveryCapacity, deliveryOptions, DEFAULT_MAX_PENDING_BYTES, type DeliveryConfig, type DeliverySnapshot } from "./delivery-capacity.js";
export interface ManagedMcpHandlers {
  configure(params: import("@agent-phonon/protocol").ManagedMcpConfigureParams): Promise<import("@agent-phonon/protocol").ManagedMcpStatusResult>;
  status(): Promise<import("@agent-phonon/protocol").ManagedMcpStatusResult>;
}
