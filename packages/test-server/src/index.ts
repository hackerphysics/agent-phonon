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
      waitForTurnEnd: (turnId, timeoutMs = 120000) => {
        const predicate = (e: StreamEvent) => (e as { turnId?: string }).turnId === turnId && (e as { final?: boolean }).final === true;
        return this.waitForBuffered(streamEvents, predicate, timeoutMs);
      },
    };
    this.conns.push(conn);
  }

  /** 驱动一个请求；若是 session.create/send，挂上 stream 收集。 */
  private async driveRequest(device: PhononDevice, method: string, params: unknown, streamEvents: StreamEvent[]): Promise<unknown> {
    if (method === "session.create") {
      const p = params as { project: string; agent: string; model: string; worktreeId?: string; verbosity?: never };
      const session = await device.createSession(p);
      // Attach stream collection before exposing the session to callers.
      session.on("stream", (ev: StreamEvent) => { streamEvents.push(ev); this.wake(ev); });
      this.sessionMap.set(session.sessionId, session);
      return { sessionId: session.sessionId, project: p.project, agent: p.agent, model: p.model, status: "idle", createdAt: new Date().toISOString() };
    }
    if (method === "session.send") {
      // Route through the SDK session object registered above. Calling the raw
      // device RPC here bypasses the object only nominally, but keeping all
      // session traffic on one object makes stream ownership explicit.
      const p = params as { sessionId: string; input: string; verbosity?: "final" | "messages" | "tools" | "trace"; skills?: string[]; whenBusy?: "queue" | "interrupt" | "inject"; clientRequestId?: string };
      const session = this.sessionMap.get(p.sessionId) as { send: (input: string, opts?: Omit<typeof p, "sessionId" | "input">) => Promise<unknown> } | undefined;
      if (!session) throw new Error(`unknown test session ${p.sessionId}`);
      const { sessionId: _sessionId, input, ...opts } = p;
      return session.send(input, opts);
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

  private waitForBuffered(events: StreamEvent[], predicate: (e: StreamEvent) => boolean, timeoutMs: number): Promise<StreamEvent> {
    const buffered = [...events].reverse().find(predicate);
    if (buffered) return Promise.resolve(buffered);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("waitFor timeout")), timeoutMs);
      const waiter = { predicate, resolve: (e: StreamEvent) => { clearTimeout(timer); resolve(e); } };
      this.waiters.push(waiter);
      // The event can arrive between the first scan and waiter registration.
      // Re-scan after registration and consume it immediately if it raced us.
      const raced = [...events].reverse().find(predicate);
      if (raced) {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        waiter.resolve(raced);
      }
    });
  }

  close(): Promise<void> {
    return this.sdk.close();
  }
}

// Deterministic in-process adapter used by daemon integration tests and embedders.
export { MockAdapter } from "./harness.js";
export type { StreamEvent };
