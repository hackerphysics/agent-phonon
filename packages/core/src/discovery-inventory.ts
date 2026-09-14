import { AgentDescriptor, type DiscoveryChangedParams } from "@agent-phonon/protocol";
import type { AgentAdapter } from "./adapter.js";
import type { ObsBus } from "./observability.js";

export interface DiscoveryOptions {
  /** Owner-only cadence; reads share this TTL. Default 30s, range 100ms–1h. */
  pollIntervalMs?: number;
  /** Per-adapter deadline. Default 20s, range 50ms–120s. */
  scanTimeoutMs?: number;
}
export function discoveryOptions(opts: DiscoveryOptions = {}): Required<DiscoveryOptions> {
  const pollIntervalMs = opts.pollIntervalMs ?? 30_000;
  const scanTimeoutMs = opts.scanTimeoutMs ?? 20_000;
  if (!Number.isInteger(pollIntervalMs) || pollIntervalMs < 100 || pollIntervalMs > 3_600_000) throw new Error("discovery.pollIntervalMs must be an integer between 100 and 3600000");
  if (!Number.isInteger(scanTimeoutMs) || scanTimeoutMs < 50 || scanTimeoutMs > 120_000) throw new Error("discovery.scanTimeoutMs must be an integer between 50 and 120000");
  return { pollIntervalMs, scanTimeoutMs };
}

// Only the protocol's scan timestamp is volatile. Object key/model order is not
// semantic; capability arrays are sets too. Compare all other schema fields.
function stable(value: unknown): string {
  if (Array.isArray(value)) return JSON.stringify(value.map(stable).sort());
  if (value && typeof value === "object") return JSON.stringify(Object.entries(value).filter(([k, v]) => k !== "scannedAt" && v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, stable(v)]));
  return JSON.stringify(value);
}
type Sink = (event: DiscoveryChangedParams) => void;

/** One cache/scanner per registry, independent of tenant/socket lifetime. */
export class DiscoveryInventory {
  private readonly options: Required<DiscoveryOptions>;
  private rows = new Map<string, AgentDescriptor[]>();
  private sinks = new Set<Sink>();
  private users = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private flight?: Promise<void>;
  private busy = new Set<AgentAdapter>();
  private controllers = new Set<AbortController>();
  private generation = 0;
  private disposed = false;
  private lastScan = -Infinity;
  private initialized = false;

  constructor(private adapters: () => AgentAdapter[], opts: DiscoveryOptions = {}, private obs?: ObsBus) {
    this.options = discoveryOptions(opts);
  }

  /** Returns an idempotent lease release; the daemon can hold a sink-less lease. */
  acquire(sink?: Sink): () => void {
    if (this.disposed) throw new Error("discovery inventory disposed");
    if (sink) this.sinks.add(sink);
    if (++this.users === 1) {
      const generation = this.generation;
      void this.refresh().then(() => {
        // A reconnect may acquire while the previous lease's cancelled scan
        // settles. Start this generation rather than reviving the old timer.
        if (!this.disposed && this.users > 0 && generation === this.generation && this.lastScan === -Infinity) void this.refresh();
      });
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (sink) this.sinks.delete(sink);
      if (--this.users === 0) this.stop();
    };
  }

  async list(): Promise<AgentDescriptor[]> {
    if (this.disposed) throw new Error("discovery inventory disposed");
    if (this.flight) await this.flight;
    else if (Date.now() - this.lastScan >= this.options.pollIntervalMs) await this.refresh();
    return structuredClone([...this.rows.values()].flat());
  }

  /** Explicit owner/embedded refresh, not a new wire method. Coalesces all callers. */
  refresh(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (this.flight) return this.flight;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const generation = this.generation;
    const baseline = !this.initialized;
    const adapters = this.adapters();
    const flight = Promise.all(adapters.map(async (adapter) => {
      // A timed-out non-cooperative adapter cannot accumulate overlapping scans.
      if (this.busy.has(adapter)) return;
      this.busy.add(adapter);
      const controller = new AbortController();
      this.controllers.add(controller);
      let deadline: ReturnType<typeof setTimeout> | undefined;
      let onAbort!: () => void;
      const cancelled = new Promise<never>((_, reject) => {
        onAbort = () => reject(new Error("scan aborted"));
        controller.signal.addEventListener("abort", onAbort, { once: true });
        deadline = setTimeout(() => controller.abort(), this.options.scanTimeoutMs);
      });
      const work = Promise.resolve().then(() => {
        controller.signal.throwIfAborted();
        return adapter.discoverAgents(controller.signal);
      });
      void work.then(() => this.busy.delete(adapter), () => this.busy.delete(adapter));
      try {
        const result = await Promise.race([work, cancelled]);
        const next = result.map(row => AgentDescriptor.parse(row));
        const ids = new Set<string>();
        for (const row of next) {
          const runtime = row.agentId.split(":")[0];
          if (runtime !== adapter.name || ids.has(row.agentId)) throw new Error("invalid adapter inventory identity");
          ids.add(row.agentId);
        }
        if (this.disposed || generation !== this.generation) return;
        const previous = this.rows.get(adapter.name) ?? [];
        this.rows.set(adapter.name, structuredClone(next));
        if (!baseline) this.changes(previous, next);
      } catch {
        // Do not expose native output/paths/credentials in error logs. Preserve
        // last-good rows, including on invalid schema and timeout.
        if (!this.disposed && generation === this.generation) this.report(controller.signal.aborted ? "discovery.scan_timeout" : "discovery.scan_failed", adapter.name);
      } finally {
        if (deadline) clearTimeout(deadline);
        controller.signal.removeEventListener("abort", onAbort);
        this.controllers.delete(controller);
      }
    })).then(() => {
      if (this.disposed || generation !== this.generation) return;
      for (const [name, rows] of this.rows) {
        if (!adapters.some(a => a.name === name)) {
          this.rows.delete(name);
          if (!baseline) this.changes(rows, []);
        }
      }
      this.initialized = true;
      this.lastScan = Date.now();
    }).finally(() => {
      if (this.flight === flight) this.flight = undefined;
      if (!this.disposed && generation === this.generation && this.users > 0) {
        this.timer = setTimeout(() => { this.timer = undefined; void this.refresh(); }, this.options.pollIntervalMs);
        this.timer.unref();
      }
    });
    this.flight = flight;
    return flight;
  }

  private changes(previous: AgentDescriptor[], next: AgentDescriptor[]): void {
    const before = new Map(previous.map(a => [a.agentId, a]));
    const after = new Map(next.map(a => [a.agentId, a]));
    for (const row of next) {
      const old = before.get(row.agentId);
      if (old && stable(old) === stable(row)) continue;
      const kind = !old ? "agent_added" : stable(old.models) !== stable(row.models) ? "models_changed" : "agent_updated";
      this.emit({ kind, agentId: row.agentId, snapshot: row, at: new Date().toISOString() });
    }
    for (const row of previous) if (!after.has(row.agentId)) this.emit({ kind: "agent_removed", agentId: row.agentId, at: new Date().toISOString() });
  }

  private emit(event: DiscoveryChangedParams): void {
    for (const sink of this.sinks) {
      try { sink(structuredClone(event)); }
      catch { this.report("discovery.delivery_failed"); }
    }
  }
  private report(event: string, adapter?: string): void {
    try {
      if (this.obs) this.obs.emitEvent({ category: "adapter", level: "warn", event, data: adapter ? { adapter } : undefined });
      else console.warn(`[discovery] ${event}${adapter ? ` (${adapter})` : ""}`);
    } catch { console.warn(`[discovery] ${event}; observer failed`); }
  }
  private stop(): void {
    this.generation++;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    for (const controller of this.controllers) controller.abort();
    // Keep an in-flight generation coalesced until it settles; never publish it.
    this.lastScan = -Infinity;
  }
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.stop();
    this.sinks.clear();
    await this.flight;
  }
}
