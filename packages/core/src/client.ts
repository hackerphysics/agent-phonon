import { WebSocket } from "ws";
import { PhononConnection } from "./index.js";
import { AdapterRegistry } from "./session-engine.js";
import { PROTOCOL_VERSION } from "@agent-phonon/protocol";
import { PhononError } from "./rpc.js";
import { PhononStore } from "./store.js";
import type { RpcTransport } from "./rpc.js";

/**
 * A5: 校验 server URL 的传输安全。
 * 非 loopback 地址必须 wss://（否则 deviceKey 明文传输 + 可被中间人/DNS 劫持冲充 server）。
 * loopback（127.0.0.1 / ::1 / localhost）允许 ws://；wss:// 始终允许。
 * allowInsecure=true 可显式绕过（自担风险）。
 */
export function assertSecureServerUrl(url: string, allowInsecure?: boolean): void {
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new PhononError("errInvalidParams", `invalid server url: ${url}`); }
  const proto = parsed.protocol.toLowerCase();
  if (proto === "wss:" || proto === "https:") return; // 加密，放行
  if (allowInsecure) return; // 显式绕过
  const host = parsed.hostname.toLowerCase();
  const isLoopback = host === "127.0.0.1" || host === "::1" || host === "localhost" || host === "[::1]";
  if (!isLoopback) {
    throw new PhononError(
      "errPolicyDenied",
      `insecure ws:// to non-loopback host "${host}" rejected; use wss:// or pass allowInsecure=true (A5)`,
    );
  }
}

/**
 * phonon 拨出客户端（design §6）：主动连到一个 server URL。
 *
 * 真实场景：连你的 Azure 服务端。测试场景：连项目内 test-server。
 * 拨出后发 connect.hello，server 回 welcome（含 tenantId），随后由 PhononConnection 处理 session.*。
 */
export class PhononClient {
  private ws?: WebSocket;
  private conn?: PhononConnection;
  private wsMessageListener?: (raw: Buffer) => void;
  private dialing = new Set<WebSocket>();
  private registry: AdapterRegistry;
  private serverUrl: string;
  private deviceId: string;
  private deviceKey?: string;
  private trustLocal?: boolean;
  private store: PhononStore;
  private ownsStore: boolean;
  private storeClosed = false;
  private policy?: Partial<import("@agent-phonon/protocol").TenantPolicy>;
  private obs?: import("./observability.js").ObsBus;
  private workspaceRoot?: string;
  private started = false;
  private backoffMs = 1000;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  /** Monotonic lifecycle generation: stale dial/close callbacks cannot publish or reconnect. */
  private generation = 0;
  /** A5: 期望的 tenantId；server welcome 不匹配则拒连。 */
  private expectedTenantId?: string;
  /** A5: 显式允许非 loopback 的明文 ws://（默认禁）。 */
  private allowInsecure?: boolean;
  private maintenance?: import("./maintenance.js").MaintenanceManagerConfig;
  /** Last verified binding for reconnect resume; persisted by server URL across process restarts. */
  private lastTenantId?: string;

  constructor(opts: {
    serverUrl: string;
    deviceId: string;
    registry: AdapterRegistry;
    /** 本地自用：放宽 policy（允许写操作 + 受控根为 allowedProjectRoots）。 */
    trustLocal?: boolean;
    workspaceRoot?: string;
    /** sqlite 文件路径（多连接可共享同一 store）。 */
    dbPath?: string;
    store?: import("./store.js").PhononStore;
    /** 可选：policy 覆盖。 */
    policy?: Partial<import("@agent-phonon/protocol").TenantPolicy>;
    /** 可观测事件总线。 */
    obs?: import("./observability.js").ObsBus;
    /** 设备本地预注册的确定性维护目标。 */
    maintenance?: import("./maintenance.js").MaintenanceManagerConfig;
    /** 设备鉴权 key（随 connect.hello 发送）。 */
    deviceKey?: string;
    /** A5: 期望的 tenantId；server 返回不一致则拒连（防恶意 server 返回别人的 tenant）。 */
    expectedTenantId?: string;
    /** A5: 显式允许非 loopback 的明文 ws://。默认 false（非 loopback 必须 wss://）。 */
    allowInsecure?: boolean;
  }) {
    this.serverUrl = opts.serverUrl;
    this.deviceId = opts.deviceId;
    this.deviceKey = opts.deviceKey;
    this.registry = opts.registry;
    this.trustLocal = opts.trustLocal;
    this.workspaceRoot = opts.workspaceRoot;
    this.ownsStore = !opts.store;
    this.store = opts.store ?? new PhononStore(opts.dbPath ?? ":memory:");
    this.policy = opts.policy;
    this.obs = opts.obs;
    this.maintenance = opts.maintenance;
    this.expectedTenantId = opts.expectedTenantId;
    this.allowInsecure = opts.allowInsecure;
    // A5: 非 loopback 的明文 ws:// 默认拒绝（防 deviceKey 明文传输 + 中间人冲 server）
    assertSecureServerUrl(opts.serverUrl, opts.allowInsecure);
  }

  /** 连接并完成握手，resolve 后即可接收 server 的 session.* 下发。 */
  connect(): Promise<{ tenantId: string }> {
    const generation = ++this.generation;
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.serverUrl);
      this.dialing.add(ws);
      let settled = false;
      let tmpPeer: import("./rpc.js").RpcPeer | undefined;
      let tmpListener: ((raw: Buffer) => void) | undefined;
      let ownedConn: PhononConnection | undefined;
      const inboundQueue: string[] = [];

      const settleReject = (err: unknown): void => {
        if (settled) return;
        settled = true;
        reject(err);
      };
      const transport: RpcTransport = {
        send: (data) => ws.send(data),
        close: () => ws.close(),
      };

      ws.on("open", async () => {
        try {
          const { RpcPeer } = await import("./rpc.js");
          tmpPeer = new RpcPeer(transport, () => { throw new Error("not ready"); });
          // connect.hello is the temporary peer's first request (id=1). Only
          // that response belongs to the handshake peer; every other frame is
          // buffered from the moment the listener is installed.
          tmpListener = (raw: Buffer) => {
            const data = raw.toString();
            try {
              const msg = JSON.parse(data) as { id?: string | number; result?: unknown; error?: unknown };
              if (msg.id === 1 && ("result" in msg || "error" in msg)) {
                void tmpPeer?.handle(data);
                return;
              }
            } catch { /* formal connection will report malformed frames */ }
            inboundQueue.push(data);
          };
          ws.on("message", tmpListener);

          const resumeTenantId = this.expectedTenantId ?? this.lastTenantId ?? this.store.connectionTenant(this.serverUrl);
          const resumeFrom = resumeTenantId
            ? (this.conn?.tenantId === resumeTenantId ? this.conn.resumeFrom() : this.store.outboxResumeFrom(resumeTenantId))
            : [];
          const welcome = (await tmpPeer.request("connect.hello", {
            protocolVersion: PROTOCOL_VERSION,
            deviceId: this.deviceId as never,
            features: [],
            ...(this.deviceKey ? { auth: { deviceKey: this.deviceKey } } : {}),
            ...(resumeFrom.length > 0 ? { resumeFrom } : {}),
            at: new Date().toISOString(),
          })) as { tenantId: string; ackedSeqs?: Array<{ sessionId: string; lastSeq: number }> };

          if (this.expectedTenantId !== undefined && welcome.tenantId !== this.expectedTenantId) {
            throw new PhononError(
              "errUnauthorized",
              `server returned tenantId "${welcome.tenantId}" but expected "${this.expectedTenantId}" (A5 identity check)`,
            );
          }

          tmpPeer.dispose("handshake complete");
          tmpPeer = undefined;
          if (generation !== this.generation) throw new Error("connection attempt superseded");
          this.lastTenantId = welcome.tenantId;
          this.store.rememberConnectionTenant(this.serverUrl, welcome.tenantId, new Date().toISOString());

          // A manual connect or reconnect may overlap an existing healthy
          // socket. Tear down the old connection before publishing its
          // replacement so no scheduler/runtime survives in parallel.
          const previousConn = this.conn;
          const previousWs = this.ws;
          const previousMessageListener = this.wsMessageListener;
          if (previousMessageListener && previousWs) previousWs.off("message", previousMessageListener);
          if (previousConn) await previousConn.dispose("connection replaced");
          if (generation !== this.generation) throw new Error("connection attempt superseded");
          if (ws.readyState !== WebSocket.OPEN) throw new Error("connection closed during handshake");

          const conn = new PhononConnection({
            tenantId: welcome.tenantId,
            transport,
            registry: this.registry,
            trustLocal: this.trustLocal,
            workspaceRoot: this.workspaceRoot,
            store: this.store,
            policy: this.policy,
            obs: this.obs,
            maintenance: this.maintenance,
          });
          ownedConn = conn;
          // welcome ACK is authoritative for already-received events. Persist it
          // before any replay so a crash during replay cannot resurrect them.
          for (const ack of welcome.ackedSeqs ?? []) conn.acknowledgeStream(ack.sessionId, ack.lastSeq);
          let inboundChain = Promise.resolve();
          for (const data of inboundQueue.splice(0)) {
            inboundChain = inboundChain.then(() => conn.handle(data));
          }
          const messageListener = (raw: Buffer): void => {
            inboundChain = inboundChain.then(() => conn.handle(raw.toString()));
          };
          if (tmpListener) ws.off("message", tmpListener);
          tmpListener = undefined;
          ws.on("message", messageListener);
          // Process welcome-adjacent ACKs before replay. New frames are chained
          // behind the buffered frames, preserving wire order.
          await inboundChain;
          if (generation !== this.generation) throw new Error("connection attempt superseded");
          this.ws = ws;
          this.conn = conn;
          this.wsMessageListener = messageListener;
          this.dialing.delete(ws);
          // Publish the replacement before closing the incumbent socket so its
          // close callback cannot clear the newly active connection.
          if (previousWs && previousWs !== ws) {
            try { previousWs.close(); } catch { /* ignore */ }
          }
          this.backoffMs = 1000;
          conn.replayPending();
          settled = true;
          resolve({ tenantId: welcome.tenantId });
        } catch (err) {
          if (tmpListener) ws.off("message", tmpListener);
          tmpPeer?.dispose("handshake failed");
          this.dialing.delete(ws);
          try { ws.close(); } catch { /* ignore */ }
          settleReject(err);
        }
      });

      ws.on("error", (err) => settleReject(err));
      ws.on("close", () => {
        this.dialing.delete(ws);
        if (tmpListener) ws.off("message", tmpListener);
        tmpPeer?.dispose("connection closed during handshake");
        settleReject(new Error("connection closed"));
        if (this.ws === ws) {
          if (this.wsMessageListener) ws.off("message", this.wsMessageListener);
          this.ws = undefined;
          this.wsMessageListener = undefined;
          this.conn = undefined;
          void (async () => {
            await ownedConn?.dispose("connection closed");
            // Socket identity, not the latest dial generation, determines
            // ownership: a failed candidate dial must not disable reconnect for
            // the still-active incumbent connection.
            if (this.started) this.scheduleReconnect();
          })();
        } else if (ownedConn) {
          void ownedConn.dispose("connection closed");
        }
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

  async close(): Promise<void> {
    this.started = false;
    this.generation++;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    const conn = this.conn;
    const ws = this.ws;
    if (this.wsMessageListener && ws) ws.off("message", this.wsMessageListener);
    this.conn = undefined;
    this.ws = undefined;
    this.wsMessageListener = undefined;
    for (const dialing of this.dialing) {
      try { dialing.close(); } catch { /* ignore */ }
    }
    this.dialing.clear();
    try { ws?.close(); } catch { /* ignore */ }
    await conn?.dispose("client closed");
    if (this.ownsStore && !this.storeClosed) {
      this.storeClosed = true;
      this.store.close();
    }
  }

  /** 本连接的 PhononConnection（HookBridge 路由用）。 */
  get connection(): PhononConnection | undefined {
    return this.conn;
  }
}
