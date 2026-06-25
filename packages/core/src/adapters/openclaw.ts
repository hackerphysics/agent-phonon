import type { ChildProcess } from "node:child_process";
import { spawnAgent } from "../proc.js";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { dropToolIOFromJsonlFiles } from "../custom-compress.js";
import type {
  AgentAdapter,
  AdapterSession,
  CreateSessionParams,
  SendOptions,
} from "../adapter.js";
import { formatInitialContextLines } from "../adapter.js";
import type { AgentCapabilities, AgentDescriptor, StreamEvent, ContextItem } from "@agent-phonon/protocol";

/**
 * OpenClaw adapter（design D10，第一个 adapter）。
 *
 * 驱动 `openclaw agent --local --json --session-key <key> --message <text> [--model <id>]`。
 * 实测（2026-06-20）：
 *   - --session-key 给持续会话，同 key 跨调用记忆上下文 → nativeSession=true
 *   - --json 输出 { payloads:[{text}], meta:{ finalAssistantVisibleText, ... } }
 *   - --model 覆盖模型 → modelSwitch=true（下一轮生效）
 * OpenClaw adapter 极薄（design D8）：直接调 CLI，把最终文本封成 result 事件。
 */

const OPENCLAW_CAPABILITIES: AgentCapabilities = {
  nativeSession: true, // --session-key resume
  nativeCompression: true, // OpenClaw 有 /compact
  contextInjection: true, // 可在 message 前注入
  proactiveOutput: true, // OpenClaw 有 cron/心跳，会自发输出
  modelSwitch: true, // --model 覆盖
  interrupt: false, // CLI 一次性调用，靠 core 兜底 kill 子进程
  injectMidTurn: false,
  skillManagement: true, // OpenClaw 有 skills 目录
  hooks: ["pre_tool", "pre_command"],
  streaming: false, // --json 是一次性返回，非增量流（v0 用 final 事件）
  workflowRoles: ["executor", "worker"],
  limits: { maxConcurrentSessions: 4, maxContextTokens: 1048576 },
};

interface OpenClawJson {
  payloads?: Array<{ text?: string }>;
  meta?: {
    finalAssistantVisibleText?: string;
    aborted?: boolean;
    stopReason?: string;
  };
}

class OpenClawSession implements AdapterSession {
  readonly sessionId: string;
  model: string;
  private sessionKey: string;
  private cwd: string;
  private openclawAgent: string;
  private current?: ChildProcess;
  /** 暂存的注入上下文（下次 send 拼进 input，不单独跑一轮，修 P0#13）。 */
  private pendingInject: string[] = [];

  constructor(sessionId: string, model: string, cwd: string, openclawAgent = "main", initialContext?: ContextItem[]) {
    this.sessionId = sessionId;
    this.model = model;
    this.cwd = cwd;
    this.openclawAgent = openclawAgent;
    // 用 phonon sessionId 派生稳定的 OpenClaw session-key
    this.sessionKey = `agent:${openclawAgent}:phonon-${sessionId}`;
    // contextInjection: 把 createSession 的 initialContext（含 workflow systemPrompt/角色定义）
    // 暂存进 pendingInject，首轮 send 时拼进首条 message。OpenClaw spawn 版没有独立
    // system-prompt 通道，这是注入 system 上下文的唯一可靠方式（修：之前 initialContext 被丢弃，
    // 导致 workflow executor 的 systemPrompt 根本没传给模型）。
    this.pendingInject.push(...formatInitialContextLines(initialContext));
  }

  async send(input: string, opts: SendOptions): Promise<void> {
    const { turnId, emit } = opts;

    let message = input;
    // 暂存的注入先拼进本轮（避免单独 turn，P0#13）
    if (this.pendingInject.length > 0) {
      message = this.pendingInject.join("\n") + "\n\n" + message;
      this.pendingInject = [];
    }
    // 若指定了 skill，在 message 前注入强制加载指令（D26 方式2）
    if (opts.skills && opts.skills.length > 0) {
      message = `[必须本轮加载并使用这些 skill: ${opts.skills.join(", ")}]\n\n${message}`;
    }

    const args = [
      "agent",
      "--local",
      "--agent",
      this.openclawAgent,
      "--json",
      "--session-key",
      this.sessionKey,
      "--message",
      message,
      "--model",
      this.model,
    ];

    const stdout = await this.run(args, opts.signal, opts.environment);
    if (stdout === null) {
      // 被 interrupt
      emit({
        type: "result",
        sessionId: this.sessionId,
        turnId,
        seq: 0,
        at: new Date().toISOString(),
        text: "",
        status: "interrupted",
        final: true,
      } as StreamEvent);
      return;
    }

    let parsed: OpenClawJson | undefined;
    try {
      parsed = JSON.parse(stdout) as OpenClawJson;
    } catch {
      // 解析失败也要给终态
    }
    const text =
      parsed?.meta?.finalAssistantVisibleText ?? parsed?.payloads?.[0]?.text ?? stdout.slice(0, 2000);

    emit({
      type: "result",
      sessionId: this.sessionId,
      turnId,
      seq: 0,
      at: new Date().toISOString(),
      text,
      status: parsed?.meta?.aborted ? "aborted" : "completed",
      final: true,
    } as StreamEvent);
  }

  async interrupt(): Promise<void> {
    if (this.current) {
      this.current.kill("SIGTERM");
      this.current = undefined;
    }
  }

  async switchModel(model: string): Promise<{ warnings?: string[] }> {
    this.model = model;
    return {};
  }

  async inject(context: ContextItem[]): Promise<void> {
    // OpenClaw spawn 版没有 transcript append API：暂存到下次 send 拼进 input，
    // 不单独跑一轮（修 P0#13：之前会产生额外 turn）。
    if (context.length === 0) return;
    for (const c of context) this.pendingInject.push(`[${c.role}] ${c.content}`);
  }

  async compressCustom(strategy = "dropToolIO", options?: { keepRecentToolCalls?: number }): Promise<{ summary?: string; filesChanged?: number; recordsChanged?: number; blocksRemoved?: number; bytesBefore?: number; bytesAfter?: number; backups?: string[] }> {
    if (strategy !== "dropToolIO") throw new Error(`unsupported custom compression strategy: ${strategy}`);
    const file = this.resolveSessionFile();
    if (!file) throw new Error(`OpenClaw session file not found for ${this.sessionKey}`);
    const r = await dropToolIOFromJsonlFiles([file], options);
    return { summary: `dropToolIO removed ${r.blocksRemoved} tool blocks from ${r.filesChanged} files`, ...r };
  }

  async compressNative(): Promise<{ summary?: string }> {
    await this.run([
      "agent", "--local", "--agent", this.openclawAgent, "--json",
      "--session-key", this.sessionKey,
      "--message", "/compact",
      "--model", this.model,
    ]);
    return { summary: "compacted via OpenClaw /compact" };
  }

  async terminate(): Promise<void> {
    await this.interrupt();
    // OpenClaw session 落盘可保留；phonon 侧标记 terminated 即可。
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

  private run(args: string[], signal?: AbortSignal, environment?: Record<string, string>): Promise<string | null> {
    return new Promise((resolve, reject) => {
      // shell:win32 — npm 全局 `openclaw` 在 Windows 是 .cmd shim，Node 22 不带 shell 直接 spawn .cmd 会抛 EINVAL（与 claude/codex/hermes adapter 保持一致）。
      const child = spawnAgent("openclaw", args, { cwd: this.cwd, env: { ...process.env, ...(environment ?? {}) } as NodeJS.ProcessEnv });
      this.current = child;
      let out = "";
      let err = "";
      let killed = false;
      child.stdout.on("data", (d) => (out += d.toString()));
      child.stderr.on("data", (d) => (err += d.toString()));
      const onAbort = () => {
        killed = true;
        child.kill("SIGTERM");
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      child.on("error", reject);
      child.on("close", (code) => {
        signal?.removeEventListener("abort", onAbort);
        this.current = undefined;
        if (killed) return resolve(null);
        if (code === 0) resolve(out);
        else reject(new Error(`openclaw exited ${code}: ${err.slice(0, 500)}`));
      });
    });
  }
}

export class OpenClawAdapter implements AgentAdapter {
  readonly name = "openclaw";
  readonly capabilities = OPENCLAW_CAPABILITIES;
  /** 默认驱动哪个 OpenClaw agent（可被 session agentConfig.openclawAgent 覆盖）。 */
  private defaultAgent: string;

  constructor(opts: { defaultAgent?: string } = {}) {
    this.defaultAgent = opts.defaultAgent ?? "main";
  }

  async discover(): Promise<AgentDescriptor> {
    return (await this.discoverAgents())[0]!;
  }

  async discoverAgents(): Promise<AgentDescriptor[]> {
    // 探测 openclaw 是否可用 + 版本
    const version = await this.probeVersion();
    const available = version !== null;
    if (!available) {
      return [{
        agentId: "openclaw" as AgentDescriptor["agentId"],
        displayName: "OpenClaw",
        adapter: "openclaw",
        available: false,
        unavailableReason: "openclaw CLI not found",
        models: [],
        capabilities: OPENCLAW_CAPABILITIES,
        scannedAt: new Date().toISOString(),
      }];
    }
    // spawn 版不枚举多 agent（Gateway 版才枚举）：只报 defaultAgent
    return [{
      agentId: `openclaw:${this.defaultAgent}` as AgentDescriptor["agentId"],
      displayName: `OpenClaw / ${this.defaultAgent}`,
      adapter: "openclaw",
      available: true,
      ...(version ? { version } : {}),
      models: [
        { id: "github-copilot/claude-opus-4.8", displayName: "Claude Opus 4.8", available: true },
        { id: "github-copilot/gpt-5.5", displayName: "GPT-5.5", available: true },
      ],
      capabilities: OPENCLAW_CAPABILITIES,
      scannedAt: new Date().toISOString(),
    }];
  }

  async createSession(params: CreateSessionParams): Promise<AdapterSession> {
    const openclawAgent =
      (params.agentConfig?.openclawAgent as string) ??
      (params.agentId?.includes(":") ? params.agentId.split(":")[1]! : this.defaultAgent);
    return new OpenClawSession(params.sessionId, params.model, params.cwd, openclawAgent, params.initialContext);
  }

  private probeVersion(): Promise<string | null> {
    return new Promise((resolve) => {
      const child = spawnAgent("openclaw", ["--version"], {});
      let out = "";
      child.stdout.on("data", (d) => (out += d.toString()));
      child.on("error", () => resolve(null));
      child.on("close", (code) => resolve(code === 0 ? out.trim() : null));
    });
  }
}
