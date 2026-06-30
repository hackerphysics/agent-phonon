import { randomBytes } from "node:crypto";
import { PhononError } from "./rpc.js";
import { nextCronAfter } from "./cron.js";
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
} from "@agent-phonon/protocol";

/**
 * L4 Scheduling Engine —— device-authoritative 定时任务调度器。
 *
 * 设计（docs/L4_SCHEDULING.md）：
 * - device 持调度真相：本地 cron 时钟触发，server 断连也照跑。
 * - 一个 run = 一次 L1 session（v1 先支持 session；workflow 留接口）。
 * - run 的 event stream / transcript / 主动推送全复用现有 session 能力。
 * - 三种 trigger（cron / webhook / manual）收敛到同一条 launchRun 路径。
 * - consent.push 决定 run 结束后推送给 server 的粒度。
 *
 * 生命周期独立于单条 WS 连接：daemon 级持有，跨重连存活（离线自治）。
 * emit 通道（run.started/run.event/run.finished/schedule.changed）由 owner 注入，
 * 断连时 owner 可把 emit 设为 no-op，靠 store 的 push_state 在重连后补推。
 */

interface RunRuntime {
  runId: string;
  scheduleId: string;
  sessionId?: string;
  status: RunStatus;
  /** server 是否订阅了该 run 的实时 event stream。 */
  subscribed: boolean;
  /** run.event 单调 seq。 */
  seq: number;
  /** 终态产物文本累积。 */
  resultText: string;
  startedAt: number;
  timeoutTimer?: ReturnType<typeof setTimeout>;
  consent: SchedulePushConsent;
  triggerSource: RunTriggerSource;
}

export interface SchedulerEngineOptions {
  tenantId: string;
  engine: SessionEngine;
  store: PhononStore;
  resolveProjectCwd: (project: string) => string;
  /** 可选 workflow 引擎（runKind=workflow）。 */
  workflows?: () => WorkflowEngine | undefined;
  /** 推送通道。owner 在断连时可换成 no-op。 */
  emit: (method: "run.started" | "run.event" | "run.finished" | "schedule.changed", params: unknown) => void;
  /** 本地 policy 门：launchRun 前调用，抛错则拒绝执行（webhook 触发也走这里）。 */
  assertRunAllowed?: (schedule: Schedule, source: RunTriggerSource) => void;
  /** 设备本地时区（cron tz 缺省值）。 */
  defaultTz?: string;
  /** 测试用：注入「现在」。 */
  now?: () => number;
}

const MASK = "***";

export class SchedulerEngine {
  private opts: SchedulerEngineOptions;
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private runtimes = new Map<string, RunRuntime>();
  /** sessionId → runId，用于 onStreamEvent 路由。 */
  private sessionToRun = new Map<string, string>();
  private idSeq = 0;
  private started = false;

  constructor(opts: SchedulerEngineOptions) {
    this.opts = opts;
  }

  private now(): number {
    return this.opts.now ? this.opts.now() : Date.now();
  }

  // =========================================================================
  // 生命周期
  // =========================================================================

  /** daemon 启动时调用：从 store 装载所有 cron schedule，排下次触发。 */
  start(): void {
    if (this.started) return;
    this.started = true;
    for (const row of this.opts.store.listSchedules(this.opts.tenantId)) {
      const s = this.rowToSchedule(row);
      if (s.enabled && s.trigger.kind === "cron") this.armCron(s);
    }
  }

  stop(): void {
    this.started = false;
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    for (const rt of this.runtimes.values()) {
      if (rt.timeoutTimer) clearTimeout(rt.timeoutTimer);
    }
  }

  /** 重连后补推未 ack 的终态 run（at-least-once）。 */
  replayUnacked(): void {
    for (const row of this.opts.store.listUnackedFinishedRuns(this.opts.tenantId)) {
      const run = this.rowToRun(row);
      const sched = this.opts.store.getSchedule(run.scheduleId);
      const consent: SchedulePushConsent = sched
        ? this.rowToSchedule(sched).consent.push
        : "summary";
      this.opts.emit("run.finished", { run: this.shapeRunForPush(run, consent), push: consent });
    }
  }

  // =========================================================================
  // schedule CRUD
  // =========================================================================

  create(params: {
    name: string;
    trigger: ScheduleTrigger;
    target: ScheduleTarget;
    consent?: ScheduleConsent;
    policy?: SchedulePolicy;
    enabled?: boolean;
  }): { schedule: Schedule; webhookToken?: string } {
    const id = `sch-${this.now()}-${this.idSeq++}`;
    const nowIso = new Date(this.now()).toISOString();
    let trigger = params.trigger;
    let webhookToken: string | undefined;
    if (trigger.kind === "webhook") {
      webhookToken = trigger.webhookToken || `whk_${randomBytes(24).toString("hex")}`;
      trigger = { kind: "webhook", webhookToken };
    }
    const consent: ScheduleConsent = params.consent ?? { push: "summary" };
    const enabled = params.enabled ?? true;
    const schedule: Schedule = {
      id: id as Schedule["id"],
      tenantId: this.opts.tenantId as Schedule["tenantId"],
      name: params.name,
      enabled,
      trigger,
      target: params.target,
      consent,
      policy: params.policy,
      createdAt: nowIso,
      updatedAt: nowIso,
      nextRunAt: undefined,
    };
    if (enabled && trigger.kind === "cron") {
      schedule.nextRunAt = this.computeNextRun(trigger);
    }
    this.persist(schedule, webhookToken);
    if (enabled && trigger.kind === "cron") this.armCron(schedule);
    this.opts.emit("schedule.changed", { schedule: this.maskSchedule(schedule) });
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
    let trigger = params.trigger ?? existing.trigger;
    let webhookToken = existing.trigger.kind === "webhook" ? existing.trigger.webhookToken : undefined;
    if (params.trigger && params.trigger.kind === "webhook") {
      // 保留旧 token（除非显式给了新值），避免 update 把 webhook 入口意外作废
      webhookToken = params.trigger.webhookToken || webhookToken || `whk_${randomBytes(24).toString("hex")}`;
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
    // 重排 cron
    this.disarm(updated.id);
    updated.nextRunAt = enabled && trigger.kind === "cron" ? this.computeNextRun(trigger) : undefined;
    this.persist(updated, webhookToken);
    if (enabled && trigger.kind === "cron") this.armCron(updated);
    this.opts.emit("schedule.changed", { schedule: this.maskSchedule(updated) });
    return { schedule: this.maskSchedule(updated) };
  }

  setEnabled(scheduleId: string, enabled: boolean): { schedule: Schedule } {
    return this.update({ scheduleId, enabled });
  }

  delete(scheduleId: string): { scheduleId: string; deleted: boolean } {
    const exists = this.opts.store.getSchedule(scheduleId);
    this.disarm(scheduleId);
    this.opts.store.deleteSchedule(scheduleId);
    this.opts.emit("schedule.changed", { scheduleId, deleted: true });
    return { scheduleId, deleted: !!exists };
  }

  list(filter?: { enabled?: boolean; triggerKind?: "cron" | "webhook" | "manual"; reveal?: boolean; limit?: number }): { schedules: Schedule[] } {
    const rows = this.opts.store.listSchedules(this.opts.tenantId);
    let schedules = rows.map((r) => this.rowToSchedule(r));
    if (filter?.enabled !== undefined) schedules = schedules.filter((s) => s.enabled === filter.enabled);
    if (filter?.triggerKind) schedules = schedules.filter((s) => s.trigger.kind === filter.triggerKind);
    if (filter?.limit) schedules = schedules.slice(0, filter.limit);
    return { schedules: schedules.map((s) => (filter?.reveal ? s : this.maskSchedule(s))) };
  }

  get(scheduleId: string, reveal?: boolean): { schedule: Schedule } {
    const s = this.loadSchedule(scheduleId);
    return { schedule: reveal ? s : this.maskSchedule(s) };
  }

  // =========================================================================
  // 触发
  // =========================================================================

  /** 手动触发一次 run（manual / 测试 cron / 重放 webhook 都走它）。 */
  async trigger(params: { scheduleId: string; source?: RunTriggerSource; input?: Record<string, unknown> }): Promise<{ scheduleId: string; runId: string; status: RunStatus }> {
    const schedule = this.loadSchedule(params.scheduleId);
    const runId = await this.launchRun(schedule, params.source ?? "manual", params.input);
    const rt = this.runtimes.get(runId);
    return { scheduleId: params.scheduleId, runId, status: rt?.status ?? "pending" };
  }

  /** webhook 入口：server 验签后按 token 找 schedule 并触发。 */
  async triggerByWebhook(token: string, input?: Record<string, unknown>): Promise<{ scheduleId: string; runId: string; status: RunStatus }> {
    const row = this.opts.store.getScheduleByWebhookToken(token);
    if (!row) throw new PhononError("errInvalidParams", "no schedule for webhook token");
    const schedule = this.rowToSchedule(row);
    if (!schedule.enabled) throw new PhononError("errPolicyDenied", "schedule disabled");
    const runId = await this.launchRun(schedule, "webhook", input);
    const rt = this.runtimes.get(runId);
    return { scheduleId: schedule.id, runId, status: rt?.status ?? "pending" };
  }

  // =========================================================================
  // run 观测
  // =========================================================================

  runGet(runId: string): { run: Run } {
    const live = this.runtimes.get(runId);
    const row = this.opts.store.getRun(runId);
    if (!row) throw new PhononError("errInvalidParams", `run ${runId} not found`);
    const run = this.rowToRun(row);
    if (live) run.status = live.status; // 内存里更新（running）优先
    return { run };
  }

  runsList(scheduleId: string, opts?: { status?: string; limit?: number }): { runs: Run[] } {
    const rows = this.opts.store.listRunsForSchedule(scheduleId, opts);
    return { runs: rows.map((r) => this.rowToRun(r)) };
  }

  subscribe(runId: string): { runId: string; subscribed: boolean; sessionId?: string } {
    const rt = this.runtimes.get(runId);
    if (!rt) {
      // 已结束的 run：无实时流可订阅，返回 false（server 应改用 transcript / runs.list）
      const row = this.opts.store.getRun(runId);
      if (!row) throw new PhononError("errInvalidParams", `run ${runId} not found`);
      return { runId, subscribed: false, sessionId: (row.session_id as string) ?? undefined };
    }
    rt.subscribed = true;
    return { runId, subscribed: true, sessionId: rt.sessionId };
  }

  unsubscribe(runId: string): { runId: string; subscribed: boolean } {
    const rt = this.runtimes.get(runId);
    if (rt) rt.subscribed = false;
    return { runId, subscribed: false };
  }

  async cancel(runId: string, reason?: string): Promise<{ runId: string; status: RunStatus }> {
    const rt = this.runtimes.get(runId);
    if (!rt) {
      const row = this.opts.store.getRun(runId);
      if (!row) throw new PhononError("errInvalidParams", `run ${runId} not found`);
      return { runId, status: this.rowToRun(row).status };
    }
    if (rt.sessionId) {
      try { await this.opts.engine.interrupt(this.opts.tenantId, rt.sessionId, reason); } catch { /* best effort */ }
    }
    this.finishRun(rt, "cancelled", reason ?? "cancelled");
    return { runId, status: "cancelled" };
  }

  // =========================================================================
  // stream.event 路由（判定 run 终态）
  // =========================================================================

  /** 由 PhononConnection 在每条 stream.event 上调用。 */
  onStreamEvent(ev: StreamEvent): void {
    const sessionId = (ev as { sessionId?: string }).sessionId;
    if (!sessionId) return;
    const runId = this.sessionToRun.get(sessionId);
    if (!runId) return;
    const rt = this.runtimes.get(runId);
    if (!rt) return;

    const evAny = ev as Record<string, unknown>;

    // 订阅了就实时转发（带 runId 标记）
    if (rt.subscribed) {
      const seq = rt.seq++;
      this.opts.emit("run.event", { runId, scheduleId: rt.scheduleId, seq, event: ev });
    }

    if (evAny.type === "message" && typeof evAny.text === "string") {
      rt.resultText += evAny.text as string;
    } else if (evAny.type === "result") {
      const text = (evAny.text as string | undefined) || rt.resultText || "";
      rt.resultText = text;
      const status = (evAny.status as string) === "error" ? "failed" : "success";
      const usage = evAny.usage as Record<string, unknown> | undefined;
      this.finishRun(rt, status as RunStatus, undefined, usage);
    } else if (evAny.type === "error") {
      this.finishRun(rt, "failed", (evAny.message as string) ?? "error");
    }
  }

  // =========================================================================
  // 内部：触发 → 启动 run
  // =========================================================================

  private async launchRun(schedule: Schedule, source: RunTriggerSource, _input?: Record<string, unknown>): Promise<string> {
    // policy / consent 门：webhook 触发也不例外
    this.opts.assertRunAllowed?.(schedule, source);

    // overlap policy：上次还在跑时如何处理
    const policy = schedule.policy ?? { overlap: "skip" as const, maxRetries: 0, catchUp: false };
    const overlap = policy.overlap ?? "skip";
    const activeForSchedule = [...this.runtimes.values()].find(
      (rt) => rt.scheduleId === schedule.id && (rt.status === "running" || rt.status === "pending"),
    );
    if (activeForSchedule && overlap === "skip") {
      // 记一条 skipped run 便于审计
      const runId = `run-${this.now()}-${this.idSeq++}`;
      const nowIso = new Date(this.now()).toISOString();
      this.opts.store.upsertRun({
        id: runId, scheduleId: schedule.id, tenantId: this.opts.tenantId,
        triggerSource: source, status: "skipped", createdAt: nowIso,
        finishedAt: nowIso, exitReason: "overlap_skip", pushState: "acked",
      });
      return runId;
    }

    const runId = `run-${this.now()}-${this.idSeq++}`;
    const nowIso = new Date(this.now()).toISOString();
    const rt: RunRuntime = {
      runId,
      scheduleId: schedule.id,
      status: "pending",
      subscribed: false,
      seq: 0,
      resultText: "",
      startedAt: this.now(),
      consent: schedule.consent.push,
      triggerSource: source,
    };
    this.runtimes.set(runId, rt);

    const baseRun: Run = {
      id: runId as Run["id"],
      scheduleId: schedule.id,
      tenantId: this.opts.tenantId as Run["tenantId"],
      triggerSource: source,
      status: "pending",
      startedAt: nowIso,
    };
    this.opts.store.upsertRun({
      id: runId, scheduleId: schedule.id, tenantId: this.opts.tenantId,
      triggerSource: source, status: "pending", createdAt: nowIso, startedAt: nowIso,
      pushState: "pending",
    });

    // 标记 schedule 最近触发
    this.touchLastRun(schedule.id, nowIso);

    try {
      if (schedule.target.runKind === "workflow") {
        // v1：workflow 形态留接口位，先报不支持，避免半成品语义
        throw new PhononError("errCapabilityUnsupported", "runKind=workflow not implemented in L4 v1; use runKind=session");
      }
      const cwd = this.opts.resolveProjectCwd(schedule.target.project);
      const created = await this.opts.engine.create({
        tenantId: this.opts.tenantId,
        project: schedule.target.project,
        cwd,
        agent: schedule.target.agent ?? "",
        model: schedule.target.model ?? "default",
        verbosity: "messages",
        agentConfig: schedule.target.agentConfig,
      });
      rt.sessionId = created.sessionId;
      rt.status = "running";
      this.sessionToRun.set(created.sessionId, runId);

      const transcriptPath = this.transcriptPathFor(created.sessionId);
      this.opts.store.upsertRun({
        id: runId, scheduleId: schedule.id, tenantId: this.opts.tenantId,
        triggerSource: source, status: "running", createdAt: nowIso, startedAt: nowIso,
        sessionId: created.sessionId, transcriptPath, pushState: "pending",
      });
      baseRun.status = "running";
      baseRun.sessionId = created.sessionId as Run["sessionId"];
      baseRun.transcriptPath = transcriptPath;
      this.opts.emit("run.started", { run: baseRun });

      // 超时
      if (policy.timeoutMs && policy.timeoutMs > 0) {
        rt.timeoutTimer = setTimeout(() => {
          if (rt.sessionId) this.opts.engine.interrupt(this.opts.tenantId, rt.sessionId, "timeout").catch(() => {});
          this.finishRun(rt, "timeout", `exceeded timeout ${policy.timeoutMs}ms`);
        }, policy.timeoutMs);
        (rt.timeoutTimer as { unref?: () => void }).unref?.();
      }

      // 发任务（不 await 完成，靠 stream.event 终态判定）
      await this.opts.engine.send(this.opts.tenantId, created.sessionId, schedule.target.prompt ?? "", {
        verbosity: "messages",
        skills: schedule.target.skills,
      });
    } catch (err) {
      this.finishRun(rt, "failed", (err as Error)?.message?.slice(0, 300) ?? "launch failed");
    }
    return runId;
  }

  private finishRun(rt: RunRuntime, status: RunStatus, exitReason?: string, usage?: Record<string, unknown>): void {
    if (["success", "failed", "timeout", "cancelled", "skipped"].includes(rt.status)) return; // 幂等
    rt.status = status;
    if (rt.timeoutTimer) { clearTimeout(rt.timeoutTimer); rt.timeoutTimer = undefined; }
    const nowIso = new Date(this.now()).toISOString();
    const run: Run = {
      id: rt.runId as Run["id"],
      scheduleId: rt.scheduleId as Run["scheduleId"],
      tenantId: this.opts.tenantId as Run["tenantId"],
      triggerSource: rt.triggerSource,
      status,
      sessionId: rt.sessionId as Run["sessionId"] | undefined,
      startedAt: new Date(rt.startedAt).toISOString(),
      finishedAt: nowIso,
      exitReason,
      error: status === "failed" || status === "timeout" ? exitReason : undefined,
      transcriptPath: rt.sessionId ? this.transcriptPathFor(rt.sessionId) : undefined,
      resultText: rt.resultText || undefined,
      usage,
    };
    this.opts.store.upsertRun({
      id: run.id, scheduleId: run.scheduleId, tenantId: this.opts.tenantId,
      triggerSource: run.triggerSource, status, createdAt: run.startedAt ?? nowIso,
      sessionId: run.sessionId, startedAt: run.startedAt, finishedAt: nowIso,
      exitReason: run.exitReason, error: run.error, transcriptPath: run.transcriptPath,
      resultText: run.resultText, usageJson: usage ? JSON.stringify(usage) : undefined,
      pushState: "pending", ackedSeq: rt.seq - 1,
    });

    // 按 consent.push 推送终态
    this.opts.emit("run.finished", { run: this.shapeRunForPush(run, rt.consent), push: rt.consent });

    // 清理（保留 store 记录，清内存）
    if (rt.sessionId) this.sessionToRun.delete(rt.sessionId);
    this.runtimes.delete(rt.runId);
  }

  /** server ack 终态 run → 标记 acked，停止补推。 */
  ack(runId: string, opts?: { lastSeq?: number; finished?: boolean }): void {
    const row = this.opts.store.getRun(runId);
    if (!row) return;
    const r = this.rowToRun(row);
    this.opts.store.upsertRun({
      id: r.id, scheduleId: r.scheduleId, tenantId: this.opts.tenantId,
      triggerSource: r.triggerSource, status: r.status, createdAt: r.startedAt ?? new Date(this.now()).toISOString(),
      sessionId: r.sessionId, startedAt: r.startedAt, finishedAt: r.finishedAt,
      exitReason: r.exitReason, error: r.error, transcriptPath: r.transcriptPath,
      resultText: r.resultText, usageJson: r.usage ? JSON.stringify(r.usage) : undefined,
      pushState: opts?.finished === false ? "pushed" : "acked",
      ackedSeq: opts?.lastSeq ?? -1,
    });
  }

  // =========================================================================
  // 同意协议：按 push 粒度裁剪 run
  // =========================================================================

  private shapeRunForPush(run: Run, push: SchedulePushConsent): Run {
    if (push === "full") return run;
    if (push === "summary") {
      return { ...run, transcriptPath: undefined };
    }
    // status-only：零内容外泄
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

  // =========================================================================
  // cron 时钟
  // =========================================================================

  private armCron(schedule: Schedule): void {
    if (schedule.trigger.kind !== "cron") return;
    this.disarm(schedule.id);
    const nextIso = schedule.nextRunAt ?? this.computeNextRun(schedule.trigger);
    if (!nextIso) return;
    const delay = Math.max(0, Date.parse(nextIso) - this.now());
    // setTimeout 上限保护：超过 ~24.8 天分段
    const capped = Math.min(delay, 2 ** 31 - 1);
    const timer = setTimeout(() => {
      this.timers.delete(schedule.id);
      void this.onCronFire(schedule.id);
    }, capped);
    // 不阻止进程退出（守护进程里由 daemon 生命周期保活；测试/CLI 不被调度器吊住）。
    (timer as { unref?: () => void }).unref?.();
    this.timers.set(schedule.id, timer);
  }

  private async onCronFire(scheduleId: string): Promise<void> {
    const row = this.opts.store.getSchedule(scheduleId);
    if (!row) return;
    const schedule = this.rowToSchedule(row);
    if (!schedule.enabled || schedule.trigger.kind !== "cron") return;
    // 若 setTimeout 因 cap 提前醒来，nextRunAt 还没到 → 重新 arm
    if (schedule.nextRunAt && Date.parse(schedule.nextRunAt) - this.now() > 1000) {
      this.armCron(schedule);
      return;
    }
    try {
      await this.launchRun(schedule, "cron");
    } catch { /* launch 内部已记 failed run */ }
    // 排下一次
    const next = this.computeNextRun(schedule.trigger);
    const updated: Schedule = { ...schedule, nextRunAt: next, lastRunAt: new Date(this.now()).toISOString() };
    this.persist(updated);
    this.opts.emit("schedule.changed", { schedule: this.maskSchedule(updated) });
    this.armCron(updated);
  }

  private disarm(scheduleId: string): void {
    const t = this.timers.get(scheduleId);
    if (t) { clearTimeout(t); this.timers.delete(scheduleId); }
  }

  private computeNextRun(trigger: ScheduleTrigger): string | undefined {
    if (trigger.kind !== "cron") return undefined;
    const tz = trigger.tz ?? this.opts.defaultTz;
    const next = nextCronAfter(trigger.expr, new Date(this.now()), tz);
    return next ? next.toISOString() : undefined;
  }

  // =========================================================================
  // 持久化 helpers
  // =========================================================================

  private persist(schedule: Schedule, webhookToken?: string): void {
    const token = webhookToken ?? (schedule.trigger.kind === "webhook" ? schedule.trigger.webhookToken : undefined);
    this.opts.store.upsertSchedule({
      id: schedule.id,
      tenantId: this.opts.tenantId,
      name: schedule.name,
      enabled: schedule.enabled,
      triggerJson: JSON.stringify(schedule.trigger),
      targetJson: JSON.stringify(schedule.target),
      consentJson: JSON.stringify(schedule.consent),
      policyJson: schedule.policy ? JSON.stringify(schedule.policy) : undefined,
      webhookToken: token,
      createdAt: schedule.createdAt,
      updatedAt: schedule.updatedAt,
      lastRunAt: schedule.lastRunAt,
      nextRunAt: schedule.nextRunAt,
    });
  }

  private touchLastRun(scheduleId: string, iso: string): void {
    const row = this.opts.store.getSchedule(scheduleId);
    if (!row) return;
    const s = this.rowToSchedule(row);
    this.persist({ ...s, lastRunAt: iso });
  }

  private loadSchedule(scheduleId: string): Schedule {
    const row = this.opts.store.getSchedule(scheduleId);
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
      sessionId: (row.session_id as string) as Run["sessionId"] | undefined ?? undefined,
      workflowId: (row.workflow_id as string) as Run["workflowId"] | undefined ?? undefined,
      startedAt: (row.started_at as string) ?? undefined,
      finishedAt: (row.finished_at as string) ?? undefined,
      exitReason: (row.exit_reason as string) ?? undefined,
      error: (row.error as string) ?? undefined,
      transcriptPath: (row.transcript_path as string) ?? undefined,
      resultText: (row.result_text as string) ?? undefined,
      usage: row.usage_json ? (JSON.parse(row.usage_json as string) as Record<string, unknown>) : undefined,
    };
  }

  /** 脱敏 webhookToken（与 secrets redaction 一致）。 */
  private maskSchedule(s: Schedule): Schedule {
    if (s.trigger.kind === "webhook" && s.trigger.webhookToken) {
      return { ...s, trigger: { kind: "webhook", webhookToken: MASK } };
    }
    return s;
  }

  private transcriptPathFor(sessionId: string): string | undefined {
    const dir = this.opts.store.transcriptDir();
    if (!dir) return undefined;
    return `${dir}/${sessionId}.jsonl`;
  }
}
