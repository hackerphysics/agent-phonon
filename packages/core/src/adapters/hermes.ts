import { parse as parseYaml } from "yaml";
import { HERMES_BRIDGE } from "./hermes-bridge.js";
import { adapterDiagnostic } from "../adapter-diagnostic.js";
import { spawnSupervisedAgent, type ProcessSupervisor } from "../process-supervisor.js";
import { discoveryProbe } from "../discovery-probe.js";
import { buildChildProcessEnvironment } from "../child-env.js";
import { DatabaseSync } from "node:sqlite";
import { homedir } from "node:os";
import { join, dirname, delimiter, isAbsolute } from "node:path";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dropToolIORowsSqlite } from "../sqlite-compress.js";
import type {
  AgentAdapter,
  AdapterSession,
  CreateSessionParams,
  SendOptions,
} from "../adapter.js";
import { formatInitialContextLines } from "../adapter.js";
import type { AgentCapabilities, AgentDescriptor, StreamEvent, ContextItem, ModelInfo } from "@agent-phonon/protocol";

/**
 * Hermes adapter（design D10/D32，**多 agent runtime**，同 OpenClaw）。
 *
 * Hermes profile = 独立 agent（各自 config.yaml/.env/SOUL.md/skills/workspace）。
 * 一个 Hermes 安装 = 一个 runtime，里面多个 profile = 多个 agent。
 * 复合 agentId：hermes:<profile>（如 hermes:default）。
 *
 * 调用安装版 Python console script 的 native `--profile <profile> chat -Q -q`。
 * 窄桥接读取 run_conversation 的结构化终态与实际工具消息；不使用有损 -z 文本。
 * 枚举 profile：`hermes profile list`。
 *
 * 使用 Hermes 现有 YAML/provider/key refs 与原生权限；不接管认证或全局策略。
 */

const HERMES_PROVIDER_FALLBACK_MODELS: Record<string, string[]> = {
  // Hermes' built-in Copilot picker exposes these account/integrator-safe model ids.
  copilot: [
    "gpt-5.4",
    "gpt-5.4-mini",
    "gpt-5-mini",
    "gpt-5.3-codex",
    "gpt-5.2-codex",
    "gpt-4.1",
    "gpt-4o",
    "gpt-4o-mini",
    "claude-sonnet-4.6",
    "claude-sonnet-4",
    "claude-sonnet-4.5",
    "claude-haiku-4.5",
    "gemini-3.1-pro-preview",
    "gemini-3-pro-preview",
    "gemini-3-flash-preview",
    "gemini-2.5-pro",
  ],
  zai: ["glm-4.5", "glm-4.5-air", "glm-4.6", "glm-4.7", "glm-5", "glm-5-turbo", "glm-5.1", "glm-5.2"],
};

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
  streaming: false, // native result messages are delivered after the turn (not token streaming)
  workflowRoles: ["executor", "worker"],
  limits: { maxConcurrentSessions: 4 },
};

/** Discovery only. Execution delegates config, dotenv and key refs to native Hermes. */
export function parseHermesConfig(configPath = join(process.env.HERMES_HOME || join(homedir(), ".hermes"), "config.yaml")): { defaultModel?: string; provider?: string; catalogUrl?: string } {
  if (!existsSync(configPath)) return {};
  const cfg = parseYaml(readFileSync(configPath, "utf8")) ?? {};
  const model = cfg.model;
  const str = (v: unknown): string | undefined => typeof v === "string" && v.trim() ? v.trim() : undefined;
  return { defaultModel: str(typeof model === "string" ? model : model?.default ?? model?.model), provider: str(model?.provider), catalogUrl: str(cfg.model_catalog?.url) };
}

/** Use the installed console script's own interpreter; never another Python's packages. */
function bridgeCommand(bin: string): { python: string; entry: string } {
  const entry = isAbsolute(bin) ? bin : (process.env.PATH ?? "").split(delimiter).map(p => join(p, bin)).find(p => existsSync(p));
  if (!entry) throw new Error("Hermes CLI not found on daemon PATH; configure hermesBinPath");
  const real = realpathSync(entry);
  const shebang = readFileSync(real, "utf8").split("\n", 1)[0]?.trim() ?? "";
  const python = shebang.match(/^#!(\/[^\r\n]+\/python[\d.]*)$/)?.[1];
  if (!python || !existsSync(python)) throw new Error("Hermes structured bridge requires an installed Python console script (configure hermesBinPath); refusing unstructured success fallback");
  return { python, entry: real };
}

function fetchHermesCatalogModels(url: string, provider?: string, signal?: AbortSignal): Promise<ModelInfo[]> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const reqMod = u.protocol === "http:" ? import("node:http") : import("node:https");
    reqMod.then((mod) => {
      const req = mod.request(url, { method: "GET", timeout: 5000, signal }, (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("error", reject);
        res.on("data", (d) => {
          body += d;
          if (body.length > 2_000_000) res.destroy(new Error("inventory response too large"));
        });
        res.on("end", () => {
          try {
            if ((res.statusCode ?? 500) < 200 || (res.statusCode ?? 500) >= 300) throw new Error("catalog HTTP failure");
            const data = JSON.parse(body) as { providers?: Record<string, { models?: Array<{ id?: string; description?: string }> }> };
            const providers = data.providers ?? {};
            const rows = provider
              ? (providers[provider]?.models ?? [])
              : Object.values(providers).flatMap((p) => p.models ?? []);
            const seen = new Set<string>();
            resolve(rows.flatMap((m) => {
              if (!m.id || seen.has(m.id)) return [];
              seen.add(m.id);
              return [{ id: m.id, ...(m.description ? { displayName: m.description } : {}), available: true } satisfies ModelInfo];
            }));
          } catch { reject(new Error("Hermes catalog scan failed")); }
        });
      });
      req.on("timeout", () => req.destroy());
      req.on("error", reject);
      req.end();
    }, reject);
  });
}

export interface HermesEnv {
  /** Hermes executable path. Prefer an absolute path when running under systemd/launchd. */
  binPath?: string;
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
  private hermesSessionId?: string;
  private convName: string;
  private started = false;
  private current?: ProcessSupervisor;
  private pendingInject: string[] = [];

  constructor(sessionId: string, model: string, cwd: string, env: HermesEnv, profile: string, initialContext?: ContextItem[]) {
    this.sessionId = sessionId;
    this.model = model;
    this.cwd = cwd;
    this.env = env;
    this.profile = profile;
    this.convName = `phonon-${sessionId.replace(/[^a-zA-Z0-9_-]/g, "")}`;
    // contextInjection: 注入 initialContext（含 workflow systemPrompt）进首轮 message
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
      prompt = `[本轮请使用这些能力: ${opts.skills.join(", ")}]\n\n${prompt}`;
    }

    const args = ["--profile", this.profile, "chat", "-Q", "-q", prompt];
    if (this.model) args.push("-m", this.model);
    if (this.env.provider) args.push("--provider", this.env.provider);
    if (this.env.toolsets) args.push("-t", this.env.toolsets);
    // Preserve native approval policy; do not auto-elevate tools.
    // Native chat creates the first session; resume only its observed real id.
    if (this.hermesSessionId) args.push("--resume", this.hermesSessionId);
    this.started = true;

    await this.run(args, turnId, emit, opts);
  }

  private run(args: string[], turnId: string, emit: (e: StreamEvent) => void, opts: SendOptions): Promise<void> {
    return new Promise((resolve) => {
      let command: ReturnType<typeof bridgeCommand>;
      try { command = bridgeCommand(this.env.binPath ?? "hermes"); }
      catch (e) {
        emit({ type: "error", sessionId: this.sessionId, turnId, seq: 0, at: new Date().toISOString(), message: adapterDiagnostic(String(e)), status: "failed", final: true } as StreamEvent);
        resolve(); return;
      }
      const supervisor = spawnSupervisedAgent(command.python, ["-c", HERMES_BRIDGE, command.entry, ...args], {
        cwd: this.cwd,
        env: buildChildProcessEnvironment(opts.environment),
      });
      // No interactive input is required by native chat -Q -q.
      supervisor.child.stdin.end();
      const child = supervisor.child;
      this.current = supervisor;
      const releaseCurrent = (): void => { if (this.current === supervisor) this.current = undefined; };
      child.once("close", releaseCurrent);
      child.once("error", releaseCurrent);
      let out = "";
      let err = "";
      let buffer = "";
      let outcome: Record<string, unknown> | undefined;
      const calls = new Map<string, string>();
      const results = new Set<string>();
      let settled = false;
      const abort = (): void => { void supervisor.terminate(); finish("interrupted", out); };
      const finish = (status: "completed" | "failed" | "interrupted" | "timeout", text: string, message?: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(guard);
        opts.signal?.removeEventListener("abort", abort);
        if (status === "failed") {
          emit({ type: "error", sessionId: this.sessionId, turnId, seq: 0, at: new Date().toISOString(), message: message ?? "hermes failed", status: "failed", final: true } as StreamEvent);
        } else {
          // Native structured final text: one message and one terminal.
          if (text) emit({ type: "message", sessionId: this.sessionId, turnId, seq: 0, at: new Date().toISOString(), role: "assistant", text, delta: false } as StreamEvent);
          emit({ type: "result", sessionId: this.sessionId, turnId, seq: 0, at: new Date().toISOString(), text, status, final: true } as StreamEvent);
        }
        resolve();
      };
      const guard = setTimeout(() => { void supervisor.terminate(); finish("timeout", out); }, 1800000);
      if (opts.signal?.aborted) abort();
      else opts.signal?.addEventListener("abort", abort, { once: true });

      const consume = (line: string): void => {
        if (settled || !line.trim()) return;
        let ev: Record<string, any>;
        try { ev = JSON.parse(line); } catch { return; }
        const base = { sessionId: this.sessionId, turnId, seq: 0, at: new Date().toISOString() };
        if (ev.type === "hermes_result") {
          outcome = ev;
          out = typeof ev.final_response === "string" ? ev.final_response : "";
          if (typeof ev.session_id === "string") this.hermesSessionId = ev.session_id;
        } else if (ev.type === "hermes_tool_call") {
          const call = ev.call, id = call?.id, fn = call?.function;
          if (typeof id !== "string" || typeof fn?.name !== "string" || calls.has(id)) return;
          calls.set(id, fn.name);
          let input = fn.arguments;
          if (typeof input === "string") { try { input = JSON.parse(input); } catch { /* retain actual raw input */ } }
          emit({ ...base, type: "tool_call", toolName: fn.name, toolCallId: id, args: input } as StreamEvent);
        } else if (ev.type === "hermes_tool_result") {
          const m = ev.message, id = m?.tool_call_id;
          if (!calls.has(id) || results.has(id)) return;
          results.add(id);
          let payload: any;
          try { payload = JSON.parse(m.content); } catch { /* native text result */ }
          emit({ ...base, type: "tool_result", toolName: calls.get(id)!, toolCallId: id, ok: !(payload?.error || payload?.success === false || m.is_error), output: m.content } as StreamEvent);
        }
      };
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (d) => {
        buffer += d;
        let nl: number;
        while ((nl = buffer.indexOf("\n")) >= 0) { consume(buffer.slice(0, nl)); buffer = buffer.slice(nl + 1); }
      });
      child.stderr.on("data", (d) => (err = (err + d).slice(-16000)));
      child.on("error", (e) => finish("failed", "", e.message));
      child.on("close", (code) => {
        if (settled) return;
        consume(buffer);
        if (outcome?.interrupted) { finish("interrupted", out.trim()); return; }
        const success = code === 0 && outcome?.completed === true && !outcome.failed && !outcome.partial && !outcome.error && !!out.trim();
        const detail = adapterDiagnostic(String(outcome?.error || err || "Native CLI returned no successful structured completion/output"));
        finish(success ? "completed" : "failed", out.trim(), success ? undefined : `hermes exited ${code}: ${detail}`);
      });
    });
  }

  async interrupt(): Promise<void> {
    if (this.current) { const current = this.current; this.current = undefined; await current.terminate(); }
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
    const dbSessionId = this.hermesSessionId ?? resolveHermesSessionByTitle(dbPath, this.convName);
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
  private modelCatalog?: { key: string; models: ModelInfo[] };

  constructor(opts: { env?: HermesEnv; defaultProfile?: string } = {}) {
    this.env = opts.env ?? {};
    this.defaultProfile = opts.defaultProfile ?? "default";
  }

  async discoverAgents(signal?: AbortSignal): Promise<AgentDescriptor[]> {
    const version = await this.probeVersion(signal);
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
    const profiles = await this.listProfiles(signal);
    const cfg = parseHermesConfig();
    const provider = this.env.provider ?? cfg.provider;
    let catalogModels: ModelInfo[] = [];
    if (cfg.catalogUrl) {
      const key = JSON.stringify([cfg.catalogUrl, provider]);
      try {
        catalogModels = await fetchHermesCatalogModels(cfg.catalogUrl, provider, signal);
        this.modelCatalog = { key, models: catalogModels };
      } catch {
        signal?.throwIfAborted();
        // Optional catalog failure is not native unavailability. Retain its
        // last-good models, or native YAML defaults on the first scan.
        catalogModels = this.modelCatalog?.key === key ? this.modelCatalog.models : [];
        console.warn("[hermes] discovery.catalog_failed; retaining known/native-config models");
      }
    }
    const providerFallbackModels = provider ? (HERMES_PROVIDER_FALLBACK_MODELS[provider] ?? []).map((id) => ({ id, available: true })) : [];
    const now = new Date().toISOString();
    return profiles.map((p) => ({
      agentId: `hermes:${p.name}` as AgentDescriptor["agentId"],
      displayName: `Hermes / ${p.name}`,
      adapter: "hermes",
      available: true,
      ...(version ? { version } : {}),
      models: this.modelsForProfile(p.model, [...catalogModels, ...providerFallbackModels], cfg.defaultModel),
      capabilities: CAPABILITIES,
      scannedAt: now,
    }));
  }

  private modelsForProfile(profileModel: string | undefined, catalogModels: ModelInfo[], configDefault: string | undefined): ModelInfo[] {
    const preferred = profileModel ?? this.env.defaultModel ?? configDefault;
    const models: ModelInfo[] = preferred ? [{ id: preferred, available: true }] : [];
    const seen = new Set(models.map((m) => m.id));
    for (const m of catalogModels) {
      if (!seen.has(m.id)) { models.push(m); seen.add(m.id); }
    }
    return models.length > 0 ? models : [{ id: "default", displayName: "Hermes default", available: true }];
  }

  async createSession(params: CreateSessionParams): Promise<AdapterSession> {
    // 从复合 agentId 解出 profile：hermes:default → default
    const profile = params.agentId.includes(":") ? params.agentId.split(":")[1]! : this.defaultProfile;
    const model = params.model && params.model !== "default" ? params.model : (this.env.defaultModel ?? "");
    return new HermesSession(params.sessionId, model, params.cwd, this.env, profile, params.initialContext);
  }

  /** 枚举 Hermes profile（去 ANSI 色解析 profile list）。 */
  private async listProfiles(signal?: AbortSignal): Promise<Array<{ name: string; model?: string }>> {
    const out = await discoveryProbe(this.env.binPath ?? "hermes", ["profile", "list"], signal) ?? "";
    const clean = out.replace(/\u001b\[[0-9;]*m/g, "");
    const names: Array<{ name: string; model?: string }> = [];
    for (const line of clean.split("\n")) {
      const m = line.match(/^\s*[\u25c6\u25cf\s]*([a-z0-9][a-z0-9_-]*)\s+(\S.*)?$/i);
      if (m && m[1] && !/^(Profile|Distribution|Model|Gateway|Alias)$/i.test(m[1])) {
        const rest = (m[2] ?? "").trim().split(/\s{2,}/);
        names.push({ name: m[1], model: rest[0] || undefined });
      }
    }
    return names.length > 0 ? names : [{ name: this.defaultProfile }];
  }

  private async probeVersion(signal?: AbortSignal): Promise<string | null> {
    return (await discoveryProbe(this.env.binPath ?? "hermes", ["--version"], signal))?.split("\n")[0] ?? null;
  }
}
