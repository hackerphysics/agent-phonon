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
  project: string;
  worktreeId?: string;
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
const ROUTE_BLOCK_RE = /```(?:phonon\.)?workflow\.(route|feedback|reply|done)\s*\n([\s\S]+?)\n```/gi;

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
  private pendingResultText = new Map<string, string>();
  private turnResultCache = new Map<string, WorkflowNodeResult>();
  private turnWaiters = new Map<string, (r: WorkflowNodeResult) => void>();
  private idSeq = 1;

  constructor(private opts: {
    tenantId: string;
    engine: SessionEngine;
    resolveCwd: (projectId: string, worktreeId?: string) => string;
    env: EnvManager;
    /** 可选：sqlite store。提供则 checkpoint 落盘 + 支持 resumeFrom。 */
    store?: PhononStore;
    emit: (event: WorkflowEvent) => void;
  }) {}

  // ---------------------------------------------------------------------------
  // RPC entry
  // ---------------------------------------------------------------------------

  async run(params: {
    project: string;
    worktreeId?: string;
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
    this.persist(run);
    this.emit(run, { type: "workflow.status", status: "cancelled", payload: { reason } });
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
      const usage = evAny.usage as WorkflowNodeResult["usage"];
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
      this.persist(run);
      this.emit(run, { type: "workflow.status", status: "completed", payload: { finalText: run.finalText } });
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
          this.executeNode(run, n.nodeId, n.agent, n.model, n.role, this.composeDagNodeInput(run, n, succeeded), n.agentConfig, n.systemPrompt)
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

    // 启动 executor
    const executorResult = await this.executeNode(
      run,
      plan.executor.nodeId,
      plan.executor.agent,
      plan.executor.model,
      "executor",
      executorPrompt,
      plan.executor.agentConfig,
      plan.executor.systemPrompt,
    );

    let currentDirectives = parseRoutingDirectives(executorResult.text ?? "");
    let lastExecutorText = executorResult.text ?? "";
    let terminated = currentDirectives.some((d) => d.kind === "workflow.done");
    let finalSummary: string | undefined;
    for (const d of currentDirectives) {
      if (d.kind === "workflow.done") finalSummary = d.finalSummary;
    }

    let iteration = 0;
    while (currentDirectives.length > 0 && !terminated && iteration < maxIterations) {
      if ((["cancelled", "failed", "timeout"] as string[]).includes(run.status)) return;
      iteration++;
      this.emit(run, { type: "round.started", payload: { iteration, mode: "graph" } });

      const workerResults: { nodeId: string; text: string }[] = [];
      for (const directive of currentDirectives) {
        if (directive.kind === "workflow.done") {
          terminated = true;
          finalSummary = directive.finalSummary;
          break;
        }
        // route / feedback / reply 都需要 target 在 allowedEdges 内
        const targets = "to" in directive
          ? (Array.isArray(directive.to) ? directive.to : [directive.to])
          : [];
        const validTargets = targets.filter((t) => allowedEdges.has(`${plan.executor.nodeId}->${t}`));
        if (validTargets.length === 0) continue;

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
            `${worker.nodeId}#it${iteration}`,
            worker.agent,
            worker.model,
            worker.role ?? "worker",
            workerInput,
            worker.agentConfig,
            worker.systemPrompt,
          );
          workerResults.push({ nodeId: target, text: workerRes.text ?? "" });
        }
      }
      if (terminated) break;
      if (workerResults.length === 0) {
        this.emit(run, { type: "round.completed", payload: { iteration, workerCount: 0 } });
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
        `${plan.executor.nodeId}#it${iteration}`,
        plan.executor.agent,
        plan.executor.model,
        "executor",
        followupPrompt,
        plan.executor.agentConfig,
        plan.executor.systemPrompt,
      );
      lastExecutorText = nextRes.text ?? lastExecutorText;
      currentDirectives = parseRoutingDirectives(lastExecutorText);
      for (const d of currentDirectives) {
        if (d.kind === "workflow.done") {
          terminated = true;
          finalSummary = d.finalSummary;
        }
      }
    }
    run.finalText = finalSummary ?? lastExecutorText;
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

      // 阶段 A：非主席并行发言
      const prompt = round === 1
        ? `Topic: ${plan.topic}\n\nThis is round ${round}. Share your view.`
        : `Topic: ${plan.topic}\n\nThis is round ${round}. Below are previous turns:\n\n${transcript.slice(-20).map((t) => `[round ${t.round}, ${t.nodeId} as ${t.role ?? "participant"}]\n${t.text}`).join("\n\n")}\n\nContinue the discussion.`;

      const speakResults = await Promise.allSettled(
        nonChair.map((p) =>
          this.executeNode(run, `${p.nodeId}#r${round}`, p.agent, p.model, p.role ?? "participant", prompt, p.agentConfig, p.systemPrompt)
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

      // 阶段 B：主席审视本轮
      const chairmanPrompt = [
        `Topic: ${plan.topic}`,
        `You are the chairman. Round ${round} just finished.`,
        "",
        "This round's contributions:",
        ...speakResults.map((sr, i) => {
          if (sr.status === "fulfilled") return `[${nonChair[i]!.nodeId} as ${nonChair[i]!.role ?? "participant"}]\n${sr.value.text}`;
          return `[${nonChair[i]!.nodeId}] (failed: ${String(sr.reason)})`;
        }),
        "",
        `If discussion should end, include the literal token "${chairmanSignal}" in your reply.`,
        "Otherwise, summarize this round and indicate what should be explored next.",
      ].join("\n\n");

      const chairmanRes = await this.executeNode(
        run, `${chairman.nodeId}#r${round}`, chairman.agent, chairman.model, chairman.role ?? "chairman",
        chairmanPrompt, chairman.agentConfig, chairman.systemPrompt,
      );
      transcript.push({ round, nodeId: chairman.nodeId, role: chairman.role ?? "chairman", text: chairmanRes.text ?? "" });

      if ((chairmanRes.text ?? "").includes(chairmanSignal)) {
        terminationReason = `chairman signal "${chairmanSignal}"`;
        break;
      }
    }
    if (!terminationReason && round >= maxRounds) terminationReason = `maxRounds (${maxRounds}) reached`;

    this.emit(run, { type: "discussion.terminated", payload: { rounds: round, reason: terminationReason ?? "unknown" } });

    // finalText = 最后一轮 chairman 输出，没有则最后一轮最后一个 participant
    const lastChairman = [...transcript].reverse().find((t) => t.nodeId === chairman.nodeId);
    run.finalText = lastChairman?.text ?? (transcript.length ? transcript[transcript.length - 1]!.text : undefined);
  }

  // ---------------------------------------------------------------------------
  // Single node execution
  // ---------------------------------------------------------------------------

  private async executeNode(
    run: WorkflowRunState,
    nodeId: string,
    agent: string,
    model: string,
    role: string | undefined,
    input: string,
    agentConfig?: Record<string, unknown>,
    nodeSystemPrompt?: string,
  ): Promise<WorkflowNodeResult> {
    const node = run.nodes.find((n) => n.nodeId === nodeId) ?? this.addNode(run, { nodeId, agent, model, role });
    node.status = "running";
    node.startedAt = new Date().toISOString();
    run.updatedAt = node.startedAt;
    this.emit(run, { type: "node.status", nodeId, agent, model, role, status: "running" });

    try {
      const cwd = this.opts.resolveCwd(run.project, run.worktreeId);
      const systemPrompt = this.buildSystemPrompt(run, nodeSystemPrompt, cwd);
      // initialContext 走 ContextItem[]，把 systemPrompt 当作 system role 项注入
      const initialContext = systemPrompt ? [{ role: "system" as const, content: systemPrompt }] : undefined;

      const created = await this.opts.engine.create({
        tenantId: run.tenantId,
        project: run.project,
        worktreeId: run.worktreeId,
        cwd,
        agent,
        model,
        verbosity: "messages",
        agentConfig,
        initialContext,
        workflowAttr: { workflowId: run.workflowId, nodeId, role },
      });
      node.sessionId = created.sessionId;
      this.sessionToNode.set(created.sessionId, { workflowId: run.workflowId, nodeId });

      const sent = await this.opts.engine.send(run.tenantId, created.sessionId, input, {
        environment: this.opts.env.resolveForExecution({ projectId: run.project, agent }),
      });
      node.turnId = sent.turnId;

      const result = await this.awaitTurnResult(run, created.sessionId, sent.turnId);
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

      try { await this.opts.engine.terminate(run.tenantId, created.sessionId); } catch {}
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

  private buildSystemPrompt(run: WorkflowRunState, nodeSystemPrompt: string | undefined, cwd: string): string | undefined {
    const sc = run.sharedContext;
    if (!sc) return nodeSystemPrompt;
    const segments: string[] = [];
    if (sc.text) segments.push(`# Shared Workflow Context\n\n${sc.text}`);
    for (const rel of sc.files ?? []) {
      try {
        const abs = path.resolve(cwd, rel);
        const real = fs.realpathSync(abs);
        // sandbox check：确保 real 路径在 cwd 下
        const cwdReal = fs.realpathSync(cwd);
        if (!real.startsWith(cwdReal + path.sep) && real !== cwdReal) continue;
        const content = fs.readFileSync(real, "utf8");
        segments.push(`# Shared File: ${rel}\n\n\`\`\`\n${content}\n\`\`\``);
      } catch {
        // 文件不存在/无法读 → 跳过
      }
    }
    if (segments.length === 0) return nodeSystemPrompt;
    const shared = segments.join("\n\n");
    if (!nodeSystemPrompt) return shared;
    return sc.placement === "prepend" ? `${shared}\n\n${nodeSystemPrompt}` : `${nodeSystemPrompt}\n\n${shared}`;
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
      project: row.project_id as string,
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
      project: row.project_id as string,
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
    const ev = { workflowId: run.workflowId, seq: run.seq++, timestamp: new Date().toISOString(), ...partial };
    this.persist(run);
    this.opts.emit(ev as unknown as WorkflowEvent);
  }
}
