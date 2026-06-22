import type {
  AgentAdapter,
  AdapterSession,
} from "./adapter.js";
import type { ContextItem, StreamEvent } from "@agent-phonon/protocol";
import { PhononError } from "./rpc.js";

/** adapter 注册表：runtime name → adapter 实例。复合 agentId 按 runtime 前缀路由。 */
export class AdapterRegistry {
  private adapters = new Map<string, AgentAdapter>();

  register(adapter: AgentAdapter): void {
    this.adapters.set(adapter.name, adapter);
  }

  /** 按 runtime name 取。 */
  get(name: string): AgentAdapter | undefined {
    return this.adapters.get(name);
  }

  /**
   * 按完整 agentId 路由到 runtime adapter。
   * agentId 形如 "openclaw:phonon" → runtime "openclaw"；单 agent runtime "codex" → "codex"。
   */
  resolve(agentId: string): AgentAdapter | undefined {
    const runtime = agentId.includes(":") ? agentId.split(":")[0]! : agentId;
    return this.adapters.get(runtime);
  }

  all(): AgentAdapter[] {
    return [...this.adapters.values()];
  }
}

/** 引擎内 session 记录。 */
interface SessionRecord {
  sessionId: string;
  tenantId: string;
  project: string;
  worktreeId?: string;
  agent: string;
  model: string;
  adapterName: string;
  adapterSession: AdapterSession;
  status: "idle" | "running" | "paused" | "terminated";
  /** 重启恢复后的游离态：无 live adapterSession，需 reattach 或 recreate。 */
  detached?: boolean;
  verbosity: "final" | "messages" | "tools" | "trace";
  currentTurnId?: string;
  /** 当前 turn 的 AbortController（interrupt 用，传给 adapter）。 */
  abort?: AbortController;
  /** 已发终态事件的 turnId（去重，避免双终态）。 */
  terminalTurns: Set<string>;
  queue: string[];
  seq: number;
  createdAt: string;
  lastActiveAt?: string;
}

/** 流式事件订阅回调（core 用它转发给对应 tenant 连接）。 */
export type StreamSink = (event: StreamEvent) => void;

/**
 * Session 引擎（L1，design §4）。
 * 只认 sessionId，不感知 tenant 隔离（隔离在 L2 dispatch）；但记录 tenantId 便于 L2 校验。
 */
export class SessionEngine {
  private sessions = new Map<string, SessionRecord>();
  private registry: AdapterRegistry;
  private sink: StreamSink;
  private idSeq = 1;
  /** 可观测事件总线（可选）。 */
  private obs?: import("./observability.js").ObsBus;

  constructor(registry: AdapterRegistry, sink: StreamSink, obs?: import("./observability.js").ObsBus, store?: import("./store.js").PhononStore) {
    this.registry = registry;
    this.sink = sink;
    this.obs = obs;
    this.store = store;
    if (store) this.restoreSessions(store);
  }

  /** 重启恢复（功能缺口）：从 sqlite 加载未 terminated 的 session，恢复为 paused（游离态）。
   * native-session adapter 可在下次 send 时 reattach；否则标记 needsRecreate。 */
  private restoreSessions(store: import("./store.js").PhononStore): void {
    for (const row of store.loadSessions()) {
      const sessionId = row.session_id as string;
      if (this.sessions.has(sessionId)) continue;
      this.sessions.set(sessionId, {
        sessionId,
        tenantId: row.tenant_id as string,
        project: (row.project_id as string) ?? "",
        worktreeId: (row.worktree_id as string) ?? undefined,
        agent: row.agent_id as string,
        model: row.model as string,
        adapterName: (row.agent_id as string).split(":")[0] ?? (row.agent_id as string),
        adapterSession: undefined as never, // 游离：无 live session
        status: "paused",
        detached: true,
        verbosity: (row.verbosity as "messages") ?? "messages",
        terminalTurns: new Set(),
        queue: [],
        seq: 0,
        createdAt: row.created_at as string,
        lastActiveAt: (row.last_active as string) ?? undefined,
      });
    }
  }

  private store?: import("./store.js").PhononStore;

  /** 持久化 session 元数据（bug-bash#2 B6）。 */
  private persist(rec: SessionRecord): void {
    this.store?.upsertSession({
      sessionId: rec.sessionId, tenantId: rec.tenantId, projectId: rec.project,
      worktreeId: rec.worktreeId, agent: rec.agent, model: rec.model,
      status: rec.status, verbosity: rec.verbosity, createdAt: rec.createdAt, lastActive: rec.lastActiveAt,
    });
  }

  private emit2(category: "session" | "turn" | "tool" | "stream" | "error", level: "debug" | "info" | "warn" | "error", event: string, rec: { sessionId: string; tenantId: string; agent: string; project: string } | undefined, extra?: { turnId?: string; msg?: string; data?: Record<string, unknown> }): void {
    this.obs?.emitEvent({
      category, level, event,
      tenantId: rec?.tenantId, sessionId: rec?.sessionId, agentId: rec?.agent, projectId: rec?.project,
      turnId: extra?.turnId, msg: extra?.msg, data: extra?.data,
    });
  }

  /** 校验 sessionId 是否属于某 tenant（L2 dispatch 用，D13）。 */
  assertTenant(sessionId: string, tenantId: string): SessionRecord {
    const rec = this.sessions.get(sessionId);
    if (!rec) throw new PhononError("errSessionNotFound", `session ${sessionId} not found`);
    if (rec.tenantId !== tenantId)
      throw new PhononError("errSessionNotInTenant", `session ${sessionId} not in tenant`);
    return rec;
  }

  async create(params: {
    tenantId: string;
    project: string;
    worktreeId?: string;
    cwd: string;
    agent: string;
    model: string;
    verbosity: "final" | "messages" | "tools" | "trace";
    agentConfig?: Record<string, unknown>;
    initialContext?: ContextItem[];
  }): Promise<{ sessionId: string; status: string; createdAt: string }> {
    const adapter = this.registry.resolve(params.agent);
    if (!adapter) throw new PhononError("errAgentUnavailable", `agent ${params.agent} not found`);

    const sessionId = `s-${Date.now()}-${this.idSeq++}`;
    const adapterSession = await adapter.createSession({
      sessionId,
      agentId: params.agent,
      model: params.model,
      cwd: params.cwd,
      agentConfig: params.agentConfig,
      initialContext: params.initialContext,
    });

    // 自发输出水槽（D16）：adapter 在无 active turn 时的输出走这里，core 统一打 seq 后转发
    adapterSession.setUnsolicitedSink?.((event) => {
      const rec = this.sessions.get(sessionId);
      if (rec) this.sink({ ...event, seq: rec.seq++ } as StreamEvent);
    });

    const createdAt = new Date().toISOString();
    this.sessions.set(sessionId, {
      sessionId,
      tenantId: params.tenantId,
      project: params.project,
      worktreeId: params.worktreeId,
      agent: params.agent,
      model: params.model,
      adapterName: params.agent,
      adapterSession,
      status: "idle",
      verbosity: params.verbosity,
      terminalTurns: new Set(),
      queue: [],
      seq: 0,
      createdAt,
    });
    const rec0 = this.sessions.get(sessionId)!;
    this.persist(rec0);
    this.emit2("session", "info", "session.create", rec0, { msg: `session ${sessionId} on ${params.agent} (${params.model})`, data: { model: params.model } });
    return { sessionId, status: "idle", createdAt };
  }

  /** 可选：reattach 时解析 project cwd（由 connection 注入）。 */
  resolveCwdForReattach?: (projectId: string) => string;

  /** 重新附着游离 session（重启恢复后首次使用）。
   * native-session adapter 重建会复用原生会话（如 OpenClaw sessionKey / Claude --resume）。 */
  private async reattach(rec: SessionRecord): Promise<void> {
    const adapter = this.registry.resolve(rec.agent);
    if (!adapter) throw new PhononError("errAgentUnavailable", `agent ${rec.agent} unavailable for reattach`);
    const cwd = this.resolveCwdForReattach?.(rec.project) ?? rec.project;
    rec.adapterSession = await adapter.createSession({
      sessionId: rec.sessionId, agentId: rec.agent, model: rec.model, cwd,
    });
    rec.adapterSession.setUnsolicitedSink?.((event) => {
      const r = this.sessions.get(rec.sessionId);
      if (r) this.sink({ ...event, seq: r.seq++ } as StreamEvent);
    });
    rec.detached = false;
    rec.status = "idle";
    this.emit2("session", "info", "session.reattach", rec, { msg: `reattached ${rec.sessionId}` });
  }

  async send(
    tenantId: string,
    sessionId: string,
    input: string,
    opts: {
      verbosity?: "final" | "messages" | "tools" | "trace";
      turnId?: string;
      skills?: string[];
      whenBusy?: "queue" | "interrupt" | "inject";
      fallback?: "queue" | "interrupt" | "inject";
      environment?: Record<string, string>;
    },
  ): Promise<{ turnId: string; disposition: string; queuePosition?: number }> {
    const rec = this.assertTenant(sessionId, tenantId);
    if (rec.status === "terminated")
      throw new PhononError("errSessionTerminated", "session terminated");
    // 重启恢复：游离 session 首次 send 时 reattach（重建 adapterSession）
    if (rec.detached) await this.reattach(rec);

    const turnId = opts.turnId ?? `t-${Date.now()}-${this.idSeq++}`;
    const verbosity = opts.verbosity ?? rec.verbosity;
    const payload = JSON.stringify({ turnId, input, verbosity, skills: opts.skills, environment: opts.environment });

    if (rec.status === "running") {
      // 忙碌处理（D18）。whenBusy 不支持时走 fallback。
      let mode = opts.whenBusy ?? "queue";
      const adapter = this.registry.resolve(rec.agent);
      if (mode === "interrupt" && !adapter?.capabilities.interrupt) mode = opts.fallback ?? "queue";
      if (mode === "inject" && !adapter?.capabilities.injectMidTurn) mode = opts.fallback ?? "queue";

      if (mode === "interrupt") {
        await this.interrupt(tenantId, sessionId);
        // 中断后立即跑本轮
      } else {
        // queue（默认）：FIFO 排队，上轮结束自动出队
        rec.queue.push(payload);
        return { turnId, disposition: "queued", queuePosition: rec.queue.length };
      }
    }

    rec.status = "running";
    rec.currentTurnId = turnId;
    rec.lastActiveAt = new Date().toISOString();
    this.emit2("turn", "info", "turn.start", rec, { turnId, msg: `turn ${turnId} started`, data: { input: input.slice(0, 200) } });
    this.persist(rec);
    void this.runTurn(rec, input, turnId, verbosity, opts.skills, opts.environment);
    return { turnId, disposition: "started" };
  }

  private async runTurn(
    rec: SessionRecord,
    input: string,
    turnId: string,
    verbosity: "final" | "messages" | "tools" | "trace",
    skills?: string[],
    environment?: Record<string, string>,
  ): Promise<void> {
    const abort = new AbortController();
    rec.abort = abort;
    const emit = (event: StreamEvent) => {
      const t = (event as { type?: string }).type;
      // 终态事件去重（避免双终态）：engine 统一发，adapter 重复发的丢弃
      const isFinal = (event as { final?: boolean }).final === true;
      if (isFinal) {
        if (rec.terminalTurns.has(turnId)) return; // 已有终态，丢
        rec.terminalTurns.add(turnId);
        // 限制集合大小（避免无限增长）
        if (rec.terminalTurns.size > 200) {
          const first = rec.terminalTurns.values().next().value;
          if (first !== undefined) rec.terminalTurns.delete(first);
        }
      }
      // 可观测：工具调用事件
      if (t === "tool_call") {
        this.emit2("tool", "info", "tool.call", rec, { turnId, msg: `tool ${(event as { toolName?: string }).toolName}`, data: { toolName: (event as { toolName?: string }).toolName } });
      } else if (t === "tool_result") {
        this.emit2("tool", "debug", "tool.result", rec, { turnId, data: { toolName: (event as { toolName?: string }).toolName } });
      }
      this.sink({ ...event, seq: rec.seq++ } as StreamEvent);
    };
    try {
      await rec.adapterSession.send(input, { turnId, verbosity, skills, environment, emit, signal: abort.signal });
    } catch (err) {
      emit({
        type: "error",
        sessionId: rec.sessionId,
        turnId,
        seq: 0,
        at: new Date().toISOString(),
        message: (err as Error)?.message ?? "turn failed",
        status: "failed",
        final: true,
      } as StreamEvent);
    } finally {
      // 竞态守卫：只有本 turn 仍是当前 turn 才能收尾（避免旧 turn 覆盖新 turn 状态）
      if (rec.currentTurnId === turnId && rec.status !== "terminated") {
        rec.abort = undefined;
        rec.status = "idle";
        rec.currentTurnId = undefined;
        this.persist(rec);
        this.emit2("turn", "info", "turn.end", rec, { turnId, msg: `turn ${turnId} ended` });
        const next = rec.queue.shift();
        if (next) {
          const n = JSON.parse(next) as { turnId: string; input: string; verbosity: typeof verbosity; skills?: string[]; environment?: Record<string, string> };
          rec.status = "running";
          rec.currentTurnId = n.turnId;
          rec.lastActiveAt = new Date().toISOString();
          void this.runTurn(rec, n.input, n.turnId, n.verbosity, n.skills, n.environment);
        }
      }
    }
  }

  async interrupt(tenantId: string, sessionId: string, reason?: string): Promise<{ interruptedTurnId?: string; status: string }> {
    const rec = this.assertTenant(sessionId, tenantId);
    const turnId = rec.currentTurnId;
    // 先发 engine 统一终态（标记 terminalTurns），确保 interrupted 是唯一终态；
    // 后续 adapter 被 kill 重发的 failed/close 会被 runTurn.emit 去重。
    if (turnId && !rec.terminalTurns.has(turnId)) {
      rec.terminalTurns.add(turnId);
      this.sink({
        type: "result",
        sessionId,
        turnId,
        seq: rec.seq++,
        at: new Date().toISOString(),
        text: "",
        status: "interrupted",
        final: true,
      } as StreamEvent);
    }
    // 再触发 abort + 停底层执行
    rec.abort?.abort();
    if (!rec.detached && rec.adapterSession?.interrupt) await rec.adapterSession.interrupt(reason);
    if (!turnId && rec.status !== "terminated") rec.status = "idle";
    return { interruptedTurnId: turnId, status: rec.status === "running" ? "idle" : rec.status };
  }

  async switchModel(tenantId: string, sessionId: string, model: string): Promise<{ previousModel: string; model: string; warnings?: string[] }> {
    const rec = this.assertTenant(sessionId, tenantId);
    if (rec.status === "running")
      throw new PhononError("errSessionBusy", "cannot switch model while running (whenRunning=reject)");
    const previousModel = rec.model;
    let warnings: string[] | undefined;
    if (!rec.detached && rec.adapterSession?.switchModel) {
      const r = await rec.adapterSession.switchModel(model);
      warnings = r.warnings;
    }
    rec.model = model;
    rec.adapterSession.model = model;
    return { previousModel, model, warnings };
  }

  async inject(tenantId: string, sessionId: string, context: ContextItem[]): Promise<{ injected: number }> {
    const rec = this.assertTenant(sessionId, tenantId);
    if (!rec.detached && rec.adapterSession?.inject) await rec.adapterSession.inject(context);
    return { injected: context.length };
  }

  async compress(
    tenantId: string,
    sessionId: string,
    mode: "native" | "custom",
    strategy?: string,
    options?: { keepRecentToolCalls?: number },
  ): Promise<{ mode: string; summary?: string; filesChanged?: number; recordsChanged?: number; blocksRemoved?: number; bytesBefore?: number; bytesAfter?: number; backups?: string[] }> {
    const rec = this.assertTenant(sessionId, tenantId);
    if (mode === "native") {
      const adapter = this.registry.resolve(rec.agent);
      if (!adapter?.capabilities.nativeCompression)
        throw new PhononError("errCapabilityUnsupported", "native compression not supported by this agent");
      if (!rec.detached && rec.adapterSession?.compressNative) {
        const r = await rec.adapterSession.compressNative();
        return { mode, summary: r.summary };
      }
      return { mode, summary: "native compress requested" };
    }
    if (!rec.detached && rec.adapterSession?.compressCustom) {
      const r = await rec.adapterSession.compressCustom(strategy ?? "dropToolIO", options);
      return { mode, ...r };
    }
    throw new PhononError("errCapabilityUnsupported", `custom compression not supported by adapter ${rec.agent}`);
  }

  /** 实时快照：当前所有 session 在干什么（可观测 /sessions 用）。 */
  snapshot(tenantId?: string): Array<Record<string, unknown>> {
    const out: Array<Record<string, unknown>> = [];
    for (const rec of this.sessions.values()) {
      if (tenantId && rec.tenantId !== tenantId) continue;
      out.push({
        sessionId: rec.sessionId,
        tenantId: rec.tenantId,
        agent: rec.agent,
        model: rec.model,
        project: rec.project,
        status: rec.status, // idle/running/paused/terminated
        currentTurnId: rec.currentTurnId,
        queued: rec.queue.length,
        lastActiveAt: rec.lastActiveAt,
      });
    }
    return out;
  }

  async terminate(tenantId: string, sessionId: string): Promise<{ status: "terminated" }> {
    const rec = this.assertTenant(sessionId, tenantId);
    if (!rec.detached) await rec.adapterSession?.terminate();
    rec.status = "terminated";
    this.persist(rec);
    this.emit2("session", "info", "session.terminate", rec, { msg: `session ${sessionId} terminated` });
    return { status: "terminated" };
  }

  async status(tenantId: string, sessionId: string) {
    const rec = this.assertTenant(sessionId, tenantId);
    const meta = this.toMeta(rec);
    // 补充上下文信息（adapter 能提供时，D33）；detached/游离 session 无 live adapterSession，跳过
    if (!rec.detached && rec.adapterSession?.describe) {
      try {
        const ctx = await rec.adapterSession.describe();
        if (ctx.contextWindow !== undefined && ctx.usedTokens !== undefined && ctx.usagePercent === undefined && ctx.contextWindow > 0) {
          ctx.usagePercent = Math.min(100, Math.max(0, (ctx.usedTokens / ctx.contextWindow) * 100));
        }
        if (ctx.contextWindow !== undefined || ctx.usedTokens !== undefined || ctx.usagePercent !== undefined || ctx.compactions !== undefined) {
          return { ...meta, context: ctx };
        }
      } catch {
        /* ignore */
      }
    }
    return meta;
  }

  /** server ack 了 seq≤lastSeq（P0-4）。v0 内存模型 no-op；接 sqlite outbox 后在此清理。 */
  ackStream(_sessionId: string | undefined, _lastSeq: number): void {
    // TODO: 接 outbox 持久化后清理 <= lastSeq
  }

  /** server 回填 interaction（P1-5）。v0：如果有等待者则 resolve。 */
  private interactionWaiters = new Map<string, (v: unknown) => void>();
  resolveInteraction(requestId: string, payload: unknown): void {
    const w = this.interactionWaiters.get(requestId);
    if (w) {
      w(payload);
      this.interactionWaiters.delete(requestId);
    }
  }
  registerInteractionWaiter(requestId: string, resolve: (v: unknown) => void): void {
    this.interactionWaiters.set(requestId, resolve);
  }

  list(
    tenantId: string,
    filter?: { project?: string; agent?: string; status?: string; limit?: number; cursor?: string },
  ): { sessions: ReturnType<SessionEngine["toMeta"]>[]; nextCursor?: string } {
    const all = [];
    for (const rec of this.sessions.values()) {
      if (rec.tenantId !== tenantId) continue; // tenant 隔离
      if (filter?.project && rec.project !== filter.project) continue;
      if (filter?.agent && rec.agent !== filter.agent) continue;
      if (filter?.status && rec.status !== filter.status) continue;
      all.push(rec);
    }
    // 稳定排序（按 createdAt），游标分页（P2#14）
    all.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.sessionId.localeCompare(b.sessionId));
    const start = filter?.cursor ? Math.max(0, all.findIndex((r) => r.sessionId === filter.cursor) + 1) : 0;
    const limit = filter?.limit;
    const page = limit ? all.slice(start, start + limit) : all.slice(start);
    const last = page[page.length - 1];
    const hasMore = limit !== undefined && start + page.length < all.length;
    return {
      sessions: page.map((rec) => this.toMeta(rec)),
      ...(hasMore && last ? { nextCursor: last.sessionId } : {}),
    };
  }

  /** 某 project 下的 active(idle/running/paused) session ids（bug-bash P0#8）。 */
  activeSessionsForProject(projectId: string): string[] {
    const out: string[] = [];
    for (const rec of this.sessions.values()) {
      if (rec.project === projectId && rec.status !== "terminated") out.push(rec.sessionId);
    }
    return out;
  }

  /** 某 worktree 上的 active session ids。 */
  activeSessionsForWorktree(worktreeId: string): string[] {
    const out: string[] = [];
    for (const rec of this.sessions.values()) {
      if (rec.worktreeId === worktreeId && rec.status !== "terminated") out.push(rec.sessionId);
    }
    return out;
  }

  private toMeta(rec: SessionRecord) {
    return {
      sessionId: rec.sessionId,
      project: rec.project,
      ...(rec.worktreeId ? { worktreeId: rec.worktreeId } : {}),
      agent: rec.agent,
      model: rec.model,
      status: rec.status,
      currentTurnId: rec.currentTurnId,
      queuedCount: rec.queue.length,
      verbosity: rec.verbosity,
      createdAt: rec.createdAt,
      lastActiveAt: rec.lastActiveAt,
    };
  }
}
