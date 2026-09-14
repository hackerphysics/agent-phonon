import type { SessionEngine } from "./session-engine.js";
import { PhononError } from "./rpc.js";
import { assertRefName } from "./project-manager.js";
import type { EnvManager } from "./env-manager.js";
import type { PhononStore } from "./store.js";
import * as path from "node:path";
import * as fs from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { InteractionRequestParams as InteractionRequestParamsSchema } from "@agent-phonon/protocol";
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

const CONTROL_SETTLE_TIMEOUT_MS = 2_000;

async function settleWithin(promises: Promise<unknown>[], timeoutMs = CONTROL_SETTLE_TIMEOUT_MS): Promise<void> {
  if (promises.length === 0) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    Promise.allSettled(promises).then(() => undefined),
    new Promise<void>((resolve) => { timer = setTimeout(resolve, timeoutMs); }),
  ]);
  if (timer) clearTimeout(timer);
}

// =============================================================================
// In-memory runtime state
// =============================================================================

interface WorkflowNodeState {
  nodeId: string;
  status: "pending" | "ready" | "running" | "paused" | "completed" | "failed" | "skipped" | "cancelled";
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
  attempts?: Array<{
    attempt: number;
    iteration?: number;
    sessionId?: string;
    turnId?: string;
    status: "running" | "completed" | "failed" | "interrupted" | "timeout" | "cancelled";
    startedAt: string;
    completedAt?: string;
    error?: string;
  }>;
}

interface GraphCursor {
  iteration: number;
  phase: "executor" | "directives";
  currentDirectives: WorkflowRoutingDirective[];
  handled: string[];
  workerResults: Array<{ nodeId: string; text: string }>;
  lastExecutorText?: string;
  finalSummary?: string;
  roundStarted?: boolean;
}

interface DiscussionCursor {
  round: number;
  phase: "participants" | "chairman";
  outputs: Record<string, { text: string; role?: string }>;
  transcript: Array<{ round: number; nodeId: string; role?: string; text: string }>;
  roundStarted?: boolean;
}

interface WorkflowCheckpoint {
  controlEpoch: number;
  /** Absolute wall-clock deadline; automatic recovery never resets total budget. */
  deadlineAt?: number;
  graph?: GraphCursor;
  discussion?: DiscussionCursor;
  persistentSessions: Record<string, string>;
  autoWorktrees: Record<string, { projectId: string; worktreeId: string; userKey: string }>;
  mainBranchCheckedOut: Record<string, string>;
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
  metadata?: Record<string, unknown>;
  status: "queued" | "running" | "paused" | "completed" | "failed" | "cancelled" | "timeout";
  nodes: WorkflowNodeState[];
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  error?: string;
  seq: number;
  ackedSeq: number;
  finalText?: string;
  checkpoint: WorkflowCheckpoint;
  ownerEpoch: number;
}

class StaleExecutionError extends Error {
  constructor() { super("stale workflow execution fenced"); }
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
  // Fence tag and body must agree. Silently letting the body override the tag
  // made validation/auditing ambiguous and could execute a different action
  // than the one shown by the markdown fence.
  if (typeof obj.kind === "string" && obj.kind !== kindFromTag) return null;
  const kind = kindFromTag as WorkflowRoutingDirective["kind"];
  switch (kind) {
    case "workflow.route":
      if (typeof obj.message !== "string") return null;
      if (!(typeof obj.to === "string" || (Array.isArray(obj.to) && obj.to.length > 0 && obj.to.every((v) => typeof v === "string")))) return null;
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
      if (obj.finalSummary !== undefined && typeof obj.finalSummary !== "string") return null;
      return {
        kind: "workflow.done",
        finalSummary: obj.finalSummary as string | undefined,
        reason: obj.reason as string | undefined,
      };
    case "workflow.human_review":
      if (typeof obj.title !== "string" || typeof obj.summary !== "string") return null;
      if (obj.timeoutSeconds !== undefined && (typeof obj.timeoutSeconds !== "number" || !Number.isFinite(obj.timeoutSeconds) || obj.timeoutSeconds <= 0)) return null;
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

function directiveKey(directive: WorkflowRoutingDirective): string {
  return createHash("sha256").update(JSON.stringify(directive)).digest("hex");
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
  private disposed = false;
  private readonly ownerId = `workflow-owner-${process.pid}-${randomUUID()}`;
  private readonly leaseMs = 5_000;
  private readonly leaseTimer: ReturnType<typeof setInterval>;
  private recovering = false;
  private finalizing = new Set<string>();

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
  }) {
    this.leaseTimer = setInterval(() => {
      try {
        this.renewLeases();
        // A real process crash cannot release its lease. Periodic scanning means
        // the successor claims the checkpoint immediately after lease expiry
        // instead of depending on a one-shot startup race.
        void this.recover().catch(() => {});
      } catch {
        // Store shutdown/replacement is handled by the owning connection.
      }
    }, Math.max(500, Math.floor(this.leaseMs / 3)));
    this.leaseTimer.unref?.();
  }

  /** Claim and continue queued/running checkpoints left by a prior owner. */
  async recover(): Promise<number> {
    if (this.disposed || !this.opts.store || this.recovering) return 0;
    this.recovering = true;
    let recovered = 0;
    try {
      for (const row of this.opts.store.listRecoverableWorkflows(this.opts.tenantId)) {
        const workflowId = row.workflow_id as string;
        if (this.runs.has(workflowId)) continue;
        const ownerEpoch = this.opts.store.claimWorkflow(workflowId, this.opts.tenantId, this.ownerId, this.leaseMs);
        if (ownerEpoch === undefined) continue;
        const run = this.restoreRow(row, ownerEpoch, true);
        try {
          this.validateExecutionTargets(run.project, run.plan);
          this.validatePlan(run.plan);
          this.hydrateCheckpoint(run);
          this.runs.set(workflowId, run);
          this.persist(run);
          void this.executeWithTimeout(run, run.checkpoint.controlEpoch).catch((err) => this.fail(run, err));
          recovered++;
        } catch (err) {
          // One corrupt/stale checkpoint must not starve every later workflow.
          run.status = "failed";
          run.error = `automatic recovery validation failed: ${(err as Error)?.message ?? String(err)}`;
          run.completedAt = new Date().toISOString();
          run.updatedAt = run.completedAt;
          this.persistDisposedRun(run);
          this.opts.store.releaseWorkflow(run.workflowId, run.tenantId, this.ownerId, run.ownerEpoch);
        }
      }
      return recovered;
    } finally {
      this.recovering = false;
    }
  }

  private renewLeases(): void {
    if (this.disposed || !this.opts.store) return;
    for (const run of this.runs.values()) {
      if (["completed", "failed", "cancelled", "timeout"].includes(run.status) && !this.finalizing.has(run.workflowId)) continue;
      const ok = this.opts.store.renewWorkflowLease(run.workflowId, run.tenantId, this.ownerId, run.ownerEpoch, this.leaseMs);
      if (!ok) run.checkpoint.controlEpoch++;
    }
  }

  // ---------------------------------------------------------------------------
  // RPC entry
  // ---------------------------------------------------------------------------

  /** Permanently release connection-scoped workflow runtime state. */
  async dispose(reason = "connection disposed"): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    clearInterval(this.leaseTimer);
    for (const resolve of this.turnWaiters.values()) resolve({ status: "interrupted", text: "" });
    this.turnWaiters.clear();
    // Let an already-started cancel/timeout finalizer commit its cleaned
    // resource mappings before this connection releases ownership. `persist`
    // remains enabled for those finalizers even though ordinary execution is fenced.
    const finalizerDeadline = Date.now() + CONTROL_SETTLE_TIMEOUT_MS + 1_000;
    while (this.finalizing.size > 0 && Date.now() < finalizerDeadline) {
      for (const workflowId of this.finalizing) {
        const active = this.runs.get(workflowId);
        if (active) this.opts.store?.renewWorkflowLease(active.workflowId, active.tenantId, this.ownerId, active.ownerEpoch, this.leaseMs);
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const lingeringFinalizers = new Set(this.finalizing);
    for (const workflowId of lingeringFinalizers) {
      const active = this.runs.get(workflowId);
      if (active) this.opts.store?.renewWorkflowLease(active.workflowId, active.tenantId, this.ownerId, active.ownerEpoch, 30_000);
    }
    const interrupts: Promise<unknown>[] = [];
    for (const run of this.runs.values()) {
      if (!["completed", "failed", "timeout", "cancelled", "paused"].includes(run.status)) {
        // A connection is transport-scoped, a workflow is not. Fence the old
        // executor and checkpoint the current boundary as queued for the next
        // connection instead of converting a recoverable run into failure.
        run.checkpoint.controlEpoch++;
        run.status = "queued";
        run.error = undefined;
        run.completedAt = undefined;
        run.updatedAt = new Date().toISOString();
        for (const node of run.nodes) {
          if (["ready", "running"].includes(node.status)) node.status = "pending";
          const attempt = node.attempts?.at(-1);
          if (attempt?.status === "running") {
            attempt.status = "interrupted";
            attempt.completedAt = run.updatedAt;
            attempt.error = reason;
          }
          if (node.sessionId) interrupts.push(this.opts.engine.interrupt(run.tenantId, node.sessionId, reason).catch(() => {}));
        }
        this.persistDisposedRun(run);
      }
      if (!lingeringFinalizers.has(run.workflowId)) {
        this.opts.store?.releaseWorkflow(run.workflowId, run.tenantId, this.ownerId, run.ownerEpoch);
      }
    }
    // Reconnect is a control-plane boundary. A non-settling adapter interrupt
    // may continue its own process-supervisor escalation, but cannot hold the
    // replacement connection hostage forever.
    await settleWithin(interrupts);
    this.runs.clear();
    this.sessionToNode.clear();
    const belongsToLingering = (key: string) => [...lingeringFinalizers].some((workflowId) => key.startsWith(`${workflowId}::`));
    for (const key of [...this.persistentSessions.keys()]) if (!belongsToLingering(key)) this.persistentSessions.delete(key);
    this.pendingResultText.clear();
    this.turnResultCache.clear();
    this.workflowEvents.clear();
    this.artifacts.clear();
    // Preserve maps still owned by a bounded finalizer. It will persist and
    // release them itself; ordinary reconnect-owned maps can be dropped here.
    for (const key of [...this.autoWorktrees.keys()]) if (!belongsToLingering(key)) this.autoWorktrees.delete(key);
    for (const key of [...this.mainBranchCheckedOut.keys()]) if (!belongsToLingering(key)) this.mainBranchCheckedOut.delete(key);
  }

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
    if (this.disposed) throw new Error("workflow engine disposed");
    // 1. 恢复路径
    if (params.resumeFrom) {
      const restored = this.restoreFromCheckpoint(params.resumeFrom);
      if (restored) {
        this.validateExecutionTargets(restored.project, restored.plan);
        this.validatePlan(restored.plan);
        void this.executeWithTimeout(restored, restored.checkpoint.controlEpoch).catch((err) => this.fail(restored, err));
        return { workflowId: restored.workflowId, status: restored.status, createdAt: restored.createdAt, resumed: true };
      }
      // 找不到 checkpoint → 错误（不静默 fallback）
      throw new PhononError("errInvalidParams", `workflow ${params.resumeFrom.workflowId} has no resumable checkpoint`);
    }

    // 2. 全新启动。必须在分配 workflowId/持久化 queued 状态之前验证所有
    // node 的有效 project/worktree，避免半条无效 workflow 留在 store。
    this.validateExecutionTargets(params.project, params.plan);
    this.validatePlan(params.plan);
    const workflowId = `wf-${Date.now()}-${randomUUID()}`;
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
      metadata: params.metadata,
      status: "queued",
      nodes,
      createdAt: now,
      updatedAt: now,
      seq: 0,
      ackedSeq: -1,
      checkpoint: {
        controlEpoch: 0,
        deadlineAt: policy.timeoutSeconds ? Date.now() + policy.timeoutSeconds * 1000 : undefined,
        persistentSessions: {},
        autoWorktrees: {},
        mainBranchCheckedOut: {},
      },
      ownerEpoch: 0,
    };
    this.runs.set(workflowId, run);
    this.persist(run);
    this.emit(run, { type: "workflow.status", status: "queued" });
    void this.executeWithTimeout(run, run.checkpoint.controlEpoch).catch((err) => this.fail(run, err));
    return { workflowId, status: run.status, createdAt: run.createdAt, resumed: false };
  }

  /**
   * v0.7: workflow.resume —— 独立入口，比 run({resumeFrom}) 更明确。
   * 支持 sharedContextPatch（浅 merge）和 feedback（写进 sharedContext.notes 末尾）。
   */
  async resume(params: {
    workflowId: string;
    strategy: "continue" | "last_success_dependents" | "failed_node" | `node:${string}`;
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
    this.validateExecutionTargets(restored.project, restored.plan);
    this.validatePlan(restored.plan);
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
    void this.executeWithTimeout(restored, restored.checkpoint.controlEpoch).catch((err) => this.fail(restored, err));
    return { workflowId: restored.workflowId, status: restored.status, createdAt: restored.createdAt, resumed: true };
  }

  status(workflowId: string): WorkflowStatusResult {
    // 优先内存；若内存里没有再查 store（已结束的历史 workflow）
    const memRun = this.runs.get(workflowId);
    if (memRun) return this.toStatus(memRun);
    if (this.opts.store) {
      const row = this.opts.store.getWorkflow(workflowId, this.opts.tenantId);
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

  async pause(workflowId: string, reason?: string): Promise<{ workflowId: string; status: "paused" }> {
    const run = this.runs.get(workflowId);
    if (!run) {
      const stored = this.opts.store?.getWorkflow(workflowId, this.opts.tenantId);
      if (stored?.status === "paused") return { workflowId, status: "paused" };
      throw new PhononError("errInvalidParams", `workflow ${workflowId} is not owned by this connection`);
    }
    if (run.status === "paused") return { workflowId, status: "paused" };
    if (["completed", "failed", "cancelled", "timeout"].includes(run.status)) {
      throw new PhononError("errInvalidParams", `workflow ${workflowId} is already terminal (${run.status})`);
    }
    run.checkpoint.controlEpoch++;
    run.status = "paused";
    run.updatedAt = new Date().toISOString();
    const interrupts: Promise<unknown>[] = [];
    for (const node of run.nodes) {
      if (node.status === "running" || node.status === "ready") node.status = "paused";
      const attempt = node.attempts?.at(-1);
      if (attempt?.status === "running") {
        attempt.status = "interrupted";
        attempt.completedAt = run.updatedAt;
        attempt.error = reason ?? "workflow paused";
      }
      this.resolveNodeWaiter(node, "interrupted");
      if (node.sessionId) interrupts.push(this.opts.engine.interrupt(run.tenantId, node.sessionId, reason ?? "workflow paused").catch(() => {}));
    }
    this.persist(run);
    this.emit(run, { type: "workflow.status", status: "paused", payload: { reason } });
    await settleWithin(interrupts);
    return { workflowId, status: "paused" };
  }

  async cancel(workflowId: string, reason?: string): Promise<{ workflowId: string; status: "cancelled" }> {
    let run = this.runs.get(workflowId);
    if (!run) {
      const row = this.opts.store?.getWorkflow(workflowId, this.opts.tenantId);
      if (!row) throw new PhononError("errInvalidParams", `workflow ${workflowId} not found`);
      if (["completed", "failed", "timeout", "cancelled"].includes(row.status as string)) return { workflowId, status: "cancelled" };
      const ownerEpoch = this.opts.store!.claimWorkflow(workflowId, this.opts.tenantId, this.ownerId, this.leaseMs);
      if (ownerEpoch === undefined) throw new PhononError("errInvalidParams", `workflow ${workflowId} is owned by another executor`);
      run = this.restoreRow(row, ownerEpoch, false);
      this.hydrateCheckpoint(run);
      this.runs.set(workflowId, run);
    }
    if (["completed", "failed", "timeout", "cancelled"].includes(run.status)) {
      return { workflowId, status: "cancelled" };
    }
    this.finalizing.add(workflowId);
    try {
      run.checkpoint.controlEpoch++;
      run.status = "cancelled";
      run.completedAt = new Date().toISOString();
      run.updatedAt = run.completedAt;
      const terminations: Promise<unknown>[] = [];
      for (const n of run.nodes) {
        if (n.status === "running" || n.status === "ready" || n.status === "pending" || n.status === "paused") {
          n.status = "cancelled";
          const attempt = n.attempts?.at(-1);
          if (attempt?.status === "running") { attempt.status = "cancelled"; attempt.completedAt = run.updatedAt; }
          this.resolveNodeWaiter(n, "interrupted");
          if (n.sessionId) terminations.push(this.opts.engine.terminate(this.opts.tenantId, n.sessionId).catch(() => {}));
        }
      }
      // Commit the terminal fence before touching any potentially stuck adapter.
      this.persist(run);
      this.emit(run, { type: "workflow.status", status: "cancelled", payload: { reason } });
      await settleWithin(terminations);
      await this.cleanupPersistent(run, false);
      const wtKept1 = await this.cleanupAutoWorktrees(run);
      this.persist(run);
      if (wtKept1.kept.length > 0) {
        this.emit(run, { type: "workflow.status", status: "cancelled", payload: { reason, worktreesKept: wtKept1.kept } });
      }
      this.opts.store?.releaseWorkflow(run.workflowId, run.tenantId, this.ownerId, run.ownerEpoch);
      return { workflowId, status: "cancelled" };
    } finally {
      this.finalizing.delete(workflowId);
    }
  }

  ack(workflowId: string, lastSeq: number): void {
    const run = this.runs.get(workflowId);
    if (run) {
      const bounded = Math.min(lastSeq, run.seq - 1);
      if (bounded > run.ackedSeq) {
        run.ackedSeq = bounded;
        this.opts.store?.ackWorkflow(workflowId, bounded, this.opts.tenantId);
      }
    } else {
      this.opts.store?.ackWorkflow(workflowId, lastSeq, this.opts.tenantId);
    }
  }

  eventsList(params: { workflowId: string; afterSeq?: number; limit?: number }): { events: WorkflowEvent[]; nextSeq?: number } {
    const afterSeq = params.afterSeq ?? -1;
    const limit = params.limit ?? 200;
    if (this.opts.store) {
      if (!this.opts.store.getWorkflow(params.workflowId, this.opts.tenantId)) {
        throw new PhononError("errInvalidParams", `workflow ${params.workflowId} not found`);
      }
      const rows = this.opts.store.workflowEvents(params.workflowId, this.opts.tenantId, afterSeq, limit + 1);
      const hasMore = rows.length > limit;
      const events = rows.slice(0, limit).map((row) => JSON.parse(row.payload) as WorkflowEvent);
      const last = events.at(-1)?.seq;
      return { events, ...(hasMore && last !== undefined ? { nextSeq: last } : {}) };
    }
    const all = this.workflowEvents.get(params.workflowId) ?? [];
    const events = all.filter((e) => e.seq > afterSeq).slice(0, limit);
    const last = events.at(-1)?.seq;
    const hasMore = last !== undefined && all.some((e) => e.seq > last);
    return { events, ...(hasMore && last !== undefined ? { nextSeq: last } : {}) };
  }

  /** Replay durable workflow events not yet acknowledged by the server. */
  replayUnacked(): number {
    if (!this.opts.store || this.disposed) return 0;
    let sent = 0;
    for (const row of this.opts.store.unackedWorkflowEvents(this.opts.tenantId)) {
      try {
        this.opts.emit(JSON.parse(row.payload) as WorkflowEvent);
        sent++;
      } catch {
        break;
      }
    }
    return sent;
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
    let temporaryOwner = false;
    if (this.opts.store && !this.opts.store.isWorkflowOwner(run.workflowId, run.tenantId, this.ownerId, run.ownerEpoch)) {
      const epoch = this.opts.store.claimWorkflow(run.workflowId, run.tenantId, this.ownerId, this.leaseMs);
      if (epoch === undefined) throw new PhononError("errInvalidParams", `workflow ${run.workflowId} is owned by another executor`);
      run.ownerEpoch = epoch;
      temporaryOwner = true;
    }
    this.emit(run, { type: "artifact.written", nodeId: params.nodeId, payload: artifact });
    if (temporaryOwner) this.opts.store?.releaseWorkflow(run.workflowId, run.tenantId, this.ownerId, run.ownerEpoch);
    return { artifact };
  }

  artifactsList(workflowId: string): { artifacts: WorkflowArtifact[] } {
    return { artifacts: this.artifacts.get(workflowId) ?? [] };
  }

  /** SessionEngine sink → 提取 result 文本到 turnWaiters；不再产生 node.stream 事件。 */
  onStreamEvent(ev: StreamEvent): void {
    if (this.disposed) return;
    const sessionId = (ev as { sessionId?: string }).sessionId;
    if (!sessionId) return;
    const mapping = this.sessionToNode.get(sessionId);
    if (!mapping) return;

    const evAny = ev as Record<string, unknown>;
    const turnId = evAny.turnId as string | undefined;
    const run = this.runs.get(mapping.workflowId);
    const node = run?.nodes.find((n) => n.nodeId === mapping.nodeId);
    // Pause/cancel/timeout/dispose advance the control boundary before the
    // adapter is interrupted. Ignore all later output from that fenced turn;
    // otherwise it accumulates in turnResultCache and can confuse recovery.
    if (!run || run.status !== "running" || (node?.turnId && turnId !== node.turnId)) return;
    const key = `${sessionId}::${turnId ?? ""}`;

    if (evAny.type === "message" && typeof evAny.text === "string") {
      const prior = this.pendingResultText.get(key) ?? "";
      this.pendingResultText.set(key, prior + (evAny.text as string));
    } else if (evAny.type === "result") {
      const text = (evAny.text as string | undefined) || this.pendingResultText.get(key) || "";
      this.pendingResultText.delete(key);
      const rawUsage = evAny.usage as WorkflowNodeResult["usage"] | undefined;
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

  /**
   * Validate every effective project/worktree before a workflow is persisted or
   * resumed. The protocol allows per-node project overrides, so checking only
   * the workflow-level project leaves invalid node paths to fail asynchronously
   * after a queued checkpoint has already been written.
   */
  private validateExecutionTargets(defaultProject: string | undefined, plan: WorkflowPlan): void {
    const nodes = plan.mode === "dag"
      ? plan.nodes
      : plan.mode === "graph"
        ? [plan.executor, ...plan.workers]
        : plan.participants;
    for (const node of nodes) {
      const projectId = node.project ?? defaultProject;
      if (!projectId) {
        throw new PhononError("errInvalidParams", `workflow node ${node.nodeId} has no project`);
      }
      // Workflow worktreeId is a caller-defined isolation key, not a persisted
      // ProjectManager worktree handle. Only validate the registered project
      // here; resolveExecution lazily creates/reuses the real worktree later.
      this.opts.resolveCwd(projectId);
    }
  }

  private validatePlan(plan: WorkflowPlan): void {
    const defs = plan.mode === "dag" ? plan.nodes : plan.mode === "graph" ? [plan.executor, ...plan.workers] : plan.participants;
    const ids = new Set<string>();
    for (const node of defs) {
      if (ids.has(node.nodeId)) throw new PhononError("errInvalidParams", `duplicate workflow nodeId ${node.nodeId}`);
      ids.add(node.nodeId);
    }
    if (plan.mode === "dag") {
      for (const node of plan.nodes) for (const dep of node.dependsOn ?? []) {
        if (!ids.has(dep)) throw new PhononError("errInvalidParams", `DAG dependency ${dep} does not exist`);
      }
      for (const edge of plan.edges ?? []) {
        if (!ids.has(edge.from) || !ids.has(edge.to)) throw new PhononError("errInvalidParams", `DAG edge ${edge.from}->${edge.to} has an unknown endpoint`);
      }
      if (plan.finalNodeId && !ids.has(plan.finalNodeId)) throw new PhononError("errInvalidParams", `finalNodeId ${plan.finalNodeId} does not exist`);
      return;
    }
    if (plan.mode === "discussion") {
      if (!ids.has(plan.chairman)) throw new PhononError("errInvalidParams", `chairman ${plan.chairman} not in participants`);
      return;
    }
    const executorId = plan.executor.nodeId;
    const workerIds = new Set(plan.workers.map((w) => w.nodeId));
    const edgeKeys = new Set<string>();
    for (const edge of plan.communicationGraph.edges) {
      const key = `${edge.from}->${edge.to}`;
      if (edgeKeys.has(key)) throw new PhononError("errInvalidParams", `duplicate communication edge ${key}`);
      edgeKeys.add(key);
      if (edge.from !== executorId) throw new PhononError("errInvalidParams", `graph edge source must be executor ${executorId}: ${key}`);
      if (!workerIds.has(edge.to)) throw new PhononError("errInvalidParams", `graph edge target is not a worker: ${key}`);
      if (!plan.communicationGraph.allowSelfLoop && edge.from === edge.to) throw new PhononError("errInvalidParams", `self-loop is disabled: ${key}`);
    }
  }

  private async executeWithTimeout(run: WorkflowRunState, executionEpoch: number): Promise<void> {
    if (this.disposed) return;
    if (run.policy.timeoutSeconds && run.checkpoint.deadlineAt === undefined) {
      run.checkpoint.deadlineAt = Date.now() + run.policy.timeoutSeconds * 1000;
      this.persist(run);
    }
    const timeoutMs = run.checkpoint.deadlineAt === undefined
      ? undefined
      : Math.max(0, run.checkpoint.deadlineAt - Date.now());
    if (timeoutMs === 0) {
      if (!this.disposed && run.checkpoint.controlEpoch === executionEpoch && ["queued", "running"].includes(run.status)) {
        await this.finalizeTimeout(run);
      }
      return;
    }
    const exec = this.execute(run, executionEpoch);
    if (timeoutMs === undefined) { await exec; return; }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<"timeout">((resolve) => { timer = setTimeout(() => resolve("timeout"), timeoutMs); });
    let winner: "done" | "timeout";
    try {
      winner = await Promise.race([exec.then(() => "done" as const), timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (winner === "timeout" && !this.disposed && run.checkpoint.controlEpoch === executionEpoch && run.status === "running") {
      await this.finalizeTimeout(run);
    }
  }

  private async finalizeTimeout(run: WorkflowRunState): Promise<void> {
    if (this.finalizing.has(run.workflowId)) return;
    this.finalizing.add(run.workflowId);
    try {
      run.checkpoint.controlEpoch++;
      run.status = "timeout";
      run.completedAt = new Date().toISOString();
      run.updatedAt = run.completedAt;
      run.error = `workflow exceeded timeout ${run.policy.timeoutSeconds}s`;
      const terminations: Promise<unknown>[] = [];
      for (const n of run.nodes) {
        if (["running", "ready", "pending", "paused"].includes(n.status)) {
          n.status = "cancelled";
          const attempt = n.attempts?.at(-1);
          if (attempt?.status === "running") { attempt.status = "timeout"; attempt.completedAt = run.updatedAt; attempt.error = run.error; }
          this.resolveNodeWaiter(n, "timeout");
          if (n.sessionId) terminations.push(this.opts.engine.terminate(this.opts.tenantId, n.sessionId).catch(() => {}));
        }
      }
      this.persist(run);
      this.emit(run, { type: "workflow.status", status: "timeout", payload: { error: run.error } });
      await settleWithin(terminations);
      await this.cleanupPersistent(run, false);
      const wtKept = await this.cleanupAutoWorktrees(run);
      this.persist(run);
      if (wtKept.kept.length > 0) {
        this.emit(run, { type: "workflow.status", status: "timeout", payload: { worktreesKept: wtKept.kept } });
      }
      this.opts.store?.releaseWorkflow(run.workflowId, run.tenantId, this.ownerId, run.ownerEpoch);
    } finally {
      this.finalizing.delete(run.workflowId);
    }
  }

  private async execute(run: WorkflowRunState, executionEpoch: number): Promise<void> {
    if (this.disposed) return;
    if (run.checkpoint.controlEpoch !== executionEpoch || run.status !== "queued") throw new StaleExecutionError();
    run.status = "running";
    run.updatedAt = new Date().toISOString();
    this.persist(run);
    this.emit(run, { type: "workflow.status", status: "running" });
    if (run.plan.mode === "dag") await this.executeDag(run, executionEpoch);
    else if (run.plan.mode === "graph") await this.executeGraph(run, executionEpoch);
    else if (run.plan.mode === "discussion") await this.executeDiscussion(run, executionEpoch);
    if (this.disposed) return;
    this.assertCurrent(run, executionEpoch);
    if (!(["cancelled", "failed", "timeout"] as string[]).includes(run.status)) {
      this.fillFinalText(run);
      // Keep status=running while cleanup is in flight so lease renewal remains
      // active and no successor can claim the pre-terminal checkpoint.
      const wtKeptEx = await this.cleanupAutoWorktrees(run);
      this.assertCurrent(run, executionEpoch);
      run.status = "completed";
      run.completedAt = new Date().toISOString();
      run.updatedAt = run.completedAt;
      this.persist(run);
      this.emit(run, { type: "workflow.status", status: "completed", payload: { finalText: run.finalText, worktreesKept: wtKeptEx.kept } });
      this.opts.store?.releaseWorkflow(run.workflowId, run.tenantId, this.ownerId, run.ownerEpoch);
    }
  }

  // ---------------------------------------------------------------------------
  // DAG
  // ---------------------------------------------------------------------------

  private async executeDag(run: WorkflowRunState, executionEpoch: number): Promise<void> {
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
      else if (node.status === "failed" && run.policy.onNodeFailure !== "fail_workflow") settled.add(node.nodeId);
    }

    while (settled.size < plan.nodes.length) {
      this.assertCurrent(run, executionEpoch);
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
      // continue runs dependents once all prerequisites settle, even if some failed.
      const runnable = run.policy.onNodeFailure === "continue" ? ready : ready.filter((n) => !toSkip.includes(n));
      if (runnable.length === 0 && toSkip.length > 0) continue;

      const batchSize = run.policy.maxParallel ?? runnable.length;
      for (let i = 0; i < runnable.length; i += batchSize) {
        const batch = runnable.slice(i, i + batchSize);
        const results = await Promise.allSettled(batch.map((n) =>
          this.executeNode(run, n.nodeId, n.agent, n.model, n.role, this.composeDagNodeInput(run, n, succeeded), n.agentConfig, n.systemPrompt, undefined,
            { project: n.project, worktreeId: n.worktreeId, branch: n.branch }, executionEpoch)
        ));
        this.assertCurrent(run, executionEpoch);
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

  private async executeGraph(run: WorkflowRunState, executionEpoch: number): Promise<void> {
    if (run.plan.mode !== "graph") return;
    const plan = run.plan;
    const allowedEdges = new Set<string>(plan.communicationGraph.edges.map((e) => `${e.from}->${e.to}`));
    const maxIterations = plan.communicationGraph.maxIterations ?? 12;
    const cursor: GraphCursor = run.checkpoint.graph ?? {
      iteration: 0,
      phase: "executor",
      currentDirectives: [],
      handled: [],
      workerResults: [],
    };
    run.checkpoint.graph = cursor;

    const executorPrompt = [
      "You are the EXECUTOR of a multi-agent workflow.",
      `Input: ${run.input ?? ""}`,
      `Workers available: ${JSON.stringify(plan.workers.map((w) => ({ nodeId: w.nodeId, role: w.role, agent: w.agent, model: w.model })))}`,
      `Communication graph (allowed routes): ${JSON.stringify(plan.communicationGraph)}`,
      "", "Emit a fenced phonon.workflow.route/feedback/reply/done directive.",
      "All targets must be workers connected by an explicit executor edge.",
      "Use `workflow.done` when the workflow is complete.",
    ].join("\n");
    const execEnv = { project: plan.executor.project, worktreeId: plan.executor.worktreeId, branch: plan.executor.branch };
    let done = false;

    while (!done) {
      this.assertCurrent(run, executionEpoch);
      if (cursor.phase === "executor") {
        const input = cursor.iteration === 0 && cursor.workerResults.length === 0
          ? executorPrompt
          : [
              "Worker results from previous iteration:",
              ...cursor.workerResults.map((w) => `[worker ${w.nodeId}]\n${w.text}`),
              "", "Either emit the next routing directive or finalize with `workflow.done`.",
            ].join("\n\n");
        const result = await this.executeNode(
          run, plan.executor.nodeId, plan.executor.agent, plan.executor.model, "executor", input,
          plan.executor.agentConfig, plan.executor.systemPrompt, plan.executor.nodeId, execEnv, executionEpoch,
        );
        this.assertCurrent(run, executionEpoch);
        cursor.lastExecutorText = result.text ?? cursor.lastExecutorText ?? "";
        cursor.workerResults = [];

        const parsed = parseRoutingDirectives(cursor.lastExecutorText);
        const seen = new Set<string>();
        cursor.currentDirectives = parsed.filter((directive) => {
          const key = directiveKey(directive);
          if (seen.has(key)) return false; // duplicate blocks in one executor turn are idempotent
          seen.add(key);
          if (directive.kind === "workflow.done" || directive.kind === "workflow.human_review") return true;
          const targets = Array.isArray(directive.to) ? directive.to : [directive.to];
          // Strict: one bad endpoint invalidates the whole directive; never
          // partially execute a broadcast that was not authorized as written.
          return targets.length > 0 && targets.every((target) =>
            plan.workers.some((w) => w.nodeId === target) && allowedEdges.has(`${plan.executor.nodeId}->${target}`));
        });
        cursor.phase = "directives";
        this.persist(run);

        const doneDirective = cursor.currentDirectives.find((d) => d.kind === "workflow.done");
        if (doneDirective?.kind === "workflow.done") {
          cursor.finalSummary = doneDirective.finalSummary;
          done = true;
          break;
        }
        if (cursor.currentDirectives.length === 0) {
          throw new Error("graph executor terminated abnormally: no_valid_targets (no valid directive or authorized target)");
        }
      }

      if (cursor.phase !== "directives") continue;
      if (cursor.iteration >= maxIterations) {
        throw new Error(`graph executor terminated abnormally: max_iterations (reached maxIterations=${maxIterations})`);
      }
      const iteration = cursor.iteration + 1;
      if (!cursor.roundStarted) {
        this.emit(run, { type: "round.started", payload: { iteration, mode: "graph" } });
        cursor.roundStarted = true;
        this.persist(run);
      }

      let produced = cursor.workerResults.length > 0;
      for (const directive of cursor.currentDirectives) {
        this.assertCurrent(run, executionEpoch);
        const baseKey = `${cursor.iteration}:${directiveKey(directive)}`;
        if (directive.kind === "workflow.done") {
          cursor.finalSummary = directive.finalSummary;
          done = true;
          break;
        }
        if (directive.kind === "workflow.human_review") {
          if (cursor.handled.includes(baseKey)) continue;
          const reviewResult = await this.requestHumanReview(run, directive, `wf-review-${run.workflowId}-${baseKey}`);
          this.assertCurrent(run, executionEpoch);
          cursor.handled.push(baseKey);
          if (reviewResult.approved) {
            cursor.finalSummary = reviewResult.feedback ?? cursor.lastExecutorText ?? directive.summary;
            done = true;
          } else {
            cursor.workerResults.push({
              nodeId: "__human_review__",
              text: `[HUMAN REVIEW REJECTED]\nReviewer feedback: ${reviewResult.feedback ?? "(no feedback)"}\nReviewer: ${reviewResult.reviewer ?? "(unknown)"}`,
            });
            produced = true;
          }
          this.persist(run);
          if (done) break;
          continue;
        }

        const targets = Array.isArray(directive.to) ? directive.to : [directive.to];
        for (const target of targets) {
          const targetKey = `${baseKey}:${target}`;
          if (cursor.handled.includes(targetKey)) continue;
          const worker = plan.workers.find((w) => w.nodeId === target)!;
          this.emit(run, {
            type: "executor.decision", nodeId: plan.executor.nodeId,
            payload: { kind: directive.kind, to: target, reason: ("reason" in directive ? directive.reason : undefined), iteration },
          });
          this.emit(run, { type: "edge.route", payload: { from: plan.executor.nodeId, to: target, kind: directive.kind, iteration } });
          const workerInput = directive.kind === "workflow.route" ? directive.message
            : directive.kind === "workflow.feedback" ? `[FEEDBACK / REVISE]\n${directive.message}`
            : directive.keystroke;
          const workerResult = await this.executeNode(
            run, worker.nodeId, worker.agent, worker.model, worker.role ?? "worker", workerInput,
            worker.agentConfig, worker.systemPrompt, worker.nodeId,
            { project: worker.project, worktreeId: worker.worktreeId, branch: worker.branch }, executionEpoch,
          );
          this.assertCurrent(run, executionEpoch);
          cursor.workerResults.push({ nodeId: target, text: workerResult.text ?? "" });
          cursor.handled.push(targetKey);
          produced = true;
          this.persist(run); // target-level boundary: recovery never repeats completed route
        }
      }
      if (done) break;
      if (!produced) throw new Error("graph executor terminated abnormally: no_directive");
      this.emit(run, { type: "round.completed", payload: { iteration, workerCount: cursor.workerResults.length } });
      cursor.iteration = iteration;
      cursor.phase = "executor";
      cursor.currentDirectives = [];
      cursor.roundStarted = false;
      this.persist(run);
    }

    run.finalText = cursor.finalSummary ?? cursor.lastExecutorText;
    await this.cleanupPersistent(run);
    const wtKept = await this.cleanupAutoWorktrees(run);
    if (wtKept.kept.length > 0) this.emit(run, { type: "workflow.status", status: run.status, payload: { worktreesKept: wtKept.kept } });
  }

  // ---------------------------------------------------------------------------
  // Discussion (v0.5 新增；借鉴 Foreman _run_discuss_rounds)
  // ---------------------------------------------------------------------------

  private async executeDiscussion(run: WorkflowRunState, executionEpoch: number): Promise<void> {
    if (run.plan.mode !== "discussion") return;
    const plan = run.plan;
    const chairman = plan.participants.find((p) => p.nodeId === plan.chairman);
    if (!chairman) throw new PhononError("errInvalidParams", `chairman ${plan.chairman} not in participants`);
    const nonChair = plan.participants.filter((p) => p.nodeId !== plan.chairman);
    const chairmanSignal = plan.termination?.chairmanSignal ?? "[DISCUSS_END]";
    const maxRounds = plan.termination?.maxRounds ?? 10;
    const consensusSignal = plan.termination?.consensusSignal;
    const cursor: DiscussionCursor = run.checkpoint.discussion ?? {
      round: 1, phase: "participants", outputs: {}, transcript: [],
    };
    run.checkpoint.discussion = cursor;
    let terminationReason: string | undefined;

    while (!terminationReason && cursor.round <= maxRounds) {
      this.assertCurrent(run, executionEpoch);
      if (!cursor.roundStarted) {
        this.emit(run, {
          type: "round.started",
          payload: { iteration: cursor.round, mode: "discussion", participants: nonChair.map((p) => p.nodeId) },
        });
        cursor.roundStarted = true;
        this.persist(run);
      }

      if (cursor.phase === "participants") {
        const missing = nonChair.filter((p) => !cursor.outputs[p.nodeId]);
        const maxParallel = Math.max(1, run.policy.maxParallel ?? (missing.length || 1));
        for (let i = 0; i < missing.length; i += maxParallel) {
          const batch = missing.slice(i, i + maxParallel);
          const results = await Promise.allSettled(batch.map(async (participant) => {
            try {
              const prompt = cursor.round === 1
                ? `This is a multi-agent discussion. Topic: ${plan.topic}\n\nThis is round ${cursor.round}. State your position briefly. Stay strictly in character.`
                : `This is round ${cursor.round} of the discussion. Advance the discussion with NEW points. Do not repeat earlier turns. Stay strictly in character.`;
              const result = await this.executeNode(
                run, participant.nodeId, participant.agent, participant.model, participant.role ?? "participant", prompt,
                participant.agentConfig, participant.systemPrompt, participant.nodeId,
                { project: participant.project, worktreeId: participant.worktreeId, branch: participant.branch }, executionEpoch,
              );
              this.assertCurrent(run, executionEpoch);
              cursor.outputs[participant.nodeId] = { role: participant.role, text: result.text ?? "" };
            } catch (err) {
              if (run.policy.onNodeFailure !== "continue") throw err;
              this.assertCurrent(run, executionEpoch);
              cursor.outputs[participant.nodeId] = { role: participant.role, text: `[participant failed: ${String(err)}]` };
            }
            const output = cursor.outputs[participant.nodeId]!;
            cursor.transcript.push({ round: cursor.round, nodeId: participant.nodeId, role: output.role, text: output.text });
            // Participant-level checkpoint: a crash while another speaker in
            // this batch is still running never repeats an already committed speech.
            this.persist(run);
          }));
          this.assertCurrent(run, executionEpoch);
          const failed = results.find((result) => result.status === "rejected");
          if (failed?.status === "rejected") throw failed.reason;
        }
        if (nonChair.some((p) => !cursor.outputs[p.nodeId])) throw new Error("discussion participant barrier incomplete");
        cursor.phase = "chairman";
        this.persist(run);
      }

      const consensusHit = !!consensusSignal && nonChair.some((p) => cursor.outputs[p.nodeId]?.text.includes(consensusSignal));
      if (consensusHit) {
        terminationReason = `consensus signal "${consensusSignal}" detected`;
        this.emit(run, { type: "round.completed", payload: { iteration: cursor.round, speakers: nonChair.length } });
        break;
      }

      if (cursor.phase === "chairman") {
        const priorChair = cursor.outputs[chairman.nodeId];
        let chairmanText = priorChair?.text;
        if (chairmanText === undefined) {
          const chairmanPrompt = [
            `Round ${cursor.round} of the discussion just finished.`, "", "This round's contributions:",
            ...nonChair.map((p) => `[${p.nodeId} as ${p.role ?? "participant"}]\n${cursor.outputs[p.nodeId]!.text}`),
            "", "As the chairman, decide whether the discussion has reached a useful conclusion.",
            `If yes, write your final summary AND include the literal token "${chairmanSignal}" somewhere in your reply.`,
            "If no, summarize this round briefly and indicate what should be explored next.",
          ].join("\n");
          const result = await this.executeNode(
            run, chairman.nodeId, chairman.agent, chairman.model, chairman.role ?? "chairman", chairmanPrompt,
            chairman.agentConfig, chairman.systemPrompt, chairman.nodeId,
            { project: chairman.project, worktreeId: chairman.worktreeId, branch: chairman.branch }, executionEpoch,
          );
          this.assertCurrent(run, executionEpoch);
          chairmanText = result.text ?? "";
          cursor.outputs[chairman.nodeId] = { role: chairman.role ?? "chairman", text: chairmanText };
          cursor.transcript.push({ round: cursor.round, nodeId: chairman.nodeId, role: chairman.role ?? "chairman", text: chairmanText });
          this.persist(run);
        }
        this.emit(run, { type: "round.completed", payload: { iteration: cursor.round, speakers: nonChair.length + 1 } });
        if (chairmanText.includes(chairmanSignal)) terminationReason = `chairman signal "${chairmanSignal}"`;
        else if (cursor.round >= maxRounds) terminationReason = `maxRounds (${maxRounds}) reached`;
        else {
          cursor.round++;
          cursor.phase = "participants";
          cursor.outputs = {};
          cursor.roundStarted = false;
          this.persist(run);
        }
      }
    }

    if (!terminationReason) terminationReason = `maxRounds (${maxRounds}) reached`;
    this.emit(run, { type: "discussion.terminated", payload: { rounds: Math.min(cursor.round, maxRounds), reason: terminationReason } });
    const lastChairman = [...cursor.transcript].reverse().find((t) => t.nodeId === chairman.nodeId);
    run.finalText = lastChairman?.text ?? cursor.transcript.at(-1)?.text;
    await this.cleanupPersistent(run);
    const wtKept = await this.cleanupAutoWorktrees(run);
    if (wtKept.kept.length > 0) this.emit(run, { type: "workflow.status", status: run.status, payload: { worktreesKept: wtKept.kept } });
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
    executionEpoch = run.checkpoint.controlEpoch,
  ): Promise<WorkflowNodeResult> {
    this.assertCurrent(run, executionEpoch);
    const node = run.nodes.find((n) => n.nodeId === nodeId) ?? this.addNode(run, { nodeId, agent, model, role });
    node.status = "running";
    node.startedAt = node.startedAt ?? new Date().toISOString();
    // A persistent node may reuse its session for a new turn. Clear the prior
    // turn id before send because adapters can emit synchronously before
    // SessionEngine.send returns the new id; onStreamEvent must accept those
    // early frames into turnResultCache.
    node.turnId = undefined;
    node.iterations = (node.iterations ?? 0) + 1;
    const attempt: NonNullable<WorkflowNodeState["attempts"]>[number] = {
      attempt: (node.attempts?.at(-1)?.attempt ?? 0) + 1,
      iteration: node.iterations,
      status: "running",
      startedAt: new Date().toISOString(),
    };
    (node.attempts ??= []).push(attempt);
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
      this.assertCurrent(run, executionEpoch);

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
      attempt.sessionId = sessionId;
      this.persist(run);
      this.assertCurrent(run, executionEpoch);

      const sent = await this.opts.engine.send(run.tenantId, sessionId, input, {
        environment: this.opts.env.resolveForExecution({ projectId: effectiveProject, agent }),
      });
      node.turnId = sent.turnId;
      attempt.turnId = sent.turnId;
      this.persist(run);

      const result = await this.awaitTurnResult(run, sessionId, sent.turnId);
      this.assertCurrent(run, executionEpoch);
      node.result = result;
      node.status = result.status === "completed" ? "completed" : "failed";
      node.completedAt = new Date().toISOString();
      run.updatedAt = node.completedAt;
      if (node.status === "failed") node.error = result.text || `turn ended with status ${result.status}`;
      attempt.status = result.status === "completed" ? "completed" : result.status === "timeout" ? "timeout" : "failed";
      attempt.completedAt = node.completedAt;
      if (node.error) attempt.error = node.error;
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
      if (err instanceof StaleExecutionError || run.checkpoint.controlEpoch !== executionEpoch || run.status !== "running") throw new StaleExecutionError();
      node.status = "failed";
      node.completedAt = new Date().toISOString();
      node.error = (err as Error)?.message ?? String(err);
      attempt.status = "failed";
      attempt.completedAt = node.completedAt;
      attempt.error = node.error;
      run.updatedAt = node.completedAt;
      this.persist(run);
      this.emit(run, { type: "node.status", nodeId, agent, model, role, status: "failed", payload: { error: node.error } });
      throw err;
    }
  }

  /** 清理某 workflow 的所有 persistent session（底层 best-effort）。 */
  private async cleanupPersistent(run: WorkflowRunState, terminate = true): Promise<void> {
    const prefix = `${run.workflowId}::`;
    const toRemove: string[] = [];
    const terminations: Promise<unknown>[] = [];
    for (const [k, sid] of this.persistentSessions.entries()) {
      if (!k.startsWith(prefix)) continue;
      toRemove.push(k);
      if (terminate) terminations.push(this.opts.engine.terminate(run.tenantId, sid).catch(() => {}));
    }
    for (const k of toRemove) this.persistentSessions.delete(k);
    await settleWithin(terminations);
  }

  private resolveNodeWaiter(node: WorkflowNodeState, status: WorkflowNodeResult["status"]): void {
    if (!node.sessionId || !node.turnId) return;
    const key = `${node.sessionId}::${node.turnId}`;
    const resolve = this.turnWaiters.get(key);
    if (resolve) resolve({ status, text: "" });
    this.pendingResultText.delete(key);
    this.turnResultCache.delete(key);
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
    requestId: string,
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
    const interactionParams = InteractionRequestParamsSchema.parse({
      // Deterministic across checkpoint recovery: a server can de-duplicate a
      // replayed review instead of showing a second form after device restart.
      requestId,
      blocking: true,
      timeoutSeconds: directive.timeoutSeconds,
      at: new Date().toISOString(),
      form: {
        title: directive.title,
        description: [
          directive.summary,
          `Workflow: ${run.workflowId}`,
          directive.reason ? `Reason: ${directive.reason}` : undefined,
          directive.artifacts?.length ? `Artifacts: ${directive.artifacts.map((a) => `${a.role}=${a.path}`).join(", ")}` : undefined,
        ].filter(Boolean).join("\n\n"),
        fields: [
          { key: "approved", label: "Approve?", type: "boolean", required: true },
          { key: "feedback", label: "Feedback", type: "text", required: false },
          { key: "reviewer", label: "Reviewer", type: "text", required: false },
        ],
        submitLabel: "Submit review",
      },
    });
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
      // Persist the resource identity before any node turn starts. This closes
      // the common crash window that otherwise creates a second worktree on
      // recovery (or leaves the first one orphaned).
      this.persist(run);
      const cwd = this.opts.resolveCwd(projectId, wt.worktreeId);
      return { projectId, worktreeId: wt.worktreeId, cwd };
    }

    // ---- 情况 2: 不要 worktree 但要切 branch ----
    if (branch !== undefined) {
      assertRefName(branch, "branch");
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
          this.persist(run);
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
      if (!this.opts.projects) {
        kept.push({ worktreeId: entry.worktreeId, userKey: entry.userKey, reason: "project manager unavailable" });
        continue;
      }
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
        toClear.push(k);
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
    if (this.disposed && !this.finalizing.has(run.workflowId)) return;
    if (!this.persistDisposedRun(run)) {
      run.checkpoint.controlEpoch++;
      throw new StaleExecutionError();
    }
  }

  /** Store helper used by dispose after the public runtime has been fenced. */
  private persistDisposedRun(run: WorkflowRunState): boolean {
    if (!this.opts.store) return true;
    return this.opts.store.upsertWorkflow(this.storeRecord(run));
  }

  private storeRecord(run: WorkflowRunState): Parameters<PhononStore["upsertWorkflow"]>[0] {
    this.captureCheckpointResources(run);
    return {
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
      checkpointJson: JSON.stringify(run.checkpoint),
      ownerId: this.ownerId,
      ownerEpoch: run.ownerEpoch,
      leaseUntil: Date.now() + this.leaseMs,
      metadataJson: run.metadata ? JSON.stringify(run.metadata) : undefined,
    };
  }

  private captureCheckpointResources(run: WorkflowRunState): void {
    const prefix = `${run.workflowId}::`;
    run.checkpoint.persistentSessions = Object.fromEntries([...this.persistentSessions].filter(([key]) => key.startsWith(prefix)));
    run.checkpoint.autoWorktrees = Object.fromEntries([...this.autoWorktrees].filter(([key]) => key.startsWith(prefix)));
    run.checkpoint.mainBranchCheckedOut = Object.fromEntries([...this.mainBranchCheckedOut].filter(([key]) => key.startsWith(prefix)));
  }

  private hydrateCheckpoint(run: WorkflowRunState): void {
    for (const [key, value] of Object.entries(run.checkpoint.persistentSessions ?? {})) this.persistentSessions.set(key, value);
    for (const [key, value] of Object.entries(run.checkpoint.autoWorktrees ?? {})) this.autoWorktrees.set(key, value);
    for (const [key, value] of Object.entries(run.checkpoint.mainBranchCheckedOut ?? {})) this.mainBranchCheckedOut.set(key, value);
    for (const node of run.nodes) {
      if (node.status === "running" || node.status === "ready" || node.status === "paused") node.status = "pending";
    }
  }

  private restoreFromCheckpoint(rf: WorkflowResumeFrom): WorkflowRunState | undefined {
    if (!this.opts.store) return undefined;
    if (this.finalizing.has(rf.workflowId)) {
      throw new PhononError("errInvalidParams", `workflow ${rf.workflowId} finalization is still in progress`);
    }
    const row = this.opts.store.getWorkflow(rf.workflowId, this.opts.tenantId);
    if (!row) return undefined;
    const priorStatus = row.status as string;
    if (["queued", "running"].includes(priorStatus)) {
      throw new PhononError("errInvalidParams", `workflow ${rf.workflowId} is already active`);
    }
    if (!["paused", "failed", "timeout", "cancelled"].includes(priorStatus)) {
      throw new PhononError("errInvalidParams", `workflow ${rf.workflowId} is not resumable from ${priorStatus}`);
    }
    const knownNodeIds = new Set((JSON.parse(row.nodes_json as string) as WorkflowNodeState[]).map((node) => node.nodeId));
    for (const nodeId of rf.rerunNodes ?? []) {
      if (!knownNodeIds.has(nodeId)) throw new PhononError("errInvalidParams", `resume node ${nodeId} does not exist`);
    }
    if (rf.strategy.startsWith("node:") && !knownNodeIds.has(rf.strategy.slice(5))) {
      throw new PhononError("errInvalidParams", `resume node ${rf.strategy.slice(5)} does not exist`);
    }
    const ownerEpoch = this.opts.store.claimWorkflow(rf.workflowId, this.opts.tenantId, this.ownerId, this.leaseMs);
    if (ownerEpoch === undefined) throw new PhononError("errInvalidParams", `workflow ${rf.workflowId} is owned by another executor`);
    const run = this.restoreRow(row, ownerEpoch, false);
    if (run.policy.timeoutSeconds && (priorStatus !== "paused" || rf.strategy !== "continue")) {
      run.checkpoint.deadlineAt = Date.now() + run.policy.timeoutSeconds * 1000;
    }

    const rerun = new Set<string>(rf.rerunNodes ?? []);
    if (rf.strategy === "continue") {
      for (const node of run.nodes) if (["paused", "running", "ready", "cancelled"].includes(node.status)) rerun.add(node.nodeId);
    } else if (rf.strategy === "failed_node") {
      for (const node of run.nodes) if (["failed", "cancelled", "running", "paused"].includes(node.status)) rerun.add(node.nodeId);
    } else if (rf.strategy === "last_success_dependents") {
      for (const node of run.nodes) if (node.status !== "completed") rerun.add(node.nodeId);
    } else if (rf.strategy.startsWith("node:")) {
      rerun.add(rf.strategy.slice(5));
      for (const node of run.nodes) if (node.status !== "completed") rerun.add(node.nodeId);
    }
    for (const node of run.nodes) {
      if (!rerun.has(node.nodeId)) continue;
      node.status = "pending";
      delete node.result; delete node.error; delete node.startedAt; delete node.completedAt;
      delete node.sessionId; delete node.turnId;
    }
    // Explicit rollback strategies intentionally restart the mode cursor. A
    // paused/automatic `continue` keeps the exact graph/discussion barrier.
    if (rf.strategy !== "continue") {
      delete run.checkpoint.graph;
      delete run.checkpoint.discussion;
    }
    run.status = "queued";
    run.error = undefined;
    run.completedAt = undefined;
    run.updatedAt = new Date().toISOString();
    run.checkpoint.controlEpoch++;
    this.hydrateCheckpoint(run);
    this.runs.set(rf.workflowId, run);
    this.persist(run);
    this.emit(run, { type: "workflow.status", status: "queued", payload: { resumed: true, strategy: rf.strategy } });
    return run;
  }

  private restoreRow(row: Record<string, unknown>, ownerEpoch: number, automatic: boolean): WorkflowRunState {
    const checkpoint = row.checkpoint_json
      ? JSON.parse(row.checkpoint_json as string) as WorkflowCheckpoint
      : { controlEpoch: 0, persistentSessions: {}, autoWorktrees: {}, mainBranchCheckedOut: {} };
    checkpoint.controlEpoch = Number(checkpoint.controlEpoch ?? 0) + (automatic ? 1 : 0);
    checkpoint.persistentSessions ??= {};
    checkpoint.autoWorktrees ??= {};
    checkpoint.mainBranchCheckedOut ??= {};
    const run: WorkflowRunState = {
      workflowId: row.workflow_id as string,
      tenantId: row.tenant_id as string,
      project: (row.project_id as string | null) ?? undefined,
      worktreeId: (row.worktree_id as string | null) ?? undefined,
      mode: row.mode as WorkflowRunState["mode"],
      plan: JSON.parse(row.plan_json as string) as WorkflowPlan,
      input: (row.input as string | null) ?? undefined,
      policy: JSON.parse((row.policy_json as string) || '{"onNodeFailure":"fail_workflow"}'),
      sharedContext: row.shared_json ? JSON.parse(row.shared_json as string) : undefined,
      metadata: row.metadata_json ? JSON.parse(row.metadata_json as string) : undefined,
      status: automatic ? "queued" : row.status as WorkflowRunState["status"],
      nodes: JSON.parse(row.nodes_json as string) as WorkflowNodeState[],
      createdAt: row.created_at as string,
      updatedAt: new Date().toISOString(),
      completedAt: automatic ? undefined : (row.completed_at as string | null) ?? undefined,
      error: automatic ? undefined : (row.error as string | null) ?? undefined,
      seq: Number(row.seq ?? 0),
      ackedSeq: Number(row.acked_seq ?? -1),
      finalText: (row.final_text as string | null) ?? undefined,
      checkpoint,
      ownerEpoch,
    };
    return run;
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private assertCurrent(run: WorkflowRunState, executionEpoch: number): void {
    const ownsLease = !this.opts.store || this.opts.store.renewWorkflowLease(
      run.workflowId, run.tenantId, this.ownerId, run.ownerEpoch, this.leaseMs,
    );
    if (this.disposed || !ownsLease || run.checkpoint.controlEpoch !== executionEpoch || run.status !== "running") {
      if (!ownsLease) run.checkpoint.controlEpoch++;
      throw new StaleExecutionError();
    }
  }

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
    if (err instanceof StaleExecutionError || this.disposed || run.status === "paused" || run.status === "cancelled" || run.status === "timeout") return;
    run.status = "failed";
    run.error = (err as Error)?.message ?? String(err);
    run.completedAt = new Date().toISOString();
    run.updatedAt = run.completedAt;
    this.persist(run);
    this.emit(run, { type: "workflow.status", status: "failed", payload: { error: run.error } });
    this.opts.store?.releaseWorkflow(run.workflowId, run.tenantId, this.ownerId, run.ownerEpoch);
    // Failed workflows are explicitly resumable. Keep their durable session and
    // worktree mappings intact; asynchronous cleanup after releasing ownership
    // can otherwise race an immediate workflow.resume and delete its resources.
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
      resumable: !!this.opts.store && ["paused", "failed", "timeout", "cancelled"].includes(run.status),
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
      resumable: ["paused", "failed", "timeout", "cancelled"].includes(row.status as string),
    } as WorkflowStatusResult;
  }

  private emit(run: WorkflowRunState, partial: Record<string, unknown>): void {
    if (this.disposed) return;
    if (this.opts.store && !this.opts.store.isWorkflowOwner(run.workflowId, run.tenantId, this.ownerId, run.ownerEpoch)) {
      run.checkpoint.controlEpoch++;
      return;
    }
    const ev = {
      workflowId: run.workflowId,
      seq: run.seq++,
      timestamp: new Date().toISOString(),
      ...(run.metadata ? { metadata: run.metadata } : {}),
      ...partial,
    } as unknown as WorkflowEvent;
    if (this.opts.store) {
      const persisted = this.opts.store.appendWorkflowEvent(this.storeRecord(run), {
        seq: ev.seq,
        payload: JSON.stringify(ev),
        createdAt: ev.timestamp,
      });
      if (!persisted) {
        run.checkpoint.controlEpoch++;
        return;
      }
    } else {
      const list = this.workflowEvents.get(run.workflowId) ?? [];
      list.push(ev);
      this.workflowEvents.set(run.workflowId, list);
    }
    try {
      this.opts.emit(ev);
    } catch {
      // Event/checkpoint are already durable; reconnect replay handles delivery.
    }
  }
}
