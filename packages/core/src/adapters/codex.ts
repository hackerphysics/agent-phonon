import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, readdirSync, statSync } from "node:fs";
import { dropToolIOFromJsonlFiles } from "../custom-compress.js";
import type {
  AgentAdapter,
  AdapterSession,
  CreateSessionParams,
  SendOptions,
} from "../adapter.js";
import type { AgentCapabilities, AgentDescriptor, StreamEvent, ContextItem, ModelInfo } from "@agent-phonon/protocol";

/**
 * Codex adapter（design D10，单 agent runtime）。
 *
 * 调用（详见 docs/agent-cli-integration.md）：
 *   codex exec - --json -c model_provider=<id> -c model_providers.<id>.base_url=...
 *     -c model_providers.<id>.wire_api=responses --model X
 *     --dangerously-bypass-approvals-and-sandbox
 *   prompt 走 stdin（argv 用 "-"）；resume：codex exec resume <thread_id> - --json ...
 *
 * 网关由调用方通过 CodexEnv 传入（baseUrl/apiKey/wireApi），adapter 不绑定任何特定网关；
 * 用 -c 临时覆盖 provider（不动用户的 ~/.codex/config.toml）。
 */

const CAPABILITIES: AgentCapabilities = {
  nativeSession: true, // exec resume <thread_id>
  nativeCompression: false,
  contextInjection: true, // 拼进下轮 prompt
  proactiveOutput: false,
  modelSwitch: true,
  interrupt: true, // kill
  injectMidTurn: false,
  skillManagement: false,
  hooks: ["pre_command"],
  streaming: true, // --json 事件流
  limits: { maxConcurrentSessions: 4 },
};

/**
 * 定位 Codex rollout 会话文件。
 * 文件名形如 sessions/YYYY/MM/DD/rollout-<ts>-<thread_id>.jsonl，后缀 uuid == thread_id。
 * 取匹配 thread_id 里 mtime 最新的一个(同 thread 可能跨多次 exec resume)。
 */
export function resolveCodexSessionFile(threadId: string, codexHome = join(homedir(), ".codex")): string | undefined {
  const root = join(codexHome, "sessions");
  if (!existsSync(root)) return undefined;
  const hits: Array<{ path: string; mtime: number }> = [];
  const walk = (dir: string): void => {
    let names: string[];
    try { names = readdirSync(dir); } catch { return; }
    for (const name of names) {
      const full = join(dir, name);
      let st;
      try { st = statSync(full); } catch { continue; }
      if (st.isDirectory()) walk(full);
      else if (name.endsWith(`-${threadId}.jsonl`)) hits.push({ path: full, mtime: st.mtimeMs });
    }
  };
  walk(root);
  if (hits.length === 0) return undefined;
  hits.sort((a, b) => b.mtime - a.mtime);
  return hits[0]!.path;
}

export interface CodexEnv {
  /** Codex executable path. Prefer an absolute path when running under systemd/launchd. */
  binPath?: string;
  /** Optional OpenAI-compatible endpoint override. Omit to use the user's native Codex config. */
  baseUrl?: string;
  /** Optional API key for baseUrl. Omit to use the user's native Codex config. */
  apiKey?: string;
  /** `default` means let Codex use the user's configured default. */
  defaultModel: string;
  /** 可选：由用户配置/上层配置发现到的真实可用模型。 */
  models?: ModelInfo[];
  /** wire_api：responses 或 chat（取决于网关/模型支持）。 */
  wireApi?: "responses" | "chat";
  /** -c model_provider 的 provider id（中性默认）。 */
  providerId?: string;
  /** provider 显示名（默认 phonon-gateway）。 */
  providerName?: string;
}

class CodexSession implements AdapterSession {
  readonly sessionId: string;
  model: string;
  private cwd: string;
  private env: CodexEnv;
  private threadId?: string; // Codex thread_id（= 会话），从 thread.started 抓
  private current?: ReturnType<typeof spawn>;
  private pendingInject: string[] = [];

  constructor(sessionId: string, model: string, cwd: string, env: CodexEnv) {
    this.sessionId = sessionId;
    this.model = model;
    this.cwd = cwd;
    this.env = env;
  }

  private providerArgs(): string[] {
    if (!this.env.baseUrl || !this.env.apiKey) return [];
    const id = this.env.providerId ?? "phonon_gateway";
    const name = this.env.providerName ?? "phonon-gateway";
    return [
      "-c", `model_provider=${id}`,
      "-c", `model_providers.${id}.name=${name}`,
      "-c", `model_providers.${id}.base_url=${this.env.baseUrl}`,
      "-c", `model_providers.${id}.wire_api=${this.env.wireApi ?? "responses"}`,
      "-c", `model_providers.${id}.env_key=OPENAI_API_KEY`,
    ];
  }

  async send(input: string, opts: SendOptions): Promise<void> {
    const { turnId, emit } = opts;
    let prompt = input;
    if (this.pendingInject.length > 0) {
      prompt = this.pendingInject.join("\n") + "\n\n" + prompt;
      this.pendingInject = [];
    }
    if (opts.skills && opts.skills.length > 0) {
      prompt = `[本轮请使用这些能力: ${opts.skills.join(", ")}]\n\n${prompt}`;
    }

    const args = this.threadId
      ? ["exec", "resume", this.threadId, "-", "--json", ...this.providerArgs(), ...(this.model !== "default" ? ["--model", this.model] : []), "--dangerously-bypass-approvals-and-sandbox"]
      : ["exec", "-", "--json", ...this.providerArgs(), ...(this.model !== "default" ? ["--model", this.model] : []), "--dangerously-bypass-approvals-and-sandbox"];

    await this.run(args, prompt, turnId, emit, opts);
  }

  private run(args: string[], stdin: string, turnId: string, emit: (e: StreamEvent) => void, opts: SendOptions): Promise<void> {
    return new Promise((resolve) => {
      const child = spawn(this.env.binPath ?? "codex", args, {
        cwd: this.cwd,
        env: { ...process.env, ...(opts.environment ?? {}), ...(this.env.apiKey ? { OPENAI_API_KEY: this.env.apiKey } : {}) } as NodeJS.ProcessEnv,
      });
      this.current = child;
      let buf = "";
      let acc = "";
      let settled = false;
      const finish = (status: "completed" | "failed" | "interrupted" | "timeout", text: string, message?: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(guard);
        this.current = undefined;
        if (status === "failed") {
          emit({ type: "error", sessionId: this.sessionId, turnId, seq: 0, at: new Date().toISOString(), message: message ?? "codex failed", status: "failed", final: true } as StreamEvent);
        } else {
          emit({ type: "result", sessionId: this.sessionId, turnId, seq: 0, at: new Date().toISOString(), text, status, final: true } as StreamEvent);
        }
        resolve();
      };
      const guard = setTimeout(() => finish("timeout", acc), 1800000);
      opts.signal?.addEventListener("abort", () => { child.kill("SIGTERM"); finish("interrupted", acc); }, { once: true });

      child.stdout.on("data", (d) => {
        buf += d.toString();
        let nl;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          let ev: Record<string, unknown>;
          try { ev = JSON.parse(line); } catch { continue; }
          this.handleEvent(ev, turnId, emit, (t) => (acc += t));
        }
      });
      child.on("error", (e) => finish("failed", "", e.message));
      child.on("close", (code) => {
        if (settled) return;
        finish(code === 0 ? "completed" : "failed", acc, code !== 0 ? `codex exited ${code}` : undefined);
      });

      child.stdin.write(stdin);
      child.stdin.end();
    });
  }

  /** 解析 Codex JSON 事件流 → phonon StreamEvent。 */
  private handleEvent(ev: Record<string, unknown>, turnId: string, emit: (e: StreamEvent) => void, addText: (t: string) => void): void {
    const now = new Date().toISOString();
    const type = ev.type as string;
    if (type === "thread.started") {
      this.threadId = ev.thread_id as string; // 记录会话 id 供 resume
    } else if (type === "item.completed") {
      const item = ev.item as { type?: string; text?: string; name?: string; command?: string } | undefined;
      if (item?.type === "agent_message" && typeof item.text === "string") {
        addText(item.text);
        emit({ type: "message", sessionId: this.sessionId, turnId, seq: 0, at: now, role: "assistant", text: item.text, delta: true } as StreamEvent);
      } else if (item?.type === "command_execution") {
        emit({ type: "tool_call", sessionId: this.sessionId, turnId, seq: 0, at: now, toolName: "command_execution", args: { command: item.command } } as StreamEvent);
      }
    }
    // turn.completed 由 close 收尾
  }

  async interrupt(): Promise<void> {
    if (this.current) { this.current.kill("SIGTERM"); this.current = undefined; }
  }
  async switchModel(model: string): Promise<{ warnings?: string[] }> { this.model = model; return {}; }
  async inject(context: ContextItem[]): Promise<void> {
    for (const c of context) this.pendingInject.push(`[${c.role}] ${c.content}`);
  }

  /**
   * 自定义压缩(dropToolIO)：编辑 Codex rollout JSONL，删掉旧的 function_call /
   * function_call_output 等工具记录，保留 message/reasoning 等文本，默认保留最近 3 个工具调用。
   */
  async compressCustom(strategy = "dropToolIO", options?: { keepRecentToolCalls?: number }): Promise<{ summary?: string; filesChanged?: number; recordsChanged?: number; blocksRemoved?: number; bytesBefore?: number; bytesAfter?: number; backups?: string[] }> {
    if (strategy !== "dropToolIO") throw new Error(`unsupported custom compression strategy: ${strategy}`);
    if (!this.threadId) throw new Error("Codex session has no thread_id yet (no turn run); nothing to compress");
    const file = resolveCodexSessionFile(this.threadId);
    if (!file) throw new Error(`Codex rollout file not found for thread ${this.threadId}`);
    const r = await dropToolIOFromJsonlFiles([file], options);
    return { summary: `dropToolIO removed ${r.blocksRemoved} tool records from Codex rollout`, ...r };
  }

  async terminate(): Promise<void> { await this.interrupt(); }
}

export class CodexAdapter implements AgentAdapter {
  readonly name = "codex";
  readonly capabilities = CAPABILITIES;
  private env: CodexEnv;

  constructor(opts: { env: CodexEnv }) {
    this.env = opts.env;
  }

  async discoverAgents(): Promise<AgentDescriptor[]> {
    const version = await this.probeVersion();
    const available = version !== null;
    return [{
      agentId: "codex" as AgentDescriptor["agentId"],
      displayName: "Codex",
      adapter: "codex",
      available,
      ...(available ? {} : { unavailableReason: "codex CLI not found" }),
      ...(version ? { version } : {}),
      models: this.env.models?.length
        ? this.env.models
        : [{ id: this.env.defaultModel, available: true }],
      capabilities: CAPABILITIES,
      scannedAt: new Date().toISOString(),
    }];
  }

  async createSession(params: CreateSessionParams): Promise<AdapterSession> {
    return new CodexSession(params.sessionId, params.model, params.cwd, this.env);
  }

  private probeVersion(): Promise<string | null> {
    return new Promise((resolve) => {
      const child = spawn(this.env.binPath ?? "codex", ["--version"]);
      let out = "";
      child.stdout.on("data", (d) => (out += d.toString()));
      child.on("error", () => resolve(null));
      child.on("close", (code) => resolve(code === 0 ? out.trim() : null));
    });
  }
}
