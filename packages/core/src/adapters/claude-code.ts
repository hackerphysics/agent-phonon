import { spawnSupervisedAgent, type ProcessSupervisor } from "../process-supervisor.js";
import { discoveryProbe } from "../discovery-probe.js";
import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, isAbsolute } from "node:path";
import { dropToolIOFromJsonlFiles } from "../custom-compress.js";
import { buildChildProcessEnvironment } from "../child-env.js";
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
 *     [--model X] [--session-id <uuid> | --resume <uuid>]
 *   prompt 走 stdin envelope（不是 argv），剥离 CLAUDECODE env，
 *   认证沿用 native HOME；显式宿主机覆盖仅通过子进程环境传入，不写临时凭据文件。
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
  /** Owner-selected standalone settings file; replaces legacy endpoint/auth/default-model overrides. */
  settingsPath?: string;
  /** Optional Anthropic-compatible endpoint override. Omit to use the user's native Claude Code login/config. */
  baseUrl?: string;
  /** Optional auth token for baseUrl. Omit to use the user's native Claude Code login/config. */
  authToken?: string;
  /** 默认模型；`default` means let Claude Code use the user's configured default. */
  defaultModel: string;
  /** 可选：由用户配置/上层配置发现到的真实可用模型。 */
  models?: ModelInfo[];
}

/** Owner config only: no session/RPC parameter can choose this file. */
export function claudeSettingsEnvironment(env: ClaudeCodeEnv, environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (!env.settingsPath) {
    if (env.baseUrl && env.authToken) {
      environment.ANTHROPIC_BASE_URL = env.baseUrl;
      environment.ANTHROPIC_AUTH_TOKEN = env.authToken;
    }
    return environment;
  }
  if (!isAbsolute(env.settingsPath) || !statSync(env.settingsPath).isFile()) throw new Error("claudeSettingsPath must be an absolute owner-configured file");
  const settings = JSON.parse(readFileSync(env.settingsPath, "utf8"));
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) throw new Error("Claude settings must be a JSON object");
  const selected = settings.env ?? {};
  if (!selected || typeof selected !== "object" || Array.isArray(selected) || Object.values(selected).some(v => typeof v !== "string")) throw new Error("Claude settings.env must contain string values");
  if (selected.ANTHROPIC_BASE_URL && !selected.ANTHROPIC_API_KEY && !selected.ANTHROPIC_AUTH_TOKEN && !settings.apiKeyHelper) throw new Error("Standalone Claude endpoint settings must supply their own auth or apiKeyHelper; refusing inherited credentials");
  // Do not combine an old endpoint's credentials or model with a selected file.
  // --setting-sources '' also prevents user/project/local settings from merging.
  for (const key of Object.keys(environment)) {
    if (key.startsWith("ANTHROPIC_") || key.startsWith("CLAUDE_CODE_USE_") || key === "CLAUDE_CODE_OAUTH_TOKEN") delete environment[key];
  }
  Object.assign(environment, selected);
  return environment;
}

class ClaudeCodeSession implements AdapterSession {
  readonly sessionId: string;
  model: string;
  private uuid: string; // Claude Code session UUID
  private cwd: string;
  private env: ClaudeCodeEnv;
  private started = false; // 是否已建过（决定 --session-id vs --resume）
  private current?: ProcessSupervisor;
  private pendingInject: string[] = [];
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
      // Retain native approval policy; the adapter must not auto-elevate tools.
    ];
    if (this.env.settingsPath) args.push("--setting-sources", "", "--settings", this.env.settingsPath);
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
      const inherited: NodeJS.ProcessEnv = {};
      for (const [k, v] of Object.entries(process.env)) {
        if (k === "CLAUDECODE" || k.startsWith("CLAUDECODE_")) continue;
        if (v !== undefined) inherited[k] = v;
      }

      const environment = buildChildProcessEnvironment(opts.environment, inherited);
      // Trusted host configuration is passed only in the child environment, never
      // copied into a settings file or command-line argument. Native auth stays intact.
      try { claudeSettingsEnvironment(this.env, environment); }
      catch {
        emit({ type: "error", sessionId: this.sessionId, turnId, seq: 0, at: new Date().toISOString(), message: "Invalid standalone Claude settings: expected an absolute JSON file with self-contained endpoint authentication", status: "failed", final: true } as StreamEvent);
        resolve(); return;
      }
      const supervisor = spawnSupervisedAgent(this.env.binPath ?? "claude", args, { cwd: this.cwd, env: environment });
      const child = supervisor.child;
      this.current = supervisor;
      const releaseCurrent = (): void => { if (this.current === supervisor) this.current = undefined; };
      child.once("close", releaseCurrent);
      child.once("error", releaseCurrent);
      let buf = "";
      let acc = "";
      let settled = false;
      const abort = (): void => { void supervisor.terminate(); finish("interrupted", acc); };
      const finish = (status: "completed" | "failed" | "interrupted" | "timeout", text: string, message?: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(guard);
        opts.signal?.removeEventListener("abort", abort);
        if (status === "failed") {
          emit({ type: "error", sessionId: this.sessionId, turnId, seq: 0, at: new Date().toISOString(), message: message ?? "claude failed", status: "failed", final: true } as StreamEvent);
        } else {
          emit({ type: "result", sessionId: this.sessionId, turnId, seq: 0, at: new Date().toISOString(), text, status, final: true } as StreamEvent);
        }
        resolve();
      };

      const guard = setTimeout(() => { void supervisor.terminate(); finish("timeout", acc); }, 1800000);
      if (opts.signal?.aborted) abort();
      else opts.signal?.addEventListener("abort", abort, { once: true });

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
    // Claude Code 把 cwd 编码成 projects 子目录名：把 / \ : . 全部替换成 -。
    // 例：POSIX /home/x/.cc → -home-x--cc；Windows C:\proj → C--proj。
    // （旧实现只替换 / 和 \，Windows 的盘符冒号 : 没处理 → 目录名对不上 → 丢原生会话续接。）
    const projectsRoot = join(homedir(), ".claude", "projects");
    const projectDir = this.cwd.replace(/[/\\:.]/g, "-");
    const primary = join(projectsRoot, projectDir, `${this.uuid}.jsonl`);
    if (existsSync(primary)) return primary;
    // 兜底：uuid 全局唯一，扫描 projects/*/ 找 <uuid>.jsonl，
    // 防止编码规则在某平台有细微差异（盘符大小写、特殊字符等）导致主路径算错。
    try {
      for (const dir of readdirSync(projectsRoot)) {
        const p = join(projectsRoot, dir, `${this.uuid}.jsonl`);
        if (existsSync(p)) return p;
      }
    } catch { /* projects 目录不存在等，忽略 */ }
    return undefined;
  }

  async interrupt(): Promise<void> {
    if (this.current) { const current = this.current; this.current = undefined; await current.terminate(); }
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

  async discoverAgents(signal?: AbortSignal): Promise<AgentDescriptor[]> {
    const version = await this.probeVersion(signal);
    const available = version !== null;
    return [{
      agentId: "claude-code" as AgentDescriptor["agentId"],
      displayName: "Claude Code",
      adapter: "claude-code",
      available,
      ...(available ? {} : { unavailableReason: "claude CLI not found" }),
      ...(version ? { version } : {}),
      models: this.env.settingsPath ? [{ id: "default", displayName: "Selected standalone Claude settings", available: true }] : this.env.models?.length
        ? this.env.models
        : [{ id: this.env.defaultModel, available: true }],
      capabilities: CAPABILITIES,
      scannedAt: new Date().toISOString(),
    }];
  }

  async createSession(params: CreateSessionParams): Promise<AdapterSession> {
    return new ClaudeCodeSession(params.sessionId, params.model, params.cwd, this.env, params.initialContext);
  }

  private async probeVersion(signal?: AbortSignal): Promise<string | null> {
    return (await discoveryProbe(this.env.binPath ?? "claude", ["--version"], signal));
  }
}
