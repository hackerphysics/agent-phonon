import { EventEmitter } from "node:events";

/**
 * 可观测性核心（design D34 / bug-bash B5）。
 *
 * 产品理念：可观测性是放权的前提——人愿意让 agent 自动干活，前提是关键时刻能掀盖看里面。
 * 黑盒不可放权，可观测才敢放权。
 *
 * 统一「可观测事件」源头 + 多消费者（结构化日志 / audit 落库 / 指标 / HTTP 端点）。
 */

/** 事件类别。 */
export type ObsCategory =
  | "daemon" // daemon 起停
  | "connection" // 到 server 的连接状态
  | "adapter" // adapter 可用性
  | "session" // session 生命周期
  | "turn" // 一轮对话/任务
  | "tool" // agent 工具调用（最贴「agent 在干什么」）
  | "hitl" // 人在回路拦截
  | "stream" // 流式输出（含自发）
  | "error"; // 错误

export type ObsLevel = "debug" | "info" | "warn" | "error";

/** 统一可观测事件。 */
export interface ObsEvent {
  ts: string; // ISO 时间
  category: ObsCategory;
  level: ObsLevel;
  /** 事件名，如 "session.create" / "turn.start" / "tool.call" / "hitl.fired"。 */
  event: string;
  /** 关联标识（便于按维度过滤/回溯）。 */
  tenantId?: string;
  sessionId?: string;
  agentId?: string;
  projectId?: string;
  turnId?: string;
  /** 人类可读摘要。 */
  msg?: string;
  /** 结构化附加数据。 */
  data?: Record<string, unknown>;
}

/**
 * 事件总线：进程内唯一事件源。各组件 emit，多消费者 on。
 */
export class ObsBus extends EventEmitter {
  emitEvent(e: Omit<ObsEvent, "ts"> & { ts?: string }): void {
    const full: ObsEvent = { ts: e.ts ?? new Date().toISOString(), ...e };
    this.emit("event", full);
  }
  onEvent(handler: (e: ObsEvent) => void): void {
    this.on("event", handler);
  }
}

/**
 * 极简结构化 JSON logger（零依赖，符合单设备原则）。
 * 从 ObsBus 消费，每事件一行 JSON 写 stdout（或注入的 sink）。
 */
export class StructuredLogger {
  private minLevel: ObsLevel;
  private sink: (line: string) => void;
  private static order: Record<ObsLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

  constructor(opts?: { level?: ObsLevel; sink?: (line: string) => void }) {
    this.minLevel = opts?.level ?? "info";
    this.sink = opts?.sink ?? ((l) => process.stdout.write(l + "\n"));
  }

  attach(bus: ObsBus): void {
    bus.onEvent((e) => this.write(e));
  }

  write(e: ObsEvent): void {
    if (StructuredLogger.order[e.level] < StructuredLogger.order[this.minLevel]) return;
    this.sink(JSON.stringify(e));
  }
}

/**
 * 实时指标（counters + gauges）。从 ObsBus 消费维护，HTTP /metrics 读取。
 */
export class Metrics {
  private counters = new Map<string, number>();
  private gauges = new Map<string, number>();
  private startedAt = Date.now();

  attach(bus: ObsBus): void {
    bus.onEvent((e) => this.observe(e));
  }

  private observe(e: ObsEvent): void {
    this.inc(`events_total{category="${e.category}"}`);
    if (e.event === "session.create") this.inc("sessions_created_total");
    if (e.event === "session.terminate") this.inc("sessions_terminated_total");
    if (e.event === "turn.start") this.inc("turns_started_total");
    if (e.event === "turn.end") this.inc("turns_ended_total");
    if (e.event === "tool.call") this.inc("tool_calls_total");
    if (e.event === "hitl.fired") this.inc("hitl_fired_total");
    if (e.event.startsWith("hitl.") && e.data?.action === "abort") this.inc("hitl_blocked_total");
    if (e.level === "error") this.inc("errors_total");
  }

  inc(key: string, by = 1): void {
    this.counters.set(key, (this.counters.get(key) ?? 0) + by);
  }
  setGauge(key: string, v: number): void {
    this.gauges.set(key, v);
  }

  /** Prometheus 文本格式快照。 */
  prometheus(): string {
    const lines: string[] = [`phonon_uptime_seconds ${Math.floor((Date.now() - this.startedAt) / 1000)}`];
    for (const [k, v] of this.counters) lines.push(`phonon_${k} ${v}`);
    for (const [k, v] of this.gauges) lines.push(`phonon_${k} ${v}`);
    return lines.join("\n") + "\n";
  }

  /** JSON 快照。 */
  json(): Record<string, unknown> {
    return {
      uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1000),
      counters: Object.fromEntries(this.counters),
      gauges: Object.fromEntries(this.gauges),
    };
  }
}

/**
 * Audit sink：从 ObsBus 消费 → 落 sqlite audit_events（可观测回溯）。
 */
export class AuditSink {
  private store: { auditAdd: (e: { ts: string; category: string; level: string; event: string; tenantId?: string; sessionId?: string; agentId?: string; projectId?: string; turnId?: string; msg?: string; data?: string }) => void };
  constructor(store: { auditAdd: (e: { ts: string; category: string; level: string; event: string; tenantId?: string; sessionId?: string; agentId?: string; projectId?: string; turnId?: string; msg?: string; data?: string }) => void }) {
    this.store = store;
  }
  attach(bus: ObsBus): void {
    bus.onEvent((e) => {
      try {
        this.store.auditAdd({
          ts: e.ts, category: e.category, level: e.level, event: e.event,
          tenantId: e.tenantId, sessionId: e.sessionId, agentId: e.agentId,
          projectId: e.projectId, turnId: e.turnId, msg: e.msg,
          data: e.data ? JSON.stringify(e.data) : undefined,
        });
      } catch {
        /* audit 不能拖垫主流程 */
      }
    });
  }
}
