import { PhononConnection, type RpcTransport, type AgentAdapter, type AdapterSession } from "@agent-phonon/core";
import type { StreamEvent, ContextItem } from "@agent-phonon/protocol";

/**
 * 功能测试 harness（bug-bash#2 测试补全）。
 *
 * 不走真实 ws/LLM：用 in-memory transport 直连 PhononConnection，
 * 模拟 server 下发 RPC + 收 server 侧通知（stream.event 等）。快、可 CI。
 */

export interface MockAdapterOpts {
  /** runtime name，如 "mock"。 */
  name?: string;
  /** 枚举的 agentId 列表（多 agent runtime 测试用）。 */
  agentIds?: string[];
  /** 每个 agent 的可用模型。 */
  models?: string[];
  /** send 时回显的文本（默认回显 input）。 */
  reply?: (input: string) => string;
  /** capabilities 覆盖。 */
  caps?: Partial<Record<string, unknown>>;
  /** 是否支持自发输出（用 emitUnsolicited 触发）。 */
  proactiveOutput?: boolean;
  /** send 延迟 ms（测并发/interrupt）。 */
  sendDelayMs?: number;
  /** global skill 目录提供。 */
  globalSkillDir?: (agentId: string) => string | undefined;
}

const DEFAULT_CAPS = {
  nativeSession: true, nativeCompression: true, contextInjection: true,
  proactiveOutput: false, modelSwitch: true, interrupt: true, injectMidTurn: false,
  skillManagement: true, hooks: ["pre_tool"], streaming: true,
};

/** 可被测试控制的 mock adapter。 */
export class MockAdapter implements AgentAdapter {
  readonly name: string;
  readonly capabilities: never;
  private opts: MockAdapterOpts;
  /** 暴露最近创建的 session，供测试触发 unsolicited/查状态。 */
  lastSession?: MockSession;

  constructor(opts: MockAdapterOpts = {}) {
    this.name = opts.name ?? "mock";
    this.opts = opts;
    this.capabilities = { ...DEFAULT_CAPS, proactiveOutput: !!opts.proactiveOutput, ...(opts.caps ?? {}) } as never;
  }

  async discoverAgents() {
    const ids = this.opts.agentIds ?? [`${this.name}:default`];
    const models = (this.opts.models ?? ["m1", "m2"]).map((id) => ({ id, available: true }));
    return ids.map((agentId) => ({
      agentId: agentId as never,
      displayName: agentId,
      adapter: this.name,
      available: true,
      models,
      capabilities: this.capabilities,
      scannedAt: new Date().toISOString(),
    }));
  }

  async createSession(params: { sessionId: string; agentId: string; model: string; cwd: string }): Promise<AdapterSession> {
    const s = new MockSession(params.sessionId, params.model, this.opts);
    this.lastSession = s;
    return s;
  }

  globalSkillDir(agentId: string): string | undefined {
    return this.opts.globalSkillDir?.(agentId);
  }
}

export class MockSession implements AdapterSession {
  readonly sessionId: string;
  model: string;
  private opts: MockAdapterOpts;
  private unsolicited?: (e: unknown) => void;
  injected: Array<{ role: string; content: string }> = [];
  compressed = 0;
  lastEnvironment?: Record<string, string>;

  constructor(sessionId: string, model: string, opts: MockAdapterOpts) {
    this.sessionId = sessionId;
    this.model = model;
    this.opts = opts;
  }

  async send(input: string, o: { turnId: string; verbosity: string; skills?: string[]; environment?: Record<string, string>; emit: (e: StreamEvent) => void; signal?: AbortSignal }): Promise<void> {
    if (this.opts.sendDelayMs) {
      await new Promise<void>((r) => {
        const t = setTimeout(r, this.opts.sendDelayMs);
        o.signal?.addEventListener("abort", () => { clearTimeout(t); r(); }, { once: true });
      });
      if (o.signal?.aborted) {
        // 被 interrupt：adapter 也发个迟到终态（测去重）
        o.emit({ type: "result", sessionId: this.sessionId, turnId: o.turnId, seq: 0, at: new Date().toISOString(), text: "", status: "failed", final: true } as StreamEvent);
        return;
      }
    }
    this.lastEnvironment = o.environment;
    const text = (this.opts.reply ?? ((i: string) => i))(input);
    o.emit({ type: "message", sessionId: this.sessionId, turnId: o.turnId, seq: 0, at: new Date().toISOString(), role: "assistant", text, delta: true } as StreamEvent);
    o.emit({ type: "result", sessionId: this.sessionId, turnId: o.turnId, seq: 0, at: new Date().toISOString(), text, status: "completed", final: true } as StreamEvent);
  }

  async interrupt(): Promise<void> { /* mock: nothing to kill */ }
  async switchModel(model: string): Promise<{ warnings?: string[] }> { this.model = model; return { warnings: ["mock switch"] }; }
  async inject(ctx: ContextItem[]): Promise<void> { this.injected.push(...(ctx as Array<{ role: string; content: string }>)); }
  async compressNative(): Promise<{ summary?: string }> { this.compressed++; return { summary: "mock compacted" }; }
  async terminate(): Promise<void> { /* mock */ }
  setUnsolicitedSink(sink: (e: StreamEvent) => void): void { this.unsolicited = sink as (e: unknown) => void; }

  /** 测试触发自发输出。 */
  emitUnsolicited(text: string, source = "cron"): void {
    this.unsolicited?.({ type: "message", sessionId: this.sessionId, turnId: `u-${Date.now()}`, origin: "unsolicited", source, seq: 0, at: new Date().toISOString(), role: "assistant", text, delta: false } as unknown as StreamEvent);
  }
}

/** 一个内存测试连接：直接 new PhononConnection，提供 call()/stream 收集。 */
export class TestConn {
  readonly conn: PhononConnection;
  readonly streamEvents: Array<Record<string, unknown>> = [];
  readonly notifications: Array<Record<string, unknown>> = [];
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>();
  private nextId = 1;
  private hookDecider?: (fired: Record<string, unknown>) => Record<string, unknown>;
  private requestResponders = new Map<string, (params: unknown) => unknown>();

  constructor(opts: { registry: ConstructorParameters<typeof PhononConnection>[0]["registry"]; tenantId?: string; trustLocal?: boolean; workspaceRoot?: string; store?: ConstructorParameters<typeof PhononConnection>[0]["store"] }) {
    const transport: RpcTransport = {
      send: (data: string) => this.onServerInbound(data),
      close: () => {},
    };
    this.conn = new PhononConnection({
      tenantId: opts.tenantId ?? "tenant-test",
      transport,
      registry: opts.registry,
      trustLocal: opts.trustLocal ?? true,
      workspaceRoot: opts.workspaceRoot,
      store: opts.store,
      resolveProjectCwd: (p) => p,
    });
  }

  /** 设置 hook.fired 的裁决（HITL 测试）。 */
  setHookDecider(fn: (fired: Record<string, unknown>) => Record<string, unknown>): void {
    this.hookDecider = fn;
  }

  /** 设置某个 p2s 方法的 server 侧响应（document.prepare_upload 等）。 */
  setRequestResponder(method: string, fn: (params: unknown) => unknown): void {
    this.requestResponders.set(method, fn);
  }

  /** server → phonon 下发一个 RPC，返回结果。 */
  call(method: string, params: unknown, timeoutMs = 10000): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`call timeout: ${method}`)); }, timeoutMs);
      this.pending.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } });
      void this.conn.handle(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    });
  }

  /** phonon 侧发来的报文（通知 stream.event / 请求 hook.fired / 响应）。 */
  private onServerInbound(data: string): void {
    const msg = JSON.parse(data) as Record<string, unknown>;
    // phonon → server 的 RPC 响应
    if (("result" in msg || "error" in msg) && "id" in msg) {
      const p = this.pending.get(msg.id as number);
      if (p) { this.pending.delete(msg.id as number); if ("error" in msg) p.reject(msg.error); else p.resolve((msg as { result: unknown }).result); }
      return;
    }
    // phonon → server 通知
    if (msg.method === "stream.event") { this.streamEvents.push(msg.params as Record<string, unknown>); return; }
    if (msg.method === "discovery.changed") { this.notifications.push(msg.params as Record<string, unknown>); return; }
    // phonon → server 请求（hook.fired / document.* / interaction.* 等）：回响应
    if (typeof msg.method === "string" && "id" in msg) {
      let result: unknown = { applied: true };
      if (msg.method === "hook.fired" && this.hookDecider) result = this.hookDecider(msg.params as Record<string, unknown>);
      else if (this.requestResponders.has(msg.method)) result = this.requestResponders.get(msg.method)!(msg.params);
      void this.conn.handle(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }));
    }
  }

  /** 等待某 turn 的终态事件。 */
  async waitTurnEnd(turnId: string, timeoutMs = 5000): Promise<Record<string, unknown>> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const e = this.streamEvents.find((x) => x.turnId === turnId && (x as { final?: boolean }).final === true);
      if (e) return e;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`turn ${turnId} did not end`);
  }
}
