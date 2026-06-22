import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { dropToolIORowsSqlite } from "../sqlite-compress.js";
import type {
  AgentAdapter,
  AdapterSession,
  CreateSessionParams,
  SendOptions,
} from "../adapter.js";
import type { AgentCapabilities, AgentDescriptor, StreamEvent, ContextItem } from "@agent-phonon/protocol";

/**
 * Hermes adapter（design D10/D32，**多 agent runtime**，同 OpenClaw）。
 *
 * Hermes profile = 独立 agent（各自 config.yaml/.env/SOUL.md/skills/workspace）。
 * 一个 Hermes 安装 = 一个 runtime，里面多个 profile = 多个 agent。
 * 复合 agentId：hermes:<profile>（如 hermes:default）。
 *
 * 调用：`HERMES_PROFILE=<profile> hermes -z <prompt> -m <model> --yolo --accept-hooks
 *   [--continue <name>]`。-z/--oneshot 纯文本输出（非流式）。
 * 枚举 profile：`hermes profile list`。
 *
 * 方案 A：用 Hermes 现有 provider 配置（不强制网关）。全自动：--yolo + --accept-hooks。
 */

const CAPABILITIES: AgentCapabilities = {
  nativeSession: true, // --resume / --pass-session-id
  nativeCompression: false,
  contextInjection: true, // 拼进下轮 prompt
  proactiveOutput: false,
  modelSwitch: true, // -m 每轮可变
  interrupt: true, // kill
  injectMidTurn: false,
  skillManagement: true, // hermes skills
  hooks: ["pre_command"],
  streaming: false, // -z 是纯文本一次性输出，非流式 → 用 final 事件
  limits: { maxConcurrentSessions: 4 },
};

export interface HermesEnv {
  /** 默认模型（如 anthropic/claude-opus-4.6 或 provider 自带格式）。 */
  defaultModel?: string;
  /** provider 覆盖（如 anthropic / openrouter；不传用 Hermes config 默认）。 */
  provider?: string;
  /** 额外 toolsets。 */
  toolsets?: string;
}

class HermesSession implements AdapterSession {
  readonly sessionId: string;
  model: string;
  private cwd: string;
  private env: HermesEnv;
  private profile: string;
  private hermesSessionId: string;
  private convName: string;
  private started = false;
  private current?: ReturnType<typeof spawn>;
  private pendingInject: string[] = [];

  constructor(sessionId: string, model: string, cwd: string, env: HermesEnv, profile: string) {
    this.sessionId = sessionId;
    this.model = model;
    this.cwd = cwd;
    this.env = env;
    this.profile = profile;
    this.hermesSessionId = randomUUID();
    this.convName = `phonon-${sessionId.replace(/[^a-zA-Z0-9_-]/g, "")}`;
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

    const args = ["-z", prompt];
    if (this.model) args.push("-m", this.model);
    if (this.env.provider) args.push("--provider", this.env.provider);
    if (this.env.toolsets) args.push("-t", this.env.toolsets);
    // 全自动模式：phonon 让 agent 自动跑，不等人授权
    args.push("--yolo", "--accept-hooks");
    // 持续会话：用 phonon sessionId 作为 Hermes 会话名，--continue <name> 恢复/创建
    // （--continue 接会话名，首轮创建、后续恢复）
    args.push("--continue", this.convName);
    this.started = true;

    await this.run(args, turnId, emit, opts);
  }

  private run(args: string[], turnId: string, emit: (e: StreamEvent) => void, opts: SendOptions): Promise<void> {
    return new Promise((resolve) => {
      const child = spawn("hermes", args, {
        cwd: this.cwd,
        env: { ...process.env, ...(opts.environment ?? {}), HERMES_PROFILE: this.profile } as NodeJS.ProcessEnv,
      });
      this.current = child;
      let out = "";
      let err = "";
      let settled = false;
      const finish = (status: "completed" | "failed" | "interrupted" | "timeout", text: string, message?: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(guard);
        this.current = undefined;
        if (status === "failed") {
          emit({ type: "error", sessionId: this.sessionId, turnId, seq: 0, at: new Date().toISOString(), message: message ?? "hermes failed", status: "failed", final: true } as StreamEvent);
        } else {
          // -z 是一次性文本：作为一条 message + result 终态
          if (text) emit({ type: "message", sessionId: this.sessionId, turnId, seq: 0, at: new Date().toISOString(), role: "assistant", text, delta: false } as StreamEvent);
          emit({ type: "result", sessionId: this.sessionId, turnId, seq: 0, at: new Date().toISOString(), text, status, final: true } as StreamEvent);
        }
        resolve();
      };
      const guard = setTimeout(() => finish("timeout", out), 1800000);
      opts.signal?.addEventListener("abort", () => { child.kill("SIGTERM"); finish("interrupted", out); }, { once: true });

      child.stdout.on("data", (d) => (out += d.toString()));
      child.stderr.on("data", (d) => (err += d.toString()));
      child.on("error", (e) => finish("failed", "", e.message));
      child.on("close", (code) => {
        if (settled) return;
        finish(code === 0 ? "completed" : "failed", out.trim(), code !== 0 ? `hermes exited ${code}: ${err.slice(0, 300)}` : undefined);
      });
    });
  }

  async interrupt(): Promise<void> {
    if (this.current) { this.current.kill("SIGTERM"); this.current = undefined; }
  }
  async switchModel(model: string): Promise<{ warnings?: string[] }> { this.model = model; return {}; }
  async inject(context: ContextItem[]): Promise<void> {
    for (const c of context) this.pendingInject.push(`[${c.role}] ${c.content}`);
  }

  /**
   * 自定义压缩(dropToolIO)：在 Hermes 的 state.db 里裁本 session 旧工具 IO。
   * Hermes 把 assistant 叙述与 tool_calls 存在同一行，所以：
   *  - role='tool' 的纯工具返回行 → 整行删
   *  - assistant 行带 tool_calls → 只清空 tool_calls/tool_call_id/tool_name 列，保留 content/reasoning
   * 默认保留最近 3 个工具调用；VACUUM INTO 一致性备份。
   */
  async compressCustom(strategy = "dropToolIO", options?: { keepRecentToolCalls?: number }): Promise<{ summary?: string; filesChanged?: number; recordsChanged?: number; blocksRemoved?: number; bytesBefore?: number; bytesAfter?: number; backups?: string[] }> {
    if (strategy !== "dropToolIO") throw new Error(`unsupported custom compression strategy: ${strategy}`);
    if (!this.started) throw new Error("Hermes session not started yet (no turn run); nothing to compress");
    const dbPath = resolveHermesDbPath();
    if (!existsSync(dbPath)) throw new Error(`Hermes state.db not found: ${dbPath}`);
    const dbSessionId = resolveHermesSessionByTitle(dbPath, this.convName);
    if (!dbSessionId) throw new Error(`Hermes session not found for title ${this.convName}`);
    const r = await dropToolIORowsSqlite({
      dbPath,
      keepRecentToolCalls: options?.keepRecentToolCalls,
      selectRows: (db: DatabaseSync) => {
        const rows = db.prepare("SELECT id, role, tool_calls FROM messages WHERE session_id = ? ORDER BY id ASC").all(dbSessionId) as Array<{ id: number; role: string; tool_calls: string | null }>;
        return rows.map((row) => {
          const hasToolCalls = row.tool_calls != null && row.tool_calls !== "" && row.tool_calls !== "[]" && row.tool_calls !== "null";
          return {
            id: row.id,
            role: row.role,
            isTool: row.role === "tool" || hasToolCalls,
            // 调用锚点 = assistant 带 tool_calls。role=tool 是结果行，不作为 keep-recent 计数点。
            isToolCall: hasToolCalls,
          };
        });
      },
      mutateRow: (db: DatabaseSync, row) => {
        if (row.role === "tool") {
          db.prepare("DELETE FROM messages WHERE id = ?").run(row.id);
        } else {
          // assistant 行：只清空工具列，保留推理/正文
          db.prepare("UPDATE messages SET tool_calls = NULL, tool_call_id = NULL, tool_name = NULL WHERE id = ?").run(row.id);
        }
      },
    });
    return { summary: `dropToolIO trimmed ${r.blocksRemoved} tool rows from Hermes session ${dbSessionId}`, ...r };
  }

  async terminate(): Promise<void> { await this.interrupt(); }
}

/** Hermes 状态库路径(默认 ~/.hermes/state.db，可被 HERMES_HOME 覆盖)。 */
export function resolveHermesDbPath(): string {
  const home = process.env.HERMES_HOME || join(homedir(), ".hermes");
  return join(home, "state.db");
}

/**
 * 复现 Hermes 的 resolve_session_by_title：优先取 "title #N" 谱系里最新的，否则精确匹配。
 * 这样定位与 CLI 的 --continue <name> 一致，避免误删其它会话。
 */
export function resolveHermesSessionByTitle(dbPath: string, title: string): string | undefined {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec("PRAGMA busy_timeout = 5000;");
    const escaped = title.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
    const numbered = db.prepare("SELECT id FROM sessions WHERE title LIKE ? ESCAPE '\\' ORDER BY started_at DESC LIMIT 1").get(`${escaped} #%`) as { id: string } | undefined;
    if (numbered?.id) return numbered.id;
    const exact = db.prepare("SELECT id FROM sessions WHERE title = ? LIMIT 1").get(title) as { id: string } | undefined;
    return exact?.id;
  } finally {
    try { db.close(); } catch { /* ignore */ }
  }
}

export class HermesAdapter implements AgentAdapter {
  readonly name = "hermes";
  readonly capabilities = CAPABILITIES;
  private env: HermesEnv;
  private defaultProfile: string;

  constructor(opts: { env?: HermesEnv; defaultProfile?: string } = {}) {
    this.env = opts.env ?? {};
    this.defaultProfile = opts.defaultProfile ?? "default";
  }

  async discoverAgents(): Promise<AgentDescriptor[]> {
    const version = await this.probeVersion();
    const available = version !== null;
    if (!available) {
      return [{
        agentId: "hermes" as AgentDescriptor["agentId"],
        displayName: "Hermes",
        adapter: "hermes",
        available: false,
        unavailableReason: "hermes CLI not found",
        models: [],
        capabilities: CAPABILITIES,
        scannedAt: new Date().toISOString(),
      }];
    }
    // 枚举所有 profile = 多个 agent（D32，同 OpenClaw）
    const profiles = await this.listProfiles();
    const now = new Date().toISOString();
    return profiles.map((p) => ({
      agentId: `hermes:${p.name}` as AgentDescriptor["agentId"],
      displayName: `Hermes / ${p.name}`,
      adapter: "hermes",
      available: true,
      ...(version ? { version } : {}),
      models: p.model
        ? [{ id: p.model, available: true }]
        : (this.env.defaultModel ? [{ id: this.env.defaultModel, available: true }] : [{ id: "default", displayName: "Hermes default", available: true }]),
      capabilities: CAPABILITIES,
      scannedAt: now,
    }));
  }

  async createSession(params: CreateSessionParams): Promise<AdapterSession> {
    // 从复合 agentId 解出 profile：hermes:default → default
    const profile = params.agentId.includes(":") ? params.agentId.split(":")[1]! : this.defaultProfile;
    const model = params.model && params.model !== "default" ? params.model : (this.env.defaultModel ?? "");
    return new HermesSession(params.sessionId, model, params.cwd, this.env, profile);
  }

  /** 枚举 Hermes profile（去 ANSI 色解析 profile list）。 */
  private listProfiles(): Promise<Array<{ name: string; model?: string }>> {
    return new Promise((resolve) => {
      const child = spawn("hermes", ["profile", "list"]);
      let out = "";
      child.stdout.on("data", (d) => (out += d.toString()));
      child.on("error", () => resolve([{ name: this.defaultProfile }]));
      child.on("close", () => {
        const clean = out.replace(/\u001b\[[0-9;]*m/g, "");
        const names: Array<{ name: string; model?: string }> = [];
        for (const line of clean.split("\n")) {
          const m = line.match(/^\s*[\u25c6\u25cf\s]*([a-z0-9][a-z0-9_-]*)\s+(\S.*)?$/i);
          if (m && m[1] && !/^(Profile|Distribution|Model|Gateway|Alias)$/i.test(m[1])) {
            const rest = (m[2] ?? "").trim().split(/\s{2,}/);
            names.push({ name: m[1], model: rest[0] || undefined });
          }
        }
        resolve(names.length > 0 ? names : [{ name: this.defaultProfile }]);
      });
    });
  }

  private probeVersion(): Promise<string | null> {
    return new Promise((resolve) => {
      const child = spawn("hermes", ["--version"]);
      let out = "";
      child.stdout.on("data", (d) => (out += d.toString()));
      child.on("error", () => resolve(null));
      child.on("close", (code) => resolve(code === 0 ? out.trim().split("\n")[0] ?? "hermes" : null));
    });
  }
}
