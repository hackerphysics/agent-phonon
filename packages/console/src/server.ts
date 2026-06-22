import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, WebSocket } from "ws";
import { PhononServer, type PhononDevice, type PhononSession } from "@agent-phonon/server-sdk";

/**
 * agent-phonon Console —— 用 server-SDK 写的带 web 控制台的服务端。
 *
 * 两个面：
 *  - phonon 面：PhononServer 监听设备拨入（ws，phononPort）
 *  - 人面：HTTP 服务 web UI + browser WS 实时推送设备/session/stream，接收发任务/HITL 指令
 *
 * 这是「真正使用」的人机入口：浏览器里看设备/agent、发任务、看流式、HITL 确认。
 */
const __dirname = dirname(fileURLToPath(import.meta.url));

interface PendingHook {
  resolve: (action: { action: string; reason?: string }) => void;
  hook: Record<string, unknown>;
}

export interface ConsoleOptions {
  /** phonon 设备拨入端口。 */
  phononPort?: number;
  /** web 控制台端口。 */
  httpPort?: number;
  /** 设备鉴权 key（缺省本地放行）。 */
  deviceKey?: string;
  /** HITL：是否需要人工确认危险操作（true=弹给浏览器等确认；false=自动放行）。 */
  requireHitl?: boolean;
}

export class PhononConsole {
  private phonon: PhononServer;
  private opts: ConsoleOptions;
  private http?: ReturnType<typeof createServer>;
  private uiWss?: WebSocketServer;
  private uiClients = new Set<WebSocket>();
  private sessions = new Map<string, PhononSession>();
  private pendingHooks = new Map<string, PendingHook>();
  private hookSeq = 1;

  constructor(opts: ConsoleOptions = {}) {
    this.opts = opts;
    this.phonon = new PhononServer({
      port: opts.phononPort,
      authenticate: (deviceId, key) => {
        if (opts.deviceKey && key !== opts.deviceKey) return null;
        return { tenantId: `tenant-${deviceId}` };
      },
    });
    this.phonon.on("device", (d: PhononDevice) => this.onDevice(d));
  }

  async listen(): Promise<{ phononPort: number; httpPort: number }> {
    const phononPort = await this.phonon.listen();
    const httpPort = await this.startHttp();
    return { phononPort, httpPort };
  }

  // ---- phonon 设备面 ----
  private onDevice(device: PhononDevice): void {
    this.broadcast({ type: "device.connected", deviceId: device.deviceId, tenantId: device.tenantId });
    // HITL：弹给浏览器等确认（requireHitl）或自动放行
    device.setHookDecider(async (hook) => {
      if (!this.opts.requireHitl) return "continue";
      const id = `hook-${this.hookSeq++}`;
      this.broadcast({ type: "hook.pending", id, deviceId: device.deviceId, hook });
      return new Promise((resolve) => {
        this.pendingHooks.set(id, { resolve: (a) => resolve(a as never), hook: hook as never });
      });
    });
    device.setUnsolicitedHandler((ev) => {
      this.broadcast({ type: "unsolicited", deviceId: device.deviceId, event: ev });
    });
    device.on("disconnect", () => this.broadcast({ type: "device.disconnected", deviceId: device.deviceId }));
  }

  // ---- 浏览器命令处理 ----
  private async handleUiCommand(msg: Record<string, unknown>): Promise<void> {
    const cmd = msg.cmd as string;
    if (cmd === "list-devices") {
      const devs = await Promise.all(this.phonon.listDevices().map(async (d) => ({
        deviceId: d.deviceId, tenantId: d.tenantId,
        agents: (await d.discover().catch(() => [])).map((a) => ({ agentId: a.agentId, available: a.available, models: a.models.map((m) => m.id) })),
      })));
      this.broadcast({ type: "devices", devices: devs });
    } else if (cmd === "send-task") {
      const { deviceId, agent, model, project, input } = msg as { deviceId: string; agent: string; model: string; project: string; input: string };
      const device = this.phonon.getDevice(deviceId);
      if (!device) return;
      // 建项目（若给名）+ session + send
      let projectId = project;
      if (project && !project.startsWith("proj-")) {
        const p = (await device.project.create({ name: project, git: false }).catch(() => null)) as { project?: { projectId: string } } | null;
        if (p?.project) projectId = p.project.projectId;
      }
      const session = await device.createSession({ project: projectId, agent, model });
      this.sessions.set(session.sessionId, session);
      this.broadcast({ type: "session.created", deviceId, sessionId: session.sessionId, agent, model });
      session.on("stream", (ev) => this.broadcast({ type: "stream", deviceId, sessionId: session.sessionId, event: ev }));
      session.on("end", (ev) => this.broadcast({ type: "session.end", deviceId, sessionId: session.sessionId, event: ev }));
      await session.send(input);
    } else if (cmd === "hook-decide") {
      const { id, action, reason } = msg as { id: string; action: string; reason?: string };
      const p = this.pendingHooks.get(id);
      if (p) { p.resolve({ action, reason }); this.pendingHooks.delete(id); }
    } else if (cmd === "interrupt") {
      const s = this.sessions.get(msg.sessionId as string);
      if (s) await s.interrupt("user interrupt");
    }
  }

  // ---- HTTP + browser WS ----
  private startHttp(): Promise<number> {
    return new Promise((resolve) => {
      const http = createServer((req, res) => this.serveStatic(req, res));
      this.http = http;
      this.uiWss = new WebSocketServer({ server: http, path: "/ws" });
      this.uiWss.on("connection", (ws: WebSocket) => {
        this.uiClients.add(ws);
        ws.on("message", (raw: Buffer) => { try { void this.handleUiCommand(JSON.parse(raw.toString())); } catch { /* ignore */ } });
        ws.on("close", () => this.uiClients.delete(ws));
        // 连上即推当前设备
        void this.handleUiCommand({ cmd: "list-devices" });
      });
      http.listen(this.opts.httpPort ?? 0, "127.0.0.1", () => {
        const addr = http.address();
        resolve(typeof addr === "object" && addr ? addr.port : (this.opts.httpPort ?? 0));
      });
    });
  }

  private serveStatic(req: IncomingMessage, res: ServerResponse): void {
    const url = req.url === "/" ? "/index.html" : (req.url ?? "/index.html");
    const file = join(__dirname, "..", "public", url.split("?")[0]!);
    if (!file.startsWith(join(__dirname, "..", "public")) || !existsSync(file)) {
      res.writeHead(404).end("not found");
      return;
    }
    const ext = file.endsWith(".html") ? "text/html" : file.endsWith(".js") ? "text/javascript" : "text/plain";
    res.writeHead(200, { "content-type": ext + "; charset=utf-8" }).end(readFileSync(file));
  }

  private broadcast(msg: unknown): void {
    const data = JSON.stringify(msg);
    for (const c of this.uiClients) { try { c.send(data); } catch { /* ignore */ } }
  }

  async close(): Promise<void> {
    for (const c of this.uiClients) c.close();
    this.uiWss?.close();
    await new Promise<void>((r) => (this.http ? this.http.close(() => r()) : r()));
    await this.phonon.close();
  }
}
