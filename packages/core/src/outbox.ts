import type { StreamEvent } from "@agent-phonon/protocol";

/**
 * 下行 outbox（design D29 / bug-bash P1）。
 *
 * stream.event 先入 outbox 再发；server 用 stream.ack{lastSeq} 确认后清理 <= lastSeq。
 * 连接断开期间事件继续缓存；重连后按 seq 补发未 ack 的。
 *
 * 内存索引 + sqlite 真相源。maxEvents 参数仅保留 API 兼容；在协议支持
 * 显式 gap/tombstone 前绝不静默淘汰未 ACK 事件。
 *
 * 注意：seq 是 per-session 单调递增（engine 打的），outbox 按 (sessionId, seq) 索引。
 */
interface Buffered {
  sessionId: string;
  seq: number;
  event: StreamEvent;
}

function compareSessionId(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export class Outbox {
  private buffer: Buffered[] = [];
  private keys = new Set<string>();
  /** per-session 已 ack 的最大 seq。 */
  private acked = new Map<string, number>();
  private store?: import("./store.js").PhononStore;
  private tenantId?: string;

  constructor(opts?: { maxEvents?: number; store?: import("./store.js").PhononStore; tenantId?: string }) {
    // Deliberately do not enforce opts.maxEvents: deleting an unacknowledged
    // sequence would create a permanent gap and violate the contiguous ACK contract.
    void opts?.maxEvents;
    this.store = opts?.store;
    this.tenantId = opts?.tenantId;
    if (this.store && this.tenantId) {
      for (const r of this.store.outboxLoadFinalized(this.tenantId)) this.acked.set(r.sessionId, r.lastSeq);
      for (const r of this.store.outboxLoad(this.tenantId)) {
        // ACK/finalization watermark is written before deletion. If the process
        // died between those sqlite statements, finish the cleanup instead of
        // replaying an already-finalized row.
        if (r.seq <= (this.acked.get(r.sessionId) ?? -1)) {
          this.store.outboxDelete(this.tenantId, r.sessionId, r.seq);
          continue;
        }
        const item = { sessionId: r.sessionId, seq: r.seq, event: JSON.parse(r.payload) as StreamEvent };
        this.buffer.push(item);
        this.keys.add(this.key(r.sessionId, r.seq));
      }
    }
  }

  /** 记录一个待投递事件（已带 seq）。返回是否触发超限丢弃。 */
  enqueue(event: StreamEvent): void {
    const sessionId = (event as { sessionId: string }).sessionId;
    const seq = (event as { seq: number }).seq;
    if (seq <= (this.acked.get(sessionId) ?? -1)) return;
    const key = this.key(sessionId, seq);
    if (this.keys.has(key)) return;
    if (this.store && !this.store.outboxAdd(this.tenantId ?? "", sessionId, seq, JSON.stringify(event), new Date().toISOString())) return;
    this.buffer.push({ sessionId, seq, event });
    this.keys.add(key);
  }

  /** server ack 了某 session 的 seq <= lastSeq → 清理。 */
  ack(sessionId: string, lastSeq: number): void {
    if (!Number.isSafeInteger(lastSeq) || lastSeq < 0) return;
    const prev = this.acked.get(sessionId) ?? -1;
    if (lastSeq <= prev) return;
    const sessionItems = this.buffer.filter((b) => b.sessionId === sessionId);
    if (sessionItems.length === 0) return;
    // ACK 只能推进到本地确实发出/持久化过的边界，恶意或错误的超大 ACK
    // 不能毒化水位并吞掉未来事件。
    const maxKnown = Math.max(...sessionItems.map((b) => b.seq));
    const effective = Math.min(lastSeq, maxKnown);
    if (effective <= prev) return;
    this.acked.set(sessionId, effective);
    const kept: Buffered[] = [];
    for (const item of this.buffer) {
      if (item.sessionId === sessionId && item.seq <= effective) this.keys.delete(this.key(item.sessionId, item.seq));
      else kept.push(item);
    }
    this.buffer = kept;
    this.store?.outboxAck(this.tenantId ?? "", sessionId, effective);
  }

  private key(sessionId: string, seq: number): string {
    return JSON.stringify([sessionId, seq]);
  }

  /** 每个 session 当前第一条未 ACK 事件（connect.hello.resumeFrom 语义）。 */
  resumeFrom(): Array<{ sessionId: string; fromSeq: number }> {
    const first = new Map<string, number>();
    for (const item of this.buffer) {
      const prev = first.get(item.sessionId);
      if (prev === undefined || item.seq < prev) first.set(item.sessionId, item.seq);
    }
    return [...first].sort(([a], [b]) => compareSessionId(a, b)).map(([id, seq]) => ({ sessionId: id, fromSeq: seq }));
  }

  /**
   * 重连补发：返回所有未 ack 的事件（按 sessionId + seq 稳定排序），由调用方重新 send。
   * resumeFrom 与 connect.hello 一致：fromSeq 是第一条待补发事件（inclusive）。
   */
  pending(resumeFrom?: Array<{ sessionId: string; fromSeq: number }>): StreamEvent[] {
    let items = [...this.buffer];
    if (resumeFrom && resumeFrom.length > 0) {
      const map = new Map(resumeFrom.map((r) => [r.sessionId, r.fromSeq]));
      items = items.filter((b) => {
        const from = map.get(b.sessionId);
        return from === undefined || b.seq >= from;
      });
    }
    items.sort((a, b) => compareSessionId(a.sessionId, b.sessionId) || a.seq - b.seq);
    return items.map((b) => b.event);
  }

  get size(): number {
    return this.buffer.length;
  }

  /** Kept for API compatibility; reliable mode never silently drops events. */
  get dropped(): number {
    return 0;
  }
}
