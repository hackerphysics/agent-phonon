import { createServer, type Server } from "node:http";
import type { PhononConnection } from "./index.js";

/**
 * HITL Bridge（design §8 / B 阶段）。
 *
 * phonon-core 起一个本地 HTTP 端点，给 OpenClaw plugin 调：
 *   plugin before_tool_call → POST /hook/before_tool_call { sessionKey, toolName, params }
 *     → bridge 找到该 sessionKey 对应的 PhononConnection（tenant）
 *       → conn.fireHook(...) 发 hook.fired 给 server，阻塞等 server 的 hook.resolve（= RPC 响应）
 *     ← server 裁决
 *   ← bridge 返回 decision 给 plugin
 *
 * server 的 hook.resolve 裁决直接作为 hook.fired 的 RPC 响应回来（hook.fired 是 request）。
 * 这样 plugin↔core↔server 三段阻塞链打通，HITL 闭环。
 */

/** sessionKey → 该 session 所属连接 + phonon sessionId 的解析器。 */
export type HookRouteResolver = (sessionKey: string) => { conn: PhononConnection; sessionId: string } | undefined;

export class HookBridge {
  private server?: Server;
  private resolveRoute: HookRouteResolver;
  private hookSeq = 1;
  /** 可选本地鉴权 token（P1）：plugin 请求需带 Authorization: Bearer <token>。 */
  private token?: string;

  constructor(resolveRoute: HookRouteResolver, opts?: { token?: string }) {
    this.resolveRoute = resolveRoute;
    this.token = opts?.token;
  }

  listen(port = 4318, host = "127.0.0.1"): Promise<number> {
    return new Promise((resolve) => {
      const server = createServer((req, res) => this.onRequest(req, res));
      this.server = server;
      server.listen(port, host, () => {
        const addr = server.address();
        resolve(typeof addr === "object" && addr ? addr.port : port);
      });
    });
  }

  private async onRequest(
    req: import("node:http").IncomingMessage,
    res: import("node:http").ServerResponse,
  ): Promise<void> {
    if (req.method !== "POST" || !req.url?.startsWith("/hook/")) {
      res.writeHead(404).end();
      return;
    }
    // 本地鉴权（P1）：配了 token 则验 Authorization: Bearer
    if (this.token) {
      const auth = req.headers["authorization"];
      if (auth !== `Bearer ${this.token}`) {
        res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ action: "continue", reason: "unauthorized" }));
        return;
      }
    }
    // 去掉 query string（修 P2#18）
    const hookType = req.url.slice("/hook/".length).split("?")[0]!; // e.g. before_tool_call
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      let payload: { sessionKey?: string; toolName?: string; params?: unknown };
      try {
        payload = JSON.parse(body);
      } catch {
        res.writeHead(400).end(JSON.stringify({ action: "continue", reason: "bad json" }));
        return;
      }
      const sessionKey = payload.sessionKey;
      const route = sessionKey ? this.resolveRoute(sessionKey) : undefined;
      if (!route) {
        // 未知 session → fail-open 放行
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ action: "continue" }));
        return;
      }
      try {
        // 发 hook.fired 给 server，阻塞等裁决（hook.fired 是 request，响应即裁决）
        const decision = (await route.conn.fireHook({
          sessionId: route.sessionId,
          hookId: `h-${Date.now()}-${this.hookSeq++}`,
          hookType: mapHookType(hookType),
          payload: {
            toolName: payload.toolName,
            command: typeof payload.params === "object" && payload.params ? (payload.params as { command?: string }).command : undefined,
            extra: payload.params as Record<string, unknown> | undefined,
          },
          at: new Date().toISOString(),
        })) as { action?: string; reason?: string; patch?: Record<string, unknown> };

        // server 的 hook.resolve 结果 → bridge decision（保留 applied 等）
        const action = (decision?.action as string) ?? "continue";
        res.writeHead(200, { "content-type": "application/json" }).end(
          JSON.stringify({ action, reason: decision?.reason, patch: decision?.patch }),
        );
      } catch (err) {
        // server 不裁决/超时 → fail-open
        res.writeHead(200, { "content-type": "application/json" }).end(
          JSON.stringify({ action: "continue", reason: `bridge error: ${(err as Error)?.message ?? "?"}` }),
        );
      }
    });
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => resolve());
    });
  }
}

/** OpenClaw hook 名 → phonon 归一化 HookType。 */
function mapHookType(openclawHook: string): string {
  switch (openclawHook) {
    case "before_tool_call":
      return "pre_tool";
    case "before_command":
      return "pre_command";
    default:
      return "pre_tool";
  }
}
