import { randomUUID } from "node:crypto";

/**
 * 双向 JSON-RPC 2.0 peer（server 侧，零 core 依赖）。
 * 每个 device 连接一个。两端皆可作 requester。
 */

export interface Transport {
  send(data: string): void;
  close(): void;
}

export type RpcHandler = (method: string, params: unknown) => Promise<unknown> | unknown;

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
  timer?: ReturnType<typeof setTimeout>;
}

export class RpcPeer {
  private transport: Transport;
  private handler: RpcHandler;
  private pending = new Map<string | number, Pending>();
  private nextId = 1;

  constructor(transport: Transport, handler: RpcHandler) {
    this.transport = transport;
    this.handler = handler;
  }

  request(method: string, params: unknown, timeoutMs = 600000): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = timeoutMs > 0 ? setTimeout(() => { this.pending.delete(id); reject(new Error(`rpc timeout: ${method}`)); }, timeoutMs) : undefined;
      this.pending.set(id, { resolve, reject, timer });
      this.transport.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    });
  }

  notify(method: string, params: unknown): void {
    this.transport.send(JSON.stringify({ jsonrpc: "2.0", method, params }));
  }

  async handle(data: string): Promise<void> {
    let msg: Record<string, unknown>;
    try { msg = JSON.parse(data); } catch { return; }

    // 响应
    if (("result" in msg || "error" in msg) && "id" in msg) {
      const p = this.pending.get(msg.id as string | number);
      if (!p) return;
      this.pending.delete(msg.id as string | number);
      if (p.timer) clearTimeout(p.timer);
      if ("error" in msg && msg.error) p.reject(msg.error);
      else p.resolve((msg as { result: unknown }).result);
      return;
    }

    // 请求 / 通知
    if (typeof msg.method === "string") {
      const isNotification = !("id" in msg) || msg.id === undefined || msg.id === null;
      try {
        const result = await this.handler(msg.method, msg.params);
        if (!isNotification) this.transport.send(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: result ?? null }));
      } catch (err) {
        if (!isNotification) {
          this.transport.send(JSON.stringify({
            jsonrpc: "2.0", id: msg.id,
            error: { code: -32000, message: (err as Error)?.message ?? "error" },
          }));
        }
      }
    }
  }

  rejectAll(reason: string): void {
    for (const [, p] of this.pending) { if (p.timer) clearTimeout(p.timer); p.reject(new Error(reason)); }
    this.pending.clear();
  }
}

export function newId(): string {
  return randomUUID();
}
