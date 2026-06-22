import {
  AdapterRegistry,
  PhononClient,
  PhononStore,
  HookBridge,
  OpenClawGatewayAdapter,
  OpenClawAdapter,
  ClaudeCodeAdapter,
  CodexAdapter,
  HermesAdapter,
  OpenCodeAdapter,
  ObsBus,
  StructuredLogger,
  Metrics,
  AuditSink,
  type PhononConnection,
} from "@agent-phonon/core";
import { type DaemonConfig, readOpenClawGatewayToken } from "./config.js";
import { autoDetectAdapters } from "./commands.js";
import { ObsServer } from "./obs-server.js";

/**
 * PhononDaemon（bug-bash B4）：设备侧常驻服务。
 *
 * 一个进程管理：共享 sqlite store、adapter registry、HookBridge，
 * 以及到多个 server 的多条 PhononClient 连接（每个 server = 一个 tenant）。
 *
 * HookBridge 跨所有连接路由：sessionKey → 找到 owns 该 session 的连接。
 */
export class PhononDaemon {
  private cfg: DaemonConfig;
  private store: PhononStore;
  private registry = new AdapterRegistry();
  private clients: PhononClient[] = [];
  private bridge?: HookBridge;
  private gatewayAdapters: OpenClawGatewayAdapter[] = [];
  private obs = new ObsBus();
  private metrics = new Metrics();
  private obsServer?: ObsServer;
  private startedAt = Date.now();

  constructor(cfg: DaemonConfig) {
    this.cfg = cfg;
    this.store = new PhononStore(cfg.dbPath);
    // 可观测堆栈：结构化日志 + 指标 + audit 落库，都从同一 ObsBus 消费
    new StructuredLogger({ level: cfg.logLevel ?? "info" }).attach(this.obs);
    this.metrics.attach(this.obs);
    new AuditSink(this.store).attach(this.obs);
    this.registerAdapters();
  }

  private registerAdapters(): void {
    for (const a of autoDetectAdapters(this.cfg.adapters)) {
      if (a.type === "openclaw-gateway") {
        const token = a.gatewayToken ?? readOpenClawGatewayToken();
        if (!token) {
          console.warn("[daemon] openclaw-gateway adapter skipped: no Gateway token");
          continue;
        }
        const ad = new OpenClawGatewayAdapter({
          gateway: { baseUrl: a.gatewayUrl ?? "ws://127.0.0.1:18789", token },
          defaultAgent: a.defaultAgent ?? "main",
        });
        this.gatewayAdapters.push(ad);
        this.registry.register(ad);
      } else if (a.type === "claude-code") {
        this.registry.register(new ClaudeCodeAdapter({ env: { binPath: a.claudeBinPath, baseUrl: a.claudeBaseUrl, authToken: a.claudeAuthToken, defaultModel: a.claudeDefaultModel ?? "default", models: a.claudeModels } }));
      } else if (a.type === "codex") {
        this.registry.register(new CodexAdapter({ env: { binPath: a.codexBinPath, baseUrl: a.codexBaseUrl, apiKey: a.codexApiKey, defaultModel: a.codexDefaultModel ?? "default", models: a.codexModels, wireApi: a.codexWireApi ?? "responses" } }));
      } else if (a.type === "hermes") {
        this.registry.register(new HermesAdapter({ env: { binPath: a.hermesBinPath, defaultModel: a.hermesModel, provider: a.hermesProvider } }));
      } else if (a.type === "opencode") {
        this.registry.register(new OpenCodeAdapter({ env: { binPath: a.opencodeBinPath, defaultModel: a.opencodeModel } }));
      } else if (a.type === "openclaw-cli") {
        this.registry.register(new OpenClawAdapter({ defaultAgent: a.defaultAgent ?? "main" }));
      }
    }
  }

  /** 启动：起 HookBridge + 连所有 server（带自动重连）。 */
  async start(): Promise<void> {
    this.obs.emitEvent({ category: "daemon", level: "info", event: "daemon.start", msg: `device=${this.cfg.deviceId}` });

    // HookBridge：跨所有连接路由 sessionKey
    this.bridge = new HookBridge(
      (sessionKey: string) => this.routeHook(sessionKey),
      this.cfg.hookBridge?.token ? { token: this.cfg.hookBridge.token } : undefined,
    );
    const port = await this.bridge.listen(this.cfg.hookBridge?.port ?? 4318);
    console.log(`[daemon] HookBridge on :${port}`);

    // 可观测 HTTP 服务（人/监控看状态）
    if (this.cfg.obs?.enabled !== false) {
      this.obsServer = new ObsServer({
        bus: this.obs,
        metrics: this.metrics,
        store: this.store,
        token: this.cfg.obs?.token,
        health: () => this.health(),
        sessions: () => this.allSessions(),
      });
      const obsPort = await this.obsServer.listen(this.cfg.obs?.port ?? 4319);
      console.log(`[daemon] obs server on http://127.0.0.1:${obsPort} (/health /metrics /sessions /events /stream)`);
    }

    if (this.cfg.servers.length === 0) {
      console.warn("[daemon] no servers configured — idle. Add servers to config and restart.");
    }
    for (const s of this.cfg.servers) {
      const client = new PhononClient({
        serverUrl: s.url,
        deviceId: this.cfg.deviceId,
        registry: this.registry,
        store: this.store,
        obs: this.obs,
        trustLocal: s.trustLocal,
        workspaceRoot: this.cfg.workspaceRoot,
        deviceKey: s.deviceKey,
        resolveProjectCwd: (p) => p,
      });
      this.clients.push(client);
      void client.start(); // 长期运行 + 自动重连
      this.obs.emitEvent({ category: "connection", level: "info", event: "connection.dial", msg: `connecting to ${s.url}` });
      console.log(`[daemon] connecting to ${s.url}…`);
    }
  }

  /** 健康快照（/health）。 */
  private health(): Record<string, unknown> {
    const connections = this.clients.map((c, i) => ({
      server: this.cfg.servers[i]?.url,
      connected: !!c.connection,
      outboxSize: c.connection?.outboxSize ?? 0,
    }));
    const anyDown = connections.some((c) => !c.connected) && this.cfg.servers.length > 0;
    return {
      ok: !anyDown,
      deviceId: this.cfg.deviceId,
      uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1000),
      adapters: this.registry.all().map((a) => a.name),
      connections,
      hookBridge: !!this.bridge,
    };
  }

  /** 所有连接的 session 快照（/sessions）。 */
  private allSessions(): Array<Record<string, unknown>> {
    const out: Array<Record<string, unknown>> = [];
    for (const c of this.clients) {
      const conn = c.connection;
      if (conn) out.push(...conn.sessionsSnapshot());
    }
    return out;
  }

  /** 可观测 HTTP 服务实际端口（测试/外部查询）。 */
  get obsPort(): number {
    return this.obsServer?.port ?? 0;
  }

  /** HookBridge 路由：找到 owns 该 session 的连接。sessionKey 形如 agent:<sub>:phonon-<sessionId>。 */
  private routeHook(sessionKey: string): { conn: PhononConnection; sessionId: string } | undefined {
    const m = sessionKey.match(/phonon-(s-\d+-\d+)$/);
    const sessionId = m?.[1];
    if (!sessionId) return undefined;
    for (const c of this.clients) {
      const conn = c.connection;
      if (conn?.ownsSession(sessionId)) return { conn, sessionId };
    }
    return undefined;
  }

  async stop(): Promise<void> {
    this.obs.emitEvent({ category: "daemon", level: "info", event: "daemon.stop" });
    for (const c of this.clients) c.close();
    for (const a of this.gatewayAdapters) a.close();
    await this.bridge?.close();
    await this.obsServer?.close();
    this.store.close();
  }
}
