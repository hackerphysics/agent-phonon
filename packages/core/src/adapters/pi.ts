import type { ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawnAgent, spawnSyncAgent } from "../proc.js";
import { buildChildProcessEnvironment } from "../child-env.js";
import { adapterDiagnostic } from "../adapter-diagnostic.js";
import type {
  AgentAdapter,
  AdapterSession,
  AdapterHitlContext,
  CreateSessionParams,
  SendOptions,
} from "../adapter.js";
import { formatInitialContextLines } from "../adapter.js";
import { materializePiHitlExtension, piHitlStateDir } from "../pi-hitl-extension.js";
import type {
  AgentCapabilities,
  AgentDescriptor,
  ContextItem,
  ModelInfo,
  StreamEvent,
} from "@agent-phonon/protocol";

/**
 * Pi coding agent adapter（https://pi.dev，github.com/earendil-works/pi）。
 *
 * 驱动方式（全部来自 Pi 官方 docs/cli.md + docs/json.md，不靠猜）：
 *
 *   pi --mode json --session-id <id>      # JSONL 事件流，跑完退出
 *
 * 关键约定（踩过坑的照抄官方文档）：
 *  - **严格 JSONL，只按 LF 切**。官方明确说 Node.js `readline` 不适用——它会把
 *    Unicode 行/段分隔符(U+2028/U+2029) 也当记录边界，而 Pi 允许这些字符出现在
 *    JSON 字符串内。所以这里用 `indexOf("\n")` 手工切，不用 readline。
 *  - **prompt 走 stdin 不走 argv**。这样任务内容不会出现在进程列表里
 *    （与 copilot adapter 同一理由）。
 *  - `--session-id` 可确定性续接同一 project 会话（比 `--resume` 交互选择器好用）。
 *    Pi 要求 session id 首尾为字母数字，可含 `A-Za-z0-9._-`，故需 sanitize。
 */

/** Pi 不暴露「按需触发压缩」的 CLI flag（它只在自己超阈值时自动 compact），故不谎报 nativeCompression。 */
const BASE_CAPABILITIES: AgentCapabilities = {
  nativeSession: true, // --session-id <id>，确定性续接
  nativeCompression: false, // Pi 内部会自动 compact，但没有可主动调用的 flag
  contextInjection: true, // --append-system-prompt / 首轮 prompt 前置
  proactiveOutput: false,
  modelSwitch: true, // --model <provider/id[:thinking]>
  interrupt: true, // kill 子进程
  injectMidTurn: false,
  skillManagement: true, // --skill <path>，Pi 原生 skills
  // Without a configured bridge there is genuinely no gate, so never advertise one.
  hooks: [],
  streaming: true, // --mode json 真流式
  workflowRoles: ["executor", "worker"],
  limits: { maxConcurrentSessions: 4 },
};

export interface PiEnv {
  /** pi 可执行文件路径；默认走 PATH。service/launchd 下建议配绝对路径。 */
  binPath?: string;
  /** 默认模型（`provider/id` 或 `id`）。 */
  defaultModel?: string;
  /** 显式模型清单；不填则尝试 `pi --list-models` 解析，失败回落默认。 */
  models?: ModelInfo[];
  /** 追加到 system prompt 的内容（persona / 项目规约等）。 */
  appendSystemPrompt?: string;
  /** Device HITL gate. When present, the blocking tool_call extension is loaded. */
  hitl?: AdapterHitlContext;
}

/** 解析后的 Pi JSONL 事件子集（本 adapter 关心的部分）。 */
export type ParsedPiEvent =
  | { kind: "session"; nativeSessionId: string; cwd?: string }
  | { kind: "text_delta"; text: string }
  | { kind: "thinking_delta"; text: string }
  | { kind: "tool_call"; toolCallId: string; toolName: string; args?: unknown }
  | { kind: "tool_result"; toolCallId: string; toolName?: string; ok: boolean; output?: unknown }
  | { kind: "turn_end"; text?: string }
  | { kind: "settled"; aborted: boolean }
  | { kind: "stream_error"; message: string }
  | { kind: "ignore" };

/** 把一条 Pi JSONL 记录归一化成 phonon 能消费的事件。 */
export function parsePiEvent(value: unknown): ParsedPiEvent {
  if (!value || typeof value !== "object") return { kind: "ignore" };
  const ev = value as Record<string, unknown>;
  switch (ev.type) {
    case "session":
      return typeof ev.id === "string"
        ? { kind: "session", nativeSessionId: ev.id, ...(typeof ev.cwd === "string" ? { cwd: ev.cwd } : {}) }
        : { kind: "ignore" };

    case "message_update": {
      const inner = ev.assistantMessageEvent as Record<string, unknown> | undefined;
      if (!inner || typeof inner !== "object") return { kind: "ignore" };
      if (inner.type === "text_delta" && typeof inner.delta === "string") {
        return { kind: "text_delta", text: inner.delta };
      }
      if (inner.type === "thinking_delta" && typeof inner.delta === "string") {
        return { kind: "thinking_delta", text: inner.delta };
      }
      if (inner.type === "error" && typeof inner.error === "string") {
        return { kind: "stream_error", message: inner.error };
      }
      return { kind: "ignore" };
    }

    case "tool_execution_start": {
      const id = typeof ev.toolCallId === "string" ? ev.toolCallId : undefined;
      const name = typeof ev.toolName === "string" ? ev.toolName : undefined;
      if (!id || !name) return { kind: "ignore" };
      return { kind: "tool_call", toolCallId: id, toolName: name, ...("args" in ev ? { args: ev.args } : {}) };
    }

    case "tool_execution_end": {
      const id = typeof ev.toolCallId === "string" ? ev.toolCallId : undefined;
      if (!id) return { kind: "ignore" };
      const name = typeof ev.toolName === "string" ? ev.toolName : undefined;
      return {
        kind: "tool_result",
        toolCallId: id,
        ...(name ? { toolName: name } : {}),
        ok: ev.isError !== true,
        ...("result" in ev ? { output: ev.result } : {}),
      };
    }

    case "turn_end": {
      const msg = ev.message as Record<string, unknown> | undefined;
      const text = typeof msg?.content === "string" ? msg.content : undefined;
      return text ? { kind: "turn_end", text } : { kind: "turn_end" };
    }

    case "agent_settled":
      return { kind: "settled", aborted: ev.aborted === true };

    default:
      return { kind: "ignore" };
  }
}

/** Pi session id 约束：首尾必须是字母数字，中间可含 `A-Za-z0-9._-`。 */
export function toPiSessionId(sessionId: string): string {
  const cleaned = sessionId.replace(/[^A-Za-z0-9._-]/g, "-");
  const trimmed = cleaned.replace(/^[^A-Za-z0-9]+/, "").replace(/[^A-Za-z0-9]+$/, "");
  return trimmed || `s${Date.now().toString(36)}`;
}

/** `pi --version` → 首行非空文本。 */
export function parsePiVersion(text: string): string | undefined {
  return text
    .replace(/\u001b\[[0-9;]*m/g, "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0);
}

/**
 * Session flags this Pi build actually accepts.
 *
 * `--session-id` (create-if-absent) and `--name` only exist in newer Pi. Pi 0.70.6
 * rejects them outright — `Error: Unknown option: --session-id` — which made every
 * session fail. Older builds offer `--session <path|id>` (lookup only) and
 * `--continue`. Detect from `pi --help` instead of trusting the docs, which track main.
 */
export interface PiSessionFlags {
  sessionId: boolean;
  name: boolean;
  session: boolean;
  continueFlag: boolean;
}

export function parsePiSessionFlags(help: string): PiSessionFlags {
  return {
    sessionId: /--session-id\b/.test(help),
    name: /(?:^|\s)-n,\s*--name\b|--name\b/.test(help),
    session: /--session\s+<|--session\s+[a-z]/i.test(help),
    continueFlag: /--continue\b/.test(help),
  };
}

/** Best-effort capability probe; an unreadable help yields all-false (no session flags). */
export function probePiSessionFlags(binPath = "pi"): PiSessionFlags {
  try {
    const r = spawnSyncAgent(binPath, ["--help"], { timeout: 10_000, encoding: "utf8" });
    if (r.status !== 0) return { sessionId: false, name: false, session: false, continueFlag: false };
    return parsePiSessionFlags(`${r.stdout ?? ""}\n${r.stderr ?? ""}`);
  } catch {
    return { sessionId: false, name: false, session: false, continueFlag: false };
  }
}

/**
 * Pi 的探测类命令把输出写到 **stderr**（`pi --version` / `pi --list-models` 实测均是，
 * stdout 为空）。`discoveryProbe` 只回 stdout，会把已安装的 Pi 误报成 unavailable，
 * 所以这里自己跑一遍并合并两个流。
 */
function probePi(bin: string, args: string[]): string | null {
  const r = spawnSyncAgent(bin, args, { timeout: 10_000 });
  if (r.error || (r.status !== 0 && r.status !== null)) return null;
  const combined = `${r.stdout?.toString() ?? ""}\n${r.stderr?.toString() ?? ""}`;
  return combined.trim() || null;
}

/** `pi --list-models` 是表格输出（实测）→ ModelInfo[]，id 用 Pi 自己的 `provider/model` 形式。 */
export function parsePiModels(text: string): ModelInfo[] {
  const seen = new Set<string>();
  const out: ModelInfo[] = [];
  for (const raw of text.replace(/\u001b\[[0-9;]*m/g, "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    // 列间是多个空格 / tab；先切列再按位置取，避免误把 provider 当成 model。
    const cols = line.split(/\s{2,}|\t/).map((c) => c.trim()).filter(Boolean);
    if (cols.length < 2) continue;
    const provider = cols[0];
    const model = cols[1];
    if (!provider || !model) continue;
    if (/^provider$/i.test(provider) && /^model$/i.test(model)) continue; // 表头
    if (!/^[a-z0-9_-]+$/i.test(provider)) continue;
    if (!/^[a-z0-9._:-]+$/i.test(model)) continue;
    const id = `${provider}/${model}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ id, available: true });
  }
  return out;
}

class PiSession implements AdapterSession {
  readonly sessionId: string;
  model: string;
  private readonly cwd: string;
  private readonly env: PiEnv;
  private readonly piSessionId: string;
  /** Session flags accepted by the installed Pi build; probed, never assumed. */
  private readonly sessionFlags: PiSessionFlags;
  /** True after the first completed turn, so --continue/--session only apply from turn 2. */
  private started = false;
  private pendingInject: string[] = [];
  private nativeSessionId?: string;
  private current?: ChildProcess;

  constructor(sessionId: string, model: string, cwd: string, env: PiEnv, initialContext: ContextItem[] | undefined, sessionFlags: PiSessionFlags) {
    this.sessionId = sessionId;
    this.model = model;
    this.cwd = cwd;
    this.env = env;
    this.sessionFlags = sessionFlags;
    this.piSessionId = toPiSessionId(sessionId);
    this.pendingInject.push(...formatInitialContextLines(initialContext));
  }

  async send(input: string, opts: SendOptions): Promise<void> {
    let prompt = input;
    if (this.pendingInject.length > 0) {
      prompt = `${this.pendingInject.join("\n")}\n\n${prompt}`;
      this.pendingInject = [];
    }
    if (opts.skills?.length) {
      prompt = `[Use these skills for this turn: ${opts.skills.join(", ")}]\n\n${prompt}`;
    }
    await this.run(prompt, opts);
  }

  private run(prompt: string, opts: SendOptions): Promise<void> {
    return new Promise((resolve) => {
      const { turnId, emit } = opts;
      const args = ["--mode", "json"];
      // Only pass session flags this Pi build actually accepts; older builds abort
      // on an unknown option instead of ignoring it.
      if (this.sessionFlags.sessionId) args.push("--session-id", this.piSessionId);
      else if (this.sessionFlags.name) args.push("--name", this.piSessionId);
      else if (this.sessionFlags.session && this.started) args.push("--session", this.piSessionId);
      else if (this.sessionFlags.continueFlag && this.started) args.push("--continue");
      if (this.model && this.model !== "default") args.push("--model", this.model);
      if (this.env.appendSystemPrompt) args.push("--append-system-prompt", this.env.appendSystemPrompt);

      const hitl = this.env.hitl;
      const childEnv: NodeJS.ProcessEnv = buildChildProcessEnvironment(opts.environment);
      if (hitl?.bridgeUrl) {
        // Load the blocking tool_call extension so a human decision actually gates tools.
        args.push("--extension", materializePiHitlExtension(piHitlStateDir()));
        childEnv.AGENT_PHONON_HITL_BRIDGE = hitl.bridgeUrl;
        childEnv.AGENT_PHONON_HITL_SESSION = this.sessionId;
        childEnv.AGENT_PHONON_HITL_FAIL_MODE = hitl.failMode ?? "closed";
        if (hitl.timeoutMs !== undefined) childEnv.AGENT_PHONON_HITL_TIMEOUT_MS = String(hitl.timeoutMs);
        if (hitl.token) childEnv.AGENT_PHONON_HITL_TOKEN = hitl.token;
      }

      const child = spawnAgent(this.env.binPath ?? "pi", args, {
        cwd: this.cwd,
        env: childEnv,
      });
      this.current = child;

      let buf = "";
      let stderr = "";
      let acc = "";
      let toolNames = new Map<string, string>();
      let settled = false;

      const finish = (status: "completed" | "failed" | "interrupted" | "timeout", message?: string): void => {
        if (settled) return;
        settled = true;
        clearTimeout(guard);
        if (this.current === child) this.current = undefined;
        const at = new Date().toISOString();
        if (status === "failed") {
          emit({
            type: "error", sessionId: this.sessionId, turnId, seq: 0, at,
            message: adapterDiagnostic(message ?? "pi failed"), status: "failed", final: true,
          } as StreamEvent);
        } else {
          // A completed turn means the next one may address the same native
          // session; --continue/--session are only meaningful from turn 2 on.
          this.started = true;
          emit({ type: "result", sessionId: this.sessionId, turnId, seq: 0, at, text: acc, status, final: true } as StreamEvent);
        }
        resolve();
      };

      const guard = setTimeout(() => {
        child.kill("SIGTERM");
        finish("timeout", "pi turn timed out");
      }, 1_800_000);

      const abort = (): void => {
        child.kill("SIGTERM");
        finish("interrupted");
      };
      if (opts.signal?.aborted) abort();
      else opts.signal?.addEventListener("abort", abort, { once: true });

      const handleLine = (line: string): void => {
        // 官方要求：只按 LF 切；\r 需剥掉，但 U+2028/U+2029 必须保留在 JSON 字符串内。
        const clean = line.endsWith("\r") ? line.slice(0, -1) : line;
        if (!clean.trim()) return;
        let raw: unknown;
        try { raw = JSON.parse(clean); } catch { return; }
        const parsed = parsePiEvent(raw);
        const at = new Date().toISOString();

        switch (parsed.kind) {
          case "session":
            this.nativeSessionId = parsed.nativeSessionId;
            break;
          case "text_delta":
            acc += parsed.text;
            emit({ type: "message", sessionId: this.sessionId, turnId, seq: 0, at, role: "assistant", text: parsed.text, delta: true } as StreamEvent);
            break;
          case "thinking_delta":
            emit({ type: "thinking", sessionId: this.sessionId, turnId, seq: 0, at, text: parsed.text, delta: true } as StreamEvent);
            break;
          case "tool_call":
            toolNames.set(parsed.toolCallId, parsed.toolName);
            emit({ type: "tool_call", sessionId: this.sessionId, turnId, seq: 0, at, toolName: parsed.toolName, toolCallId: parsed.toolCallId, args: parsed.args } as StreamEvent);
            break;
          case "tool_result":
            emit({
              type: "tool_result", sessionId: this.sessionId, turnId, seq: 0, at,
              toolName: parsed.toolName ?? toolNames.get(parsed.toolCallId) ?? "",
              toolCallId: parsed.toolCallId, ok: parsed.ok, output: parsed.output,
            } as StreamEvent);
            toolNames.delete(parsed.toolCallId);
            break;
          case "turn_end":
            // 最终权威文本优先于累加的 delta（message_end 才是 authoritative）。
            if (parsed.text && parsed.text.length > acc.length) acc = parsed.text;
            break;
          case "stream_error":
            finish("failed", parsed.message);
            break;
          case "settled":
            finish(parsed.aborted ? "interrupted" : "completed");
            break;
          case "ignore":
            break;
        }
      };

      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        buf += chunk;
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          handleLine(line);
        }
      });
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-16_000); });
      child.on("error", (err) => finish("failed", err.message));
      child.on("close", (code) => {
        if (settled) return;
        if (buf.trim()) handleLine(buf);
        if (code === 0) finish("completed");
        else finish("failed", stderr.trim() || `pi exited ${code}`);
      });

      if (!settled) {
        // prompt 走 stdin：不出现在进程列表里。
        child.stdin.write(prompt + "\n");
        child.stdin.end();
      }
    });
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
    for (const item of context) this.pendingInject.push(`[${item.role}] ${item.content}`);
  }

  async terminate(): Promise<void> {
    await this.interrupt();
  }
}

export class PiAdapter implements AgentAdapter {
  readonly name = "pi";
  /** Blocking pre_tool HITL is only real when a device bridge is configured.
   *  Not readonly: the daemon re-derives this once the hook bridge binds. */
  capabilities: AgentCapabilities;
  private env: PiEnv;
  /** Cached Pi session-flag probe; undefined until first use. */
  private sessionFlags: PiSessionFlags | undefined;

  constructor(opts: { env?: PiEnv } = {}) {
    this.env = opts.env ?? {};
    this.sessionFlags = undefined;
    this.capabilities = this.deriveCapabilities();
  }

  /** Detect once; older Pi builds reject newer session flags outright. */
  private flags(): PiSessionFlags {
    this.sessionFlags ??= probePiSessionFlags(this.env.binPath ?? "pi");
    return this.sessionFlags;
  }

  /**
   * Attach (or clear) the device HITL gate. The daemon calls this once the hook
   * bridge has bound, because only then is its real port known — a port chosen at
   * construction time can be wrong when the configured port is dynamic (0).
   */
  setHitl(hitl: AdapterHitlContext | undefined): void {
    this.env = { ...this.env, hitl };
    this.capabilities = this.deriveCapabilities();
  }

  private deriveCapabilities(): AgentCapabilities {
    // Probe eagerly so discovery reports the truth rather than an optimistic claim.
    const flags = this.flags();
    return {
      ...BASE_CAPABILITIES,
      // Deterministic cross-turn resume needs a create-if-absent selector.
      nativeSession: flags.sessionId || flags.name,
      hooks: this.env.hitl?.bridgeUrl ? ["pre_tool"] : [],
    };
  }

  async discoverAgents(signal?: AbortSignal): Promise<AgentDescriptor[]> {
    signal?.throwIfAborted();
    const version = await this.probeVersion();
    const available = version !== null;
    if (!available) {
      return [{
        agentId: "pi" as AgentDescriptor["agentId"],
        displayName: "Pi",
        adapter: "pi",
        available: false,
        unavailableReason: "pi CLI not found (install: curl -fsSL https://pi.dev/install.sh | sh)",
        models: [],
        capabilities: this.capabilities,
        scannedAt: new Date().toISOString(),
      }];
    }
    return [{
      agentId: "pi" as AgentDescriptor["agentId"],
      displayName: "Pi",
      adapter: "pi",
      available: true,
      ...(version ? { version } : {}),
      models: await this.resolveModels(signal),
      capabilities: this.capabilities,
      scannedAt: new Date().toISOString(),
    }];
  }

  async createSession(params: CreateSessionParams): Promise<AdapterSession> {
    const model = params.model && params.model !== "default" ? params.model : (this.env.defaultModel ?? "default");
    return new PiSession(params.sessionId, model, params.cwd, this.env, params.initialContext, this.flags());
  }

  private async resolveModels(signal?: AbortSignal): Promise<ModelInfo[]> {
    signal?.throwIfAborted();
    if (this.env.models?.length) return this.env.models;
    const out = probePi(this.env.binPath ?? "pi", ["--list-models"]);
    const parsed = out ? parsePiModels(out) : [];
    const preferred = this.env.defaultModel ?? this.configuredModel();
    if (preferred && !parsed.some((m) => m.id === preferred)) parsed.unshift({ id: preferred, available: true });
    return parsed.length ? parsed : [{ id: preferred ?? "default", available: true }];
  }

  private configuredModel(): string | undefined {
    const path = join(process.env.PI_CODING_AGENT_HOME ?? join(homedir(), ".pi", "agent"), "settings.json");
    if (!existsSync(path)) return undefined;
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as { model?: unknown };
      return typeof parsed.model === "string" && parsed.model ? parsed.model : undefined;
    } catch {
      return undefined;
    }
  }

  private async probeVersion(): Promise<string | null> {
    const out = probePi(this.env.binPath ?? "pi", ["--version"]);
    return out ? parsePiVersion(out) ?? null : null;
  }
}