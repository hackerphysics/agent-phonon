import { createServer, type Server } from "node:http";
import type { ObsBus, ObsEvent, Metrics, PhononStore } from "@agent-phonon/core";

/**
 * 可观测性 HTTP 服务（design D34 / B5）。
 *
 * 产品理念：可观测性是放权的前提。人放权让 agent 自动干活，但关键时刻要能掀盖看里面。
 *
 * 端点：
 *   GET /health         daemon/连接/db/adapter 健康（人/监控看「活没活」）
 *   GET /metrics        Prometheus 文本指标
 *   GET /metrics.json   JSON 指标
 *   GET /sessions       当前每个 agent 在干什么的实时快照（「不是黑盒」的心脏）
 *   GET /events         审计时间线（最近 N 条，可 ?session= ?category= 过滤）
 *   GET /stream         SSE 实时事件流（人盯着看 agent 实时动作）
 */
export interface ObsServerDeps {
  bus: ObsBus;
  metrics: Metrics;
  store: PhononStore;
  /** 健康快照提供者（daemon 注入）。 */
  health: () => Record<string, unknown>;
  /** 所有连接的 session 快照（daemon 注入）。 */
  sessions: () => Array<Record<string, unknown>>;
  /** 可选 bearer token。 */
  token?: string;
}

export class ObsServer {
  private server?: Server;
  private deps: ObsServerDeps;
  private actualPort = 0;
  /** SSE 客户端。 */
  private sseClients = new Set<import("node:http").ServerResponse>();

  constructor(deps: ObsServerDeps) {
    this.deps = deps;
    // 实时事件广播到 SSE 客户端
    deps.bus.onEvent((e: ObsEvent) => this.broadcast(e));
  }

  listen(port = 4319, host = "127.0.0.1"): Promise<number> {
    return new Promise((resolve) => {
      const server = createServer((req, res) => this.handle(req, res));
      this.server = server;
      server.listen(port, host, () => {
        const addr = server.address();
        this.actualPort = typeof addr === "object" && addr ? addr.port : port;
        resolve(this.actualPort);
      });
    });
  }

  private authed(req: import("node:http").IncomingMessage): boolean {
    if (!this.deps.token) return true;
    return req.headers["authorization"] === `Bearer ${this.deps.token}`;
  }

  private handle(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse): void {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;

    if (!this.authed(req)) {
      res.writeHead(401).end("unauthorized");
      return;
    }

    if (path === "/health") {
      const h = this.deps.health();
      const ok = h.ok !== false;
      res.writeHead(ok ? 200 : 503, { "content-type": "application/json" }).end(JSON.stringify(h, null, 2));
      return;
    }
    if (path === "/metrics") {
      res.writeHead(200, { "content-type": "text/plain; version=0.0.4" }).end(this.deps.metrics.prometheus());
      return;
    }
    if (path === "/metrics.json") {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(this.deps.metrics.json(), null, 2));
      return;
    }
    if (path === "/sessions") {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(this.deps.sessions(), null, 2));
      return;
    }
    if (path === "/events") {
      const rows = this.deps.store.auditQuery({
        sessionId: url.searchParams.get("session") ?? undefined,
        category: url.searchParams.get("category") ?? undefined,
        limit: Number(url.searchParams.get("limit") ?? 200),
      });
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(rows, null, 2));
      return;
    }
    if (path === "/stream") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      res.write(": connected\n\n");
      this.sseClients.add(res);
      req.on("close", () => this.sseClients.delete(res));
      return;
    }
    if (path === "/") {
      res.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({ service: "agent-phonon obs", endpoints: ["/health", "/metrics", "/metrics.json", "/sessions", "/events", "/stream"] }, null, 2),
      );
      return;
    }
    res.writeHead(404).end("not found");
  }

  private broadcast(e: ObsEvent): void {
    if (this.sseClients.size === 0) return;
    const line = `data: ${JSON.stringify(e)}\n\n`;
    for (const c of this.sseClients) {
      try {
        c.write(line);
      } catch {
        this.sseClients.delete(c);
      }
    }
  }

  get port(): number {
    return this.actualPort;
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      for (const c of this.sseClients) c.end();
      this.sseClients.clear();
      if (!this.server) return resolve();
      this.server.close(() => resolve());
    });
  }
}
