import { spawn } from "node:child_process";
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
import { formatInitialContextLines } from "../adapter.js";
import type { AgentCapabilities, AgentDescriptor, StreamEvent, ContextItem } from "@agent-phonon/protocol";

/**
 * OpenCode adapter（design D10，单 agent runtime）。
 *
 * 调用：`opencode run <message> --format json [-m provider/model] [-s <sessionID>]`。
 * --format json 输出 raw JSON 事件流（step_start / text / tool 等，每事件带 sessionID）。
 * session 用 OpenCode 返回的 ses_ id，后续 -s 恢复。
 *
 * 方案 A：用 OpenCode 现有 provider 配置（opencode.json）。model 由 config/调用方传。
 * binary 路径可配（默认探测 ~/.opencode/bin/opencode 或 PATH）。
 */

const CAPABILITIES: AgentCapabilities = {
  nativeSession: true, // -s <sessionID> / -c continue
  nativeCompression: false,
  contextInjection: true,
  proactiveOutput: false,
  modelSwitch: true, // -m
  interrupt: true,
  injectMidTurn: false,
  skillManagement: false,
  hooks: ["pre_command"],
  streaming: true, // --format json 事件流
  workflowRoles: ["worker"],
  limits: { maxConcurrentSessions: 4 },
};

export interface OpenCodeEnv {
  /** opencode binary 路径（默认探测）。 */
  binPath?: string;
  /** 默认模型（provider/model 格式，如 opencode/deepseek-v4-flash-free）。 */
  defaultModel?: string;
}

function resolveBin(configured?: string): string {
  if (configured) return configured;
  const standard = join(homedir(), ".opencode", "bin", "opencode");
  if (existsSync(standard)) return standard;
  return "opencode"; // PATH
}

/** OpenCode 会话库路径(part 表存消息块)。 */
export function resolveOpenCodeDbPath(): string {
  const xdg = process.env.XDG_DATA_HOME;
  const base = xdg ? join(xdg, "opencode") : join(homedir(), ".local", "share", "opencode");
  return join(base, "opencode.db");
}

class OpenCodeSession implements AdapterSession {
  readonly sessionId: string;
  model: string;
  private cwd: string;
  private bin: string;
  private ocSessionId?: string; // OpenCode ses_ id（从事件抓，供 -s resume）
  private current?: ReturnType<typeof spawn>;
  private pendingInject: string[] = [];

  constructor(sessionId: string, model: string, cwd: string, bin: string, initialContext?: ContextItem[]) {
    this.sessionId = sessionId;
    this.model = model;
    this.cwd = cwd;
    this.bin = bin;
    // contextInjection: 注入 initialContext（含 workflow systemPrompt）进首轮 message
    this.pendingInject.push(...formatInitialContextLines(initialContext));
  }

  async send(input: string, opts: SendOptions): Promise<void> {
    const { turnId, emit } = opts;
    let message = input;
    if (this.pendingInject.length > 0) {
      message = this.pendingInject.join("\n") + "\n\n" + message;
      this.pendingInject = [];
    }
    if (opts.skills && opts.skills.length > 0) {
      message = `[本轮请使用这些能力: ${opts.skills.join(", ")}]\n\n${message}`;
    }

    const args = ["run", "--format", "json", "--dangerously-skip-permissions"];
    if (this.model) args.push("--model", this.model);
    if (this.ocSessionId) args.push("--session", this.ocSessionId); // 持续会话
    args.push(message); // prompt 作为位置参数放最后

    await this.run(args, turnId, emit, opts);
  }

  private run(args: string[], turnId: string, emit: (e: StreamEvent) => void, opts: SendOptions): Promise<void> {
    return new Promise((resolve) => {
      // 关键：stdin 设 ignore(=DEVNULL)，否则 OpenCode 检测到 stdin pipe 会等交互输入卡死
      // shell:win32 — bin 回退为 PATH 上的 `opencode`（.cmd shim），Node 22 不带 shell spawn .cmd 会抛 EINVAL（与其它 adapter 一致）。
      const child = spawn(this.bin, args, { cwd: this.cwd, stdio: ["ignore", "pipe", "pipe"], shell: process.platform === "win32", env: { ...process.env, ...(opts.environment ?? {}) } as NodeJS.ProcessEnv });
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
          emit({ type: "error", sessionId: this.sessionId, turnId, seq: 0, at: new Date().toISOString(), message: message ?? "opencode failed", status: "failed", final: true } as StreamEvent);
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
        finish(code === 0 ? "completed" : "failed", acc, code !== 0 ? `opencode exited ${code}` : undefined);
      });
    });
  }

  /** 解析 OpenCode JSON 事件 → phonon StreamEvent。 */
  private handleEvent(ev: Record<string, unknown>, turnId: string, emit: (e: StreamEvent) => void, addText: (t: string) => void): void {
    const now = new Date().toISOString();
    const type = ev.type as string;
    // 记录 OpenCode session id（首次出现）供 resume
    const sid = ev.sessionID as string | undefined;
    if (sid && !this.ocSessionId) this.ocSessionId = sid;

    const part = ev.part as Record<string, unknown> | undefined;
    if (type === "text" && typeof part?.text === "string") {
      addText(part.text);
      emit({ type: "message", sessionId: this.sessionId, turnId, seq: 0, at: now, role: "assistant", text: part.text, delta: true } as StreamEvent);
    } else if (type === "tool" || type === "tool_use") {
      emit({ type: "tool_call", sessionId: this.sessionId, turnId, seq: 0, at: now, toolName: String(part?.tool ?? part?.name ?? "?"), args: part?.input } as StreamEvent);
    } else if (type === "error") {
      const err = ev.error as { data?: { message?: string }; name?: string } | undefined;
      const msg = err?.data?.message ?? err?.name ?? "opencode error";
      // 中间 error 事件（非终态）当作 message 上报；真正终态由 close 统一处理
      emit({ type: "message", sessionId: this.sessionId, turnId, seq: 0, at: now, role: "system", text: `[error] ${msg}`, delta: false } as StreamEvent);
      addText(`[error] ${msg}`);
    }
  }

  async interrupt(): Promise<void> {
    if (this.current) { this.current.kill("SIGTERM"); this.current = undefined; }
  }
  async switchModel(model: string): Promise<{ warnings?: string[] }> { this.model = model; return {}; }
  async inject(context: ContextItem[]): Promise<void> {
    for (const c of context) this.pendingInject.push(`[${c.role}] ${c.content}`);
  }

  /**
   * 自定义压缩(dropToolIO)：在 OpenCode 的 opencode.db 里删本 session 旧的 type='tool'
   * part 行，保留 text/reasoning/step 等文本，默认保留最近 3 个工具调用。
   * 改动前整库备份。
   */
  async compressCustom(strategy = "dropToolIO", options?: { keepRecentToolCalls?: number }): Promise<{ summary?: string; filesChanged?: number; recordsChanged?: number; blocksRemoved?: number; bytesBefore?: number; bytesAfter?: number; backups?: string[] }> {
    if (strategy !== "dropToolIO") throw new Error(`unsupported custom compression strategy: ${strategy}`);
    if (!this.ocSessionId) throw new Error("OpenCode session id unknown yet (no turn run); nothing to compress");
    const dbPath = resolveOpenCodeDbPath();
    const sid = this.ocSessionId;
    const r = await dropToolIORowsSqlite({
      dbPath,
      keepRecentToolCalls: options?.keepRecentToolCalls,
      selectRows: (db: DatabaseSync) => {
        const rows = db.prepare("SELECT id, data FROM part WHERE session_id = ? ORDER BY time_created ASC, id ASC").all(sid) as Array<{ id: string; data: string }>;
        return rows.map((row) => {
          let type = "";
          try { type = (JSON.parse(row.data) as { type?: string }).type ?? ""; } catch { /* ignore */ }
          return { id: row.id, isTool: type === "tool" };
        });
      },
      mutateRow: (db: DatabaseSync, row: { id: string | number }) => { db.prepare("DELETE FROM part WHERE id = ?").run(row.id); },
    });
    return { summary: `dropToolIO removed ${r.blocksRemoved} tool parts from OpenCode session ${sid}`, ...r };
  }

  async terminate(): Promise<void> { await this.interrupt(); }
}

export class OpenCodeAdapter implements AgentAdapter {
  readonly name = "opencode";
  readonly capabilities = CAPABILITIES;
  private bin: string;
  private defaultModel?: string;

  constructor(opts: { env?: OpenCodeEnv } = {}) {
    this.bin = resolveBin(opts.env?.binPath);
    this.defaultModel = opts.env?.defaultModel;
  }

  async discoverAgents(): Promise<AgentDescriptor[]> {
    const version = await this.probeVersion();
    const available = version !== null;
    return [{
      agentId: "opencode" as AgentDescriptor["agentId"],
      displayName: "OpenCode",
      adapter: "opencode",
      available,
      ...(available ? {} : { unavailableReason: "opencode CLI not found" }),
      ...(version ? { version } : {}),
      models: this.defaultModel
        ? [{ id: this.defaultModel, available: true }]
        : [{ id: "default", displayName: "OpenCode default (from config)", available: true }],
      capabilities: CAPABILITIES,
      scannedAt: new Date().toISOString(),
    }];
  }

  async createSession(params: CreateSessionParams): Promise<AdapterSession> {
    const model = params.model && params.model !== "default" ? params.model : (this.defaultModel ?? "");
    return new OpenCodeSession(params.sessionId, model, params.cwd, this.bin, params.initialContext);
  }

  private probeVersion(): Promise<string | null> {
    return new Promise((resolve) => {
      const child = spawn(this.bin, ["--version"], { shell: process.platform === "win32" });
      let out = "";
      child.stdout.on("data", (d) => (out += d.toString()));
      child.on("error", () => resolve(null));
      child.on("close", (code) => resolve(code === 0 ? out.trim() : null));
    });
  }
}
