import { EventEmitter } from "node:events";
import {
  JSON_RPC_CODES,
  type JsonRpcId,
  type MethodName,
  type ParamsOf,
  type ResultOf,
} from "@agent-phonon/protocol";

/**
 * 双向 JSON-RPC 2.0 peer（design D2）。
 *
 * 抽象掉传输：构造时传入一个 send 函数（把字符串发出去）和把收到的字符串喂给 handle()。
 * 两端皆可作 requester。core 与 test-server 都用它。
 */

export interface RpcTransport {
  /** 把一条 JSON 文本发出去。 */
  send(data: string): void;
  /** 关闭传输。 */
  close(): void;
}

/** 方法处理器：收到对端请求时调用，返回 result（或抛错）。 */
export type RpcHandler = (method: string, params: unknown) => Promise<unknown> | unknown;

interface Pending {
  method?: string;
  requestId?: string;
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
  timer?: ReturnType<typeof setTimeout>;
}

export class RpcPeer extends EventEmitter {
  private transport: RpcTransport;
  private handler: RpcHandler;
  private pending = new Map<string | number, Pending>();
  private nextId = 1;
  private disposed = false;

  constructor(transport: RpcTransport, handler: RpcHandler) {
    super();
    this.transport = transport;
    this.handler = handler;
  }

  /** 发一个请求（需要响应），强类型版本。 */
  async request<M extends MethodName>(method: M, params: ParamsOf<M>): Promise<ResultOf<M>> {
    return this.requestRaw(method, params) as Promise<ResultOf<M>>;
  }

  /** 发一个请求（弱类型，内部用）。 */
  /** 发一个请求（弱类型，内部用）。timeoutMs 缺省 120s，0=不超时。 */
  requestRaw(method: string, params: unknown, timeoutMs = 120000): Promise<unknown> {
    if (this.disposed) return Promise.reject(new Error("RPC peer disposed"));
    const id = this.nextId++;
    const msg = { jsonrpc: "2.0", id, method, params };
    return new Promise((resolve, reject) => {
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              this.pending.delete(id);
              reject(new PhononError("errInternal", `RPC timeout: ${method}`));
            }, timeoutMs)
          : undefined;
      const requestId = (params as { requestId?: string } | undefined)?.requestId;
      this.pending.set(id, { resolve, reject, timer, method, requestId });
      try { this.transport.send(JSON.stringify(msg)); }
      catch (err) { if (timer) clearTimeout(timer); this.pending.delete(id); reject(err); }
    });
  }

  /** Resolve the same pending RPC via its application-level correlation id. */
  resolveRequest(method: string, requestId: string, value: unknown): boolean {
    for (const [id, pending] of this.pending) {
      if (pending.method !== method || pending.requestId !== requestId) continue;
      this.pending.delete(id);
      if (pending.timer) clearTimeout(pending.timer);
      pending.resolve(value);
      return true;
    }
    return false;
  }

  /** 发一个通知（不需要响应）。 */
  notify<M extends MethodName>(method: M, params: ParamsOf<M>): void {
    this.notifyRaw(method, params);
  }

  notifyRaw(method: string, params: unknown): void {
    if (this.disposed) return;
    this.transport.send(JSON.stringify({ jsonrpc: "2.0", method, params }));
  }

  /** 喂入一条收到的文本。 */
  async handle(data: string): Promise<void> {
    if (this.disposed) return;
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(data);
    } catch {
      this.sendError(null, JSON_RPC_CODES.parseError, "parse error");
      return;
    }

    // 响应（成功/失败）
    if (("result" in msg || "error" in msg) && "id" in msg) {
      const p = this.pending.get(msg.id as string | number);
      if (!p) return;
      this.pending.delete(msg.id as string | number);
      if (p.timer) clearTimeout(p.timer);
      if ("error" in msg && msg.error) {
        p.reject(msg.error);
      } else {
        p.resolve((msg as { result: unknown }).result);
      }
      return;
    }

    // 请求 / 通知
    if (typeof msg.method === "string") {
      const isNotification = !("id" in msg) || msg.id === undefined || msg.id === null;
      try {
        const result = await this.handler(msg.method, msg.params);
        if (!isNotification) {
          this.transport.send(
            JSON.stringify({ jsonrpc: "2.0", id: msg.id as JsonRpcId, result: result ?? null }),
          );
        }
      } catch (err) {
        if (!isNotification) {
          const appCode = (err as { appCode?: string })?.appCode;
          const message = (err as Error)?.message ?? "internal error";
          this.transport.send(
            JSON.stringify({
              jsonrpc: "2.0",
              id: msg.id as JsonRpcId,
              error: {
                code: JSON_RPC_CODES.applicationError,
                message,
                ...(appCode ? { data: { appCode } } : {}),
              },
            }),
          );
        }
      }
      return;
    }
  }

  private sendError(id: JsonRpcId | null, code: number, message: string): void {
    this.transport.send(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }));
  }

  /** 连接断开时：拒绝所有 pending，避免悬挂。 */
  rejectAllPending(reason: string): void {
    for (const [, p] of this.pending) {
      if (p.timer) clearTimeout(p.timer);
      p.reject(new Error(reason));
    }
    this.pending.clear();
  }

  /** Permanently release pending timers and EventEmitter listeners. */
  dispose(reason = "RPC peer disposed"): void {
    if (this.disposed) return;
    this.disposed = true;
    this.rejectAllPending(reason);
    this.removeAllListeners();
  }
}

/** 带 appCode 的应用错误，handler 抛它，peer 会编码进 JSON-RPC error.data。 */
export class PhononError extends Error {
  appCode: string;
  constructor(appCode: string, message?: string) {
    super(message ?? appCode);
    this.appCode = appCode;
  }
}
