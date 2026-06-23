import type { SessionEngine } from "./session-engine.js";
import { PhononError } from "./rpc.js";
import type { EnvManager } from "./env-manager.js";
import type {
  WorkflowEvent,
  WorkflowPlan,
  WorkflowStatusResult,
  WorkflowRunResult,
  WorkflowPolicy,
  WorkflowNodeResult,
  WorkflowRoutingDirective,
  StreamEvent,
} from "@agent-phonon/protocol";

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
}

interface WorkflowRunState {
  workflowId: string;
  tenantId: string;
  project: string;
  worktreeId?: string;
  mode: "dag" | "graph";
  plan: WorkflowPlan;
  input?: string;
  policy: Required<Pick<WorkflowPolicy, "onNodeFailure">> & WorkflowPolicy;
  status: "queued" | "running" | "completed" | "failed" | "cancelled" | "timeout";
  nodes: WorkflowNodeState[];
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  error?: string;
  /** workflow.event 维度的单调 seq（与 stream.event seq 各自独立）。 */
  seq: number;
  /** server 已 ack 的最大 workflow.event seq（P0-3）。 */
  ackedSeq: number;
  /** finalText 缓存（DAG: finalNodeId 命中节点 / Graph: executor）。 */
  finalText?: string;
}

/** Routing directive 解析器：在 executor 输出里找 fenced block `phonon.workflow.route`。 */
const ROUTE_BLOCK_RE = /```(?:phonon\.workflow\.route|workflow\.route)\s*\n([\s\S]+?)\n```/gi;
function parseRoutingDirectives(text: string): WorkflowRoutingDirective[] {
  const out: WorkflowRoutingDirective[] = [];
  let m: RegExpExecArray | null;
  ROUTE_BLOCK_RE.lastIndex = 0;
  while ((m = ROUTE_BLOCK_RE.exec(text)) !== null) {
    try {
      const obj = JSON.parse(m[1]!) as Partial<WorkflowRoutingDirective>;
      if (obj && (obj.kind === "workflow.route" || obj.kind === undefined) && obj.to && typeof obj.message === "string") {
        out.push({
          kind: "workflow.route",
          to: obj.to,
          message: obj.message,
          reason: obj.reason,
          terminate: obj.terminate ?? false,
          metadata: obj.metadata,
        });
      }
    } catch {
      // 忽略解析失败的块，下一块继续
    }
  }
  return out;
}

export class WorkflowEngine {
  private runs = new Map<string, WorkflowRunState>();
  private sessionToNode = new Map<string, { workflowId: string; nodeId: string }>();
  /** 暂存每个 session 当前 turn 的最终文本（用于回填 node.result.text）。 */
  private pendingResultText = new Map<string, string>();
  /** turn 终态结果缓存：result/error event 在 awaitTurnResult set waiter 之前到达时先落这里。 */
  private turnResultCache = new Map<string, WorkflowNodeResult>();
  /** turn 终态等待器：sessionId+turnId -> resolver。 */
  private turnWaiters = new Map<string, (r: WorkflowNodeResult) => void>();
  private idSeq = 1;

  constructor(private opts: {
    tenantId: string;
    engine: SessionEngine;
    resolveCwd: (projectId: string, worktreeId?: string) => string;
    env: EnvManager;
    emit: (event: WorkflowEvent) => void;
  }) {}

  // -------------------------------------------------------------------------
  // RPC entry
  // -------------------------------------------------------------------------

  async run(params: {
    project: string;
    worktreeId?: string;
    plan: WorkflowPlan;
    input?: string;
    policy?: WorkflowPolicy;
    metadata?: Record<string, unknown>;
  }): Promise<WorkflowRunResult> {
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
      status: "queued",
      nodes,
      createdAt: now,
      updatedAt: now,
      seq: 0,
      ackedSeq: -1,
    };
    this.runs.set(workflowId, run);
    this.emit(run, { type: "workflow.status", status: "queued" });
    void this.executeWithTimeout(run).catch((err) => this.fail(run, err));
    return { workflowId, status: run.status, createdAt: run.createdAt };
  }

  status(workflowId: string): WorkflowStatusResult {
    return this.toStatus(this.get(workflowId));
  }

  list(filter?: { status?: string; projectId?: string; since?: string; until?: string; limit?: number }): { workflows: WorkflowStatusResult[] } {
    const limit = filter?.limit ?? 50;
    const rows = [...this.runs.values()]
      .filter((r) => (!filter?.status || r.status === filter.status)
        && (!filter?.projectId || r.project === filter.projectId)
        && (!filter?.since || r.createdAt >= filter.since)
        && (!filter?.until || r.createdAt < filter.until))
      .slice(-limit)
      .reverse();
    return { workflows: rows.map((r) => this.toStatus(r)) };
  }

  async cancel(workflowId: string, reason?: string): Promise<{ workflowId: string; status: "cancelled" }> {
    const run = this.get(workflowId);
    if (run.status === "completed" || run.status === "failed" || run.status === "timeout") {
      // already terminal; idempotent cancel
      return { workflowId, status: "cancelled" };
    }
    run.status = "cancelled";
    run.completedAt = new Date().toISOString();
    run.updatedAt = run.completedAt;
    for (const n of run.nodes) {
      if (n.sessionId && (n.status === "running" || n.status === "ready" || n.status === "pending")) {
        n.status = "cancelled";
        try { await this.opts.engine.terminate(this.opts.tenantId, n.sessionId); } catch { /* best-effort */ }
      }
    }
    this.emit(run, { type: "workflow.status", status: "cancelled", payload: { reason } });
    return { workflowId, status: "cancelled" };
  }

  /** server → phonon ack workflow.event seq（P0-3）。 */
  ack(workflowId: string, lastSeq: number): void {
    const run = this.runs.get(workflowId);
    if (!run) return;
    if (lastSeq > run.ackedSeq) run.ackedSeq = lastSeq;
  }

  /**
   * SessionEngine sink → WorkflowEngine（统一在 PhononConnection 转发）。
   * 用于：(a) 提取 result.text 回填 node.result；(b) Graph 模式解析 RoutingDirective。
   */
  onStreamEvent(ev: StreamEvent): void {
    const sessionId = (ev as { sessionId?: string }).sessionId;
    if (!sessionId) return;
    const mapping = this.sessionToNode.get(sessionId);
    if (!mapping) return;

    const evAny = ev as Record<string, unknown>;
    const turnId = evAny.turnId as string | undefined;
    const key = `${sessionId}::${turnId ?? ""}`;

    if (evAny.type === "message" && typeof evAny.text === "string") {
      // 累积 assistant 文本（adapter 可能流式打字）
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
        // result 在 awaitTurnResult set waiter 之前就到了（adapter 同步 emit）：先缓存
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

  // -------------------------------------------------------------------------
  // Execution
  // -------------------------------------------------------------------------

  private async executeWithTimeout(run: WorkflowRunState): Promise<void> {
    const timeoutMs = run.policy.timeoutSeconds ? run.policy.timeoutSeconds * 1000 : undefined;
    const exec = this.execute(run);
    if (!timeoutMs) {
      await exec;
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<"timeout">((resolve) => { timer = setTimeout(() => resolve("timeout"), timeoutMs); });
    const winner = await Promise.race([exec.then(() => "done" as const), timeout]);
    if (timer) clearTimeout(timer);
    if (winner === "timeout") {
      run.status = "timeout";
      run.completedAt = new Date().toISOString();
      run.updatedAt = run.completedAt;
      run.error = `workflow exceeded timeout ${run.policy.timeoutSeconds}s`;
      this.emit(run, { type: "workflow.status", status: "timeout", payload: { error: run.error } });
      for (const n of run.nodes) {
        if (n.sessionId && (n.status === "running" || n.status === "ready" || n.status === "pending")) {
          n.status = "cancelled";
          try { await this.opts.engine.terminate(this.opts.tenantId, n.sessionId); } catch {}
        }
      }
    }
  }

  private async execute(run: WorkflowRunState): Promise<void> {
    run.status = "running";
    run.updatedAt = new Date().toISOString();
    this.emit(run, { type: "workflow.status", status: "running" });
    if (run.plan.mode === "dag") await this.executeDag(run);
    else await this.executeGraph(run);
    if (!(["cancelled", "failed", "timeout"] as string[]).includes(run.status)) {
      run.status = "completed";
      run.completedAt = new Date().toISOString();
      run.updatedAt = run.completedAt;
      this.fillFinalText(run);
      this.emit(run, { type: "workflow.status", status: "completed", payload: { finalText: run.finalText } });
    }
  }

  // ---- DAG ----------------------------------------------------------------

  private async executeDag(run: WorkflowRunState): Promise<void> {
    if (run.plan.mode !== "dag") return;
    const plan = run.plan;
    const allNodes = new Map(plan.nodes.map((n) => [n.nodeId, n] as const));
    const deps = new Map<string, Set<string>>();
    for (const n of plan.nodes) deps.set(n.nodeId, new Set(n.dependsOn ?? []));
    for (const e of plan.edges ?? []) deps.get(e.to)?.add(e.from);

    const settled = new Set<string>(); // done in any terminal way
    const succeeded = new Set<string>();
    const skipped = new Set<string>();

    while (settled.size < plan.nodes.length) {
      if ((["cancelled", "failed", "timeout"] as string[]).includes(run.status)) return;

      // 找已 ready 且未 settled 的 node
      const ready = plan.nodes.filter((n) => {
        if (settled.has(n.nodeId)) return false;
        const ds = deps.get(n.nodeId) ?? new Set();
        return [...ds].every((d) => settled.has(d));
      });
      if (ready.length === 0) {
        throw new PhononError("errInvalidParams", "workflow DAG has a cycle or missing dependency");
      }

      // skip_dependents: 上游 skipped/failed → 自己 skipped
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
          this.emit(run, { type: "node.status", nodeId: n.nodeId, agent: n.agent, model: n.model, role: n.role, status: "skipped" });
          settled.add(n.nodeId);
          skipped.add(n.nodeId);
        }
      }
      const runnable = ready.filter((n) => !toSkip.includes(n));
      if (runnable.length === 0 && toSkip.length > 0) continue;

      // 应用 maxParallel
      const batchSize = run.policy.maxParallel ?? runnable.length;
      const batches: typeof runnable[] = [];
      for (let i = 0; i < runnable.length; i += batchSize) batches.push(runnable.slice(i, i + batchSize));

      for (const batch of batches) {
        const results = await Promise.allSettled(batch.map((n) => this.executeDagNode(run, n, allNodes, succeeded)));
        for (let i = 0; i < batch.length; i++) {
          const n = batch[i]!;
          const r = results[i]!;
          settled.add(n.nodeId);
          if (r.status === "fulfilled") {
            succeeded.add(n.nodeId);
          } else {
            // 失败传播
            if (run.policy.onNodeFailure === "fail_workflow") {
              this.fail(run, r.reason);
              return;
            }
            // skip_dependents / continue：下一轮循环里处理
          }
        }
      }
    }
  }

  private async executeDagNode(
    run: WorkflowRunState,
    nodeDef: { nodeId: string; agent: string; model: string; role?: string; input?: string; agentConfig?: Record<string, unknown>; systemPrompt?: string },
    allNodes: Map<string, { nodeId: string; agent: string; model: string }>,
    succeeded: Set<string>,
  ): Promise<void> {
    void allNodes;
    // 拼接 input：节点自己的 input + 上游 succeeded 节点的 result.text
    const upstreamCtx = this.collectUpstreamContext(run, nodeDef.nodeId, succeeded);
    const finalInput = upstreamCtx
      ? `${nodeDef.input ?? run.input ?? ""}\n\n${upstreamCtx}`.trim()
      : (nodeDef.input ?? run.input ?? "");
    await this.executeNode(run, nodeDef.nodeId, nodeDef.agent, nodeDef.model, nodeDef.role, finalInput, nodeDef.agentConfig);
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
        lines.push(`[upstream node \"${dep}\" (role=${node.role ?? "n/a"}) result]\n${node.result.text}`);
      }
    }
    return lines.join("\n\n");
  }

  // ---- Graph (executor + workers) ----------------------------------------

  private async executeGraph(run: WorkflowRunState): Promise<void> {
    if (run.plan.mode !== "graph") return;
    const plan = run.plan;
    const allowedEdges = new Set<string>(
      (plan.communicationGraph.edges ?? []).map((e) => `${e.from}->${e.to}`),
    );
    const maxIterations = plan.communicationGraph.maxIterations ?? 12;

    const executorPrompt = [
      "You are the EXECUTOR of a multi-agent workflow.",
      `Input: ${run.input ?? ""}`,
      `Workers available: ${JSON.stringify(plan.workers.map((w) => ({ nodeId: w.nodeId, role: w.role, agent: w.agent, model: w.model })))}`,
      `Communication graph (allowed routes): ${JSON.stringify(plan.communicationGraph)}`,
      "",
      "To route a message to a worker, emit a fenced block:",
      "```phonon.workflow.route",
      '{"to":"<workerNodeId>","message":"...","reason":"...","terminate":false}',
      "```",
      'Set `terminate: true` in your final routing directive to end the workflow with your conclusion.',
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
    );

    // 解析首轮路由指令
    let currentDirectives = parseRoutingDirectives(executorResult.text ?? "");
    let lastExecutorText = executorResult.text ?? "";
    let terminate = currentDirectives.some((d) => d.terminate);

    let iteration = 0;
    while (currentDirectives.length > 0 && !terminate && iteration < maxIterations) {
      if ((["cancelled", "failed", "timeout"] as string[]).includes(run.status)) return;
      iteration++;

      // 检查每条 directive 的目标边是否被 communicationGraph 允许
      const validDirectives = currentDirectives.filter((d) => {
        const targets = Array.isArray(d.to) ? d.to : [d.to];
        return targets.every((t) => allowedEdges.has(`${plan.executor.nodeId}->${t}`));
      });

      // 执行每条 directive
      const workerResults: { nodeId: string; text: string }[] = [];
      for (const directive of validDirectives) {
        const targets = Array.isArray(directive.to) ? directive.to : [directive.to];
        for (const target of targets) {
          const worker = plan.workers.find((w) => w.nodeId === target);
          if (!worker) continue;
          this.emit(run, {
            type: "executor.decision",
            nodeId: plan.executor.nodeId,
            payload: { to: target, reason: directive.reason, iteration },
          });
          this.emit(run, {
            type: "edge.route",
            payload: { from: plan.executor.nodeId, to: target, iteration },
          });
          const workerRes = await this.executeNode(
            run,
            `${worker.nodeId}#it${iteration}`,
            worker.agent,
            worker.model,
            worker.role ?? "worker",
            directive.message,
            worker.agentConfig,
          );
          workerResults.push({ nodeId: target, text: workerRes.text ?? "" });
        }
      }

      if (workerResults.length === 0) break;

      // 把 worker 反馈喂回 executor，由 executor 决定下一步
      const followupPrompt = [
        "Worker results from previous iteration:",
        ...workerResults.map((w) => `[worker ${w.nodeId}]\n${w.text}`),
        "",
        "Either emit the next routing directive or finalize with `terminate: true`.",
      ].join("\n\n");
      const nextRes = await this.executeNode(
        run,
        `${plan.executor.nodeId}#it${iteration}`,
        plan.executor.agent,
        plan.executor.model,
        "executor",
        followupPrompt,
        plan.executor.agentConfig,
      );
      lastExecutorText = nextRes.text ?? lastExecutorText;
      currentDirectives = parseRoutingDirectives(lastExecutorText);
      terminate = currentDirectives.some((d) => d.terminate);
    }

    run.finalText = lastExecutorText;
  }

  // ---- Single node execution ---------------------------------------------

  private async executeNode(
    run: WorkflowRunState,
    nodeId: string,
    agent: string,
    model: string,
    role: string | undefined,
    input: string,
    agentConfig?: Record<string, unknown>,
  ): Promise<WorkflowNodeResult> {
    const node = run.nodes.find((n) => n.nodeId === nodeId) ?? this.addNode(run, { nodeId, agent, model, role });
    node.status = "running";
    node.startedAt = new Date().toISOString();
    run.updatedAt = node.startedAt;
    this.emit(run, { type: "node.status", nodeId, agent, model, role, status: "running" });
    try {
      const cwd = this.opts.resolveCwd(run.project, run.worktreeId);
      const created = await this.opts.engine.create({
        tenantId: run.tenantId,
        project: run.project,
        worktreeId: run.worktreeId,
        cwd,
        agent,
        model,
        verbosity: "messages",
        agentConfig,
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
      if (node.status === "failed") {
        node.error = result.text || `turn ended with status ${result.status}`;
      }
      this.emit(run, {
        type: "node.status",
        nodeId,
        sessionId: node.sessionId,
        turnId: node.turnId,
        agent,
        model,
        role,
        status: node.status,
        result,
      });

      // turn 完成后清掉 session（一次性 worker session）
      try { await this.opts.engine.terminate(run.tenantId, created.sessionId); } catch {}
      if (node.status === "failed") {
        // 向上抛，让 DAG 的 Promise.allSettled 拿到 rejected，从而 onNodeFailure 策略生效
        throw new Error(node.error ?? "node failed");
      }
      return result;
    } catch (err) {
      node.status = "failed";
      node.completedAt = new Date().toISOString();
      node.error = (err as Error)?.message ?? String(err);
      run.updatedAt = node.completedAt;
      this.emit(run, { type: "node.status", nodeId, agent, model, role, status: "failed", payload: { error: node.error } });
      throw err;
    }
  }

  private async awaitTurnResult(run: WorkflowRunState, sessionId: string, turnId: string): Promise<WorkflowNodeResult> {
    const key = `${sessionId}::${turnId}`;
    // result/error 可能在 set waiter 之前就到了（adapter 同步 emit）：先查缓存
    const cached = this.turnResultCache.get(key);
    if (cached) {
      this.turnResultCache.delete(key);
      return cached;
    }
    const perNodeTimeoutMs = run.policy.perNodeTimeoutSeconds ? run.policy.perNodeTimeoutSeconds * 1000 : undefined;
    return new Promise<WorkflowNodeResult>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (r: WorkflowNodeResult) => {
        if (timer) clearTimeout(timer);
        this.turnWaiters.delete(key);
        resolve(r);
      };
      this.turnWaiters.set(key, finish);
      if (perNodeTimeoutMs) {
        timer = setTimeout(() => finish({ status: "timeout", text: "" }), perNodeTimeoutMs);
      }
      // safety net：轮询 session.status 兜底（仅当终态事件都没到、会话已 idle/terminated）
      const poll = async () => {
        try {
          const s = await this.opts.engine.status(this.opts.tenantId, sessionId);
          if (s.status === "idle" || s.status === "terminated" || s.status === "paused") {
            if (this.turnWaiters.has(key)) finish({ status: "completed", text: this.pendingResultText.get(key) ?? "" });
          } else if (this.turnWaiters.has(key)) {
            setTimeout(poll, 200);
          }
        } catch { /* 等 stream 事件 */ }
      };
      setTimeout(poll, 500);
    });
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
  }

  private initialNodes(plan: WorkflowPlan): WorkflowNodeState[] {
    const list = plan.mode === "dag" ? plan.nodes : [plan.executor, ...plan.workers];
    return list.map((n) => ({ nodeId: n.nodeId, status: "pending", agent: n.agent, model: n.model, role: n.role }));
  }

  private addNode(run: WorkflowRunState, n: { nodeId: string; agent: string; model: string; role?: string }): WorkflowNodeState {
    const node: WorkflowNodeState = { ...n, status: "pending" };
    run.nodes.push(node);
    return node;
  }

  private get(workflowId: string): WorkflowRunState {
    const run = this.runs.get(workflowId);
    if (!run) throw new PhononError("errInvalidParams", `workflow ${workflowId} not found`);
    return run;
  }

  private fail(run: WorkflowRunState, err: unknown): void {
    if (run.status === "cancelled" || run.status === "timeout") return;
    run.status = "failed";
    run.error = (err as Error)?.message ?? String(err);
    run.completedAt = new Date().toISOString();
    run.updatedAt = run.completedAt;
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
    } as WorkflowStatusResult;
  }

  private emit(run: WorkflowRunState, partial: Record<string, unknown>): void {
    const ev = { workflowId: run.workflowId, seq: run.seq++, timestamp: new Date().toISOString(), ...partial };
    this.opts.emit(ev as unknown as WorkflowEvent);
  }
}
