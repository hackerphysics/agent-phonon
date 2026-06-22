import type { StreamEvent } from "@agent-phonon/protocol";

/**
 * 下行 outbox（design D29 / bug-bash P1）。
 *
 * stream.event 先入 outbox 再发；server 用 stream.ack{lastSeq} 确认后清理 <= lastSeq。
 * 连接断开期间事件继续缓存；重连后按 seq 补发未 ack 的。
 *
 * v0 内存版，带上限（超限丢最旧 + 计数告警）。后续可接 sqlite outbox_events 表。
 *
 * 注意：seq 是 per-session 单调递增（engine 打的），outbox 按 (sessionId, seq) 索引。
 */
interface Buffered {
  sessionId: string;
  seq: number;
  event: StreamEvent;
}

export class Outbox {
  private buffer: Buffered[] = [];
  private maxEvents: number;
  private droppedCount = 0;
  /** per-session 已 ack 的最大 seq。 */
  private acked = new Map<string, number>();
  private store?: import("./store.js").PhononStore;
  private tenantId?: string;

  constructor(opts?: { maxEvents?: number; store?: import("./store.js").PhononStore; tenantId?: string }) {
    this.maxEvents = opts?.maxEvents ?? 10000;
    this.store = opts?.store;
    this.tenantId = opts?.tenantId;
    if (this.store && this.tenantId) {
      for (const r of this.store.outboxLoad(this.tenantId)) {
        this.buffer.push({ sessionId: r.sessionId, seq: r.seq, event: JSON.parse(r.payload) as StreamEvent });
      }
    }
  }

  /** 记录一个待投递事件（已带 seq）。返回是否触发超限丢弃。 */
  enqueue(event: StreamEvent): void {
    const sessionId = (event as { sessionId: string }).sessionId;
    const seq = (event as { seq: number }).seq;
    this.buffer.push({ sessionId, seq, event });
    this.store?.outboxAdd(this.tenantId ?? "", sessionId, seq, JSON.stringify(event), new Date().toISOString());
    if (this.buffer.length > this.maxEvents) {
      this.buffer.shift(); // 丢最旧
      this.droppedCount++;
    }
  }

  /** server ack 了某 session 的 seq <= lastSeq → 清理。 */
  ack(sessionId: string | undefined, lastSeq: number): void {
    if (sessionId) {
      const prev = this.acked.get(sessionId) ?? -1;
      if (lastSeq > prev) this.acked.set(sessionId, lastSeq);
      this.buffer = this.buffer.filter((b) => !(b.sessionId === sessionId && b.seq <= lastSeq));
    } else {
      // 全局 ack（无 sessionId）：按 seq 清所有 session 中 <= lastSeq 的（少用）
      this.buffer = this.buffer.filter((b) => b.seq > lastSeq);
    }
    this.store?.outboxAck(this.tenantId ?? "", sessionId, lastSeq);
  }

  /**
   * 重连补发：返回所有未 ack 的事件（按 seq 排序），由调用方重新 send。
   * resumeFrom 可指定每个 session 从哪个 seq 开始（server 告知 ackedSeqs）。
   */
  pending(resumeFrom?: Array<{ sessionId: string; fromSeq: number }>): StreamEvent[] {
    let items = [...this.buffer];
    if (resumeFrom && resumeFrom.length > 0) {
      const map = new Map(resumeFrom.map((r) => [r.sessionId, r.fromSeq]));
      items = items.filter((b) => {
        const from = map.get(b.sessionId);
        return from === undefined || b.seq > from;
      });
    }
    items.sort((a, b) => a.seq - b.seq);
    return items.map((b) => b.event);
  }

  get size(): number {
    return this.buffer.length;
  }

  get dropped(): number {
    return this.droppedCount;
  }
}
