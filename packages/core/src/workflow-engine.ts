import type { SessionEngine } from "./session-engine.js";
import { PhononError } from "./rpc.js";
import type { EnvManager } from "./env-manager.js";
import type { PhononStore } from "./store.js";
import * as path from "node:path";
import * as fs from "node:fs";
import type {
  WorkflowEvent,
  WorkflowPlan,
  WorkflowStatusResult,
  WorkflowRunResult,
  WorkflowPolicy,
  WorkflowSharedContext,
  WorkflowResumeFrom,
  WorkflowNodeResult,
  WorkflowArtifact,
  WorkflowRoutingDirective,
  StreamEvent,
} from "@agent-phonon/protocol";

// =============================================================================
// In-memory runtime state
// =============================================================================

interface WorkflowNodeState {
  nodeId: string;
  status: "pending" | "ready" | "running" | "completed" | "failed" | "skipped" | "cancelled";
  agent: string;
  model: string;
  role?: string;
  sessionId?: string;
  turnId?: string;
  startedAt?: string;
  completedAt?: string;
  error?: string;
  result?: WorkflowNodeResult;
  iterations?: number;
}

interface WorkflowRunState {
  workflowId: string;
  tenantId: string;
  /** workflow 级默认 project；v0.6 起可选（node 可覆盖） */
  project?: string;
  /** workflow 级默认 worktree key；v0.6 起 node 可覆盖 */
  worktreeId?: string;
  /** workflow 级默认 branch；v0.6 起 node 可覆盖 */
  branch?: string;
  mode: "dag" | "graph" | "discussion";
  plan: WorkflowPlan;
  input?: string;
  policy: Required<Pick<WorkflowPolicy, "onNodeFailure">> & WorkflowPolicy;
  sharedContext?: WorkflowSharedContext;
  status: "queued" | "running" | "completed" | "failed" | "cancelled" | "timeout";
  nodes: WorkflowNodeState[];
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  error?: string;
  seq: number;
  ackedSeq: number;
  finalText?: string;
}

// =============================================================================
// RoutingDirective parser (v0.5: 4-kind discriminated union)
// =============================================================================

// 兼容前缀：phonon.workflow.<kind> 或 workflow.<kind>
const ROUTE_BLOCK_RE = /```(?:phonon\.)?workflow\.(route|feedback|reply|done|human_review)\s*\n([\s\S]+?)\n```/gi;

function parseRoutingDirectives(text: string): WorkflowRoutingDirective[] {
  const out: WorkflowRoutingDirective[] = [];
  ROUTE_BLOCK_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ROUTE_BLOCK_RE.exec(text)) !== null) {
    const kindTag = m[1]!.toLowerCase();
    try {
      const obj = JSON.parse(m[2]!) as Record<string, unknown>;
      const directive = buildDirective(`workflow.${kindTag}`, obj);
      if (directive) out.push(directive);
    } catch {
      // skip malformed block
    }
  }
  return out;
}

function buildDirective(kindFromTag: string, obj: Record<string, unknown>): WorkflowRoutingDirective | null {
  // body 里如果有 kind，优先用 body 的；否则用 fenced block 的 tag
  const kind = (typeof obj.kind === "string" ? obj.kind : kindFromTag) as WorkflowRoutingDirective["kind"];
  switch (kind) {
    case "workflow.route":
      if (!obj.to || typeof obj.message !== "string") return null;
      return {
        kind: "workflow.route",
        to: obj.to as never,
        message: obj.message,
        reason: obj.reason as string | undefined,
        metadata: obj.metadata as Record<string, unknown> | undefined,
      };
    case "workflow.feedback":
      if (typeof obj.to !== "string" || typeof obj.message !== "string") return null;
      return {
        kind: "workflow.feedback",
        to: obj.to as never,
        message: obj.message,
        reason: obj.reason as string | undefined,
        metadata: obj.metadata as Record<string, unknown> | undefined,
      };
    case "workflow.reply":
      if (typeof obj.to !== "string" || typeof obj.keystroke !== "string") return null;
      return {
        kind: "workflow.reply",
        to: obj.to as never,
        keystroke: obj.keystroke,
        reason: obj.reason as string | undefined,
      };
    case "workflow.done":
      return {
        kind: "workflow.done",
        finalSummary: obj.finalSummary as string | undefined,
        reason: obj.reason as string | undefined,
      };
    case "workflow.human_review":
      if (typeof obj.title !== "string" || typeof obj.summary !== "string") return null;
      return {
        kind: "workflow.human_review",
        title: obj.title,
        summary: obj.summary,
        artifacts: Array.isArray(obj.artifacts) ? obj.artifacts as { path: string; role: "report"|"diff"|"spec"|"log"|"other" }[] : undefined,
        reason: obj.reason as string | undefined,
        timeoutSeconds: (typeof obj.timeoutSeconds === "number" ? obj.timeoutSeconds : 1800),
      };
    default:
      return null;
  }
}

// =============================================================================
// WorkflowEngine
// =============================================================================

export class WorkflowEngine {
  private runs = new Map<string, WorkflowRunState>();
  private sessionToNode = new Map<string, { workflowId: string; nodeId: string }>();
  /**
   * 持久 session 缓存（修复问题 A，2026-06-23）。
   * key = `${workflowId}::${persistentNodeId}`，value = sessionId。
   *
   * Graph executor、Graph worker、Discussion participants 都走这个缓存：
   * - 首轮 create session 后入缓存
   * - 后续轮 send 进同一 session（agent 看到完整历史）
   * - workflow 终态时由 cleanupPersistent() 统一 terminate
   *
   * DAG 节点仍是 burner 模式（纯一次性），不进这个缓存。
   */
  private persistentSessions = new Map<string, string>();
  private pendingResultText = new Map<string, string>();
  private turnResultCache = new Map<string, WorkflowNodeResult>();
  private turnWaiters = new Map<string, (r: WorkflowNodeResult) => void>();
  private workflowEvents = new Map<string, WorkflowEvent[]>();
  private artifacts = new Map<string, WorkflowArtifact[]>();
  private idSeq = 1;

  /**
   * 隔离 key → 实际 worktreeId（v0.6）。
   * key = `${workflowId}::${projectId}::${userWorktreeKey}`，value = phonon 创出的 内部 worktreeId。
   * 那些 worktree 是 phonon 自己创的 → workflow 终态时负责清理。
   */
  private autoWorktrees = new Map<string, { projectId: string; worktreeId: string; userKey: string }>();

  /**
   * 主目录 checkout 的 branch 跨节点缓存（v0.6）。
   * key = `${workflowId}::${projectId}` → 该 workflow 上一次在它里 checkout 的 branch。
   * 用于避免同一个 branch 重复 checkout。
   */
  private mainBranchCheckedOut = new Map<string, string>();

  constructor(private opts: {
    tenantId: string;
    engine: SessionEngine;
    resolveCwd: (projectId: string, worktreeId?: string) => string;
    env: EnvManager;
    /**
     * 可选：project manager 访问接口，用于 per-node 按需创建 worktree + 主目录 branch checkout。
     * 不指明则 worktreeId/branch 覆写失效、phonon 徽后退到 v0.5 行为。
     */
    projects?: {
      worktreeCreate: (params: { projectId: string; baseBranch: string; newBranch?: string }) => Promise<{ worktreeId: string; path: string; branch: string }>;
      worktreeRemove: (params: { projectId: string; worktreeId: string; force?: boolean }) => Promise<unknown>;
      runGit?: (projectId: string, args: string[]) => Promise<string>;
      getProjectPath: (projectId: string) => string;
    };
    /** 可选：sqlite store。提供则 checkpoint 落盘 + 支持 resumeFrom。 */
    store?: PhononStore;
    emit: (event: WorkflowEvent) => void;
    /** v0.7: 反向请求 server 做 HITL（用于 workflow.human_review directive） */
    requestInteraction?: (params: unknown) => Promise<unknown>;
  }) {}

  // ---------------------------------------------------------------------------
  // RPC entry
  // ---------------------------------------------------------------------------

  async run(params: {
    project?: string;
    worktreeId?: string;
    branch?: string;
    plan: WorkflowPlan;
    input?: string;
    policy?: WorkflowPolicy;
    sharedContext?: WorkflowSharedContext;
    resumeFrom?: WorkflowResumeFrom;
    metadata?: Record<string, unknown>;
  }): Promise<WorkflowRunResult> {
    // 1. 恢复路径
    if (params.resumeFrom) {
      const restored = this.restoreFromCheckpoint(params.resumeFrom);
      if (restored) {
        void this.executeWithTimeout(restored).catch((err) => this.fail(restored, err));
        return { workflowId: restored.workflowId, status: restored.status, createdAt: restored.createdAt, resumed: true };
      }
      // 找不到 checkpoint → 错误（不静默 fallback）
      throw new PhononError("errInvalidParams", `workflow ${params.resumeFrom.workflowId} has no resumable checkpoint`);
    }

    // 2. 全新启动
    const workflowId = `wf-${Date.now()}-${this.idSeq++}`;
    const now = new Date().toISOString();
    const nodes = this.initialNodes(params.plan);
    const policy: WorkflowRunState["policy"] = {
      onNodeFailure: params.policy?.onNodeFailure ?? "fail_workflow",
      timeoutSeconds: params.policy?.timeoutSeconds,
      perNodeTimeoutSeconds: params.policy?.perNodeTimeoutSeconds,
      maxParallel: params.policy?.maxParallel,
    };
    const run: WorkflowRunState = {
      workflowId,
      tenantId: this.opts.tenantId,
      project: params.project,
      worktreeId: params.worktreeId,
      branch: params.branch,
      mode: params.plan.mode,
      plan: params.plan,
      input: params.input,
      policy,
      sharedContext: params.sharedContext,
      status: "queued",
      nodes,
      createdAt: now,
      updatedAt: now,
      seq: 0,
      ackedSeq: -1,
    };
    this.runs.set(workflowId, run);
    this.persist(run);
    this.emit(run, { type: "workflow.status", status: "queued" });
    void this.executeWithTimeout(run).catch((err) => this.fail(run, err));
    return { workflowId, status: run.status, createdAt: run.createdAt, resumed: false };
  }

  /**
   * v0.7: workflow.resume —— 独立入口，比 run({resumeFrom}) 更明确。
   * 支持 sharedContextPatch（浅 merge）和 feedback（写进 sharedContext.notes 末尾）。
   */
  async resume(params: {
    workflowId: string;
    strategy: "last_success_dependents" | "failed_node" | `node:${string}`;
    rerunNodes?: string[];
    feedback?: string;
    sharedContextPatch?: WorkflowSharedContext;
  }): Promise<WorkflowRunResult> {
    const restored = this.restoreFromCheckpoint({
      workflowId: params.workflowId,
      strategy: params.strategy,
      rerunNodes: params.rerunNodes,
    });
    if (!restored) {
      throw new PhononError("errInvalidParams", `workflow ${params.workflowId} has no resumable checkpoint`);
    }
    // 合并 sharedContext patch + feedback
    if (params.sharedContextPatch || params.feedback) {
      const base = restored.sharedContext ?? {};
      const merged: WorkflowSharedContext = {
        placement: "append",
        ...base,
        ...(params.sharedContextPatch ?? {}),
      };
      if (params.feedback) {
        const prevText = typeof merged.text === "string" ? merged.text : "";
        const fbBlock = `\n\n[resume feedback @${new Date().toISOString()}]\n${params.feedback}`;
        merged.text = prevText ? prevText + fbBlock : fbBlock.trimStart();
      }
      restored.sharedContext = merged;
      this.persist(restored);
    }
    void this.executeWithTimeout(restored).catch((err) => this.fail(restored, err));
    return { workflowId: restored.workflowId, status: restored.status, createdAt: restored.createdAt, resumed: true };
  }

  status(workflowId: string): WorkflowStatusResult {
    // 优先内存；若内存里没有再查 store（已结束的历史 workflow）
    const memRun = this.runs.get(workflowId);
    if (memRun) return this.toStatus(memRun);
    if (this.opts.store) {
      const row = this.opts.store.getWorkflow(workflowId);
      if (row) return this.rowToStatus(row);
    }
    throw new PhononError("errInvalidParams", `workflow ${workflowId} not found`);
  }

  list(filter?: { status?: string; projectId?: string; since?: string; until?: string; limit?: number }): { workflows: WorkflowStatusResult[] } {
    const limit = filter?.limit ?? 50;
    // 内存优先，store 补
    const mem = [...this.runs.values()];
    const all: WorkflowStatusResult[] = mem.map((r) => this.toStatus(r));
    if (this.opts.store) {
      const known = new Set(mem.map((r) => r.workflowId));
      for (const row of this.opts.store.listWorkflows(this.opts.tenantId)) {
        const id = row.workflow_id as string;
        if (!known.has(id)) all.push(this.rowToStatus(row));
      }
    }
    const filtered = all
      .filter((w) => (!filter?.status || w.status === filter.status)
        && (!filter?.projectId || w.project === filter.projectId)
        && (!filter?.since || w.createdAt >= filter.since)
        && (!filter?.until || w.createdAt < filter.until))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit);
    return { workflows: filtered };
  }

  async cancel(workflowId: string, reason?: string): Promise<{ workflowId: string; status: "cancelled" }> {
    const run = this.runs.get(workflowId);
    if (!run) {
      // 已落盘但内存无 → 直接幂等
      return { workflowId, status: "cancelled" };
    }
    if (["completed", "failed", "timeout"].includes(run.status)) {
      return { workflowId, status: "cancelled" };
    }
    run.status = "cancelled";
    run.completedAt = new Date().toISOString();
    run.updatedAt = run.completedAt;
    for (const n of run.nodes) {
      if (n.sessionId && (n.status === "running" || n.status === "ready" || n.status === "pending")) {
        n.status = "cancelled";
        try { await this.opts.engine.terminate(this.opts.tenantId, n.sessionId); } catch {}
      }
    }
    // 清理本 workflow 的所有 persistent session + worktree
    await this.cleanupPersistent(run);
    const wtKept1 = await this.cleanupAutoWorktrees(run);
    this.persist(run);
    this.emit(run, { type: "workflow.status", status: "cancelled", payload: { reason, worktreesKept: wtKept1.kept } });
    return { workflowId, status: "cancelled" };
  }

  ack(workflowId: string, lastSeq: number): void {
    const run = this.runs.get(workflowId);
    if (run) {
      if (lastSeq > run.ackedSeq) {
        run.ackedSeq = lastSeq;
        this.opts.store?.ackWorkflow(workflowId, lastSeq);
      }
    } else {
      this.opts.store?.ackWorkflow(workflowId, lastSeq);
    }
  }

  eventsList(params: { workflowId: string; afterSeq?: number; limit?: number }): { events: WorkflowEvent[]; nextSeq?: number } {
    const all = this.workflowEvents.get(params.workflowId) ?? [];
    const afterSeq = params.afterSeq ?? -1;
    const limit = params.limit ?? 200;
    const events = all.filter((e) => e.seq > afterSeq).slice(0, limit);
    const last = events.at(-1)?.seq;
    const hasMore = last !== undefined && all.some((e) => e.seq > last);
    return { events, ...(hasMore && last !== undefined ? { nextSeq: last } : {}) };
  }

  artifactRegister(params: { workflowId: string; nodeId?: string; kind: WorkflowArtifact["kind"]; path: string; title?: string; mimeType?: string; metadata?: Record<string, unknown> }): { artifact: WorkflowArtifact } {
    const run = this.runs.get(params.workflowId);
    if (!run) throw new PhononError("errInvalidParams", `workflow ${params.workflowId} not found or is not active`);
    let size: number | undefined;
    try { size = fs.statSync(params.path).size; } catch { /* path may be virtual or created later */ }
    const artifact: WorkflowArtifact = {
      artifactId: `art-${Date.now()}-${this.idSeq++}`,
      workflowId: params.workflowId,
      nodeId: params.nodeId,
      kind: params.kind,
      path: params.path,
      title: params.title,
      mimeType: params.mimeType,
      size,
      createdAt: new Date().toISOString(),
      metadata: params.metadata,
    };
    const list = this.artifacts.get(params.workflowId) ?? [];
    list.push(artifact);
    this.artifacts.set(params.workflowId, list);
    this.emit(run, { type: "artifact.written", nodeId: params.nodeId, payload: artifact });
    return { artifact };
  }

  artifactsList(workflowId: string): { artifacts: WorkflowArtifact[] } {
    return { artifacts: this.artifacts.get(workflowId) ?? [] };
  }

  /** SessionEngine sink → 提取 result 文本到 turnWaiters；不再产生 node.stream 事件。 */
  onStreamEvent(ev: StreamEvent): void {
    const sessionId = (ev as { sessionId?: string }).sessionId;
    if (!sessionId) return;
    const mapping = this.sessionToNode.get(sessionId);
    if (!mapping) return;

    const evAny = ev as Record<string, unknown>;
    const turnId = evAny.turnId as string | undefined;
    const key = `${sessionId}::${turnId ?? ""}`;

    if (evAny.type === "message" && typeof evAny.text === "string") {
      const prior = this.pendingResultText.get(key) ?? "";
      this.pendingResultText.set(key, prior + (evAny.text as string));
    } else if (evAny.type === "result") {
      const text = (evAny.text as string | undefined) || this.pendingResultText.get(key) || "";
      this.pendingResultText.delete(key);
      const rawUsage = evAny.usage as WorkflowNodeResult["usage"] | undefined;
      const run = this.runs.get(mapping.workflowId);
      const node = run?.nodes.find((n) => n.nodeId === mapping.nodeId);
      const durationMs = node?.startedAt ? Math.max(0, Date.now() - Date.parse(node.startedAt)) : undefined;
      const usage = rawUsage || durationMs !== undefined ? { ...(rawUsage ?? {}), ...(durationMs !== undefined && rawUsage?.durationMs === undefined ? { durationMs } : {}) } : undefined;
      const status = (evAny.status as WorkflowNodeResult["status"]) ?? "completed";
      const result: WorkflowNodeResult = { text, status, usage };
      const resolver = this.turnWaiters.get(key);
      if (resolver) {
        this.turnWaiters.delete(key);
        resolver(result);
      } else {
        this.turnResultCache.set(key, result);
      }
    } else if (evAny.type === "error") {
      this.pendingResultText.delete(key);
      const result: WorkflowNodeResult = { status: (evAny.status as WorkflowNodeResult["status"]) ?? "failed", text: (evAny.message as string) ?? "" };
      const resolver = this.turnWaiters.get(key);
      if (resolver) {
        this.turnWaiters.delete(key);
        resolver(result);
      } else {
        this.turnResultCache.set(key, result);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Execution dispatch
  // ---------------------------------------------------------------------------

  private async executeWithTimeout(run: WorkflowRunState): Promise<void> {
    const timeoutMs = run.policy.timeoutSeconds ? run.policy.timeoutSeconds * 1000 : undefined;
    const exec = this.execute(run);
    if (!timeoutMs) { await exec; return; }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<"timeout">((resolve) => { timer = setTimeout(() => resolve("timeout"), timeoutMs); });
    const winner = await Promise.race([exec.then(() => "done" as const), timeout]);
    if (timer) clearTimeout(timer);
    if (winner === "timeout") {
      run.status = "timeout";
      run.completedAt = new Date().toISOString();
      run.updatedAt = run.completedAt;
      run.error = `workflow exceeded timeout ${run.policy.timeoutSeconds}s`;
      this.persist(run);
      this.emit(run, { type: "workflow.status", status: "timeout", payload: { error: run.error } });
      for (const n of run.nodes) {
        if (n.sessionId && ["running", "ready", "pending"].includes(n.status)) {
          n.status = "cancelled";
          try { await this.opts.engine.terminate(this.opts.tenantId, n.sessionId); } catch {}
        }
      }
      await this.cleanupPersistent(run);
      const wtKept2 = await this.cleanupAutoWorktrees(run);
      if (wtKept2.kept.length > 0) {
        this.emit(run, { type: "workflow.status", status: "timeout", payload: { worktreesKept: wtKept2.kept } });
      }
    }
  }

  private async execute(run: WorkflowRunState): Promise<void> {
    run.status = "running";
    run.updatedAt = new Date().toISOString();
    this.persist(run);
    this.emit(run, { type: "workflow.status", status: "running" });
    if (run.plan.mode === "dag") await this.executeDag(run);
    else if (run.plan.mode === "graph") await this.executeGraph(run);
    else if (run.plan.mode === "discussion") await this.executeDiscussion(run);
    if (!(["cancelled", "failed", "timeout"] as string[]).includes(run.status)) {
      run.status = "completed";
      run.completedAt = new Date().toISOString();
      run.updatedAt = run.completedAt;
      this.fillFinalText(run);
      // DAG completed 路径：也要清理 auto worktree（持久 session 在 graph/discussion 内部已清）
      const wtKeptEx = await this.cleanupAutoWorktrees(run);
      this.persist(run);
      this.emit(run, { type: "workflow.status", status: "completed", payload: { finalText: run.finalText, worktreesKept: wtKeptEx.kept } });
    }
  }

  // ---------------------------------------------------------------------------
  // DAG
  // ---------------------------------------------------------------------------

  private async executeDag(run: WorkflowRunState): Promise<void> {
    if (run.plan.mode !== "dag") return;
    const plan = run.plan;
    const deps = new Map<string, Set<string>>();
    for (const n of plan.nodes) deps.set(n.nodeId, new Set(n.dependsOn ?? []));
    for (const e of plan.edges ?? []) deps.get(e.to)?.add(e.from);

    const settled = new Set<string>(); // 任何终态
    const succeeded = new Set<string>();
    const skipped = new Set<string>();

    // 已经成功过的（resume 场景）直接计入 settled / succeeded
    for (const node of run.nodes) {
      if (node.status === "completed") { settled.add(node.nodeId); succeeded.add(node.nodeId); }
      else if (node.status === "skipped") { settled.add(node.nodeId); skipped.add(node.nodeId); }
    }

    while (settled.size < plan.nodes.length) {
      if ((["cancelled", "failed", "timeout"] as string[]).includes(run.status)) return;

      const ready = plan.nodes.filter((n) => {
        if (settled.has(n.nodeId)) return false;
        const ds = deps.get(n.nodeId) ?? new Set();
        return [...ds].every((d) => settled.has(d));
      });
      if (ready.length === 0) throw new PhononError("errInvalidParams", "workflow DAG has a cycle or missing dependency");

      const toSkip = ready.filter((n) => {
        const ds = deps.get(n.nodeId) ?? new Set();
        return [...ds].some((d) => skipped.has(d) || (!succeeded.has(d) && settled.has(d)));
      });
      for (const n of toSkip) {
        if (run.policy.onNodeFailure === "skip_dependents" || run.policy.onNodeFailure === "fail_workflow") {
          const node = run.nodes.find((x) => x.nodeId === n.nodeId)!;
          node.status = "skipped";
          node.completedAt = new Date().toISOString();
          run.updatedAt = node.completedAt;
          this.persist(run);
          this.emit(run, { type: "node.status", nodeId: n.nodeId, agent: n.agent, model: n.model, role: n.role, status: "skipped" });
          settled.add(n.nodeId);
          skipped.add(n.nodeId);
        }
      }
      const runnable = ready.filter((n) => !toSkip.includes(n));
      if (runnable.length === 0 && toSkip.length > 0) continue;

      const batchSize = run.policy.maxParallel ?? runnable.length;
      for (let i = 0; i < runnable.length; i += batchSize) {
        const batch = runnable.slice(i, i + batchSize);
        const results = await Promise.allSettled(batch.map((n) =>
          this.executeNode(run, n.nodeId, n.agent, n.model, n.role, this.composeDagNodeInput(run, n, succeeded), n.agentConfig, n.systemPrompt, undefined,
            { project: n.project, worktreeId: n.worktreeId, branch: n.branch })
        ));
        for (let j = 0; j < batch.length; j++) {
          const n = batch[j]!;
          const r = results[j]!;
          settled.add(n.nodeId);
          if (r.status === "fulfilled") {
            succeeded.add(n.nodeId);
          } else if (run.policy.onNodeFailure === "fail_workflow") {
            this.fail(run, r.reason);
            return;
          }
        }
      }
    }
  }

  private composeDagNodeInput(
    run: WorkflowRunState,
    nodeDef: { nodeId: string; input?: string; dependsOn?: string[] },
    succeeded: Set<string>,
  ): string {
    const base = nodeDef.input ?? run.input ?? "";
    const upstream = this.collectUpstreamContext(run, nodeDef.nodeId, succeeded);
    return upstream ? `${base}\n\n${upstream}`.trim() : base;
  }

  private collectUpstreamContext(run: WorkflowRunState, nodeId: string, succeeded: Set<string>): string {
    if (run.plan.mode !== "dag") return "";
    const plan = run.plan;
    const deps = new Set<string>();
    const nodeDef = plan.nodes.find((n) => n.nodeId === nodeId);
    for (const d of nodeDef?.dependsOn ?? []) deps.add(d);
    for (const e of plan.edges ?? []) if (e.to === nodeId) deps.add(e.from);
    const lines: string[] = [];
    for (const dep of deps) {
      if (!succeeded.has(dep)) continue;
      const node = run.nodes.find((n) => n.nodeId === dep);
      if (node?.result?.text) {
        lines.push(`[upstream node "${dep}" (role=${node.role ?? "n/a"}) result]\n${node.result.text}`);
      }
    }
    return lines.join("\n\n");
  }

  // ---------------------------------------------------------------------------
  // Graph (executor + workers, v0.5 升级到 4-kind RoutingDirective)
  // ---------------------------------------------------------------------------

  private async executeGraph(run: WorkflowRunState): Promise<void> {
    if (run.plan.mode !== "graph") return;
    const plan = run.plan;
    const allowedEdges = new Set<string>(plan.communicationGraph.edges.map((e) => `${e.from}->${e.to}`));
    const maxIterations = plan.communicationGraph.maxIterations ?? 12;

    const executorPrompt = [
      "You are the EXECUTOR of a multi-agent workflow.",
      `Input: ${run.input ?? ""}`,
      `Workers available: ${JSON.stringify(plan.workers.map((w) => ({ nodeId: w.nodeId, role: w.role, agent: w.agent, model: w.model })))}`,
      `Communication graph (allowed routes): ${JSON.stringify(plan.communicationGraph)}`,
      "",
      "You may emit one of these fenced directives:",
      "```phonon.workflow.route",
      '{"to":"<workerNodeId>","message":"...","reason":"..."}',
      "```",
      "```phonon.workflow.feedback",
      '{"to":"<workerNodeId>","message":"revise: ...","reason":"..."}',
      "```",
      "```phonon.workflow.reply",
      '{"to":"<workerNodeId>","keystroke":"Y"}',
      "```",
      "```phonon.workflow.done",
      '{"finalSummary":"...","reason":"..."}',
      "```",
      "Use `workflow.done` when you decide the workflow is complete.",
    ].join("\n");

    // 启动 executor（persistKey = executor nodeId，后续轮复用同一 session）
    const execEnv = { project: plan.executor.project, worktreeId: plan.executor.worktreeId, branch: plan.executor.branch };
    const executorResult = await this.executeNode(
      run,
      plan.executor.nodeId,
      plan.executor.agent,
      plan.executor.model,
      "executor",
      executorPrompt,
      plan.executor.agentConfig,
      plan.executor.systemPrompt,
      plan.executor.nodeId,
      execEnv,
    );

    let currentDirectives = parseRoutingDirectives(executorResult.text ?? "");
    let lastExecutorText = executorResult.text ?? "";
    let terminated = currentDirectives.some((d) => d.kind === "workflow.done");
    let finalSummary: string | undefined;
    for (const d of currentDirectives) {
      if (d.kind === "workflow.done") finalSummary = d.finalSummary;
    }

    // 退出原因跟踪（修复问题 C）：executor 放弃/超 maxIterations 不是正常完成。
    type GraphExit = "done" | "max_iterations" | "no_directive" | "no_valid_targets";
    let exitReason: GraphExit | undefined;

    // executor 首轮就没 emit 任何 directive：直接判定为 no_directive
    if (currentDirectives.length === 0) {
      exitReason = "no_directive";
    }

    let iteration = 0;
    while (currentDirectives.length > 0 && !terminated && iteration < maxIterations) {
      if ((["cancelled", "failed", "timeout"] as string[]).includes(run.status)) return;
      iteration++;
      this.emit(run, { type: "round.started", payload: { iteration, mode: "graph" } });

      const workerResults: { nodeId: string; text: string }[] = [];
      let hadValidTarget = false;
      for (const directive of currentDirectives) {
        if (directive.kind === "workflow.done") {
          terminated = true;
          finalSummary = directive.finalSummary;
          exitReason = "done";
          break;
        }
        if (directive.kind === "workflow.human_review") {
          // v0.7: 暂停 workflow，反向问 server，等回复后决定 done 或继续
          const reviewResult = await this.requestHumanReview(run, directive);
          if (reviewResult.approved) {
            terminated = true;
            // v0.7 review fix: reviewer 不填 feedback 时，优先保留 executor 原始产出（不丢 LLM 输出），其次才是 directive.summary。
            finalSummary = reviewResult.feedback ?? lastExecutorText ?? directive.summary;
            exitReason = "done";
            break;
          }
          // 拒绝 → 把 feedback 作为下一轮 executor 输入
          hadValidTarget = true;
          // 把 feedback 当成一个伪 worker 结果喂回 executor
          workerResults.push({
            nodeId: "__human_review__",
            text: `[HUMAN REVIEW REJECTED]\nReviewer feedback: ${reviewResult.feedback ?? "(no feedback)"}\nReviewer: ${reviewResult.reviewer ?? "(unknown)"}`,
          });
          continue;
        }
        // route / feedback / reply 都需要 target 在 allowedEdges 内
        const targets = "to" in directive
          ? (Array.isArray(directive.to) ? directive.to : [directive.to])
          : [];
        const validTargets = targets.filter((t) => allowedEdges.has(`${plan.executor.nodeId}->${t}`));
        if (validTargets.length === 0) continue;
        hadValidTarget = true;

        for (const target of validTargets) {
          const worker = plan.workers.find((w) => w.nodeId === target);
          if (!worker) continue;

          this.emit(run, {
            type: "executor.decision",
            nodeId: plan.executor.nodeId,
            payload: { kind: directive.kind, to: target, reason: ("reason" in directive ? directive.reason : undefined), iteration },
          });
          this.emit(run, {
            type: "edge.route",
            payload: { from: plan.executor.nodeId, to: target, kind: directive.kind, iteration },
          });

          // 根据 kind 构造发给 worker 的输入
          let workerInput: string;
          if (directive.kind === "workflow.route") {
            workerInput = directive.message;
          } else if (directive.kind === "workflow.feedback") {
            workerInput = `[FEEDBACK / REVISE]\n${directive.message}`;
          } else if (directive.kind === "workflow.reply") {
            workerInput = directive.keystroke;
          } else {
            continue;
          }

          const workerRes = await this.executeNode(
            run,
            worker.nodeId, // 修复问题 B：所有迭代复用同一 nodeId，iteration 走 payload，不再留空占位
            worker.agent,
            worker.model,
            worker.role ?? "worker",
            workerInput,
            worker.agentConfig,
            worker.systemPrompt,
            worker.nodeId, // persistKey: 同一 worker 跨轮复用 session
            { project: worker.project, worktreeId: worker.worktreeId, branch: worker.branch },
          );
          workerResults.push({ nodeId: target, text: workerRes.text ?? "" });
        }
      }
      if (terminated) break;
      if (!hadValidTarget) {
        // 本轮中所有 directive 的 target 都被 graph 拒了 → executor 乱府或疑似问题
        this.emit(run, { type: "round.completed", payload: { iteration, workerCount: 0 } });
        exitReason = "no_valid_targets";
        break;
      }
      if (workerResults.length === 0) {
        this.emit(run, { type: "round.completed", payload: { iteration, workerCount: 0 } });
        exitReason = "no_directive";
        break;
      }
      this.emit(run, { type: "round.completed", payload: { iteration, workerCount: workerResults.length } });

      // 把 worker 反馈喂回 executor
      const followupPrompt = [
        "Worker results from previous iteration:",
        ...workerResults.map((w) => `[worker ${w.nodeId}]\n${w.text}`),
        "",
        "Either emit the next routing directive or finalize with `workflow.done`.",
      ].join("\n\n");
      const nextRes = await this.executeNode(
        run,
        plan.executor.nodeId, // 修复问题 B：executor 跨轮复用同一 nodeId
        plan.executor.agent,
        plan.executor.model,
        "executor",
        followupPrompt,
        plan.executor.agentConfig,
        plan.executor.systemPrompt,
        plan.executor.nodeId, // persistKey
        execEnv,
      );
      lastExecutorText = nextRes.text ?? lastExecutorText;
      currentDirectives = parseRoutingDirectives(lastExecutorText);
      for (const d of currentDirectives) {
        if (d.kind === "workflow.done") {
          terminated = true;
          finalSummary = d.finalSummary;
          exitReason = "done";
        }
      }
      // executor 本轮输出不含任何 directive → 放弃了
      if (currentDirectives.length === 0 && !terminated) {
        exitReason = "no_directive";
      }
    }
    if (!exitReason) {
      // while 正常退出但未设 exitReason → 一定是超了 maxIterations
      exitReason = terminated ? "done" : "max_iterations";
    }

    run.finalText = finalSummary ?? lastExecutorText;
    // Graph 终态：清理 persistent session + worktree
    await this.cleanupPersistent(run);
    const wtKept3 = await this.cleanupAutoWorktrees(run);
    if (wtKept3.kept.length > 0) {
      this.emit(run, { type: "workflow.status", status: run.status, payload: { worktreesKept: wtKept3.kept } });
    }

    // 修复问题 C：非 done 退出都该标 failed，不是 completed
    if (exitReason !== "done") {
      run.status = "failed";
      run.completedAt = new Date().toISOString();
      run.updatedAt = run.completedAt;
      run.error = `graph executor terminated abnormally: ${exitReason}` +
        (exitReason === "no_directive" ? " (executor emitted no parseable directive)" :
         exitReason === "no_valid_targets" ? " (all routing targets were rejected by communicationGraph)" :
         exitReason === "max_iterations" ? ` (reached maxIterations=${maxIterations})` : "");
      this.persist(run);
      this.emit(run, {
        type: "workflow.status",
        status: "failed",
        payload: { error: run.error, terminationReason: exitReason, finalText: run.finalText },
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Discussion (v0.5 新增；借鉴 Foreman _run_discuss_rounds)
  // ---------------------------------------------------------------------------

  private async executeDiscussion(run: WorkflowRunState): Promise<void> {
    if (run.plan.mode !== "discussion") return;
    const plan = run.plan;
    const chairman = plan.participants.find((p) => p.nodeId === plan.chairman);
    if (!chairman) throw new PhononError("errInvalidParams", `chairman ${plan.chairman} not in participants`);
    const nonChair = plan.participants.filter((p) => p.nodeId !== plan.chairman);

    const termination = plan.termination;
    const chairmanSignal = termination?.chairmanSignal ?? "[DISCUSS_END]";
    const maxRounds = termination?.maxRounds ?? 10;
    const consensusSignal = termination?.consensusSignal;

    let terminationReason: string | undefined;
    let round = 0;
    const transcript: { round: number; nodeId: string; role?: string; text: string }[] = [];

    while (round < maxRounds) {
      if ((["cancelled", "failed", "timeout"] as string[]).includes(run.status)) return;
      round++;
      this.emit(run, { type: "round.started", payload: { iteration: round, mode: "discussion", participants: nonChair.map((p) => p.nodeId) } });

      // 阶段 A：非主席并行发言。复用各自持久 session（persistKey = p.nodeId）：agent
      // 本身记得上轮说过什么、自己是谁，不需在 prompt 里复述全部历史（避免问题 E 复粘）。
      const prompt = round === 1
        ? `This is a multi-agent discussion. Topic: ${plan.topic}\n\nThis is round ${round}. State your position briefly. Stay strictly in character.`
        : `This is round ${round} of the discussion. Building on what has already been said in earlier rounds (you remember your own prior turns), advance the discussion with NEW points. Do not repeat or summarize previous turns. Stay strictly in character.`;

      const speakResults = await Promise.allSettled(
        nonChair.map((p) =>
          this.executeNode(run, p.nodeId, p.agent, p.model, p.role ?? "participant", prompt, p.agentConfig, p.systemPrompt, p.nodeId,
            { project: p.project, worktreeId: p.worktreeId, branch: p.branch })
            .then((r) => ({ nodeId: p.nodeId, role: p.role, text: r.text ?? "" })),
        ),
      );

      let consensusHit = false;
      for (const sr of speakResults) {
        if (sr.status === "fulfilled") {
          transcript.push({ round, nodeId: sr.value.nodeId, role: sr.value.role, text: sr.value.text });
          if (consensusSignal && sr.value.text.includes(consensusSignal)) consensusHit = true;
        }
      }
      this.emit(run, { type: "round.completed", payload: { iteration: round, speakers: speakResults.length } });

      if (consensusHit) {
        terminationReason = `consensus signal "${consensusSignal}" detected`;
        break;
      }

      // 阶段 B：主席审视本轮。复用同一 chairman session（他也记得自己之前的总结）。
      // prompt 只发本轮 contributions，避免复述全部历史。
      const chairmanPrompt = [
        `Round ${round} of the discussion just finished.`,
        "",
        "This round's contributions:",
        ...speakResults.map((sr, i) => {
          if (sr.status === "fulfilled") return `[${nonChair[i]!.nodeId} as ${nonChair[i]!.role ?? "participant"}]\n${sr.value.text}`;
          return `[${nonChair[i]!.nodeId}] (failed: ${String(sr.reason)})`;
        }),
        "",
        `As the chairman, decide whether the discussion has reached a useful conclusion.`,
        `If yes, write your final summary AND include the literal token "${chairmanSignal}" somewhere in your reply (this signals the discussion to end).`,
        "If no, summarize this round briefly and indicate what should be explored next.",
      ].join("\n");

      const chairmanRes = await this.executeNode(
        run, chairman.nodeId, chairman.agent, chairman.model, chairman.role ?? "chairman",
        chairmanPrompt, chairman.agentConfig, chairman.systemPrompt, chairman.nodeId,
        { project: chairman.project, worktreeId: chairman.worktreeId, branch: chairman.branch },
      );
      transcript.push({ round, nodeId: chairman.nodeId, role: chairman.role ?? "chairman", text: chairmanRes.text ?? "" });

      if ((chairmanRes.text ?? "").includes(chairmanSignal)) {
        terminationReason = `chairman signal "${chairmanSignal}"`;
        break;
      }
    }
    if (!terminationReason && round >= maxRounds) terminationReason = `maxRounds (${maxRounds}) reached`;

    this.emit(run, { type: "discussion.terminated", payload: { rounds: round, reason: terminationReason ?? "unknown" } });

    // Discussion 终态：清理 persistent session + worktree
    await this.cleanupPersistent(run);
    const wtKept4 = await this.cleanupAutoWorktrees(run);
    if (wtKept4.kept.length > 0) {
      this.emit(run, { type: "workflow.status", status: run.status, payload: { worktreesKept: wtKept4.kept } });
    }

    // finalText = 最后一轮 chairman 输出，没有则最后一轮最后一个 participant
    const lastChairman = [...transcript].reverse().find((t) => t.nodeId === chairman.nodeId);
    run.finalText = lastChairman?.text ?? (transcript.length ? transcript[transcript.length - 1]!.text : undefined);
  }

  // ---------------------------------------------------------------------------
  // Single node execution
  // ---------------------------------------------------------------------------

  /**
   * 运行单个 node。
   *
   * persistKey（修复问题 A，2026-06-23）：
   *   - undefined  : burner 模式（DAG）— create 一个临时 session、跑完立刻 terminate
   *   - 非空    : persistent 模式（Graph executor / Graph workers / Discussion participants）—
   *                 首轮 create + 入 persistentSessions cache，后续轮复用同一 session 走 send，
   *                 agent 看到完整历史；workflow 终态时由 cleanupPersistent() 统一 terminate。
   *                 传 persistKey 是调用方选定的逻辑 node id（不带 #it1 / #r1 迭代后缀）。
   */
  private async executeNode(
    run: WorkflowRunState,
    nodeId: string,
    agent: string,
    model: string,
    role: string | undefined,
    input: string,
    agentConfig?: Record<string, unknown>,
    nodeSystemPrompt?: string,
    persistKey?: string,
    /** v0.6: 该节点的执行环境覆写（project/worktreeId/branch）。不传默认继承 workflow 级。 */
    nodeEnv?: { project?: string; worktreeId?: string; branch?: string },
  ): Promise<WorkflowNodeResult> {
    const node = run.nodes.find((n) => n.nodeId === nodeId) ?? this.addNode(run, { nodeId, agent, model, role });
    node.status = "running";
    node.startedAt = node.startedAt ?? new Date().toISOString();
    node.iterations = (node.iterations ?? 0) + 1;
    run.updatedAt = new Date().toISOString();
    this.emit(run, { type: "node.status", nodeId, agent, model, role, status: "running", payload: { iteration: node.iterations } });

    try {
      // v0.6: resolveExecution 处理 per-node 覆写 + worktree 按需创建/复用 + branch checkout
      const exec = await this.resolveExecution(run, nodeEnv);
      const cwd = exec.cwd;
      const effectiveProject = exec.projectId;
      const effectiveWorktreeId = exec.worktreeId;
      const systemPrompt = this.buildSystemPrompt(run, nodeSystemPrompt, cwd, role, effectiveProject, effectiveWorktreeId);
      const initialContext = systemPrompt ? [{ role: "system" as const, content: systemPrompt }] : undefined;

      // ---- session 获取：persistent 复用 cache；burner 每次新建 ----
      const cacheKey = persistKey ? `${run.workflowId}::${persistKey}` : undefined;
      let sessionId = cacheKey ? this.persistentSessions.get(cacheKey) : undefined;
      const isNewSession = !sessionId;
      if (!sessionId) {
        const created = await this.opts.engine.create({
          tenantId: run.tenantId,
          project: effectiveProject,
          worktreeId: effectiveWorktreeId,
          cwd,
          agent,
          model,
          verbosity: "messages",
          agentConfig,
          initialContext,
          workflowAttr: { workflowId: run.workflowId, nodeId, role },
        });
        sessionId = created.sessionId;
        this.sessionToNode.set(sessionId, { workflowId: run.workflowId, nodeId });
        if (cacheKey) this.persistentSessions.set(cacheKey, sessionId);
      } else {
        // 复用中的 session：sessionToNode 映射要重新指向当前 nodeId（比如 exec#it1 这种调用）
        this.sessionToNode.set(sessionId, { workflowId: run.workflowId, nodeId });
      }
      node.sessionId = sessionId;

      const sent = await this.opts.engine.send(run.tenantId, sessionId, input, {
        environment: this.opts.env.resolveForExecution({ projectId: effectiveProject, agent }),
      });
      node.turnId = sent.turnId;

      const result = await this.awaitTurnResult(run, sessionId, sent.turnId);
      node.result = result;
      node.status = result.status === "completed" ? "completed" : "failed";
      node.completedAt = new Date().toISOString();
      run.updatedAt = node.completedAt;
      if (node.status === "failed") node.error = result.text || `turn ended with status ${result.status}`;
      this.persist(run);
      this.emit(run, {
        type: "node.status",
        nodeId, sessionId: node.sessionId, turnId: node.turnId,
        agent, model, role, status: node.status, result,
      });

      // burner 模式：跑完立刻纸连 session。
      // persistent 模式：保留 session，下轮复用；由 cleanupPersistent() 统一清理。
      if (!cacheKey) {
        try { await this.opts.engine.terminate(run.tenantId, sessionId); } catch {}
      }
      void isNewSession;
      if (node.status === "failed") throw new Error(node.error ?? "node failed");
      return result;
    } catch (err) {
      node.status = "failed";
      node.completedAt = new Date().toISOString();
      node.error = (err as Error)?.message ?? String(err);
      run.updatedAt = node.completedAt;
      this.persist(run);
      this.emit(run, { type: "node.status", nodeId, agent, model, role, status: "failed", payload: { error: node.error } });
      throw err;
    }
  }

  /** 清理某 workflow 的所有 persistent session（底层 best-effort）。 */
  private async cleanupPersistent(run: WorkflowRunState): Promise<void> {
    const prefix = `${run.workflowId}::`;
    const toRemove: string[] = [];
    for (const [k, sid] of this.persistentSessions.entries()) {
      if (!k.startsWith(prefix)) continue;
      toRemove.push(k);
      try { await this.opts.engine.terminate(run.tenantId, sid); } catch {}
    }
    for (const k of toRemove) this.persistentSessions.delete(k);
  }

  // =============================================================================
  // v0.6: per-node 执行环境解析（project / worktreeId / branch）+ 按需 worktree
  // =============================================================================

  /**
   * v0.7: 把 workflow.human_review directive 转成对 server 的 interaction.request 调用。
   * server 用 interaction.respond 返回 { approved, feedback?, reviewer? }，phonon 解析回来。
   */
  private async requestHumanReview(
    run: WorkflowRunState,
    directive: { kind: "workflow.human_review"; title: string; summary: string; artifacts?: Array<{ path: string; role: string }>; reason?: string; timeoutSeconds: number },
  ): Promise<{ approved: boolean; feedback?: string; reviewer?: string }> {
    // emit requested 事件，server 端 UI 可以预先准备
    this.emit(run, {
      type: "human_review.requested",
      payload: { title: directive.title, summary: directive.summary, artifacts: directive.artifacts, reason: directive.reason },
    });
    if (!this.opts.requestInteraction) {
      // 没接 interaction → 视为拒绝（让 executor 知道这条路走不通）
      const result = { approved: false, feedback: "phonon was not configured with requestInteraction; reject by default" };
      this.emit(run, { type: "human_review.resolved", payload: result });
      return result;
    }
    // 构造 interaction.request 表单
    const interactionParams = {
      reason: directive.reason ?? "Human review requested by workflow executor",
      sessionId: run.workflowId, // 让 server 能按 workflowId 路由
      timeoutSeconds: directive.timeoutSeconds,
      form: {
        title: directive.title,
        description: directive.summary,
        metadata: {
          workflowId: run.workflowId,
          artifacts: directive.artifacts,
        },
        fields: [
          { name: "approved", label: "Approve?", type: "boolean", required: true },
          { name: "feedback", label: "Feedback", type: "text", required: false },
          { name: "reviewer", label: "Reviewer", type: "text", required: false },
        ],
      },
    };
    let response: { approved?: boolean; feedback?: string; reviewer?: string; values?: Record<string, unknown> };
    // v0.7 补补丁：engine 本地 timeout race，防止 server 不 honor timeoutSeconds 或永远不回导致 workflow 永久挂死。
    // 策略：取 directive.timeoutSeconds + 5 秒宽限（留 server 优先回的机会），在 phonon 这边超时 → reject + emit resolved。
    const localTimeoutMs = Math.max(1000, directive.timeoutSeconds * 1000 + 5000);
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeoutP = new Promise<"__local_timeout__">((resolve) => {
        timeoutHandle = setTimeout(() => resolve("__local_timeout__"), localTimeoutMs);
      });
      const raceResult = await Promise.race([
        this.opts.requestInteraction(interactionParams),
        timeoutP,
      ]);
      if (raceResult === "__local_timeout__") {
        const toResult = {
          approved: false,
          feedback: `human review timed out locally after ${localTimeoutMs}ms (directive timeoutSeconds=${directive.timeoutSeconds})`,
        };
        this.emit(run, { type: "human_review.resolved", payload: toResult });
        return toResult;
      }
      response = raceResult as never;
    } catch (e) {
      const errResult = { approved: false, feedback: `interaction failed: ${(e as Error).message}` };
      this.emit(run, { type: "human_review.resolved", payload: errResult });
      return errResult;
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
    }
    // server 可能返回 { values: {...} } 或直接平铺
    const values = (response?.values ?? response) as { approved?: boolean; feedback?: string; reviewer?: string };
    const result = {
      approved: !!values?.approved,
      feedback: typeof values?.feedback === "string" ? values.feedback : undefined,
      reviewer: typeof values?.reviewer === "string" ? values.reviewer : undefined,
    };
    this.emit(run, { type: "human_review.resolved", payload: result });
    return result;
  }

  /**
   * 解析 node 的执行环境。处理 4 种情况（详见 protocol WorkflowNode.branch/worktreeId 文档）：
   *   1) 不传 worktreeId + 不传 branch  → project 主目录当前 branch
   *   2) 不传 worktreeId + 传 branch    → project 主目录先 git checkout <branch>
   *   3) 传 worktreeId（首次）         → 按需创建 worktree（branch 决定 base）
   *   4) 传 worktreeId（复用）         → 直接拿之前创的 worktree，branch 字段被忽略
   *
   * 返回 { projectId, worktreeId, cwd }；项目级 + node 级覆写都已合并。
   */
  private async resolveExecution(
    run: WorkflowRunState,
    nodeEnv?: { project?: string; worktreeId?: string; branch?: string },
  ): Promise<{ projectId: string; worktreeId?: string; cwd: string }> {
    const projectId = nodeEnv?.project ?? run.project;
    if (!projectId) {
      throw new PhononError(
        "errInvalidParams",
        "workflow node has no project: neither node.project nor workflow.project is set",
      );
    }
    const userWorktreeKey = nodeEnv?.worktreeId ?? run.worktreeId;
    const branch = nodeEnv?.branch ?? run.branch;

    // ---- 情况 3/4: 用户给了 worktreeId ----
    if (userWorktreeKey) {
      const autoKey = `${run.workflowId}::${projectId}::${userWorktreeKey}`;
      const existing = this.autoWorktrees.get(autoKey);
      if (existing) {
        // 复用：branch 字段被忽略；不再 checkout/创建
        const cwd = this.opts.resolveCwd(projectId, existing.worktreeId);
        return { projectId, worktreeId: existing.worktreeId, cwd };
      }
      // 首次：按需创建。branch 决定 base，缺省用项目当前 branch（git 默认行为）
      if (!this.opts.projects) {
        throw new PhononError(
          "errCapabilityUnsupported",
          "workflow node uses worktreeId but ProjectManager API is not wired into WorkflowEngine",
        );
      }
      const baseBranch = branch ?? await this.detectCurrentBranch(projectId);
      const autoBranch = `phonon-wf-${run.workflowId}-${userWorktreeKey}`.replace(/[^a-zA-Z0-9._/-]/g, "-");
      const wt = await this.opts.projects.worktreeCreate({
        projectId, baseBranch, newBranch: autoBranch,
      });
      this.autoWorktrees.set(autoKey, { projectId, worktreeId: wt.worktreeId, userKey: userWorktreeKey });
      const cwd = this.opts.resolveCwd(projectId, wt.worktreeId);
      return { projectId, worktreeId: wt.worktreeId, cwd };
    }

    // ---- 情况 2: 不要 worktree 但要切 branch ----
    if (branch) {
      const cacheKey = `${run.workflowId}::${projectId}`;
      const already = this.mainBranchCheckedOut.get(cacheKey);
      if (already !== branch) {
        if (!this.opts.projects?.runGit) {
          throw new PhononError(
            "errCapabilityUnsupported",
            "workflow node uses branch but git runner is not wired into WorkflowEngine",
          );
        }
        try {
          await this.opts.projects.runGit(projectId, ["checkout", branch]);
          this.mainBranchCheckedOut.set(cacheKey, branch);
        } catch (e) {
          throw new PhononError("errInvalidParams", `git checkout ${branch} failed: ${(e as Error).message}`);
        }
      }
    }

    // ---- 情况 1/2 终态: 项目主目录 cwd ----
    const cwd = this.opts.resolveCwd(projectId);
    return { projectId, cwd };
  }

  private async detectCurrentBranch(projectId: string): Promise<string> {
    if (!this.opts.projects?.runGit) return "HEAD"; // 极端兜底
    try {
      const out = await this.opts.projects.runGit(projectId, ["rev-parse", "--abbrev-ref", "HEAD"]);
      const branch = out.trim();
      return branch || "HEAD";
    } catch {
      return "HEAD";
    }
  }

  /**
   * 清理某 workflow 自动创建的所有 worktree。
   * 安全规则（按 Stephen 要求）：
   *  - git status --porcelain 干净 → 调 worktreeRemove（不 force）
   *  - dirty → 保留 worktree 不删；emit warn 到 workflow.status payload
   *  - branch 一律不删（用户下次可传 branch 名继续开发）
   */
  private async cleanupAutoWorktrees(run: WorkflowRunState): Promise<{ kept: Array<{ worktreeId: string; userKey: string; reason: string }> }> {
    const kept: Array<{ worktreeId: string; userKey: string; reason: string }> = [];
    const prefix = `${run.workflowId}::`;
    const toClear: string[] = [];
    for (const [k, entry] of this.autoWorktrees.entries()) {
      if (!k.startsWith(prefix)) continue;
      toClear.push(k);
      if (!this.opts.projects) continue;
      try {
        // 检查 worktree dirty 状态
        let dirty = false;
        if (this.opts.projects.runGit) {
          // 通过 worktree path 跑 git status；先拿 path
          const wtPath = this.opts.resolveCwd(entry.projectId, entry.worktreeId);
          try {
            // 走 git -C <wtPath> status --porcelain
            const out = await this.opts.projects.runGit(entry.projectId, ["-C", wtPath, "status", "--porcelain"]);
            dirty = out.trim().length > 0;
          } catch (e) {
            // 检查失败保守起见标 dirty（不删除）
            dirty = true;
          }
        }
        if (dirty) {
          kept.push({ worktreeId: entry.worktreeId, userKey: entry.userKey, reason: "worktree has uncommitted changes" });
          continue;
        }
        await this.opts.projects.worktreeRemove({ projectId: entry.projectId, worktreeId: entry.worktreeId });
      } catch (err) {
        kept.push({ worktreeId: entry.worktreeId, userKey: entry.userKey, reason: `cleanup failed: ${(err as Error).message}` });
      }
    }
    for (const k of toClear) this.autoWorktrees.delete(k);
    // 同时清掉主目录 branch checkout 缓存
    for (const k of [...this.mainBranchCheckedOut.keys()]) {
      if (k.startsWith(prefix)) this.mainBranchCheckedOut.delete(k);
    }
    return { kept };
  }

  private async awaitTurnResult(run: WorkflowRunState, sessionId: string, turnId: string): Promise<WorkflowNodeResult> {
    const key = `${sessionId}::${turnId}`;
    const cached = this.turnResultCache.get(key);
    if (cached) { this.turnResultCache.delete(key); return cached; }
    const perNodeTimeoutMs = run.policy.perNodeTimeoutSeconds ? run.policy.perNodeTimeoutSeconds * 1000 : undefined;
    return new Promise<WorkflowNodeResult>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (r: WorkflowNodeResult) => {
        if (timer) clearTimeout(timer);
        this.turnWaiters.delete(key);
        resolve(r);
      };
      this.turnWaiters.set(key, finish);
      if (perNodeTimeoutMs) timer = setTimeout(() => finish({ status: "timeout", text: "" }), perNodeTimeoutMs);
      const poll = async () => {
        try {
          const s = await this.opts.engine.status(this.opts.tenantId, sessionId);
          if (s.status === "idle" || s.status === "terminated" || s.status === "paused") {
            if (this.turnWaiters.has(key)) finish({ status: "completed", text: this.pendingResultText.get(key) ?? "" });
          } else if (this.turnWaiters.has(key)) {
            setTimeout(poll, 200);
          }
        } catch {}
      };
      setTimeout(poll, 500);
    });
  }

  // ---------------------------------------------------------------------------
  // SharedContext: 把 sharedContext (text + files) 拼到每个 node 的 systemPrompt
  // ---------------------------------------------------------------------------

  private buildSystemPrompt(run: WorkflowRunState, nodeSystemPrompt: string | undefined, cwd: string, role?: string, projectId?: string, worktreeId?: string): string | undefined {
    const segments: string[] = [];

    // 问题 D 修复（2026-06-23 真 Claude 跳出角色）：role 字段加进 system prompt，
    // 让 agent 清楚知道自己演什么、处于什么 workflow。不依赖调用方手动拼接。
    if (role) {
      segments.push(
        `# Workflow Role\n\nYou are participating in an agent-phonon workflow (workflowId=${run.workflowId}, mode=${run.mode}).\nYour role in this workflow: **${role}**.\nNode id: ${this.nodeContextForPrompt(run, role) ?? "current"}.\nStay in this role for the entire turn. Do not break character.`,
      );
    }

    segments.push(
      `# Target Workspace\n\nProject ID: ${projectId ?? "(none)"}\nWorktree ID: ${worktreeId ?? "(main project directory)"}\nTarget path: ${cwd}\n\nDo all project file operations under the target path above. If your runtime starts elsewhere, first switch to this target path before reading or writing project files.`,
    );

    const sc = run.sharedContext;
    if (sc) {
      if (sc.text) segments.push(`# Shared Workflow Context\n\n${sc.text}`);
      for (const rel of sc.files ?? []) {
        try {
          const abs = path.resolve(cwd, rel);
          const real = fs.realpathSync(abs);
          const cwdReal = fs.realpathSync(cwd);
          if (!real.startsWith(cwdReal + path.sep) && real !== cwdReal) continue;
          const content = fs.readFileSync(real, "utf8");
          segments.push(`# Shared File: ${rel}\n\n\`\`\`\n${content}\n\`\`\``);
        } catch {
          // skip
        }
      }
    }

    if (segments.length === 0) return nodeSystemPrompt;
    const built = segments.join("\n\n");
    if (!nodeSystemPrompt) return built;
    return sc?.placement === "prepend" ? `${built}\n\n${nodeSystemPrompt}` : `${nodeSystemPrompt}\n\n${built}`;
  }

  private nodeContextForPrompt(run: WorkflowRunState, _role: string): string | undefined {
    // 预留接口：如果有需要可以按 nodeId 反查，目前不指明返回 undefined。
    void run;
    return undefined;
  }

  // ---------------------------------------------------------------------------
  // Checkpoint / Resume
  // ---------------------------------------------------------------------------

  private persist(run: WorkflowRunState): void {
    if (!this.opts.store) return;
    this.opts.store.upsertWorkflow({
      workflowId: run.workflowId,
      tenantId: run.tenantId,
      projectId: run.project,
      worktreeId: run.worktreeId,
      mode: run.mode,
      planJson: JSON.stringify(run.plan),
      input: run.input,
      policyJson: JSON.stringify(run.policy),
      sharedJson: run.sharedContext ? JSON.stringify(run.sharedContext) : undefined,
      status: run.status,
      finalText: run.finalText,
      error: run.error,
      nodesJson: JSON.stringify(run.nodes),
      seq: run.seq,
      ackedSeq: run.ackedSeq,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
      completedAt: run.completedAt,
    });
  }

  private restoreFromCheckpoint(rf: WorkflowResumeFrom): WorkflowRunState | undefined {
    if (!this.opts.store) return undefined;
    const row = this.opts.store.getWorkflow(rf.workflowId);
    if (!row) return undefined;

    const plan = JSON.parse(row.plan_json as string) as WorkflowPlan;
    const nodes = JSON.parse(row.nodes_json as string) as WorkflowNodeState[];
    const policy = JSON.parse((row.policy_json as string) || '{"onNodeFailure":"fail_workflow"}');
    const sharedContext = row.shared_json ? JSON.parse(row.shared_json as string) : undefined;

    // 应用恢复策略：决定哪些节点要重置到 pending 重跑
    const rerun = new Set<string>(rf.rerunNodes ?? []);
    if (rf.strategy === "failed_node") {
      for (const n of nodes) if (n.status === "failed" || n.status === "cancelled" || n.status === "running") rerun.add(n.nodeId);
    } else if (rf.strategy === "last_success_dependents") {
      // 把所有非 completed 节点 + 失败节点的依赖图下游都重置
      for (const n of nodes) if (n.status !== "completed") rerun.add(n.nodeId);
    } else if (rf.strategy.startsWith("node:")) {
      const fromId = rf.strategy.slice(5);
      rerun.add(fromId);
      // 简化：把所有非 completed 节点都加入（DAG runtime 自然只挑 ready 的）
      for (const n of nodes) if (n.status !== "completed") rerun.add(n.nodeId);
    }
    for (const n of nodes) {
      if (rerun.has(n.nodeId)) {
        n.status = "pending";
        delete n.result; delete n.error; delete n.startedAt; delete n.completedAt;
        delete n.sessionId; delete n.turnId;
      }
    }

    const now = new Date().toISOString();
    const run: WorkflowRunState = {
      workflowId: rf.workflowId,
      tenantId: row.tenant_id as string,
      project: (row.project_id as string | null) ?? undefined,
      worktreeId: (row.worktree_id as string | null) ?? undefined,
      mode: row.mode as "dag" | "graph" | "discussion",
      plan,
      input: (row.input as string | null) ?? undefined,
      policy,
      sharedContext,
      status: "queued",
      nodes,
      createdAt: row.created_at as string,
      updatedAt: now,
      seq: Number(row.seq ?? 0),
      ackedSeq: Number(row.acked_seq ?? -1),
      finalText: (row.final_text as string | null) ?? undefined,
    };
    this.runs.set(rf.workflowId, run);
    this.persist(run);
    this.emit(run, { type: "workflow.status", status: "queued", payload: { resumed: true, strategy: rf.strategy } });
    return run;
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private fillFinalText(run: WorkflowRunState): void {
    if (run.finalText) return;
    const plan = run.plan;
    if (plan.mode === "dag") {
      const targetId = plan.finalNodeId;
      if (targetId) {
        const node = run.nodes.find((n) => n.nodeId === targetId);
        run.finalText = node?.result?.text;
      }
    } else if (plan.mode === "graph") {
      const exec = run.nodes.find((n) => n.nodeId === plan.executor.nodeId);
      run.finalText = exec?.result?.text;
    }
    // discussion 的 finalText 在 executeDiscussion 里已 set
  }

  private initialNodes(plan: WorkflowPlan): WorkflowNodeState[] {
    let list: { nodeId: string; agent: string; model: string; role?: string }[];
    if (plan.mode === "dag") list = plan.nodes;
    else if (plan.mode === "graph") list = [plan.executor, ...plan.workers];
    else list = plan.participants;
    return list.map((n) => ({ nodeId: n.nodeId, status: "pending", agent: n.agent, model: n.model, role: n.role }));
  }

  private addNode(run: WorkflowRunState, n: { nodeId: string; agent: string; model: string; role?: string }): WorkflowNodeState {
    const node: WorkflowNodeState = { ...n, status: "pending" };
    run.nodes.push(node);
    return node;
  }

  private fail(run: WorkflowRunState, err: unknown): void {
    if (run.status === "cancelled" || run.status === "timeout") return;
    run.status = "failed";
    run.error = (err as Error)?.message ?? String(err);
    run.completedAt = new Date().toISOString();
    run.updatedAt = run.completedAt;
    this.persist(run);
    this.emit(run, { type: "workflow.status", status: "failed", payload: { error: run.error } });
    // 清理本 workflow 的所有 persistent session + worktree（不阻塞 fail 路径）
    void this.cleanupPersistent(run).catch(() => {});
    void this.cleanupAutoWorktrees(run).catch(() => {});
  }

  private toStatus(run: WorkflowRunState): WorkflowStatusResult {
    return {
      workflowId: run.workflowId,
      status: run.status,
      project: run.project,
      mode: run.mode,
      nodes: run.nodes,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
      completedAt: run.completedAt,
      error: run.error,
      finalText: run.finalText,
      resumable: !!this.opts.store && (run.status === "failed" || run.status === "timeout" || run.status === "cancelled"),
    } as WorkflowStatusResult;
  }

  private rowToStatus(row: Record<string, unknown>): WorkflowStatusResult {
    return {
      workflowId: row.workflow_id as string,
      status: row.status as WorkflowStatusResult["status"],
      project: (row.project_id as string | null) ?? undefined,
      mode: row.mode as "dag" | "graph" | "discussion",
      nodes: JSON.parse(row.nodes_json as string),
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
      completedAt: (row.completed_at as string | null) ?? undefined,
      error: (row.error as string | null) ?? undefined,
      finalText: (row.final_text as string | null) ?? undefined,
      resumable: ["failed", "timeout", "cancelled"].includes(row.status as string),
    } as WorkflowStatusResult;
  }

  private emit(run: WorkflowRunState, partial: Record<string, unknown>): void {
    const ev = { workflowId: run.workflowId, seq: run.seq++, timestamp: new Date().toISOString(), ...partial } as unknown as WorkflowEvent;
    const list = this.workflowEvents.get(run.workflowId) ?? [];
    list.push(ev);
    this.workflowEvents.set(run.workflowId, list);
    this.persist(run);
    this.opts.emit(ev);
  }
}
