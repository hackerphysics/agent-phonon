import { randomBytes, randomUUID } from "node:crypto";
import { PhononError } from "./rpc.js";
import { nextCronAfter, parseCron } from "./cron.js";
import type { SessionEngine } from "./session-engine.js";
import type { WorkflowEngine } from "./workflow-engine.js";
import type { PhononStore } from "./store.js";
import type {
  Schedule,
  ScheduleTrigger,
  ScheduleTarget,
  ScheduleConsent,
  SchedulePolicy,
  SchedulePushConsent,
  Run,
  RunStatus,
  RunTriggerSource,
  StreamEvent,
  WorkflowEvent,
} from "@agent-phonon/protocol";

type TriggerInput = string | Record<string, unknown>;
type RuntimePhase = "queued" | "launching" | "running" | "retry_wait";
type RetryPhase = "launch" | "runtime";

interface RetryAudit {
  attempt: number;
  at: string;
  phase: RetryPhase;
  error: string;
}

interface RunRuntime {
  runId: string;
  scheduleId: string;
  sessionId?: string;
  workflowId?: string;
  status: RunStatus;
  phase: RuntimePhase;
  subscribed: boolean;
  seq: number;
  ackedSeq: number;
  resultText: string;
  createdAt: number;
  startedAt?: number;
  timeoutTimer?: ReturnType<typeof setTimeout>;
  consent: SchedulePushConsent;
  triggerSource: RunTriggerSource;
  input?: TriggerInput;
  attempt: number;
  maxAttempts: number;
  retryHistory: RetryAudit[];
  retryAt?: number;
  ownerEpoch: number;
}

export interface SchedulerEngineOptions {
  tenantId: string;
  engine: SessionEngine;
  store: PhononStore;
  resolveCwd: (projectId: string) => string;
  /** The current tenant-scoped workflow engine. */
  workflows?: () => WorkflowEngine | undefined;
  emit: (method: "run.started" | "run.event" | "run.finished" | "schedule.changed", params: unknown) => void;
  /** Local consent/policy gate. Webhook triggers use the same gate. */
  assertRunAllowed?: (schedule: Schedule, source: RunTriggerSource) => void;
  defaultTz?: string;
  now?: () => number;
}

const MASK = "***";
const TERMINAL = new Set<RunStatus>(["success", "failed", "timeout", "cancelled", "skipped"]);

/** Device-authoritative L4 scheduler. One run wraps one L1 session or L3 workflow. */
export class SchedulerEngine {
  private opts: SchedulerEngineOptions;
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private runtimes = new Map<string, RunRuntime>();
  private sessionToRun = new Map<string, string>();
  private workflowToRun = new Map<string, string>();
  private queues = new Map<string, string[]>();
  private started = false;
  private disposed = false;
  private readonly ownerId = `scheduler-owner-${process.pid}-${randomUUID()}`;
  private readonly leaseMs = 5_000;
  private leaseTimer?: ReturnType<typeof setInterval>;
  private reconciling = false;

  constructor(opts: SchedulerEngineOptions) {
    this.opts = opts;
  }

  private now(): number {
    return this.opts.now ? this.opts.now() : Date.now();
  }

  // -------------------------------------------------------------------------
  // lifecycle
  // -------------------------------------------------------------------------

  start(): void {
    if (this.started || this.disposed) return;
    this.started = true;
    this.reconcileOrphanedRuns();
    this.leaseTimer = setInterval(() => {
      try {
        this.renewRunLeases();
        this.reconcileOrphanedRuns();
      } catch {
        // Store shutdown/replacement is handled by the owning connection.
      }
    }, Math.max(500, Math.floor(this.leaseMs / 3)));
    this.leaseTimer.unref?.();
    for (const row of this.opts.store.listSchedules(this.opts.tenantId)) {
      const schedule = this.rowToSchedule(row);
      if (schedule.enabled && schedule.trigger.kind === "cron") this.restoreCron(schedule);
    }
  }

  stop(): void {
    this.started = false;
    if (this.leaseTimer) clearInterval(this.leaseTimer);
    this.leaseTimer = undefined;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    for (const rt of this.runtimes.values()) this.clearRunTimer(rt);
  }

  /**
   * Permanent teardown. Running work is failed and queued work is cancelled so
   * no persisted run remains pending. The disposed fence prevents late async
   * completions from writing a second terminal state.
   */
  dispose(reason = "connection disposed"): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stop();
    for (const rt of [...this.runtimes.values()]) {
      const queued = rt.phase === "queued";
      // A workflow and its schedule run are device-authoritative, not bound to
      // one websocket. Leave the run active so the replacement scheduler can
      // reattach before WorkflowEngine emits recovery events.
      if ((rt.workflowId || rt.phase === "retry_wait") && !TERMINAL.has(rt.status)) {
        this.clearRunTimer(rt);
        this.opts.store.releaseRun(rt.runId, this.opts.tenantId, this.ownerId, rt.ownerEpoch);
        continue;
      }
      this.finishRun(rt, queued ? "cancelled" : "failed", queued ? `queued run cancelled: ${reason}` : reason, undefined, {
        drain: false,
        emit: false,
      });
      if (!queued) void this.cancelExecution(rt, reason);
    }
    this.queues.clear();
    this.runtimes.clear();
    this.sessionToRun.clear();
    this.workflowToRun.clear();
  }

  replayUnacked(): void {
    for (const row of this.opts.store.unackedRunEvents(this.opts.tenantId)) {
      try { this.safeEmit("run.event", JSON.parse(row.payload)); } catch { break; }
    }
    for (const row of this.opts.store.listUnackedFinishedRuns(this.opts.tenantId)) {
      const run = this.rowToRun(row);
      const sched = this.opts.store.getSchedule(run.scheduleId, this.opts.tenantId);
      const consent: SchedulePushConsent = sched ? this.rowToSchedule(sched).consent.push : "summary";
      this.safeEmit("run.finished", { run: this.shapeRunForPush(run, consent), push: consent });
    }
  }

  // -------------------------------------------------------------------------
  // schedule CRUD
  // -------------------------------------------------------------------------

  create(params: {
    name: string;
    trigger: ScheduleTrigger;
    target: ScheduleTarget;
    consent?: ScheduleConsent;
    policy?: SchedulePolicy;
    enabled?: boolean;
  }): { schedule: Schedule; webhookToken?: string } {
    const id = `sch-${this.now()}-${randomUUID()}`;
    const nowIso = new Date(this.now()).toISOString();
    let trigger = this.prepareTrigger(params.trigger);
    let webhookToken: string | undefined;
    if (trigger.kind === "webhook") {
      webhookToken = trigger.webhookToken || `whk_${randomBytes(24).toString("hex")}`;
      trigger = { kind: "webhook", webhookToken };
    }
    const enabled = params.enabled ?? true;
    const schedule: Schedule = {
      id: id as Schedule["id"],
      tenantId: this.opts.tenantId as Schedule["tenantId"],
      name: params.name,
      enabled,
      trigger,
      target: params.target,
      consent: params.consent ?? { push: "summary" },
      policy: params.policy,
      createdAt: nowIso,
      updatedAt: nowIso,
      nextRunAt: enabled && trigger.kind === "cron" ? this.computeNextRun(trigger) : undefined,
    };
    this.persist(schedule, webhookToken);
    if (enabled && trigger.kind === "cron") this.armCron(schedule);
    this.safeEmit("schedule.changed", { schedule: this.maskSchedule(schedule) });
    return { schedule: this.maskSchedule(schedule), webhookToken };
  }

  update(params: {
    scheduleId: string;
    name?: string;
    enabled?: boolean;
    trigger?: ScheduleTrigger;
    target?: ScheduleTarget;
    consent?: ScheduleConsent;
    policy?: SchedulePolicy;
  }): { schedule: Schedule } {
    const existing = this.loadSchedule(params.scheduleId);
    const nowIso = new Date(this.now()).toISOString();
    let trigger = params.trigger ? this.prepareTrigger(params.trigger) : existing.trigger;
    let webhookToken: string | undefined;
    if (trigger.kind === "webhook") {
      webhookToken = trigger.webhookToken
        || (existing.trigger.kind === "webhook" ? existing.trigger.webhookToken : undefined)
        || `whk_${randomBytes(24).toString("hex")}`;
      trigger = { kind: "webhook", webhookToken };
    }
    const enabled = params.enabled ?? existing.enabled;
    const updated: Schedule = {
      ...existing,
      name: params.name ?? existing.name,
      enabled,
      trigger,
      target: params.target ?? existing.target,
      consent: params.consent ?? existing.consent,
      policy: params.policy ?? existing.policy,
      updatedAt: nowIso,
    };
    this.disarm(updated.id);
    updated.nextRunAt = enabled && trigger.kind === "cron" ? this.computeNextRun(trigger) : undefined;
    this.persist(updated, webhookToken);

    const overlap = updated.policy?.overlap ?? "skip";
    if (!enabled) this.cancelQueued(updated.id, "schedule disabled");
    else if (overlap !== "queue") this.cancelQueued(updated.id, `overlap policy changed to ${overlap}`);

    if (enabled && trigger.kind === "cron") this.armCron(updated);
    this.safeEmit("schedule.changed", { schedule: this.maskSchedule(updated) });
    return { schedule: this.maskSchedule(updated) };
  }

  setEnabled(scheduleId: string, enabled: boolean): { schedule: Schedule } {
    return this.update({ scheduleId, enabled });
  }

  delete(scheduleId: string): { scheduleId: string; deleted: boolean } {
    const row = this.opts.store.getSchedule(scheduleId, this.opts.tenantId);
    if (!row) return { scheduleId, deleted: false };
    this.disarm(scheduleId);
    for (const rt of [...this.runtimes.values()].filter((candidate) => candidate.scheduleId === scheduleId)) {
      this.finishRun(rt, "cancelled", "schedule deleted", undefined, { drain: false });
      void this.cancelExecution(rt, "schedule deleted");
    }
    this.queues.delete(scheduleId);
    this.opts.store.deleteSchedule(scheduleId);
    this.safeEmit("schedule.changed", { scheduleId, deleted: true });
    return { scheduleId, deleted: true };
  }

  list(filter?: { enabled?: boolean; triggerKind?: "cron" | "webhook" | "manual"; reveal?: boolean; limit?: number }): { schedules: Schedule[] } {
    let schedules = this.opts.store.listSchedules(this.opts.tenantId).map((row) => this.rowToSchedule(row));
    if (filter?.enabled !== undefined) schedules = schedules.filter((s) => s.enabled === filter.enabled);
    if (filter?.triggerKind) schedules = schedules.filter((s) => s.trigger.kind === filter.triggerKind);
    if (filter?.limit) schedules = schedules.slice(0, filter.limit);
    return { schedules: schedules.map((s) => (filter?.reveal ? s : this.maskSchedule(s))) };
  }

  get(scheduleId: string, reveal?: boolean): { schedule: Schedule } {
    const schedule = this.loadSchedule(scheduleId);
    return { schedule: reveal ? schedule : this.maskSchedule(schedule) };
  }

  // -------------------------------------------------------------------------
  // triggering and observation
  // -------------------------------------------------------------------------

  async trigger(params: { scheduleId: string; source?: RunTriggerSource; input?: TriggerInput }): Promise<{ scheduleId: string; runId: string; status: RunStatus }> {
    const schedule = this.loadSchedule(params.scheduleId);
    if (!schedule.enabled) throw new PhononError("errPolicyDenied", "schedule disabled");
    const runId = await this.launchRun(schedule, params.source ?? "manual", params.input);
    return { scheduleId: params.scheduleId, runId, status: this.runtimes.get(runId)?.status ?? this.storedRunStatus(runId) };
  }

  async triggerByWebhook(token: string, input?: TriggerInput): Promise<{ scheduleId: string; runId: string; status: RunStatus }> {
    const row = this.opts.store.getScheduleByWebhookToken(token, this.opts.tenantId);
    if (!row) throw new PhononError("errInvalidParams", "no schedule for webhook token");
    const schedule = this.rowToSchedule(row);
    if (schedule.trigger.kind !== "webhook") throw new PhononError("errInvalidParams", "webhook token is no longer active");
    if (!schedule.enabled) throw new PhononError("errPolicyDenied", "schedule disabled");
    const runId = await this.launchRun(schedule, "webhook", input);
    return { scheduleId: schedule.id, runId, status: this.runtimes.get(runId)?.status ?? this.storedRunStatus(runId) };
  }

  runGet(runId: string): { run: Run } {
    const row = this.opts.store.getRun(runId, this.opts.tenantId);
    if (!row) throw new PhononError("errInvalidParams", `run ${runId} not found`);
    return { run: this.rowToRun(row) };
  }

  runsList(scheduleId: string, opts?: { status?: string; limit?: number }): { runs: Run[] } {
    if (!this.opts.store.getSchedule(scheduleId, this.opts.tenantId)) {
      throw new PhononError("errInvalidParams", `schedule ${scheduleId} not found`);
    }
    return {
      runs: this.opts.store
        .listRunsForSchedule(scheduleId, { ...opts, tenantId: this.opts.tenantId })
        .map((row) => this.rowToRun(row)),
    };
  }

  subscribe(runId: string): { runId: string; subscribed: boolean; sessionId?: string } {
    const rt = this.runtimes.get(runId);
    if (!rt) {
      const row = this.opts.store.getRun(runId, this.opts.tenantId);
      if (!row) throw new PhononError("errInvalidParams", `run ${runId} not found`);
      const sched = this.opts.store.getSchedule(row.schedule_id as string, this.opts.tenantId);
      const push = sched ? this.rowToSchedule(sched).consent.push : "summary";
      if (push !== "full") throw new PhononError("errPolicyDenied", `run.events.subscribe requires schedule consent.push=\"full\" (current: ${push})`);
      return { runId, subscribed: false, sessionId: (row.session_id as string) ?? undefined };
    }
    if (rt.consent !== "full") throw new PhononError("errPolicyDenied", `run.events.subscribe requires schedule consent.push=\"full\" (current: ${rt.consent})`);
    rt.subscribed = true;
    return { runId, subscribed: true, sessionId: rt.sessionId };
  }

  unsubscribe(runId: string): { runId: string; subscribed: boolean } {
    const rt = this.runtimes.get(runId);
    if (rt) rt.subscribed = false;
    return { runId, subscribed: false };
  }

  async cancel(runId: string, reason = "cancelled"): Promise<{ runId: string; status: RunStatus }> {
    const rt = this.runtimes.get(runId);
    if (!rt) {
      const row = this.opts.store.getRun(runId, this.opts.tenantId);
      if (!row) throw new PhononError("errInvalidParams", `run ${runId} not found`);
      return { runId, status: this.rowToRun(row).status };
    }
    if (!this.assertRunOwner(rt)) {
      const row = this.opts.store.getRun(runId, this.opts.tenantId);
      return { runId, status: row ? this.rowToRun(row).status : "cancelled" };
    }
    // Persist/fence first. Late session/workflow events can no longer overwrite it.
    this.finishRun(rt, "cancelled", reason);
    // Terminal state is already durable and fenced; cancellation is best effort
    // and must not keep the RPC open on a stuck adapter.
    void this.cancelExecution(rt, reason);
    return { runId, status: "cancelled" };
  }

  // -------------------------------------------------------------------------
  // execution event routing
  // -------------------------------------------------------------------------

  onStreamEvent(ev: StreamEvent): void {
    if (this.disposed) return;
    const sessionId = (ev as { sessionId?: string }).sessionId;
    if (!sessionId) return;
    const rt = this.runtimeForMapping(this.sessionToRun, sessionId);
    if (!rt || !this.assertRunOwner(rt)) return;
    this.forwardRunEvent(rt, ev as unknown as Record<string, unknown>);
    const event = ev as Record<string, unknown>;
    if (event.type === "message" && typeof event.text === "string") {
      rt.resultText += event.text;
    } else if (event.type === "result") {
      rt.resultText = (event.text as string | undefined) || rt.resultText;
      const rawStatus = String(event.status ?? "completed");
      if (["completed", "success"].includes(rawStatus)) {
        this.finishRun(rt, "success", undefined, event.usage as Record<string, unknown> | undefined);
      } else {
        this.failAttempt(rt, String(event.message ?? `session result: ${rawStatus}`), "runtime");
      }
    } else if (event.type === "error") {
      this.failAttempt(rt, String(event.message ?? "session error"), "runtime");
    }
  }

  /** WorkflowEngine emit sink. Also forwards workflow-level events to full-consent subscribers. */
  onWorkflowEvent(ev: WorkflowEvent): void {
    if (this.disposed) return;
    const rt = this.runtimeForMapping(this.workflowToRun, ev.workflowId)
      ?? [...this.runtimes.values()].find((candidate) => (
        candidate.phase === "launching"
        && candidate.workflowId === undefined
        && (ev.metadata as Record<string, unknown> | undefined)?.runId === candidate.runId
      ));
    if (!rt || !this.assertRunOwner(rt)) return;
    if (!rt.workflowId) {
      rt.workflowId = ev.workflowId;
      this.workflowToRun.set(ev.workflowId, rt.runId);
    }
    this.forwardRunEvent(rt, ev as unknown as Record<string, unknown>);
    // Keep the latest node result as a useful fallback for DAG plans without
    // finalNodeId; terminal workflow.status.finalText takes precedence below.
    if (typeof ev.result?.text === "string") rt.resultText = ev.result.text;
    if (ev.type !== "workflow.status") return;
    const payload = ev.payload as Record<string, unknown> | undefined;
    if (typeof payload?.finalText === "string") rt.resultText = payload.finalText;
    switch (ev.status) {
      case "completed":
        this.finishRun(rt, "success");
        break;
      case "failed":
        this.failAttempt(rt, String(payload?.error ?? "workflow failed"), "runtime");
        break;
      case "timeout":
        this.finishRun(rt, "timeout", String(payload?.error ?? "workflow timeout"));
        break;
      case "cancelled":
        this.finishRun(rt, "cancelled", String(payload?.reason ?? "workflow cancelled"));
        break;
      default:
        break;
    }
  }

  // -------------------------------------------------------------------------
  // launch / queue / retry
  // -------------------------------------------------------------------------

  private async launchRun(schedule: Schedule, source: RunTriggerSource, input?: TriggerInput): Promise<string> {
    if (this.disposed) throw new Error("scheduler disposed");
    this.opts.assertRunAllowed?.(schedule, source);
    const overlap = schedule.policy?.overlap ?? "skip";
    const active = this.hasActive(schedule.id);
    if (active && overlap === "skip") return this.persistSkipped(schedule, source);

    const rt = this.createRuntime(schedule, source, input, active && overlap === "queue" ? "queued" : "launching");
    if (rt.phase === "queued") {
      const queue = this.queues.get(schedule.id) ?? [];
      queue.push(rt.runId);
      this.queues.set(schedule.id, queue);
      return rt.runId;
    }
    await this.launchAttempt(rt, schedule);
    return rt.runId;
  }

  private createRuntime(schedule: Schedule, source: RunTriggerSource, input: TriggerInput | undefined, phase: RuntimePhase): RunRuntime {
    const runId = `run-${this.now()}-${randomUUID()}`;
    const createdAt = this.now();
    const rt: RunRuntime = {
      runId,
      scheduleId: schedule.id,
      status: "pending",
      phase,
      subscribed: false,
      seq: 0,
      ackedSeq: -1,
      resultText: "",
      createdAt,
      consent: schedule.consent.push,
      triggerSource: source,
      input,
      attempt: 0,
      maxAttempts: 1 + (schedule.policy?.maxRetries ?? 0),
      retryHistory: [],
      ownerEpoch: 0,
    };
    this.runtimes.set(runId, rt);
    this.persistRuntime(rt);
    this.touchLastRun(schedule.id, new Date(createdAt).toISOString());
    return rt;
  }

  private async launchAttempt(rt: RunRuntime, initialSchedule?: Schedule): Promise<void> {
    if (this.disposed || !this.runtimes.has(rt.runId) || TERMINAL.has(rt.status) || !this.assertRunOwner(rt)) return;
    const row = this.opts.store.getSchedule(rt.scheduleId, this.opts.tenantId);
    const schedule = row ? this.rowToSchedule(row) : initialSchedule;
    if (!schedule || !schedule.enabled) {
      this.finishRun(rt, "cancelled", schedule ? "schedule disabled before launch" : "schedule deleted before launch");
      return;
    }

    rt.phase = "launching";
    rt.retryAt = undefined;
    rt.status = "pending";
    if (rt.attempt === 0) {
      // Queued work adopts the latest target policy/consent at actual launch.
      rt.maxAttempts = 1 + (schedule.policy?.maxRetries ?? 0);
      rt.consent = schedule.consent.push;
    }
    rt.attempt++;
    rt.resultText = "";
    rt.sessionId = undefined;
    rt.workflowId = undefined;
    rt.startedAt ??= this.now();
    this.persistRuntime(rt);

    try {
      if (schedule.target.runKind === "workflow") {
        const workflows = this.opts.workflows?.();
        if (!workflows) throw new PhononError("errCapabilityUnsupported", "workflow engine unavailable");
        if (!schedule.target.plan) throw new PhononError("errInvalidParams", "runKind=workflow requires target.plan");
        const launchMetadata = { scheduleId: schedule.id, runId: rt.runId, attempt: rt.attempt };
        // Record intent before WorkflowEngine.run emits its synchronous queued
        // event; onWorkflowEvent can correlate that first event by metadata.
        const launched = await workflows.run({
          project: schedule.target.project,
          plan: schedule.target.plan,
          input: this.mapInput(undefined, rt.input),
          policy: schedule.policy?.timeoutMs ? { timeoutSeconds: Math.max(1, Math.ceil(schedule.policy.timeoutMs / 1000)) } : undefined,
          metadata: launchMetadata,
        });
        if (this.disposed || !this.runtimes.has(rt.runId) || TERMINAL.has(rt.status)) {
          await workflows.cancel(launched.workflowId, "scheduler no longer owns run").catch(() => {});
          return;
        }
        rt.workflowId = launched.workflowId;
        this.workflowToRun.set(launched.workflowId, rt.runId);
      } else {
        const cwd = this.opts.resolveCwd(schedule.target.project);
        const created = await this.opts.engine.create({
          tenantId: this.opts.tenantId,
          project: schedule.target.project,
          cwd,
          agent: schedule.target.agent ?? "",
          model: schedule.target.model ?? "default",
          verbosity: "messages",
          agentConfig: schedule.target.agentConfig,
        });
        if (this.disposed || !this.runtimes.has(rt.runId) || TERMINAL.has(rt.status)) {
          await this.opts.engine.terminate(this.opts.tenantId, created.sessionId).catch(() => {});
          return;
        }
        rt.sessionId = created.sessionId;
        this.sessionToRun.set(created.sessionId, rt.runId);
      }

      rt.phase = "running";
      rt.status = "running";
      this.persistRuntime(rt);
      this.safeEmit("run.started", { run: this.shapeRunForPush(this.runtimeToRun(rt), rt.consent) });
      this.armRunTimeout(rt, schedule.policy?.timeoutMs);

      if (rt.sessionId) {
        await this.opts.engine.send(
          this.opts.tenantId,
          rt.sessionId,
          this.mapInput(schedule.target.prompt ?? "", rt.input) ?? "",
          { verbosity: "messages", skills: schedule.target.skills },
        );
      }
    } catch (err) {
      if (!this.disposed && this.runtimes.has(rt.runId) && !TERMINAL.has(rt.status)) {
        this.failAttempt(rt, (err as Error)?.message?.slice(0, 500) ?? "launch failed", "launch");
      }
    }
  }

  private failAttempt(rt: RunRuntime, error: string, phase: RetryPhase): void {
    if (this.disposed || TERMINAL.has(rt.status) || !this.runtimes.has(rt.runId) || !this.assertRunOwner(rt)) return;
    this.clearRunTimer(rt);
    this.detachMappings(rt);
    const sessionId = rt.sessionId;
    const workflowId = rt.workflowId;
    rt.retryHistory.push({ attempt: rt.attempt, at: new Date(this.now()).toISOString(), phase, error });
    // Every failed attempt relinquishes its execution resource, including the
    // final attempt. Mapping is already detached, so late events are fenced.
    if (sessionId) void this.opts.engine.terminate(this.opts.tenantId, sessionId).catch(() => {});
    if (workflowId) void this.opts.workflows?.()?.cancel(workflowId, "scheduled attempt failed").catch(() => {});

    if (rt.attempt < rt.maxAttempts) {
      rt.status = "pending";
      rt.phase = "retry_wait";
      rt.sessionId = undefined;
      rt.workflowId = undefined;
      const retryDelayMs = Math.min(1000, 50 * 2 ** Math.max(0, rt.attempt - 1));
      rt.retryAt = this.now() + retryDelayMs;
      this.persistRuntime(rt, `retrying after attempt ${rt.attempt}: ${error}`, error);
      const retryTimer = setTimeout(() => {
        rt.timeoutTimer = undefined;
        if (this.disposed || !this.runtimes.has(rt.runId) || rt.phase !== "retry_wait") return;
        void this.launchAttempt(rt);
      }, retryDelayMs);
      retryTimer.unref?.();
      rt.timeoutTimer = retryTimer;
      return;
    }
    this.finishRun(rt, "failed", error);
  }

  private finishRun(
    rt: RunRuntime,
    status: RunStatus,
    exitReason?: string,
    usage?: Record<string, unknown>,
    options: { drain?: boolean; emit?: boolean } = {},
  ): void {
    if (TERMINAL.has(rt.status) || !this.runtimes.has(rt.runId)) return;
    rt.status = status;
    this.clearRunTimer(rt);
    this.detachMappings(rt);
    this.removeFromQueue(rt);
    const nowIso = new Date(this.now()).toISOString();
    const run = this.runtimeToRun(rt, {
      status,
      finishedAt: nowIso,
      exitReason,
      error: status === "failed" || status === "timeout" ? exitReason : undefined,
      usage,
    });
    const persisted = this.opts.store.upsertRun({
      id: rt.runId,
      scheduleId: rt.scheduleId,
      tenantId: this.opts.tenantId,
      triggerSource: rt.triggerSource,
      status,
      createdAt: new Date(rt.createdAt).toISOString(),
      sessionId: rt.sessionId,
      workflowId: rt.workflowId,
      startedAt: rt.startedAt ? new Date(rt.startedAt).toISOString() : undefined,
      finishedAt: nowIso,
      exitReason,
      error: run.error,
      transcriptPath: rt.sessionId ? this.transcriptPathFor(rt.sessionId) : undefined,
      resultText: rt.resultText || undefined,
      usageJson: usage ? JSON.stringify(usage) : undefined,
      pushState: "pending",
      ackedSeq: rt.ackedSeq,
      eventSeq: rt.seq,
      attempt: rt.attempt,
      maxAttempts: rt.maxAttempts,
      retryHistoryJson: JSON.stringify(rt.retryHistory),
      inputJson: rt.input === undefined ? undefined : JSON.stringify(rt.input),
      phase: rt.phase,
      ownerId: this.ownerId,
      ownerEpoch: rt.ownerEpoch,
      leaseUntil: this.now() + this.leaseMs,
    });
    if (persisted && options.emit !== false) this.safeEmit("run.finished", { run: this.shapeRunForPush(run, rt.consent), push: rt.consent });
    if (persisted) this.opts.store.releaseRun(rt.runId, this.opts.tenantId, this.ownerId, rt.ownerEpoch);
    this.runtimes.delete(rt.runId);
    if (options.drain !== false && !this.disposed) this.drainQueue(rt.scheduleId);
  }

  private drainQueue(scheduleId: string): void {
    if (this.disposed || this.hasActive(scheduleId)) return;
    const queue = this.queues.get(scheduleId);
    if (!queue?.length) return;
    while (queue.length) {
      const runId = queue.shift()!;
      const rt = this.runtimes.get(runId);
      if (!rt || rt.phase !== "queued") continue;
      if (queue.length === 0) this.queues.delete(scheduleId);
      void this.launchAttempt(rt);
      return;
    }
    this.queues.delete(scheduleId);
  }

  private cancelQueued(scheduleId: string, reason: string): void {
    const ids = [...(this.queues.get(scheduleId) ?? [])];
    this.queues.delete(scheduleId);
    for (const id of ids) {
      const rt = this.runtimes.get(id);
      if (rt?.phase === "queued") this.finishRun(rt, "cancelled", reason, undefined, { drain: false });
    }
  }

  private hasActive(scheduleId: string): boolean {
    return [...this.runtimes.values()].some((rt) => rt.scheduleId === scheduleId && rt.phase !== "queued" && !TERMINAL.has(rt.status));
  }

  private persistSkipped(schedule: Schedule, source: RunTriggerSource): string {
    const runId = `run-${this.now()}-${randomUUID()}`;
    const nowIso = new Date(this.now()).toISOString();
    const run = {
      id: runId,
      scheduleId: schedule.id,
      tenantId: this.opts.tenantId,
      triggerSource: source,
      status: "skipped",
      finishedAt: nowIso,
      exitReason: "overlap_skip",
      attempt: 0,
      maxAttempts: 1 + (schedule.policy?.maxRetries ?? 0),
      retryHistory: [],
    } as unknown as Run;
    this.opts.store.upsertRun({
      id: runId,
      scheduleId: schedule.id,
      tenantId: this.opts.tenantId,
      triggerSource: source,
      status: "skipped",
      createdAt: nowIso,
      finishedAt: nowIso,
      exitReason: "overlap_skip",
      pushState: "pending",
      attempt: 0,
      maxAttempts: 1 + (schedule.policy?.maxRetries ?? 0),
      retryHistoryJson: "[]",
    });
    this.safeEmit("run.finished", { run: this.shapeRunForPush(run, schedule.consent.push), push: schedule.consent.push });
    return runId;
  }

  // -------------------------------------------------------------------------
  // timeout / cancellation / queue helpers
  // -------------------------------------------------------------------------

  private armRunTimeout(rt: RunRuntime, timeoutMs?: number): void {
    if (!timeoutMs || timeoutMs <= 0) return;
    rt.timeoutTimer = setTimeout(() => {
      if (this.disposed || !this.runtimes.has(rt.runId) || TERMINAL.has(rt.status) || !this.assertRunOwner(rt)) return;
      this.finishRun(rt, "timeout", `exceeded timeout ${timeoutMs}ms`);
      void this.cancelExecution(rt, "timeout");
    }, timeoutMs);
    (rt.timeoutTimer as { unref?: () => void }).unref?.();
  }

  private async cancelExecution(rt: RunRuntime, reason: string): Promise<void> {
    const tasks: Promise<unknown>[] = [];
    if (rt.sessionId) tasks.push(this.opts.engine.interrupt(this.opts.tenantId, rt.sessionId, reason).catch(() => {}));
    if (rt.workflowId) tasks.push(this.opts.workflows?.()?.cancel(rt.workflowId, reason).catch(() => {}) ?? Promise.resolve());
    await Promise.allSettled(tasks);
  }

  private clearRunTimer(rt: RunRuntime): void {
    if (rt.timeoutTimer) clearTimeout(rt.timeoutTimer);
    rt.timeoutTimer = undefined;
  }

  private detachMappings(rt: RunRuntime): void {
    if (rt.sessionId) this.sessionToRun.delete(rt.sessionId);
    if (rt.workflowId) this.workflowToRun.delete(rt.workflowId);
  }

  private removeFromQueue(rt: RunRuntime): void {
    const queue = this.queues.get(rt.scheduleId);
    if (!queue) return;
    const next = queue.filter((id) => id !== rt.runId);
    if (next.length) this.queues.set(rt.scheduleId, next);
    else this.queues.delete(rt.scheduleId);
  }

  private runtimeForMapping(mapping: Map<string, string>, executionId: string): RunRuntime | undefined {
    const runId = mapping.get(executionId);
    if (!runId) return undefined;
    const rt = this.runtimes.get(runId);
    return rt && !TERMINAL.has(rt.status) ? rt : undefined;
  }

  private forwardRunEvent(rt: RunRuntime, event: Record<string, unknown>): void {
    if (rt.subscribed && rt.consent === "full") {
      const seq = rt.seq++;
      const params = { runId: rt.runId, scheduleId: rt.scheduleId, seq, event };
      const persisted = this.opts.store.appendRunEvent(this.runtimeRecord(rt), {
        seq,
        payload: JSON.stringify(params),
        createdAt: new Date(this.now()).toISOString(),
      });
      if (persisted) this.safeEmit("run.event", params);
    }
  }

  // -------------------------------------------------------------------------
  // cron
  // -------------------------------------------------------------------------

  private restoreCron(schedule: Schedule): void {
    if (schedule.trigger.kind !== "cron") return;
    const missed = schedule.nextRunAt !== undefined && Date.parse(schedule.nextRunAt) <= this.now();
    if (missed) {
      // Advance durably before any catch-up launch. One startup produces at most
      // one catch-up run regardless of how many occurrences were missed.
      const updated = { ...schedule, nextRunAt: this.computeNextRun(schedule.trigger) };
      this.persist(updated);
      this.safeEmit("schedule.changed", { schedule: this.maskSchedule(updated) });
      this.armCron(updated);
      if (schedule.policy?.catchUp) void this.launchRun(updated, "cron").catch(() => {});
      return;
    }
    if (!schedule.nextRunAt) {
      const updated = { ...schedule, nextRunAt: this.computeNextRun(schedule.trigger) };
      this.persist(updated);
      this.armCron(updated);
      return;
    }
    this.armCron(schedule);
  }

  private armCron(schedule: Schedule): void {
    if (!this.started || this.disposed || schedule.trigger.kind !== "cron") return;
    this.disarm(schedule.id);
    const nextIso = schedule.nextRunAt ?? this.computeNextRun(schedule.trigger);
    if (!nextIso) return;
    const delay = Math.max(0, Date.parse(nextIso) - this.now());
    const timer = setTimeout(() => {
      this.timers.delete(schedule.id);
      void this.onCronFire(schedule.id);
    }, Math.min(delay, 2 ** 31 - 1));
    (timer as { unref?: () => void }).unref?.();
    this.timers.set(schedule.id, timer);
  }

  private async onCronFire(scheduleId: string): Promise<void> {
    if (!this.started || this.disposed) return;
    const row = this.opts.store.getSchedule(scheduleId, this.opts.tenantId);
    if (!row) return;
    const schedule = this.rowToSchedule(row);
    if (!schedule.enabled || schedule.trigger.kind !== "cron") return;
    if (schedule.nextRunAt && Date.parse(schedule.nextRunAt) - this.now() > 1000) {
      this.armCron(schedule);
      return;
    }
    const updated: Schedule = {
      ...schedule,
      nextRunAt: this.computeNextRun(schedule.trigger),
      lastRunAt: new Date(this.now()).toISOString(),
    };
    this.persist(updated);
    this.safeEmit("schedule.changed", { schedule: this.maskSchedule(updated) });
    try {
      await this.launchRun(updated, "cron");
    } catch {
      // launchRun persists execution failures. Policy rejection intentionally has no run.
    }
    if (!this.started || this.disposed) return;
    this.armCron(updated);
  }

  private disarm(scheduleId: string): void {
    const timer = this.timers.get(scheduleId);
    if (timer) clearTimeout(timer);
    this.timers.delete(scheduleId);
  }

  private prepareTrigger(trigger: ScheduleTrigger): ScheduleTrigger {
    if (trigger.kind !== "cron") return trigger;
    try {
      parseCron(trigger.expr);
      if (!nextCronAfter(trigger.expr, new Date(this.now()), trigger.tz ?? this.opts.defaultTz)) {
        throw new Error("cron expression never fires");
      }
    } catch (err) {
      throw new PhononError("errInvalidParams", `invalid cron expr: ${(err as Error)?.message ?? "parse error"}`);
    }
    return trigger;
  }

  private computeNextRun(trigger: ScheduleTrigger): string | undefined {
    if (trigger.kind !== "cron") return undefined;
    return nextCronAfter(trigger.expr, new Date(this.now()), trigger.tz ?? this.opts.defaultTz)?.toISOString();
  }

  // -------------------------------------------------------------------------
  // persistence and shaping
  // -------------------------------------------------------------------------

  ack(runId: string, opts?: { lastSeq?: number; finished?: boolean }): void {
    const rt = this.runtimes.get(runId);
    if (rt && opts?.lastSeq !== undefined) {
      rt.ackedSeq = Math.max(rt.ackedSeq, Math.min(opts.lastSeq, rt.seq - 1));
    }
    // Receipt ACK is tenant-authoritative and independent from execution owner.
    // Only finished=true acknowledges run.finished; a pure event ACK must not
    // suppress terminal replay.
    this.opts.store.ackRun(runId, this.opts.tenantId, opts);
  }

  private persistRuntime(rt: RunRuntime, exitReason?: string, error?: string): boolean {
    return this.opts.store.upsertRun(this.runtimeRecord(rt, exitReason, error));
  }

  private runtimeRecord(rt: RunRuntime, exitReason?: string, error?: string): Parameters<PhononStore["upsertRun"]>[0] {
    return {
      id: rt.runId,
      scheduleId: rt.scheduleId,
      tenantId: this.opts.tenantId,
      triggerSource: rt.triggerSource,
      status: rt.status,
      createdAt: new Date(rt.createdAt).toISOString(),
      sessionId: rt.sessionId,
      workflowId: rt.workflowId,
      startedAt: rt.startedAt ? new Date(rt.startedAt).toISOString() : undefined,
      exitReason,
      error,
      transcriptPath: rt.sessionId ? this.transcriptPathFor(rt.sessionId) : undefined,
      resultText: rt.resultText || undefined,
      pushState: "pending",
      ackedSeq: rt.ackedSeq,
      eventSeq: rt.seq,
      attempt: rt.attempt,
      maxAttempts: rt.maxAttempts,
      retryHistoryJson: JSON.stringify(rt.retryHistory),
      inputJson: rt.input === undefined ? undefined : JSON.stringify(rt.input),
      phase: rt.phase,
      retryAt: rt.retryAt,
      ownerId: this.ownerId,
      ownerEpoch: rt.ownerEpoch,
      leaseUntil: this.now() + this.leaseMs,
    };
  }

  private runtimeToRun(rt: RunRuntime, patch: Partial<Run> = {}): Run {
    return {
      id: rt.runId as Run["id"],
      scheduleId: rt.scheduleId as Run["scheduleId"],
      tenantId: this.opts.tenantId as Run["tenantId"],
      triggerSource: rt.triggerSource,
      status: rt.status,
      sessionId: rt.sessionId as Run["sessionId"] | undefined,
      workflowId: rt.workflowId as Run["workflowId"] | undefined,
      startedAt: rt.startedAt ? new Date(rt.startedAt).toISOString() : undefined,
      transcriptPath: rt.sessionId ? this.transcriptPathFor(rt.sessionId) : undefined,
      resultText: rt.resultText || undefined,
      attempt: rt.attempt,
      maxAttempts: rt.maxAttempts,
      retryHistory: rt.retryHistory,
      ...patch,
    } as Run;
  }

  private shapeRunForPush(run: Run, push: SchedulePushConsent): Run {
    if (push === "full") return run;
    if (push === "summary") return { ...run, transcriptPath: undefined };
    return {
      id: run.id,
      scheduleId: run.scheduleId,
      tenantId: run.tenantId,
      triggerSource: run.triggerSource,
      status: run.status,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
    };
  }

  private persist(schedule: Schedule, webhookToken?: string): void {
    this.opts.store.upsertSchedule({
      id: schedule.id,
      tenantId: this.opts.tenantId,
      name: schedule.name,
      enabled: schedule.enabled,
      triggerJson: JSON.stringify(schedule.trigger),
      targetJson: JSON.stringify(schedule.target),
      consentJson: JSON.stringify(schedule.consent),
      policyJson: schedule.policy ? JSON.stringify(schedule.policy) : undefined,
      webhookToken: webhookToken ?? (schedule.trigger.kind === "webhook" ? schedule.trigger.webhookToken : undefined),
      createdAt: schedule.createdAt,
      updatedAt: schedule.updatedAt,
      lastRunAt: schedule.lastRunAt,
      nextRunAt: schedule.nextRunAt,
    });
  }

  private touchLastRun(scheduleId: string, iso: string): void {
    const row = this.opts.store.getSchedule(scheduleId, this.opts.tenantId);
    if (row) this.persist({ ...this.rowToSchedule(row), lastRunAt: iso });
  }

  private assertRunOwner(rt: RunRuntime): boolean {
    const owned = this.opts.store.renewRunLease(
      rt.runId, this.opts.tenantId, this.ownerId, rt.ownerEpoch, this.leaseMs,
    );
    if (owned) return true;
    this.clearRunTimer(rt);
    this.detachMappings(rt);
    this.removeFromQueue(rt);
    this.runtimes.delete(rt.runId);
    return false;
  }

  private renewRunLeases(): void {
    if (this.disposed) return;
    for (const rt of [...this.runtimes.values()]) {
      if (TERMINAL.has(rt.status)) continue;
      if (this.opts.store.renewRunLease(rt.runId, this.opts.tenantId, this.ownerId, rt.ownerEpoch, this.leaseMs)) continue;
      this.clearRunTimer(rt);
      this.detachMappings(rt);
      this.removeFromQueue(rt);
      this.runtimes.delete(rt.runId);
    }
  }

  private reconcileOrphanedRuns(): void {
    if (this.disposed || this.reconciling) return;
    this.reconciling = true;
    const nowIso = new Date(this.now()).toISOString();
    try {
      for (const row of this.opts.store.listActiveRuns(this.opts.tenantId)) {
        const runId = row.id as string;
        if (this.runtimes.has(runId)) continue;
        const ownerEpoch = this.opts.store.claimRun(runId, this.opts.tenantId, this.ownerId, this.leaseMs);
        if (ownerEpoch === undefined) continue;
        const scheduleRow = this.opts.store.getSchedule(row.schedule_id as string, this.opts.tenantId);
        const schedule = scheduleRow ? this.rowToSchedule(scheduleRow) : undefined;
        const consent = schedule?.consent.push ?? "summary";
        const baseRuntime = (phase: RuntimePhase, status: RunStatus, workflowId?: string): RunRuntime => ({
          runId,
          scheduleId: row.schedule_id as string,
          workflowId,
          sessionId: (row.session_id as string | null) ?? undefined,
          status,
          phase,
          subscribed: false,
          seq: Math.max(Number(row.event_seq ?? 0), Number(row.acked_seq ?? -1) + 1),
          ackedSeq: Number(row.acked_seq ?? -1),
          resultText: (row.result_text as string | null) ?? "",
          createdAt: Date.parse(row.created_at as string),
          startedAt: row.started_at ? Date.parse(row.started_at as string) : undefined,
          consent,
          triggerSource: row.trigger_source as RunTriggerSource,
          input: row.input_json ? JSON.parse(row.input_json as string) as TriggerInput : undefined,
          attempt: Number(row.attempt ?? 0),
          maxAttempts: Number(row.max_attempts ?? 1),
          retryHistory: row.retry_history_json ? JSON.parse(row.retry_history_json as string) as RetryAudit[] : [],
          retryAt: row.retry_at == null ? undefined : Number(row.retry_at),
          ownerEpoch,
        });

        if (row.phase === "retry_wait") {
          const rt = baseRuntime("retry_wait", "pending");
          this.runtimes.set(runId, rt);
          this.persistRuntime(rt);
          const delay = Math.max(0, (rt.retryAt ?? this.now()) - this.now());
          const timer = setTimeout(() => {
            rt.timeoutTimer = undefined;
            if (this.disposed || !this.runtimes.has(runId) || rt.phase !== "retry_wait") return;
            void this.launchAttempt(rt);
          }, delay);
          timer.unref?.();
          rt.timeoutTimer = timer;
          continue;
        }

        let workflowId = (row.workflow_id as string | null) ?? undefined;
        if (!workflowId) {
          const correlated = this.opts.store.listWorkflows(this.opts.tenantId).find((workflowRow) => {
            if (!workflowRow.metadata_json) return false;
            try { return JSON.parse(workflowRow.metadata_json as string)?.runId === runId; } catch { return false; }
          });
          workflowId = (correlated?.workflow_id as string | undefined) ?? undefined;
        }
        if (workflowId) {
          try {
            const workflow = this.opts.workflows?.()?.status(workflowId);
            if (workflow && ["queued", "running", "paused"].includes(workflow.status)) {
              const rt = baseRuntime("running", "running", workflowId);
              this.runtimes.set(runId, rt);
              this.workflowToRun.set(workflowId, runId);
              this.persistRuntime(rt);
              const timeoutMs = schedule?.policy?.timeoutMs;
              if (timeoutMs && rt.startedAt) {
                this.armRunTimeout(rt, Math.max(1, timeoutMs - Math.max(0, this.now() - rt.startedAt)));
              }
              continue;
            }
            if (workflow?.status === "completed") {
              this.finishRecoveredRun(row, ownerEpoch, "success", workflowId, workflow.finalText);
              continue;
            }
            if (workflow?.status === "timeout") {
              this.finishRecoveredRun(row, ownerEpoch, "timeout", workflowId, workflow.finalText, workflow.error ?? "workflow timeout");
              continue;
            }
            if (workflow?.status === "cancelled") {
              this.finishRecoveredRun(row, ownerEpoch, "cancelled", workflowId, workflow.finalText, workflow.error ?? "workflow cancelled");
              continue;
            }
            if (workflow?.status === "failed") {
              // A failed active attempt must still honor maxRetries after restart.
              const rt = baseRuntime("running", "running", workflowId);
              this.runtimes.set(runId, rt);
              this.workflowToRun.set(workflowId, runId);
              this.failAttempt(rt, workflow.error ?? "workflow failed", "runtime");
              continue;
            }
          } catch {
            // Fall through to an auditable failure if the workflow checkpoint is missing/corrupt.
          }
        }

        const wasRunning = row.status === "running";
        const persisted = this.opts.store.upsertRun({
          id: runId,
          scheduleId: row.schedule_id as string,
          tenantId: this.opts.tenantId,
          triggerSource: row.trigger_source as string,
          status: wasRunning ? "failed" : "cancelled",
          createdAt: row.created_at as string,
          sessionId: (row.session_id as string) ?? undefined,
          workflowId,
          startedAt: (row.started_at as string) ?? undefined,
          finishedAt: nowIso,
          exitReason: wasRunning ? "scheduler restarted during non-recoverable execution" : "queued launch cancelled by scheduler restart",
          error: wasRunning ? "scheduler restarted during non-recoverable execution" : undefined,
          transcriptPath: (row.transcript_path as string) ?? undefined,
          resultText: (row.result_text as string) ?? undefined,
          usageJson: (row.usage_json as string) ?? undefined,
          pushState: "pending",
          ackedSeq: (row.acked_seq as number) ?? -1,
          eventSeq: (row.event_seq as number) ?? 0,
          attempt: (row.attempt as number) ?? 0,
          maxAttempts: (row.max_attempts as number) ?? 1,
          retryHistoryJson: (row.retry_history_json as string) ?? "[]",
          inputJson: (row.input_json as string) ?? undefined,
          phase: "running",
          ownerId: this.ownerId,
          ownerEpoch,
          leaseUntil: this.now() + this.leaseMs,
        });
        if (persisted) {
          this.opts.store.releaseRun(runId, this.opts.tenantId, this.ownerId, ownerEpoch);
          this.emitStoredFinished(runId);
        }
      }
    } finally {
      this.reconciling = false;
    }
  }

  private finishRecoveredRun(
    row: Record<string, unknown>, ownerEpoch: number, status: RunStatus, workflowId?: string, resultText?: string, error?: string,
  ): void {
    const finishedAt = new Date(this.now()).toISOString();
    const persisted = this.opts.store.upsertRun({
      id: row.id as string,
      scheduleId: row.schedule_id as string,
      tenantId: this.opts.tenantId,
      triggerSource: row.trigger_source as string,
      status,
      createdAt: row.created_at as string,
      sessionId: (row.session_id as string) ?? undefined,
      workflowId: workflowId ?? (row.workflow_id as string) ?? undefined,
      startedAt: (row.started_at as string) ?? undefined,
      finishedAt,
      exitReason: status,
      error,
      transcriptPath: (row.transcript_path as string) ?? undefined,
      resultText: resultText ?? (row.result_text as string) ?? undefined,
      usageJson: (row.usage_json as string) ?? undefined,
      pushState: "pending",
      ackedSeq: (row.acked_seq as number) ?? -1,
      eventSeq: (row.event_seq as number) ?? 0,
      attempt: (row.attempt as number) ?? 0,
      maxAttempts: (row.max_attempts as number) ?? 1,
      retryHistoryJson: (row.retry_history_json as string) ?? "[]",
      inputJson: (row.input_json as string) ?? undefined,
      phase: "running",
      ownerId: this.ownerId,
      ownerEpoch,
      leaseUntil: this.now() + this.leaseMs,
    });
    if (persisted) {
      this.opts.store.releaseRun(row.id as string, this.opts.tenantId, this.ownerId, ownerEpoch);
      this.emitStoredFinished(row.id as string);
    }
  }

  private emitStoredFinished(runId: string): void {
    const row = this.opts.store.getRun(runId, this.opts.tenantId);
    if (!row || !TERMINAL.has(row.status as RunStatus)) return;
    const run = this.rowToRun(row);
    const scheduleRow = this.opts.store.getSchedule(run.scheduleId, this.opts.tenantId);
    const consent = scheduleRow ? this.rowToSchedule(scheduleRow).consent.push : "summary";
    this.safeEmit("run.finished", { run: this.shapeRunForPush(run, consent), push: consent });
  }

  private loadSchedule(scheduleId: string): Schedule {
    const row = this.opts.store.getSchedule(scheduleId, this.opts.tenantId);
    if (!row) throw new PhononError("errInvalidParams", `schedule ${scheduleId} not found`);
    return this.rowToSchedule(row);
  }

  private rowToSchedule(row: Record<string, unknown>): Schedule {
    return {
      id: row.id as Schedule["id"],
      tenantId: row.tenant_id as Schedule["tenantId"],
      name: row.name as string,
      enabled: (row.enabled as number) === 1,
      trigger: JSON.parse(row.trigger_json as string) as ScheduleTrigger,
      target: JSON.parse(row.target_json as string) as ScheduleTarget,
      consent: JSON.parse(row.consent_json as string) as ScheduleConsent,
      policy: row.policy_json ? (JSON.parse(row.policy_json as string) as SchedulePolicy) : undefined,
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
      lastRunAt: (row.last_run_at as string) ?? undefined,
      nextRunAt: (row.next_run_at as string) ?? undefined,
    };
  }

  private rowToRun(row: Record<string, unknown>): Run {
    return {
      id: row.id as Run["id"],
      scheduleId: row.schedule_id as Run["scheduleId"],
      tenantId: row.tenant_id as Run["tenantId"],
      triggerSource: row.trigger_source as RunTriggerSource,
      status: row.status as RunStatus,
      sessionId: ((row.session_id as string) ?? undefined) as Run["sessionId"] | undefined,
      workflowId: ((row.workflow_id as string) ?? undefined) as Run["workflowId"] | undefined,
      startedAt: (row.started_at as string) ?? undefined,
      finishedAt: (row.finished_at as string) ?? undefined,
      exitReason: (row.exit_reason as string) ?? undefined,
      error: (row.error as string) ?? undefined,
      transcriptPath: (row.transcript_path as string) ?? undefined,
      resultText: (row.result_text as string) ?? undefined,
      usage: row.usage_json ? (JSON.parse(row.usage_json as string) as Record<string, unknown>) : undefined,
      attempt: (row.attempt as number) ?? undefined,
      maxAttempts: (row.max_attempts as number) ?? undefined,
      retryHistory: row.retry_history_json ? (JSON.parse(row.retry_history_json as string) as RetryAudit[]) : undefined,
    } as Run;
  }

  private maskSchedule(schedule: Schedule): Schedule {
    if (schedule.trigger.kind === "webhook" && schedule.trigger.webhookToken) {
      return { ...schedule, trigger: { kind: "webhook", webhookToken: MASK } };
    }
    return schedule;
  }

  private mapInput(base: string | undefined, input?: TriggerInput): string | undefined {
    if (input === undefined) return base;
    const injected = typeof input === "string" ? input : JSON.stringify(input);
    return base ? `${base}\n\n${injected}` : injected;
  }

  private storedRunStatus(runId: string): RunStatus {
    const row = this.opts.store.getRun(runId, this.opts.tenantId);
    return (row?.status as RunStatus | undefined) ?? "pending";
  }

  private transcriptPathFor(sessionId: string): string | undefined {
    const dir = this.opts.store.transcriptDir();
    return dir ? `${dir}/${sessionId}.jsonl` : undefined;
  }

  private safeEmit(method: "run.started" | "run.event" | "run.finished" | "schedule.changed", params: unknown): void {
    try {
      this.opts.emit(method, params);
    } catch {
      // Run/schedule state is already durable. Reconnect replay handles finished runs.
    }
  }
}
