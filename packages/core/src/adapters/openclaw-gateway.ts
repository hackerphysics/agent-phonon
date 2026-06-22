import type {
  AgentAdapter,
  AdapterSession,
  CreateSessionParams,
  SendOptions,
} from "../adapter.js";
import type { AgentCapabilities, AgentDescriptor, StreamEvent, ContextItem, ModelInfo } from "@agent-phonon/protocol";
import { GatewayClient, type GatewayConfig } from "../gateway-client.js";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { dropToolIOFromJsonlFiles } from "../custom-compress.js";

/**
 * OpenClaw adapter（Gateway WS 版，design D10）。
 *
 * 连 OpenClaw Gateway 的 WebSocket（参考 LMA 传输层），拿到完整能力：
 *   - chat 事件 state=delta（增量流）→ verbosity=messages/trace 的流式
 *   - chat 事件 state=final → turn 终态
 *   - sessions.compact（原生压缩）、chat.abort（中断）、chat.inject（注入）
 *   - sessions.messages.subscribe（订阅自发输出，cron/心跳冒泡）→ proactiveOutput
 *
 * 实测（2026-06-20，直连本机 Gateway 18789）：
 *   - 握手 client.id 必须是 "gateway-client"
 *   - chat.send 必须带 idempotencyKey
 *   - 多 agent 共享 Gateway，事件按 sessionKey 区分，不串台
 */

const CAPABILITIES: AgentCapabilities = {
  nativeSession: true,
  nativeCompression: true, // sessions.compact
  contextInjection: true, // chat.inject
  proactiveOutput: true, // sessions.messages.subscribe
  modelSwitch: true, // sessions.patch model
  interrupt: true, // chat.abort（真中断，非 kill 进程）
  injectMidTurn: false,
  skillManagement: true,
  hooks: ["pre_tool", "pre_command"],
  streaming: true, // chat delta
  limits: { maxConcurrentSessions: 4, maxContextTokens: 1048576 },
};

class GatewaySession implements AdapterSession {
  readonly sessionId: string;
  model: string;
  private gw: GatewayClient;
  private sessionKey: string;
  private openclawAgent: string;
  /** 当前活动 turn 的 emit/runId 跟踪。 */
  private activeTurn?: { turnId: string; emit: (e: StreamEvent) => void; verbosity: string; done: () => void; acc: string };
  /** 自发输出水槽（无 active turn 时用，D16 unsolicited）。 */
  private unsolicitedSink?: (event: StreamEvent) => void;
  private unsolicitedSeq = 0;

  setUnsolicitedSink(sink: (event: StreamEvent) => void): void {
    this.unsolicitedSink = sink;
  }

  constructor(gw: GatewayClient, sessionId: string, model: string, openclawAgent: string) {
    this.gw = gw;
    this.sessionId = sessionId;
    this.model = model;
    this.openclawAgent = openclawAgent;
    this.sessionKey = `agent:${openclawAgent}:phonon-${sessionId}`;
  }

  get key(): string {
    return this.sessionKey;
  }

  /** 接收 Gateway 事件（由 adapter 路由进来，已按 sessionKey 过滤）。 */
  handleEvent(event: string, payload: Record<string, unknown>): void {
    const turn = this.activeTurn;
    const now = new Date().toISOString();

    if (event !== "chat") return;
    const state = payload.state as string;

    // 无 active turn 的 chat 输出 = 自发（D16 unsolicited）：OpenClaw cron/定时/心跳（修 P0#7）
    if (!turn) {
      if (state === "final") {
        const text =
          (payload.message as { text?: string })?.text ?? (payload.finalText as string) ?? "";
        if (text && this.unsolicitedSink) {
          this.unsolicitedSink({
            type: "message",
            sessionId: this.sessionId,
            turnId: `u-${Date.now()}-${this.unsolicitedSeq++}`,
            origin: "unsolicited",
            source: (payload.source as string) ?? "openclaw",
            seq: 0,
            at: now,
            role: "assistant",
            text,
            delta: false,
          } as StreamEvent);
        }
      }
      return;
    }

    if (state === "delta") {
        const deltaText = payload.deltaText as string | undefined;
        if (deltaText) {
          turn.acc += deltaText;
          if (turn.verbosity === "messages" || turn.verbosity === "tools" || turn.verbosity === "trace") {
            turn.emit({
              type: "message", sessionId: this.sessionId, turnId: turn.turnId, seq: 0, at: now,
              role: "assistant", text: deltaText, delta: true,
            } as StreamEvent);
          }
        }
      } else if (state === "final") {
        // final 文本优先取 payload，没有则用累积的 delta
        const finalText =
          (payload.message as { text?: string })?.text ??
          (payload.finalText as string) ??
          turn.acc;
        turn.emit({
          type: "result", sessionId: this.sessionId, turnId: turn.turnId, seq: 0, at: now,
          text: finalText, status: "completed", final: true,
        } as StreamEvent);
        turn.done();
        this.activeTurn = undefined;
    }
  }

  async send(input: string, opts: SendOptions): Promise<void> {
    const { turnId, emit } = opts;
    let message = input;
    if (opts.skills && opts.skills.length > 0) {
      message = `[必须本轮加载并使用这些 skill: ${opts.skills.join(", ")}]\n\n${input}`;
    }

    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(guard);
        resolve();
      };
      this.activeTurn = { turnId, emit, verbosity: opts.verbosity, done: finish, acc: "" };
      this.gw
        .rpc("chat.send", {
          sessionKey: this.sessionKey,
          message,
          deliver: false,
          idempotencyKey: randomUUID(),
        }, 1800000)
        .catch((err) => {
          emit({
            type: "error", sessionId: this.sessionId, turnId, seq: 0, at: new Date().toISOString(),
            message: (err as Error)?.message ?? "chat.send failed", status: "failed", final: true,
          } as StreamEvent);
          this.activeTurn = undefined;
          finish();
        });
      // 兜底超时：30 分钟没 final 就强制收尾
      const guard = setTimeout(() => {
        if (this.activeTurn?.turnId === turnId) {
          emit({
            type: "result", sessionId: this.sessionId, turnId, seq: 0, at: new Date().toISOString(),
            text: "", status: "timeout", final: true,
          } as StreamEvent);
          this.activeTurn = undefined;
          finish();
        }
      }, 1800000);
    });
  }

  async interrupt(): Promise<void> {
    await this.gw.rpc("chat.abort", { sessionKey: this.sessionKey }, 5000).catch(() => {});
  }

  async switchModel(model: string): Promise<{ warnings?: string[] }> {
    this.model = model;
    await this.gw.rpc("sessions.patch", { key: this.sessionKey, model }, 10000).catch(() => {});
    return {};
  }

  async inject(context: ContextItem[]): Promise<void> {
    if (context.length === 0) return;
    const message = context.map((c) => `[${c.role}] ${c.content}`).join("\n");
    await this.gw.rpc("chat.inject", { sessionKey: this.sessionKey, message }, 10000).catch(() => {});
  }

  async compressCustom(strategy = "dropToolIO", options?: { keepRecentToolCalls?: number }): Promise<{ summary?: string; filesChanged?: number; recordsChanged?: number; blocksRemoved?: number; bytesBefore?: number; bytesAfter?: number; backups?: string[] }> {
    if (strategy !== "dropToolIO") throw new Error(`unsupported custom compression strategy: ${strategy}`);
    const file = this.resolveSessionFile();
    if (!file) throw new Error(`OpenClaw session file not found for ${this.sessionKey}`);
    const r = await dropToolIOFromJsonlFiles([file], options);
    return { summary: `dropToolIO removed ${r.blocksRemoved} tool blocks from ${r.filesChanged} files`, ...r };
  }

  async compressNative(): Promise<{ summary?: string }> {
    await this.gw.rpc("sessions.compact", { key: this.sessionKey }, 600000).catch(() => {});
    return { summary: "compacted via sessions.compact" };
  }

  private resolveSessionFile(): string | undefined {
    const sessionsJson = join(homedir(), ".openclaw", "agents", this.openclawAgent, "sessions", "sessions.json");
    try {
      if (existsSync(sessionsJson)) {
        const sessions = JSON.parse(readFileSync(sessionsJson, "utf8")) as Record<string, { sessionId?: string }>;
        const id = sessions[this.sessionKey]?.sessionId;
        if (id) {
          const p = join(homedir(), ".openclaw", "agents", this.openclawAgent, "sessions", `${id}.jsonl`);
          if (existsSync(p)) return p;
        }
      }
    } catch {
      // fall through
    }
    return undefined;
  }

  async terminate(): Promise<void> {
    await this.interrupt();
    // 不删 transcript：留痕。仅停活动。
  }

  async describe(): Promise<{ contextWindow?: number; usedTokens?: number; compactions?: number }> {
    try {
      const d = await this.gw.rpc("sessions.describe", { key: this.sessionKey }, 8000);
      const sess = (d.session ?? {}) as Record<string, unknown>;
      return {
        contextWindow: typeof sess.contextTokens === "number" ? sess.contextTokens : undefined,
        usedTokens: typeof sess.usedContextTokens === "number" ? sess.usedContextTokens : undefined,
        compactions: typeof sess.compactions === "number" ? sess.compactions : undefined,
      };
    } catch {
      return {};
    }
  }
}

export class OpenClawGatewayAdapter implements AgentAdapter {
  readonly name = "openclaw";
  readonly capabilities = CAPABILITIES;
  private gw: GatewayClient;
  private defaultAgent: string;
  private sessions = new Map<string, GatewaySession>(); // sessionKey → session
  /** agentId(openclaw:sub) → workspace 路径（从 agents.list 缓存，用于 global skill 目录）。 */
  private workspaceCache = new Map<string, string>();

  constructor(opts: { gateway: GatewayConfig; defaultAgent?: string }) {
    this.gw = new GatewayClient(opts.gateway);
    this.defaultAgent = opts.defaultAgent ?? "main";
    // 路由 Gateway 事件到对应 session（按 sessionKey 过滤，不串台）
    this.gw.onEvent((event, payload) => {
      const sk = payload.sessionKey as string | undefined;
      if (!sk) return;
      const session = this.sessions.get(sk);
      session?.handleEvent(event, payload);
    });
  }

  async discoverAgents(): Promise<AgentDescriptor[]> {
    let connected = false;
    try {
      await this.gw.connect();
      connected = this.gw.isConnected();
    } catch {
      connected = false;
    }
    if (!connected) {
      return [
        {
          agentId: "openclaw" as AgentDescriptor["agentId"],
          displayName: "OpenClaw",
          adapter: "openclaw",
          available: false,
          unavailableReason: "OpenClaw Gateway not reachable",
          models: [],
          capabilities: CAPABILITIES,
          scannedAt: new Date().toISOString(),
        },
      ];
    }

    // 枚举该 Gateway 下所有 OpenClaw agent（按 workspace 分）
    let subAgents: Array<{ id: string; workspace?: string; model?: { primary?: string } | string }> = [];
    try {
      const r = await this.gw.rpc("agents.list", {}, 8000);
      subAgents = (r.agents as typeof subAgents) ?? [];
    } catch {
      subAgents = [{ id: this.defaultAgent }];
    }
    if (subAgents.length === 0) subAgents = [{ id: this.defaultAgent }];

    const now = new Date().toISOString();
    const gatewayModels = await this.listGatewayModels();
    return subAgents.map((a) => {
      if (a.workspace) this.workspaceCache.set(`openclaw:${a.id}`, a.workspace);
      const primaryModel =
        typeof a.model === "string" ? a.model : a.model?.primary;
      // 优先报 Gateway 的完整可用模型目录；拿不到时退回 agents.list 的 primary。
      const models = gatewayModels.length > 0 ? gatewayModels : (primaryModel ? [{ id: primaryModel, available: true }] : []);
      return {
        // 复合 agentId：openclaw:<subAgentId>（design D32）
        agentId: `openclaw:${a.id}` as AgentDescriptor["agentId"],
        displayName: `OpenClaw / ${a.id}`,
        adapter: "openclaw",
        available: true,
        models,
        capabilities: CAPABILITIES,
        scannedAt: now,
      } satisfies AgentDescriptor;
    });
  }

  private async listGatewayModels(): Promise<ModelInfo[]> {
    try {
      const r = await this.gw.rpc("models.list", { view: "all" }, 8000);
      const rows = Array.isArray(r.models) ? r.models as Array<Record<string, unknown>> : [];
      const models: ModelInfo[] = [];
      const seen = new Set<string>();
      for (const row of rows) {
        const id = typeof row.key === "string" ? row.key : (typeof row.id === "string" ? row.id : undefined);
        if (!id || seen.has(id)) continue;
        if (row.available === false || row.missing === true) continue;
        seen.add(id);
        const contextWindow = typeof row.contextWindow === "number"
          ? row.contextWindow
          : (typeof row.contextTokens === "number" ? row.contextTokens : undefined);
        models.push({
          id,
          ...(typeof row.name === "string" ? { displayName: row.name } : {}),
          ...(contextWindow && contextWindow > 0 ? { contextWindow } : {}),
          available: true,
        });
      }
      return models;
    } catch {
      return [];
    }
  }

  async createSession(params: CreateSessionParams): Promise<AdapterSession> {
    await this.gw.connect();
    // 从复合 agentId 解出 OpenClaw sub-agent：openclaw:phonon → phonon
    const subAgent =
      (params.agentConfig?.openclawAgent as string) ??
      (params.agentId.includes(":") ? params.agentId.split(":")[1]! : this.defaultAgent);
    const session = new GatewaySession(this.gw, params.sessionId, params.model, subAgent);
    // sessions.create 失败要外显（修 P0#6），不能静默吞
    try {
      await this.gw.rpc("sessions.create", { key: session.key, model: params.model }, 15000);
    } catch (err) {
      throw new Error(`OpenClaw sessions.create failed: ${(err as Error)?.message ?? "?"}`);
    }
    // 订阅自发输出（proactiveOutput）；订阅失败不致命，记警告即可
    await this.gw.rpc("sessions.messages.subscribe", { key: session.key }, 10000).catch((e) => {
      console.warn(`[openclaw-gateway] subscribe failed for ${session.key}: ${(e as Error)?.message}`);
    });
    this.sessions.set(session.key, session);
    return session;
  }

  /** 关闭 Gateway 连接（daemon 退出时）。 */
  close(): void {
    this.gw.close();
  }

  /** OpenClaw 某 sub-agent 的 global skill 目录 = 该 agent workspace/skills。 */
  globalSkillDir(agentId: string): string | undefined {
    const ws = this.workspaceCache.get(agentId);
    return ws ? `${ws}/skills` : undefined;
  }
}
