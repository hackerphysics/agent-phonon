import { PhononServer, type PhononDevice } from "@agent-phonon/server-sdk";
import type { StreamEvent } from "@agent-phonon/protocol";

/**
 * 项目内参考测试 server（NOT for production）。
 *
 * 现在是 **@agent-phonon/server-sdk 的参考实现** —— 用 SDK 写的最小 server，
 * 顺便证明 SDK 好用。对外保留测试 harness API（firstDevice / device.peer.requestRaw /
 * hookDecision），底层全由 server-sdk 驱动。
 */
export interface TestServerOptions {
  port?: number;
  assignTenant?: (deviceId: string) => string;
  /** hook.fired 裁决（HITL）。缺省 continue。 */
  hookDecision?: (fired: { hookType: string; payload: Record<string, unknown> }) => { action: string; reason?: string; patch?: Record<string, unknown> };
}

/** 测试用的 device 句柄（包装 SDK PhononDevice，提供老接口）。 */
export interface DeviceConn {
  tenantId: string;
  deviceId: string;
  /** 兼容老测试：peer.requestRaw(method, params)。 */
  peer: { requestRaw: (method: string, params: unknown) => Promise<unknown> };
  streamEvents: StreamEvent[];
  waitForTurnEnd(turnId: string, timeoutMs?: number): Promise<StreamEvent>;
}

export class PhononTestServer {
  private sdk: PhononServer;
  private conns: DeviceConn[] = [];
  private opts: TestServerOptions;
  private waiters: Array<{ predicate: (e: StreamEvent) => boolean; resolve: (e: StreamEvent) => void }> = [];

  constructor(opts: TestServerOptions = {}) {
    this.opts = opts;
    this.sdk = new PhononServer({
      port: opts.port,
      authenticate: (deviceId) => ({ tenantId: (opts.assignTenant ?? ((d) => `tenant-${d}`))(deviceId) }),
    });
    this.sdk.on("device", (device: PhononDevice) => this.onDevice(device));
  }

  listen(): Promise<number> {
    return this.sdk.listen();
  }

  async firstDevice(timeoutMs = 5000): Promise<DeviceConn> {
    const start = Date.now();
    while (this.conns.length === 0) {
      if (Date.now() - start > timeoutMs) throw new Error("no device connected in time");
      await new Promise((r) => setTimeout(r, 20));
    }
    return this.conns[0]!;
  }

  private onDevice(device: PhononDevice): void {
    const streamEvents: StreamEvent[] = [];
    // 收 stream 事件（SDK 的 device 会自动 ack；这里再镜像一份给测试断言）
    device.setUnsolicitedHandler((ev) => { streamEvents.push(ev); this.wake(ev); });
    // HITL：转给 hookDecision
    if (this.opts.hookDecision) {
      device.setHookDecider((hook) => {
        const d = this.opts.hookDecision!({ hookType: (hook as { hookType: string }).hookType, payload: (hook as { payload: Record<string, unknown> }).payload ?? {} });
        return { action: d.action as "continue" | "abort" | "inject" | "modify", reason: d.reason };
      });
    }
    // 老接口需要能拿到所有 stream（不止 unsolicited），用底层 call 拦截不便；
    // 改为：测试通过 session 不直接拿，而是用 device 的低层 peer。SDK 没暴露 peer，
    // 所以这里用 device.call 发请求，stream 通过监听 SDK session 收集。
    const conn: DeviceConn = {
      tenantId: device.tenantId,
      deviceId: device.deviceId,
      peer: { requestRaw: (method, params) => this.driveRequest(device, method, params, streamEvents) },
      streamEvents,
      waitForTurnEnd: (turnId, timeoutMs = 120000) =>
        this.waitFor((e) => (e as { turnId?: string }).turnId === turnId && (e as { final?: boolean }).final === true, timeoutMs),
    };
    this.conns.push(conn);
  }

  /** 驱动一个请求；若是 session.create/send，挂上 stream 收集。 */
  private async driveRequest(device: PhononDevice, method: string, params: unknown, streamEvents: StreamEvent[]): Promise<unknown> {
    if (method === "session.create") {
      const p = params as { project: string; agent: string; model: string; worktreeId?: string; verbosity?: never };
      const session = await device.createSession(p);
      // 挂 stream 收集 + 唤醒等待者
      session.on("stream", (ev: StreamEvent) => { streamEvents.push(ev); this.wake(ev); });
      this.sessionMap.set(session.sessionId, session);
      return { sessionId: session.sessionId, project: p.project, agent: p.agent, model: p.model, status: "idle", createdAt: new Date().toISOString() };
    }
    // 其余直接走 device.call（底层 peer.request）
    return device.call(method, params);
  }
  private sessionMap = new Map<string, unknown>();

  private wake(ev: StreamEvent): void {
    for (let i = this.waiters.length - 1; i >= 0; i--) {
      if (this.waiters[i]!.predicate(ev)) { this.waiters[i]!.resolve(ev); this.waiters.splice(i, 1); }
    }
  }

  private waitFor(predicate: (e: StreamEvent) => boolean, timeoutMs: number): Promise<StreamEvent> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("waitFor timeout")), timeoutMs);
      this.waiters.push({ predicate, resolve: (e) => { clearTimeout(timer); resolve(e); } });
    });
  }

  close(): Promise<void> {
    return this.sdk.close();
  }
}

export type { StreamEvent };
