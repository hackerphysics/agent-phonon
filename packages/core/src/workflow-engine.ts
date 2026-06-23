import type { SessionEngine } from "./session-engine.js";
import { PhononError } from "./rpc.js";
import type { EnvManager } from "./env-manager.js";
import type { WorkflowEvent, WorkflowPlan, WorkflowStatusResult, WorkflowRunResult, StreamEvent } from "@agent-phonon/protocol";

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
}

interface WorkflowRunState {
  workflowId: string;
  tenantId: string;
  project: string;
  worktreeId?: string;
  mode: "dag" | "graph";
  plan: WorkflowPlan;
  input?: string;
  status: "queued" | "running" | "completed" | "failed" | "cancelled" | "timeout";
  nodes: WorkflowNodeState[];
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  error?: string;
  seq: number;
}

export class WorkflowEngine {
  private runs = new Map<string, WorkflowRunState>();
  private sessionToNode = new Map<string, { workflowId: string; nodeId: string }>();
  private idSeq = 1;

  constructor(private opts: {
    tenantId: string;
    engine: SessionEngine;
    resolveCwd: (projectId: string, worktreeId?: string) => string;
    env: EnvManager;
    emit: (event: WorkflowEvent) => void;
  }) {}

  async run(params: { project: string; worktreeId?: string; plan: WorkflowPlan; input?: string; metadata?: Record<string, unknown> }): Promise<WorkflowRunResult> {
    const workflowId = `wf-${Date.now()}-${this.idSeq++}`;
    const now = new Date().toISOString();
    const nodes = this.initialNodes(params.plan);
    const run: WorkflowRunState = { workflowId, tenantId: this.opts.tenantId, project: params.project, worktreeId: params.worktreeId, mode: params.plan.mode, plan: params.plan, input: params.input, status: "queued", nodes, createdAt: now, updatedAt: now, seq: 0 };
    this.runs.set(workflowId, run);
    this.emit(run, { type: "workflow.status", status: "queued" });
    void this.execute(run).catch((err) => this.fail(run, err));
    return { workflowId, status: run.status, createdAt: run.createdAt };
  }

  status(workflowId: string): WorkflowStatusResult {
    const run = this.get(workflowId);
    return this.toStatus(run);
  }

  list(filter?: { status?: string; limit?: number }): { workflows: WorkflowStatusResult[] } {
    const limit = filter?.limit ?? 50;
    const rows = [...this.runs.values()].filter((r) => !filter?.status || r.status === filter.status).slice(-limit).reverse();
    return { workflows: rows.map((r) => this.toStatus(r)) };
  }

  async cancel(workflowId: string, reason?: string): Promise<{ workflowId: string; status: "cancelled" }> {
    const run = this.get(workflowId);
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

  onStreamEvent(ev: StreamEvent): void {
    const sessionId = (ev as { sessionId?: string }).sessionId;
    if (!sessionId) return;
    const m = this.sessionToNode.get(sessionId);
    if (!m) return;
    const run = this.runs.get(m.workflowId);
    const node = run?.nodes.find((n) => n.nodeId === m.nodeId);
    if (!run || !node) return;
    this.emit(run, {
      type: "node.stream",
      nodeId: node.nodeId,
      sessionId,
      turnId: (ev as { turnId?: string }).turnId,
      agent: node.agent,
      model: node.model,
      role: node.role,
      payload: ev as unknown as Record<string, unknown>,
    });
  }

  private async execute(run: WorkflowRunState): Promise<void> {
    run.status = "running"; run.updatedAt = new Date().toISOString();
    this.emit(run, { type: "workflow.status", status: "running" });
    if (run.plan.mode === "dag") await this.executeDag(run);
    else await this.executeGraph(run);
    if (!(["cancelled", "failed"] as string[]).includes(run.status)) {
      run.status = "completed"; run.completedAt = new Date().toISOString(); run.updatedAt = run.completedAt;
      this.emit(run, { type: "workflow.status", status: "completed" });
    }
  }

  private async executeDag(run: WorkflowRunState): Promise<void> {
    const plan = run.plan.mode === "dag" ? run.plan : undefined;
    if (!plan) return;
    const deps = new Map<string, Set<string>>();
    for (const n of plan.nodes) deps.set(n.nodeId, new Set(n.dependsOn ?? []));
    for (const e of plan.edges ?? []) deps.get(e.to)?.add(e.from);
    const done = new Set<string>();
    while (done.size < plan.nodes.length) {
      const ready = plan.nodes.filter((n) => !done.has(n.nodeId) && [...(deps.get(n.nodeId) ?? [])].every((d) => done.has(d)));
      if (ready.length === 0) throw new PhononError("errInvalidParams", "workflow DAG has a cycle or missing dependency");
      await Promise.all(ready.map((n) => this.executeNode(run, n.nodeId, n.agent, n.model, n.role, n.input ?? run.input ?? "", n.agentConfig)));
      for (const n of ready) done.add(n.nodeId);
    }
  }

  private async executeGraph(run: WorkflowRunState): Promise<void> {
    const plan = run.plan.mode === "graph" ? run.plan : undefined;
    if (!plan) return;
    const prompt = [
      "You are the executor for a multi-agent graph workflow.",
      `Input: ${run.input ?? ""}`,
      `Workers: ${JSON.stringify(plan.workers.map((w) => ({ nodeId: w.nodeId, role: w.role, agent: w.agent, model: w.model })))}`,
      `Communication graph: ${JSON.stringify(plan.communicationGraph)}`,
      "Produce the first routing decision and final summary for this initial implementation.",
    ].join("\n\n");
    await this.executeNode(run, plan.executor.nodeId, plan.executor.agent, plan.executor.model, plan.executor.role, prompt, plan.executor.agentConfig);
    this.emit(run, { type: "executor.decision", nodeId: plan.executor.nodeId, payload: { initialImplementation: true } });
  }

  private async executeNode(run: WorkflowRunState, nodeId: string, agent: string, model: string, role: string | undefined, input: string, agentConfig?: Record<string, unknown>): Promise<void> {
    const node = run.nodes.find((n) => n.nodeId === nodeId) ?? this.addNode(run, { nodeId, agent, model, role });
    node.status = "running"; node.startedAt = new Date().toISOString(); run.updatedAt = node.startedAt;
    this.emit(run, { type: "node.status", nodeId, agent, model, role, status: "running" });
    try {
      const cwd = this.opts.resolveCwd(run.project, run.worktreeId);
      const created = await this.opts.engine.create({ tenantId: run.tenantId, project: run.project, worktreeId: run.worktreeId, cwd, agent, model, verbosity: "messages", agentConfig });
      node.sessionId = created.sessionId;
      this.sessionToNode.set(created.sessionId, { workflowId: run.workflowId, nodeId });
      const sent = await this.opts.engine.send(run.tenantId, created.sessionId, input, { environment: this.opts.env.resolveForExecution({ projectId: run.project, agent }) });
      node.turnId = sent.turnId;
      await this.waitIdle(run.tenantId, created.sessionId);
      node.status = "completed"; node.completedAt = new Date().toISOString(); run.updatedAt = node.completedAt;
      this.emit(run, { type: "node.status", nodeId, sessionId: node.sessionId, turnId: node.turnId, agent, model, role, status: "completed" });
    } catch (err) {
      node.status = "failed"; node.completedAt = new Date().toISOString(); node.error = (err as Error)?.message ?? String(err); run.updatedAt = node.completedAt;
      this.emit(run, { type: "node.status", nodeId, agent, model, role, status: "failed", payload: { error: node.error } });
      throw err;
    }
  }

  private async waitIdle(tenantId: string, sessionId: string): Promise<void> {
    for (;;) {
      const s = await this.opts.engine.status(tenantId, sessionId);
      if (s.status === "idle" || s.status === "terminated" || s.status === "paused") return;
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  private initialNodes(plan: WorkflowPlan): WorkflowNodeState[] {
    const nodes = plan.mode === "dag" ? plan.nodes : [plan.executor, ...plan.workers];
    return nodes.map((n) => ({ nodeId: n.nodeId, status: "pending", agent: n.agent, model: n.model, role: n.role }));
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
    if (run.status === "cancelled") return;
    run.status = "failed"; run.error = (err as Error)?.message ?? String(err); run.completedAt = new Date().toISOString(); run.updatedAt = run.completedAt;
    this.emit(run, { type: "workflow.status", status: "failed", payload: { error: run.error } });
  }

  private toStatus(run: WorkflowRunState): WorkflowStatusResult {
    return { workflowId: run.workflowId, status: run.status, project: run.project, mode: run.mode, nodes: run.nodes, createdAt: run.createdAt, updatedAt: run.updatedAt, completedAt: run.completedAt, error: run.error } as WorkflowStatusResult;
  }

  private emit(run: WorkflowRunState, partial: Record<string, unknown>): void {
    const ev = { workflowId: run.workflowId, seq: run.seq++, timestamp: new Date().toISOString(), ...partial };
    this.opts.emit(ev as unknown as WorkflowEvent);
  }
}
