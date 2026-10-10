import type { ObsBus, Metrics } from "./observability.js";
import { PhononError } from "./rpc.js";

export interface DeliveryConfig { maxPendingBytes: number }
export const DEFAULT_MAX_PENDING_BYTES = 1_073_741_824;

/** Strict validation shared by daemon, clients, connections and standalone stores. */
export function deliveryOptions(input?: Partial<DeliveryConfig>): DeliveryConfig {
  if (input !== undefined && (input === null || typeof input !== "object" || Array.isArray(input))) {
    throw new Error("delivery must be an object");
  }
  const value = input?.maxPendingBytes;
  if (value !== undefined && (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0)) {
    throw new Error("delivery.maxPendingBytes must be a positive safe integer");
  }
  return { maxPendingBytes: value ?? DEFAULT_MAX_PENDING_BYTES };
}

export type DeliveryChannel = "stream" | "workflow" | "run";
export interface DeliveryPending { count: number; bytes: number }
export interface DeliverySnapshot {
  channels: Record<DeliveryChannel, DeliveryPending>;
  pendingCount: number;
  pendingBytes: number;
  maxPendingBytes: number;
  warningBytes: number;
  state: "normal" | "warning" | "critical";
  persistenceHealthy: boolean;
  admissionBlocked: boolean;
  pressureCritical: boolean;
}

/** Device-wide payload pressure monitor. Bytes only warn; actual persistence
 * failure alone gates new work. Never drops an event or invents an inbound queue. */
export class DeliveryCapacity {
  private config: DeliveryConfig;
  private state: DeliverySnapshot["state"] = "normal";
  private persistenceHealthy = true;
  private buses = new Set<ObsBus>();
  private metrics = new Set<Metrics>();
  private backgroundFailures = new Set<string>();

  constructor(private readPending: () => Record<DeliveryChannel, DeliveryPending>, config?: Partial<DeliveryConfig>) {
    this.config = deliveryOptions(config);
  }

  configure(config?: Partial<DeliveryConfig>, bus?: ObsBus, metrics?: Metrics): void {
    if (config !== undefined) this.config = deliveryOptions(config);
    const newBus = bus && !this.buses.has(bus);
    const previousState = this.state;
    if (bus) this.buses.add(bus);
    if (metrics) this.metrics.add(metrics);
    const snapshot = this.snapshot();
    if (newBus && bus && previousState === snapshot.state && snapshot.state !== "normal") {
      try { bus.emitEvent({ category: "stream", level: "warn", event: `delivery.${snapshot.state}`, data: { ...snapshot } }); } catch {}
    }
  }

  snapshot(): DeliverySnapshot {
    let channels: Record<DeliveryChannel, DeliveryPending>;
    try { channels = this.readPending(); } catch (error) { this.failed(); throw error; }
    const pendingBytes = Object.values(channels).reduce((n, c) => n + c.bytes, 0);
    const pendingCount = Object.values(channels).reduce((n, c) => n + c.count, 0);
    const maxPendingBytes = this.config.maxPendingBytes;
    const warningBytes = Math.ceil(maxPendingBytes * 0.8);
    // No hysteresis: critical clears below 100%, warning clears below 80%.
    const state = pendingBytes >= maxPendingBytes ? "critical" : pendingBytes >= warningBytes ? "warning" : "normal";
    const result: DeliverySnapshot = {
      channels, pendingCount, pendingBytes, maxPendingBytes, warningBytes, state,
      persistenceHealthy: this.persistenceHealthy,
      admissionBlocked: !this.persistenceHealthy,
      pressureCritical: state === "critical",
    };
    if (state !== this.state) {
      this.state = state;
      this.emit(state === "normal" ? "delivery.recovered" : `delivery.${state}`, state === "normal" ? "info" : "warn", { ...result });
    }
    for (const m of this.metrics) {
      m.setGauge("delivery_pending_bytes", pendingBytes);
      m.setGauge("delivery_pending_events", pendingCount);
      m.setGauge("delivery_max_pending_bytes", maxPendingBytes);
      m.setGauge("delivery_admission_blocked", Number(result.admissionBlocked));
      m.setGauge("delivery_persistence_healthy", Number(this.persistenceHealthy));
      m.setGauge("delivery_pressure_critical", Number(result.pressureCritical));
      for (const [channel, values] of Object.entries(channels)) {
        m.setGauge(`delivery_pending_bytes{channel="${channel}"}`, values.bytes);
        m.setGauge(`delivery_pending_events{channel="${channel}"}`, values.count);
      }
    }
    return result;
  }

  assertNewWork(): void {
    const snapshot = this.snapshot();
    if (snapshot.admissionBlocked) {
      throw new PhononError("errInternal", "delivery persistence unhealthy; inspect local storage and restart before new work");
    }
  }

  /** Sticky until reopening the store: a successful later write cannot prove no gap. */
  failed(): void {
    if (!this.persistenceHealthy) return;
    this.persistenceHealthy = false;
    this.emit("delivery.persistence_failed", "error", { persistenceHealthy: false });
    for (const m of this.metrics) {
      m.setGauge("delivery_persistence_healthy", 0);
      m.setGauge("delivery_admission_blocked", 1);
    }
  }

  /** Terminal callback for detached work: never writes SQLite, copies errors,
   * or throws a second rejection while trying to report the first failure. */
  backgroundFailed(component: "workflow" | "scheduler"): void {
    try {
      this.failed();
      if (this.backgroundFailures.has(component)) return;
      this.backgroundFailures.add(component);
      this.emit("delivery.background_failed", "error", { component, persistenceHealthy: false });
    } catch { /* the terminal observer must never reject detached work */ }
  }

  private emit(event: string, level: "info" | "warn" | "error", data: Record<string, unknown>): void {
    for (const bus of this.buses) {
      // Observers must not turn a committed write into an apparent persistence failure.
      try { bus.emitEvent({ category: "stream", level, event, data }); } catch { /* isolated observer */ }
    }
  }
}
