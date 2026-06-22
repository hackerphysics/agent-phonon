import { WebSocket } from "ws";
import { randomUUID } from "node:crypto";

/**
 * OpenClaw Gateway WebSocket 客户端（传输层）。
 *
 * 借鉴 LMA src/openclaw-client.ts 的传输层（握手 + RPC + 事件路由），
 * 不抄其飞书业务逻辑。协议帧：{type:"req"|"res"|"event", id, method, params/payload}。
 *
 * 握手：连上 → 收 connect.challenge(event) → 发 connect(req, operator scopes + token) → hello-ok。
 */

const GATEWAY_PROTOCOL_MIN = 1;
const GATEWAY_PROTOCOL_MAX = 10;

export interface GatewayConfig {
  /** ws 或 http URL（http 会自动转 ws）。 */
  baseUrl: string;
  token: string;
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
  timer: NodeJS.Timeout;
}

/** Gateway 事件回调：method=事件名（agent/chat/...），payload=事件体。 */
export type GatewayEventHandler = (event: string, payload: Record<string, unknown>) => void;

export class GatewayClient {
  private ws: WebSocket | null = null;
  private connected = false;
  private config: GatewayConfig;
  private pending = new Map<string, Pending>();
  private eventHandlers = new Set<GatewayEventHandler>();
  private connectPromise: Promise<void> | null = null;

  constructor(config: GatewayConfig) {
    this.config = config;
  }

  onEvent(handler: GatewayEventHandler): void {
    this.eventHandlers.add(handler);
  }

  isConnected(): boolean {
    return this.connected;
  }

  connect(): Promise<void> {
    if (this.connectPromise) return this.connectPromise;
    this.connectPromise = this.doConnect();
    return this.connectPromise;
  }

  private doConnect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const wsUrl = this.config.baseUrl.replace(/^http/, "ws");
      const ws = new WebSocket(wsUrl);
      this.ws = ws;
      let handshakeDone = false;

      ws.on("message", (raw: Buffer) => {
        let frame: Record<string, unknown>;
        try {
          frame = JSON.parse(raw.toString());
        } catch {
          return;
        }

        if (!handshakeDone) {
          if (frame.type === "event" && frame.event === "connect.challenge") {
            ws.send(
              JSON.stringify({
                type: "req",
                id: "connect-1",
                method: "connect",
                params: {
                  minProtocol: GATEWAY_PROTOCOL_MIN,
                  maxProtocol: GATEWAY_PROTOCOL_MAX,
                  client: { id: "gateway-client", version: "0.0.1", platform: "linux", mode: "backend" },
                  role: "operator",
                  scopes: ["operator.read", "operator.write", "operator.admin"],
                  auth: { token: this.config.token },
                  userAgent: "agent-phonon/0.0.1",
                },
              }),
            );
          } else if (frame.type === "res" && frame.ok && (frame.payload as { type?: string })?.type === "hello-ok") {
            handshakeDone = true;
            this.connected = true;
            resolve();
          } else if (frame.type === "res" && !frame.ok) {
            reject(new Error(`handshake failed: ${JSON.stringify(frame.error)}`));
          }
          return;
        }

        // 响应
        if (frame.type === "res" && frame.id) {
          const p = this.pending.get(frame.id as string);
          if (p) {
            this.pending.delete(frame.id as string);
            clearTimeout(p.timer);
            if (frame.ok) p.resolve(frame.payload);
            else p.reject(new Error(`RPC error: ${JSON.stringify(frame.error)}`));
          }
          return;
        }

        // 事件 → 分发给所有 handler
        if (frame.type === "event" && typeof frame.event === "string") {
          for (const h of this.eventHandlers) {
            try {
              h(frame.event, (frame.payload as Record<string, unknown>) ?? {});
            } catch {
              /* ignore handler error */
            }
          }
        }
      });

      ws.on("error", (err) => {
        if (!handshakeDone) reject(err);
      });
      ws.on("close", () => {
        this.connected = false;
        this.connectPromise = null;
        for (const [, p] of this.pending) {
          clearTimeout(p.timer);
          p.reject(new Error("gateway connection closed"));
        }
        this.pending.clear();
      });
    });
  }

  /** 发一个 Gateway RPC。 */
  async rpc(method: string, params: unknown, timeoutMs = 120000): Promise<Record<string, unknown>> {
    if (!this.connected) await this.connect();
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`RPC timeout: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      this.ws!.send(JSON.stringify({ type: "req", id, method, params }));
    });
  }

  close(): void {
    this.ws?.close();
    this.ws = null;
    this.connected = false;
  }
}
