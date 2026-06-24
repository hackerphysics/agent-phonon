import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { writeFileSync, rmSync, mkdtempSync, existsSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { dropToolIOFromJsonlFiles } from "../custom-compress.js";
import type {
  AgentAdapter,
  AdapterSession,
  CreateSessionParams,
  SendOptions,
} from "../adapter.js";
import { formatInitialContextLines } from "../adapter.js";
import type { AgentCapabilities, AgentDescriptor, StreamEvent, ContextItem, ModelInfo } from "@agent-phonon/protocol";

/**
 * Claude Code adapter（design D10，单 agent runtime）。
 *
 * 调用方式（详见 docs/agent-cli-integration.md）：
 *   claude -p --output-format stream-json --input-format stream-json --verbose
 *     --permission-mode bypassPermissions --settings <env-json>
 *     [--model X] [--session-id <uuid> | --resume <uuid>]
 *   prompt 走 stdin envelope（不是 argv），剥离 CLAUDECODE env，
 *   认证用 --settings 注入完整 ANTHROPIC env 集（CC Switch 范式）。
 *
 * 单 agent runtime：discoverAgents 只返回一个 claude-code。
 */

const CAPABILITIES: AgentCapabilities = {
  nativeSession: true, // --session-id / --resume
  nativeCompression: false, // 无原生 compact，core custom 兜底
  contextInjection: true, // --append-system-prompt / stdin
  proactiveOutput: false, // 一次性，无自发输出
  modelSwitch: true, // --model 每轮可变
  interrupt: true, // kill 子进程
  injectMidTurn: false,
  skillManagement: true, // Claude Code 有 skills（/skill-name）
  hooks: ["pre_tool", "pre_command"],
  streaming: true, // stream-json 真流式
  workflowRoles: ["executor", "worker"],
  limits: { maxConcurrentSessions: 4 },
};

export interface ClaudeCodeEnv {
  /** Claude executable path. Prefer an absolute path when running under systemd/launchd. */
  binPath?: string;
  /** Optional Anthropic-compatible endpoint override. Omit to use the user's native Claude Code login/config. */
  baseUrl?: string;
  /** Optional auth token for baseUrl. Omit to use the user's native Claude Code login/config. */
  authToken?: string;
  /** 默认模型；`default` means let Claude Code use the user's configured default. */
  defaultModel: string;
  /** 可选：由用户配置/上层配置发现到的真实可用模型。 */
  models?: ModelInfo[];
}

/**
 * 写 settings 到临时 0600 文件（避免 token 进 argv 被 ps 看到，bug-bash#2 B4）。
 * 返回文件路径；调用方负责用后删（cleanup）。
 */
function writeSettingsFile(env: ClaudeCodeEnv, model: string): string | undefined {
  if (!env.baseUrl || !env.authToken) return undefined;
  const dir = mkdtempSync(join(tmpdir(), "phonon-cc-"));
  const file = join(dir, "settings.json");
  const content = JSON.stringify({
    env: {
      ANTHROPIC_BASE_URL: env.baseUrl,
      ANTHROPIC_AUTH_TOKEN: env.authToken,
      ...(model !== "default" ? {
        ANTHROPIC_MODEL: model,
        ANTHROPIC_DEFAULT_OPUS_MODEL: model,
        ANTHROPIC_DEFAULT_SONNET_MODEL: model,
        ANTHROPIC_DEFAULT_HAIKU_MODEL: model,
      } : {}),
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    },
  });
  writeFileSync(file, content, { mode: 0o600 });
  return file;
}

class ClaudeCodeSession implements AdapterSession {
  readonly sessionId: string;
  model: string;
  private uuid: string; // Claude Code session UUID
  private cwd: string;
  private env: ClaudeCodeEnv;
  private started = false; // 是否已建过（决定 --session-id vs --resume）
  private current?: ReturnType<typeof spawn>;
  private pendingInject: string[] = [];
  private settingsPath?: string;

  /** 本轮 settings 临时文件路径（每次 send 重建，finish 时删）。 */
  private settingsFile(): string | undefined {
    this.settingsPath = writeSettingsFile(this.env, this.model);
    return this.settingsPath;
  }

  constructor(sessionId: string, model: string, cwd: string, env: ClaudeCodeEnv, initialContext?: ContextItem[]) {
    this.sessionId = sessionId;
    this.model = model;
    this.cwd = cwd;
    this.env = env;
    this.uuid = randomUUID();
    // contextInjection: 把 createSession 的 initialContext（含 workflow systemPrompt/角色定义）
    // 暂存进 pendingInject，首轮 send 拼进 prompt（修：之前 initialContext 被丢弃，
    // 导致 workflow node 的 systemPrompt 没传给模型）。
    this.pendingInject.push(...formatInitialContextLines(initialContext));
  }

  async send(input: string, opts: SendOptions): Promise<void> {
    const { turnId, emit } = opts;
    let prompt = input;
    if (this.pendingInject.length > 0) {
      prompt = this.pendingInject.join("\n") + "\n\n" + prompt;
      this.pendingInject = [];
    }
    if (opts.skills && opts.skills.length > 0) {
      prompt = `[必须本轮加载并使用这些 skill: ${opts.skills.join(", ")}]\n\n${prompt}`;
    }

    const args = [
      "-p",
      "--output-format", "stream-json",
      "--input-format", "stream-json",
      "--verbose",
      // 最高权限：bypassPermissions 跳过所有权限确认；不限定 allowedTools = 所有工具可用
      // （phonon 定位：全自动执行，牺牲安全换自动化）
      "--permission-mode", "bypassPermissions",
    ];
    const settings = this.settingsFile();
    if (settings) args.push("--settings", settings);
    if (this.model !== "default") args.push("--model", this.model);
    // 首轮 --session-id，后续 --resume（持续会话）
    if (this.started) args.push("--resume", this.uuid);
    else args.push("--session-id", this.uuid);
    this.started = true;

    const envelope = JSON.stringify({
      type: "user",
      message: { role: "user", content: [{ type: "text", text: prompt }] },
    }) + "\n";

    await this.run(args, envelope, turnId, emit, opts);
  }

  private run(args: string[], stdin: string, turnId: string, emit: (e: StreamEvent) => void, opts: SendOptions): Promise<void> {
    return new Promise((resolve) => {
      // 剥离 CLAUDECODE* env（避免外层污染）
      const childEnv: Record<string, string> = {};
      for (const [k, v] of Object.entries(process.env)) {
        if (k === "CLAUDECODE" || k.startsWith("CLAUDECODE_") || k.startsWith("CLAUDE_CODE_")) continue;
        if (v !== undefined) childEnv[k] = v;
      }

      const child = spawn(this.env.binPath ?? "claude", args, { cwd: this.cwd, shell: process.platform === "win32", env: { ...childEnv, ...(opts.environment ?? {}) } });
      this.current = child;
      let buf = "";
      let acc = "";
      let settled = false;
      const finish = (status: "completed" | "failed" | "interrupted" | "timeout", text: string, message?: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(guard);
        this.current = undefined;
        // 清理 settings 临时文件（含 token）
        if (this.settingsPath) {
          try { rmSync(this.settingsPath, { force: true }); rmSync(join(this.settingsPath, ".."), { recursive: true, force: true }); } catch { /* ignore */ }
          this.settingsPath = undefined;
        }
        if (status === "failed") {
          emit({ type: "error", sessionId: this.sessionId, turnId, seq: 0, at: new Date().toISOString(), message: message ?? "claude failed", status: "failed", final: true } as StreamEvent);
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
          this.handleStreamEvent(ev, turnId, emit, (t) => (acc += t));
        }
      });
      child.stderr.on("data", () => { /* stream-json 已含错误 */ });
      child.on("error", (e) => finish("failed", "", e.message));
      child.on("close", (code) => {
        if (settled) return;
        finish(code === 0 ? "completed" : "failed", acc, code !== 0 ? `claude exited ${code}` : undefined);
      });

      child.stdin.write(stdin);
      child.stdin.end();
    });
  }

  /** 解析 Claude Code stream-json 事件 → phonon StreamEvent（流式 + 工具）。 */
  private handleStreamEvent(ev: Record<string, unknown>, turnId: string, emit: (e: StreamEvent) => void, addText: (t: string) => void): void {
    const now = new Date().toISOString();
    const type = ev.type as string;
    if (type === "assistant") {
      const msg = ev.message as { content?: Array<Record<string, unknown>> } | undefined;
      for (const block of msg?.content ?? []) {
        if (block.type === "text" && typeof block.text === "string") {
          addText(block.text);
          emit({ type: "message", sessionId: this.sessionId, turnId, seq: 0, at: now, role: "assistant", text: block.text, delta: true } as StreamEvent);
        } else if (block.type === "tool_use") {
          emit({ type: "tool_call", sessionId: this.sessionId, turnId, seq: 0, at: now, toolName: String(block.name ?? "?"), args: block.input, toolCallId: String(block.id ?? "") } as StreamEvent);
        }
      }
    } else if (type === "user") {
      // tool_result 回传
      const msg = ev.message as { content?: Array<Record<string, unknown>> } | undefined;
      for (const block of msg?.content ?? []) {
        if (block.type === "tool_result") {
          emit({ type: "tool_result", sessionId: this.sessionId, turnId, seq: 0, at: now, toolName: "", toolCallId: String(block.tool_use_id ?? ""), ok: !block.is_error, output: block.content } as StreamEvent);
        }
      }
    }
    // type === "result" 由 close 统一收尾（避免重复终态）
  }

  async compressCustom(strategy = "dropToolIO", options?: { keepRecentToolCalls?: number }): Promise<{ summary?: string; filesChanged?: number; recordsChanged?: number; blocksRemoved?: number; bytesBefore?: number; bytesAfter?: number; backups?: string[] }> {
    if (strategy !== "dropToolIO") throw new Error(`unsupported custom compression strategy: ${strategy}`);
    const file = this.resolveSessionFile();
    if (!file) throw new Error(`Claude Code session file not found for ${this.uuid}`);
    const r = await dropToolIOFromJsonlFiles([file], options);
    return { summary: `dropToolIO removed ${r.blocksRemoved} tool blocks from ${r.filesChanged} files`, ...r };
  }

  private resolveSessionFile(): string | undefined {
    const projectDir = this.cwd.replace(/\\/g, "-").replace(/\//g, "-");
    const file = join(homedir(), ".claude", "projects", projectDir, `${this.uuid}.jsonl`);
    return existsSync(file) ? file : undefined;
  }

  async interrupt(): Promise<void> {
    if (this.current) { this.current.kill("SIGTERM"); this.current = undefined; }
  }
  async switchModel(model: string): Promise<{ warnings?: string[] }> { this.model = model; return {}; }
  async inject(context: ContextItem[]): Promise<void> {
    for (const c of context) this.pendingInject.push(`[${c.role}] ${c.content}`);
  }
  async terminate(): Promise<void> { await this.interrupt(); }
}

export class ClaudeCodeAdapter implements AgentAdapter {
  readonly name = "claude-code";
  readonly capabilities = CAPABILITIES;
  private env: ClaudeCodeEnv;

  constructor(opts: { env: ClaudeCodeEnv }) {
    this.env = opts.env;
  }

  async discoverAgents(): Promise<AgentDescriptor[]> {
    const version = await this.probeVersion();
    const available = version !== null;
    return [{
      agentId: "claude-code" as AgentDescriptor["agentId"],
      displayName: "Claude Code",
      adapter: "claude-code",
      available,
      ...(available ? {} : { unavailableReason: "claude CLI not found" }),
      ...(version ? { version } : {}),
      models: this.env.models?.length
        ? this.env.models
        : [{ id: this.env.defaultModel, available: true }],
      capabilities: CAPABILITIES,
      scannedAt: new Date().toISOString(),
    }];
  }

  async createSession(params: CreateSessionParams): Promise<AdapterSession> {
    return new ClaudeCodeSession(params.sessionId, params.model, params.cwd, this.env, params.initialContext);
  }

  private probeVersion(): Promise<string | null> {
    return new Promise((resolve) => {
      const child = spawn(this.env.binPath ?? "claude", ["--version"], { shell: process.platform === "win32" });
      let out = "";
      child.stdout.on("data", (d) => (out += d.toString()));
      child.on("error", () => resolve(null));
      child.on("close", (code) => resolve(code === 0 ? out.trim() : null));
    });
  }
}
