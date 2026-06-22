import { WebSocket } from "ws";
import { PhononConnection } from "./index.js";
import { AdapterRegistry } from "./session-engine.js";
import { PROTOCOL_VERSION } from "@agent-phonon/protocol";
import type { RpcTransport } from "./rpc.js";

/**
 * phonon 拨出客户端（design §6）：主动连到一个 server URL。
 *
 * 真实场景：连你的 Azure 服务端。测试场景：连项目内 test-server。
 * 拨出后发 connect.hello，server 回 welcome（含 tenantId），随后由 PhononConnection 处理 session.*。
 */
export class PhononClient {
  private ws?: WebSocket;
  private conn?: PhononConnection;
  private registry: AdapterRegistry;
  private serverUrl: string;
  private deviceId: string;
  private deviceKey?: string;
  private resolveProjectCwd?: (project: string) => string;
  private trustLocal?: boolean;
  private dbPath?: string;
  private store?: import("./store.js").PhononStore;
  private policy?: import("@agent-phonon/protocol").TenantPolicy;
  private obs?: import("./observability.js").ObsBus;
  private workspaceRoot?: string;
  private started = false;
  private backoffMs = 1000;
  private reconnectTimer?: ReturnType<typeof setTimeout>;

  constructor(opts: {
    serverUrl: string;
    deviceId: string;
    registry: AdapterRegistry;
    resolveProjectCwd?: (project: string) => string;
    /** 本地自用：放宽 policy（允许写操作 + 受控根为 allowedProjectRoots）。 */
    trustLocal?: boolean;
    workspaceRoot?: string;
    /** sqlite 文件路径（多连接可共享同一 store）。 */
    dbPath?: string;
    store?: import("./store.js").PhononStore;
    /** 可选：policy 覆盖。 */
    policy?: import("@agent-phonon/protocol").TenantPolicy;
    /** 可观测事件总线。 */
    obs?: import("./observability.js").ObsBus;
    /** 设备鉴权 key（随 connect.hello 发送）。 */
    deviceKey?: string;
  }) {
    this.serverUrl = opts.serverUrl;
    this.deviceId = opts.deviceId;
    this.deviceKey = opts.deviceKey;
    this.registry = opts.registry;
    this.resolveProjectCwd = opts.resolveProjectCwd;
    this.trustLocal = opts.trustLocal;
    this.workspaceRoot = opts.workspaceRoot;
    this.dbPath = opts.dbPath;
    this.store = opts.store;
    this.policy = opts.policy;
    this.obs = opts.obs;
  }

  /** 连接并完成握手，resolve 后即可接收 server 的 session.* 下发。 */
  connect(): Promise<{ tenantId: string }> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.serverUrl);
      this.ws = ws;

      const transport: RpcTransport = {
        send: (data) => ws.send(data),
        close: () => ws.close(),
      };

      ws.on("open", async () => {
        // 握手前先建连接处理器，但 tenantId 要等 welcome；先用占位，再在 welcome 后重建
        // 简化：先发 hello 作为一个 request，拿到 welcome.tenantId 后再建 PhononConnection。
        try {
          // 临时 peer 仅用于 hello/welcome
          const { RpcPeer } = await import("./rpc.js");
          const tmpPeer = new RpcPeer(transport, () => {
            throw new Error("not ready");
          });
          // 把 message 暂时喂给 tmpPeer
          const tmpListener = (raw: Buffer) => tmpPeer.handle(raw.toString());
          ws.on("message", tmpListener);

          const welcome = (await tmpPeer.request("connect.hello", {
            protocolVersion: PROTOCOL_VERSION,
            deviceId: this.deviceId as never,
            features: [],
            ...(this.deviceKey ? { auth: { deviceKey: this.deviceKey } } : {}),
            at: new Date().toISOString(),
          })) as { tenantId: string };

          // 切换到正式连接处理器
          ws.off("message", tmpListener);
          const conn = new PhononConnection({
            tenantId: welcome.tenantId,
            transport,
            registry: this.registry,
            resolveProjectCwd: this.resolveProjectCwd,
            trustLocal: this.trustLocal,
            workspaceRoot: this.workspaceRoot,
            dbPath: this.dbPath,
            store: this.store,
            policy: this.policy,
            obs: this.obs,
          });
          this.conn = conn;
          ws.on("message", (raw: Buffer) => conn.handle(raw.toString()));
          this.backoffMs = 1000; // 连上重置 backoff
          // 重连补发（D29）：server welcome.ackedSeqs → resumeFrom
          const wAck = (welcome as { ackedSeqs?: Array<{ sessionId: string; lastSeq: number }> }).ackedSeqs;
          if (wAck && wAck.length > 0) {
            conn.replayPending(wAck.map((a) => ({ sessionId: a.sessionId, fromSeq: a.lastSeq })));
          }
          resolve({ tenantId: welcome.tenantId });
        } catch (err) {
          reject(err);
        }
      });

      ws.on("error", (err) => {
        if (!this.started) reject(err);
      });
      ws.on("close", () => {
        this.conn?.onClose();
        this.conn = undefined; // 清 conn，health 不误报 connected（修 B8）
        if (this.started) this.scheduleReconnect();
      });
    });
  }

  /**
   * 长期运行：连上后自动保持，断线指数退避重连（bug-bash P1）。
   * 首次连接失败也进重试（不抛）。
   */
  async start(): Promise<void> {
    this.started = true;
    try {
      await this.connect();
    } catch {
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (!this.started || this.reconnectTimer) return;
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, 30000); // 上限 30s
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = undefined;
      try {
        await this.connect();
      } catch {
        this.scheduleReconnect();
      }
    }, delay);
  }

  close(): void {
    this.started = false; // 停止重连
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.ws?.close();
  }

  /** 本连接的 PhononConnection（HookBridge 路由用）。 */
  get connection(): PhononConnection | undefined {
    return this.conn;
  }
}
