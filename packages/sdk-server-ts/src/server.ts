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
  WorkflowListResult,
  WorkflowListParams,
  WorkflowRunResult,
} from "@agent-phonon/protocol";

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

  /** 发任务（结果走 'stream' 事件）。 */
  async send(input: string, opts?: { verbosity?: "final" | "messages" | "tools" | "trace"; skills?: string[]; whenBusy?: "queue" | "interrupt" | "inject"; clientRequestId?: string }): Promise<SendResult> {
    return this.device.call("session.send", { sessionId: this.sessionId, input, ...opts }) as Promise<SendResult>;
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
  compress(mode: "native" | "custom" = "native"): Promise<unknown> {
    return this.device.call("session.compress", { sessionId: this.sessionId, mode });
  }
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
  private documentHandler?: (params: unknown) => Promise<unknown> | unknown;
  private prepareUploadHandler?: (params: unknown) => Promise<unknown> | unknown;
  /** 自发输出（无对应 session 时）回调。 */
  private onUnsolicited?: (ev: StreamEvent) => void;

  constructor(deviceId: string, tenantId: string, peer: RpcPeer) {
    super();
    this.deviceId = deviceId;
    this.tenantId = tenantId;
    this.peer = peer;
  }

  call(method: string, params: unknown): Promise<unknown> {
    return this.peer.request(method, params);
  }

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
  async createSession(params: { project: string; agent: string; model: string; worktreeId?: string; verbosity?: "final" | "messages" | "tools" | "trace"; clientRequestId?: string }): Promise<PhononSession> {
    const r = (await this.peer.request("session.create", { verbosity: "messages", ...params })) as { sessionId: string };
    const s = new PhononSession(this, r.sessionId);
    this.sessions.set(r.sessionId, s);
    return s;
  }

  /** 列会话。 */
  async listSessions(filter?: { project?: string; agent?: string; status?: string; limit?: number; cursor?: string }): Promise<{ sessions: SessionMeta[]; nextCursor?: string }> {
    return this.peer.request("session.list", filter ?? {}) as Promise<{ sessions: SessionMeta[]; nextCursor?: string }>;
  }

  /** 设备 OS/机器信息，用于 server 做任务调度决策。 */
  info(): Promise<unknown> {
    return this.peer.request("device.info", {});
  }

  /** 设备资源快照（CPU/内存/磁盘/进程/GPU best-effort）。 */
  resources(): Promise<unknown> {
    return this.peer.request("device.resources", {});
  }

  // ---- project / file / skill 便捷封装 ----
  project = {
    create: (p: { name: string; path?: string; git?: boolean; remote?: string; clientRequestId?: string }) => this.peer.request("project.create", p) as Promise<{ project: { projectId: string; path: string } }>,
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
    uninstall: (p: { agent: string; name: string; scope: "global" | "project"; projectId?: string }) => this.peer.request("skill.uninstall", p),
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
    run: (params: {
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
    }) => this.peer.request("workflow.run", params) as Promise<WorkflowRunResult>,
    status: (workflowId: string) =>
      this.peer.request("workflow.status", { workflowId }) as Promise<WorkflowStatusResult>,
    cancel: (workflowId: string, reason?: string) =>
      this.peer.request("workflow.cancel", { workflowId, reason }) as Promise<{ workflowId: string; status: "cancelled" }>,
    list: (filter?: WorkflowListParams) =>
      this.peer.request("workflow.list", filter ?? {}) as Promise<WorkflowListResult>,
    /** v0.7: 独立 resume 入口。推荐使用，比 run({resumeFrom}) 语义更明确。 */
    resume: (params: {
      workflowId: string;
      strategy?: "last_success_dependents" | "failed_node" | `node:${string}`;
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
  setInteractionHandler(fn: (params: unknown) => Promise<unknown> | unknown): void {
    this.interactionHandler = fn;
  }
  /** v0.7: 设置 document.send 处理器（不设则默认 delivered=[]）。 */
  setDocumentHandler(fn: (params: unknown) => Promise<unknown> | unknown): void {
    this.documentHandler = fn;
  }
  /** v0.7: 设置 document.prepare_upload 处理器（不设则默认空 stub）。 */
  setPrepareUploadHandler(fn: (params: unknown) => Promise<unknown> | unknown): void {
    this.prepareUploadHandler = fn;
  }
  /** 设置自发输出回调。 */
  setUnsolicitedHandler(fn: (ev: StreamEvent) => void): void {
    this.onUnsolicited = fn;
  }

  /** 内部：处理 phonon → server 的请求/通知。 */
  async _handleInbound(method: string, params: unknown): Promise<unknown> {
    if (method === "stream.event") {
      const ev = params as StreamEvent;
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
      // auto-ack （与 stream.event 一致，避免 outbox 胀胀）
      const ev = params as { workflowId?: string; seq?: number };
      if (ev?.workflowId && typeof ev.seq === "number") {
        this.peer.notify("workflow.ack", { workflowId: ev.workflowId, lastSeq: ev.seq });
      }
      this.emit("workflowEvent", params);
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
    if (method === "interaction.request") {
      this.emit("interaction", params);
      if (this.interactionHandler) return await this.interactionHandler(params);
      // v0.7: 默认没注册 handler 时，engine 会按 rejected 处理（进 进 欢迎改进。返回 cancel 动作）。
      return { requestId: (params as { requestId?: string })?.requestId, action: "cancel" };
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
  host?: string;
  /** 鉴权：返回 tenantId 表示通过，返回 null 拒绝。缺省全部放行（本地测试）。 */
  authenticate?: (deviceId: string, deviceKey: string | undefined) => { tenantId: string } | null | Promise<{ tenantId: string } | null>;
}

export class PhononServer extends EventEmitter {
  private wss?: WebSocketServer;
  private opts: PhononServerOptions;
  private devices = new Map<string, PhononDevice>();
  private actualPort = 0;

  constructor(opts: PhononServerOptions = {}) {
    super();
    this.opts = opts;
  }

  listen(): Promise<number> {
    return new Promise((resolve) => {
      const wss = new WebSocketServer({ port: this.opts.port ?? 0, host: this.opts.host });
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
      if (device) { this.devices.delete(device.deviceId); device._onClose(); }
    });
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.wss) return resolve();
      this.wss.close(() => resolve());
    });
  }
}
