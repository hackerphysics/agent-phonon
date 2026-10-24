import { WebSocket } from "ws";
import { PhononConnection } from "./index.js";
import { AdapterRegistry } from "./session-engine.js";
import { PROTOCOL_VERSION } from "@agent-phonon/protocol";
import { PhononError } from "./rpc.js";
import { PhononStore } from "./store.js";
import type { RpcTransport } from "./rpc.js";

const CONNECTION_TIMING = {
  connectTimeoutMs: 15_000,
  handshakeTimeoutMs: 10_000,
  helloTimeoutMs: 5_000,
  pingIntervalMs: 10_000,
  pongTimeoutMs: 5_000,
  stableConnectionMs: 30_000,
  reconnectBaseMs: 1_000,
  reconnectMaxMs: 30_000,
};

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
  private readonly managedMcp?: import("./index.js").ManagedMcpHandlers;
  private ws?: WebSocket;
  private conn?: PhononConnection;
  private dialing = new Map<WebSocket, (reason: string) => void>();
  private stopActive?: (reason: string) => void;
  /** Every replacement waits for all retired runtimes, including unpublished candidates. */
  private teardown: Promise<void> = Promise.resolve();
  private closed = false;
  private closing?: Promise<void>;
  private readonly timing: typeof CONNECTION_TIMING;
  private readonly random: () => number;
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
  private employeeProfileFileBrokerRoot?:string;
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
    managedMcp?: import("./index.js").ManagedMcpHandlers;
    serverUrl: string;
    deviceId: string;
    registry: AdapterRegistry;
    /** 本地自用：放宽 policy（允许写操作 + 受控根为 allowedProjectRoots）。 */
    trustLocal?: boolean;
    workspaceRoot?: string;
    employeeProfileFileBrokerRoot?:string;
    /** sqlite 文件路径（多连接可共享同一 store）。 */
    dbPath?: string;
    store?: import("./store.js").PhononStore;
    delivery?: Partial<import("./delivery-capacity.js").DeliveryConfig>;
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
    /** @internal Device-local timing injection for tests; never remote/env configuration. */
    connectionTiming?: Partial<typeof CONNECTION_TIMING> & { random?: () => number };
  }) {
    this.managedMcp = opts.managedMcp;
    const { random = Math.random, ...timing } = opts.connectionTiming ?? {};
    this.timing = { ...CONNECTION_TIMING, ...timing };
    for (const value of Object.values(this.timing)) {
      if (!Number.isSafeInteger(value) || value <= 0) throw new Error("invalid connection timing");
    }
    if (this.timing.connectTimeoutMs > 20_000 || this.timing.handshakeTimeoutMs > 20_000 || this.timing.helloTimeoutMs > 20_000
      || this.timing.reconnectBaseMs > this.timing.reconnectMaxMs || this.timing.reconnectMaxMs > 30_000) throw new Error("invalid connection timing bounds");
    this.random = random;
    this.backoffMs = this.timing.reconnectBaseMs;
    this.serverUrl = opts.serverUrl;
    this.deviceId = opts.deviceId;
    this.deviceKey = opts.deviceKey;
    this.registry = opts.registry;
    this.trustLocal = opts.trustLocal;
    this.workspaceRoot = opts.workspaceRoot;
    this.employeeProfileFileBrokerRoot=opts.employeeProfileFileBrokerRoot;
    this.ownsStore = !opts.store;
    this.store = opts.store ?? new PhononStore(opts.dbPath ?? ":memory:");
    this.store.delivery.configure(opts.delivery, opts.obs);
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
    if (this.closed) return Promise.reject(new Error("client closed"));
    const generation = ++this.generation;
    this.clearReconnect();
    for (const cancel of this.dialing.values()) cancel("connection attempt superseded");
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.serverUrl, { handshakeTimeout: this.timing.handshakeTimeoutMs });
      let settled = false;
      let stopped = false;
      let tmpPeer: import("./rpc.js").RpcPeer | undefined;
      let tmpListener: ((raw: Buffer) => void) | undefined;
      let ownedConn: PhononConnection | undefined;
      let messageListener: ((raw: Buffer) => void) | undefined;
      let pingTimer: ReturnType<typeof setTimeout> | undefined;
      let pongTimer: ReturnType<typeof setTimeout> | undefined;
      let stableTimer: ReturnType<typeof setTimeout> | undefined;
      let pendingPong: Buffer | undefined;
      let pingSequence = 0;
      let stable = false;
      let receivedPong = false;
      const inboundQueue: string[] = [];

      const settleReject = (err: unknown): void => {
        if (settled) return;
        settled = true;
        reject(err);
      };
      const assertCurrent = (): void => {
        if (stopped || this.closed || generation !== this.generation || ws.readyState !== WebSocket.OPEN) throw new Error("connection attempt superseded or closed");
      };
      const stop = (error: unknown): void => {
        if (stopped) return;
        stopped = true;
        clearTimeout(deadline);
        clearTimeout(pingTimer);
        clearTimeout(pongTimer);
        clearTimeout(stableTimer);
        pendingPong = undefined;
        ws.off("pong", onPong);
        if (tmpListener) ws.off("message", tmpListener);
        if (messageListener) ws.off("message", messageListener);
        tmpPeer?.dispose("connection ended");
        tmpPeer = undefined;
        inboundQueue.length = 0;
        this.dialing.delete(ws);
        if (this.ws === ws) {
          this.ws = undefined;
          this.conn = undefined;
          this.stopActive = undefined;
        }
        if (ownedConn) this.retire(ownedConn, error instanceof Error ? error.message : "connection ended");
        settleReject(error);
        // close() can wait 30 seconds for an unreachable peer. Dead or superseded
        // sockets must release the descriptor immediately, including CONNECTING.
        if (ws.readyState !== WebSocket.CLOSED) ws.terminate();
        void this.teardown.then(() => this.scheduleReconnect(), () => undefined);
      };
      const deadline = setTimeout(() => stop(new Error("connection handshake deadline exceeded")), this.timing.connectTimeoutMs);
      this.dialing.set(ws, reason => stop(new Error(reason)));
      const armPing = (): void => {
        pingTimer = setTimeout(() => {
          if (stopped || this.ws !== ws) return;
          if (ws.readyState !== WebSocket.OPEN) { stop(new Error("connection not open")); return; }
          pendingPong = Buffer.from(`${generation}:${++pingSequence}`);
          pongTimer = setTimeout(() => stop(new Error("websocket pong deadline exceeded")), this.timing.pongTimeoutMs);
          try { ws.ping(pendingPong, undefined, (error?: Error) => { if (error) stop(error); }); }
          catch (error) { stop(error); }
        }, this.timing.pingIntervalMs);
      };
      const onPong = (payload: Buffer): void => {
        if (stopped || this.ws !== ws || !pendingPong?.equals(payload)) return;
        clearTimeout(pongTimer);
        pongTimer = undefined;
        pendingPong = undefined;
        receivedPong = true;
        if (stable) this.backoffMs = this.timing.reconnectBaseMs;
        armPing();
      };
      ws.on("pong", onPong);
      const transport: RpcTransport = {
        send: (data) => ws.send(data),
        close: () => ws.close(),
      };

      ws.on("open", async () => {
        try {
          const { RpcPeer } = await import("./rpc.js");
          assertCurrent();
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
          const welcome = (await tmpPeer.requestRaw("connect.hello", {
            protocolVersion: PROTOCOL_VERSION,
            deviceId: this.deviceId as never,
            features: [],
            ...(this.deviceKey ? { auth: { deviceKey: this.deviceKey } } : {}),
            ...(resumeFrom.length > 0 ? { resumeFrom } : {}),
            at: new Date().toISOString(),
          }, this.timing.helloTimeoutMs)) as { tenantId: string; ackedSeqs?: Array<{ sessionId: string; lastSeq: number }> };

          assertCurrent();

          if (this.expectedTenantId !== undefined && welcome.tenantId !== this.expectedTenantId) {
            throw new PhononError(
              "errUnauthorized",
              `server returned tenantId "${welcome.tenantId}" but expected "${this.expectedTenantId}" (A5 identity check)`,
            );
          }

          tmpPeer.dispose("handshake complete");
          tmpPeer = undefined;

          // A manual connect or reconnect may overlap an existing healthy
          // socket. Tear down the old connection before publishing its
          // replacement so no scheduler/runtime survives in parallel.
          this.stopActive?.("connection replaced");
          await this.teardown;
          assertCurrent();
          this.lastTenantId = welcome.tenantId;
          this.store.rememberConnectionTenant(this.serverUrl, welcome.tenantId, new Date().toISOString());

          const conn = new PhononConnection({
            managedMcp: this.managedMcp,
            tenantId: welcome.tenantId,
            archiveAuthority: new URL(this.serverUrl).origin,
            transport,
            registry: this.registry,
            trustLocal: this.trustLocal,
            workspaceRoot: this.workspaceRoot,
            employeeProfileFileBrokerRoot:this.employeeProfileFileBrokerRoot,
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
          const enqueueInbound = (data: string): void => {
            inboundChain = inboundChain.then(() => {
              if (stopped || conn.isDisposed) return;
              let request = false;
              try {
                const frame = JSON.parse(data);
                request = typeof frame?.method === "string" && frame.id !== undefined && frame.id !== null;
              } catch { /* The RPC peer returns the normal parse error. */ }
              const handled = conn.handle(data);
              if (!request) return handled;
              // Preserve arrival/ACK order, not completion order of long RPCs.
              // A tool-gap request must not block replies to a reverse RPC.
              void handled.catch(() => undefined);
            });
          };
          for (const data of inboundQueue.splice(0)) {
            enqueueInbound(data);
          }
          messageListener = (raw: Buffer): void => {
            enqueueInbound(raw.toString());
          };
          if (tmpListener) ws.off("message", tmpListener);
          tmpListener = undefined;
          ws.on("message", messageListener);
          // Process welcome-adjacent ACKs before replay. New frames are chained
          // behind the buffered frames, preserving wire order.
          await inboundChain;
          assertCurrent();
          this.ws = ws;
          this.conn = conn;
          this.dialing.delete(ws);
          this.stopActive = reason => stop(new Error(reason));
          clearTimeout(deadline);
          armPing();
          stableTimer = setTimeout(() => {
            stable = true;
            if (!stopped && this.ws === ws && ws.readyState === WebSocket.OPEN && receivedPong && !pendingPong) this.backoffMs = this.timing.reconnectBaseMs;
          }, this.timing.stableConnectionMs);
          conn.replayPending();
          settled = true;
          resolve({ tenantId: welcome.tenantId });
        } catch (err) {
          stop(err);
        }
      });

      ws.on("error", stop);
      ws.on("close", () => stop(new Error("connection closed")));
    });
  }

  /**
   * 长期运行：连上后自动保持，断线指数退避重连（bug-bash P1）。
   * 首次连接失败也进重试（不抛）。
   */
  async start(): Promise<void> {
    if (this.closed) throw new Error("client closed");
    if (this.started) return;
    this.started = true;
    try {
      await this.connect();
    } catch {
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (!this.started || this.closed || this.ws || this.dialing.size || this.reconnectTimer) return;
    const random = this.random();
    const jitter = Number.isFinite(random) ? Math.max(0, Math.min(1, random)) : 0.5;
    const delay = Math.min(this.timing.reconnectMaxMs, Math.max(1, Math.round(this.backoffMs * (0.8 + jitter * 0.4))));
    this.backoffMs = Math.min(this.backoffMs * 2, this.timing.reconnectMaxMs);
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = undefined;
      try {
        await this.connect();
      } catch {
        this.scheduleReconnect();
      }
    }, delay);
  }

  private clearReconnect(): void {
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
  }

  private retire(conn: PhononConnection, reason: string): void {
    this.teardown = Promise.all([this.teardown, conn.dispose(reason)]).then(() => undefined);
    void this.teardown.catch(() => undefined);
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.started = false;
    this.closed = true;
    this.generation++;
    this.clearReconnect();
    for (const cancel of this.dialing.values()) cancel("client closed");
    this.stopActive?.("client closed");
    this.closing = this.teardown.then(() => {
      if (this.ownsStore && !this.storeClosed) {
        this.storeClosed = true;
        this.store.close();
      }
    });
    return this.closing;
  }

  /** 本连接的 PhononConnection（HookBridge 路由用）。 */
  get connection(): PhononConnection | undefined {
    return this.conn;
  }
}
