import { createHash } from "node:crypto";
import { PhononError } from "./rpc.js";

/**
 * 幂等存储（design D28 / bug-bash P0#2）。
 *
 * 协议定义了 clientRequestId，但 v0 dispatch 没去重。这里实现：
 *   tenantId + method + clientRequestId → 缓存的 result（或 in-flight promise）
 * 断线重发同一请求时返回缓存结果，不重复执行（不丢 + 不重）。
 *
 * v0 内存版，带 TTL + 上限；后续可接 sqlite。
 */
interface Entry {
  promise: Promise<unknown>;
  at: number;
  fingerprint?: string;
}

export class IdempotencyStore {
  private map = new Map<string, Entry>();
  private ttlMs: number;
  private max: number;
  private store?: { idempotencyGet: (k: string) => string | undefined; idempotencyFingerprint?: (k: string) => string | undefined; idempotencyPut: (k: string, r: string, fingerprint?: string) => void };

  constructor(opts?: { ttlMs?: number; max?: number; store?: { idempotencyGet: (k: string) => string | undefined; idempotencyFingerprint?: (k: string) => string | undefined; idempotencyPut: (k: string, r: string, fingerprint?: string) => void } }) {
    this.ttlMs = opts?.ttlMs ?? 10 * 60 * 1000; // 10 分钟
    this.max = opts?.max ?? 5000;
    this.store = opts?.store;
  }

  private key(tenantId: string, method: string, clientRequestId: string): string {
    return `${tenantId}\u0000${method}\u0000${clientRequestId}`;
  }

  /**
   * 若该 (tenant,method,clientRequestId) 已见过，返回其结果；否则执行 fn 并缓存。
   * 内存 + sqlite 两级：跨重启也去重（功能缺口）。clientRequestId 为空不去重。
   */
  async run<T>(
    tenantId: string,
    method: string,
    clientRequestId: string | undefined,
    fn: () => Promise<T>,
    request?: unknown,
  ): Promise<T> {
    if (!clientRequestId) return fn();
    this.gc();
    const k = this.key(tenantId, method, clientRequestId);
    const fingerprint = request === undefined ? undefined : createHash("sha256").update(stableRequestJson(request)).digest("hex");
    const mismatch = () => { throw new PhononError("errInvalidParams", "idempotency payload mismatch or unverifiable legacy identity"); };
    const existing = this.map.get(k);
    if (existing) {
      if (fingerprint !== existing.fingerprint) mismatch();
      return existing.promise as Promise<T>;
    }
    // sqlite 二级：跨重启命中则直接返回缓存结果
    const persisted = this.store?.idempotencyGet(k);
    if (persisted !== undefined) {
      if (fingerprint !== undefined && this.store?.idempotencyFingerprint?.(k) !== fingerprint) mismatch();
      return JSON.parse(persisted) as T;
    }
    const promise = fn();
    this.map.set(k, { promise, at: Date.now(), fingerprint });
    // 成功落 sqlite（跨重启）；失败不缓存（允许重试）
    promise.then(
      (r) => { try {
        this.store?.idempotencyPut(k, JSON.stringify(r), fingerprint);
      } catch { /* ignore */ } },
      () => this.map.delete(k),
    );
    return promise;
  }

  private gc(): void {
    const now = Date.now();
    if (this.map.size < this.max && now % 16 !== 0) return; // 抽样 GC
    for (const [k, v] of this.map) {
      if (now - v.at > this.ttlMs) this.map.delete(k);
    }
    // 仍超限：删最旧
    if (this.map.size >= this.max) {
      const sorted = [...this.map.entries()].sort((a, b) => a[1].at - b[1].at);
      for (let i = 0; i < sorted.length - this.max + 1; i++) this.map.delete(sorted[i]![0]);
    }
  }
}

/** Canonical parsed request; key order does not change retry identity. */
function stableRequestJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableRequestJson).join(",")}]`;
  const row = value as Record<string, unknown>;
  return `{${Object.keys(row).filter(k => row[k] !== undefined).sort().map(k => `${JSON.stringify(k)}:${stableRequestJson(row[k])}`).join(",")}}`;
}
