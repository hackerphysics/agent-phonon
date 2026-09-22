import { spawnAgent, spawnSyncAgent } from "../proc.js";
import { buildChildProcessEnvironment } from "../child-env.js";
import { discoveryProbe } from "../discovery-probe.js";
import { adapterDiagnostic } from "../adapter-diagnostic.js";
import type {
  AgentAdapter,
  AdapterSession,
  CreateSessionParams,
  SendOptions,
} from "../adapter.js";
import { formatInitialContextLines } from "../adapter.js";
import type {
  AgentCapabilities,
  AgentDescriptor,
  ContextItem,
  ModelInfo,
  StreamEvent,
} from "@agent-phonon/protocol";

/**
 * Herdr adapter (design D10 + D32 — 多 agent runtime).
 *
 * Herdr 是 Rust 写的终端多路复用器，把多个 agent CLI 跑在它控制的 PTY pane 里。
 * 我们不是直接 spawn agent CLI——而是把"workspace / pane / agent"的生命周期
 * 委托给 Herdr，通过 Herdr CLI 命令驱动。
 *
 * agentId 形式：`herdr:<kind>`（herdr:codex / herdr:claude / herdr:copilot ...），
 * kind 必须由 Herdr 识别（见 HERDR_KINDS 子集）。调用时通过
 * `herdr agent start --kind <kind> -- <args>` 透传给底层 CLI。
 *
 * 关键诚实声明（capabilities 里写明）：
 * - 我们从 pane 拿的是屏幕文字（ANSI 解析），不是 JSONL 结构化事件。
 *   tool_call / tool_result 不能可靠识别——在 capabilities 里声明 streaming:false / hooks:[]。
 * - agent 状态（idle / working / blocked / done）由 Herdr 通过 lifecycle hook 或
 *   screen manifest 判定，比我们从 stream 反推准——这是杠杆。
 * - send 是 polling 模型：发 prompt → 等 state 回 idle → 抓 pane 输出 → emit message + result。
 *
 * 这个 adapter 的定位："方便 + 跨 OS 一致 + 复用 Herdr 的 22 个 agent 检测"
 * ——结构化能力需要时还是用 claude/codex 直连 adapter。
 */

const CAPABILITIES: AgentCapabilities = {
  nativeSession: true, // herdr agent name 作为 resume token
  nativeCompression: false,
  contextInjection: true, // 拼进首轮 message
  proactiveOutput: false, // Herdr 不主动推事件给外部消费者
  modelSwitch: false, // 切模型需要重启 agent，复杂度不值，先不支持
  interrupt: true, // send-keys esc 或 pane close
  injectMidTurn: false,
  skillManagement: false,
  hooks: [], // 不暴露协议级 hook；HITL 由 Herdr 自己处理（它能截 approval）
  streaming: false, // polling 拿终态，不是 token stream
  workflowRoles: ["executor", "worker"],
  limits: { maxConcurrentSessions: 8 },
};

/**
 * Herdr 支持的 agent kind 子集（来自 herdr.dev/docs/agent-automation/）。
 * 只列我们已经确认 Herdr 列在 `--kind` 接受的；新增先验证再开。
 */
export const HERDR_KINDS = [
  "claude", "codex", "copilot", "opencode", "hermes", "grok", "pi",
  "cursor", "kimi", "letta", "qwen", "muse", "maki",
] as const;
export type HerdrKind = typeof HERDR_KINDS[number];

/** Herdr agent kind 提取自 agentId：`herdr:codex` → `codex`。 */
export function parseHerdrKind(agentId: string): HerdrKind | undefined {
  if (!agentId.startsWith("herdr:")) return undefined;
  const k = agentId.slice("herdr:".length);
  return (HERDR_KINDS as readonly string[]).includes(k) ? (k as HerdrKind) : undefined;
}

/** `herdr --version` 的第一行（无 ANSI 色）。 */
export function parseHerdrVersion(text: string): string | undefined {
  const cleaned = text.replace(/\u001b\[[0-9;]*m/g, "");
  // 跳过开头空行（herdr --version 偶有 banner + 空行）。
  const first = cleaned.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0);
  return first || undefined;
}

export interface HerdrEnv {
  /** `herdr` 可执行路径；默认 PATH 找。service/launchd 下请配绝对路径。 */
  binPath?: string;
  /** 默认模型（`herdr agent start -- --model <m>` 透传给底层 CLI）。 */
  defaultModel?: string;
  /** 触发 Herdr 的 agent.kind 默认值；如果不指定则按 discover 顺序。 */
  defaultKind?: HerdrKind;
  /** 单轮最大等待秒数（默认 1800 = 30 分钟）。 */
  turnTimeoutSeconds?: number;
  /** 状态轮询间隔 ms（默认 800）。 */
  pollIntervalMs?: number;
}

/** Herdr 状态字符串（herdr agent get --json 返回的 state 字段）。 */
export type HerdrAgentState = "working" | "idle" | "blocked" | "done" | "unknown" | "not_running";

function isTerminalForTurn(prev: HerdrAgentState, cur: HerdrAgentState): boolean {
  // turn 结束：曾 working 又回到 idle/done
  if (prev === "working" && (cur === "idle" || cur === "done" || cur === "blocked")) return true;
  // blocked 也算 turn 终态（需要决策才能继续）
  return false;
}

function safeAgentName(raw: string): string {
  // Herdr agent name 格式：^[a-z][a-z0-9_-]{0,31}$
  return `phonon-${raw.replace(/[^a-z0-9_-]/gi, "-").toLowerCase().slice(0, 24)}`;
}

/** 执行 `herdr` 子命令，返回 stdout/stderr/exitCode（best-effort JSON 解析）。 */
async function runHerdr(
  env: HerdrEnv,
  args: string[],
  opts: { timeoutMs?: number; cwd?: string; environment?: Record<string, string> } = {},
): Promise<{ exitCode: number; stdout: string; stderr: string; json?: unknown }> {
  return new Promise((resolve) => {
    const child = spawnAgent(env.binPath ?? "herdr", args, {
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
      env: buildChildProcessEnvironment(opts.environment),
    });
    let stdout = "";
    let stderr = "";
    const max = 256 * 1024;
    const timer = setTimeout(() => child.kill("SIGTERM"), opts.timeoutMs ?? 30_000);
    child.stdout.on("data", (d) => { stdout = (stdout + d.toString()).slice(-max); });
    child.stderr.on("data", (d) => { stderr = (stderr + d.toString()).slice(-max); });
    child.once("error", () => { /* fallthrough to close */ });
    child.on("close", (code) => {
      clearTimeout(timer);
      const clean = stdout.replace(/\u001b\[[0-9;]*m/g, "");
      let json: unknown | undefined;
      // Herdr 在末尾响应里 JSON.stringify；有些命令（如 api schema --json）本身就是 JSON。
      try { json = JSON.parse(clean); } catch { /* not JSON; leave undefined */ }
      resolve({ exitCode: typeof code === "number" ? code : 1, stdout: clean.trim(), stderr: stderr.trim(), json });
    });
  });
}

class HerdrSession implements AdapterSession {
  readonly sessionId: string;
  model: string;
  private readonly cwd: string;
  private readonly env: HerdrEnv;
  private readonly kind: HerdrKind;
  private readonly agentName: string;
  private readonly pollMs: number;
  private readonly turnTimeoutMs: number;
  private currentAbort: AbortController | undefined;
  private pendingInject: string[] = [];
  private reattach: boolean;
  /** pane ID（workspace_id:pane_id 形式），启动后填上，供 pane read 使用。 */
  private paneId?: string;

  constructor(
    sessionId: string,
    model: string,
    cwd: string,
    env: HerdrEnv,
    kind: HerdrKind,
    initialContext: ContextItem[] | undefined,
    reattach: boolean,
  ) {
    this.sessionId = sessionId;
    this.model = model;
    this.cwd = cwd;
    this.env = env;
    this.kind = kind;
    this.agentName = safeAgentName(sessionId);
    this.pollMs = env.pollIntervalMs ?? 800;
    this.turnTimeoutMs = (env.turnTimeoutSeconds ?? 1800) * 1000;
    this.reattach = reattach;
    this.pendingInject.push(...formatInitialContextLines(initialContext));
  }

  async send(input: string, opts: SendOptions): Promise<void> {
    if (opts.signal?.aborted) return;
    const localAbort = new AbortController();
    const forwardAbort = (): void => localAbort.abort(opts.signal?.reason);
    if (opts.signal) opts.signal.addEventListener("abort", forwardAbort, { once: true });
    this.currentAbort = localAbort;

    try {
      let prompt = input;
      if (this.pendingInject.length > 0) {
        prompt = `${this.pendingInject.join("\n")}\n\n${prompt}`;
        this.pendingInject = [];
      }
      if (opts.skills?.length) {
        prompt = `[Use these skills for this turn: ${opts.skills.join(", ")}]\n\n${prompt}`;
      }

      // 第一次 send：workspace + pane + agent 还没建。herdr workspace create 给 pane_id；
      // herdr agent start 把 agent 跑进 pane。后续 send 复用同一个 agent name。
      if (!this.reattach) {
        await this.bootstrapWorkspace(opts);
        this.reattach = true;
      }

      const turnId = opts.turnId;
      const emit = opts.emit;
      const at = new Date().toISOString();

      // Herdr 自己有 --wait --until 机制：直接用它等 turn 结束，不退化成 poll agent get。
      const deadline = this.turnTimeoutMs;
      const promptRes = await runHerdr(
        this.env,
        ["agent", "prompt", this.agentName, prompt, "--wait", "--until", "idle", "--until", "done", "--until", "blocked", "--timeout", String(deadline)],
        { timeoutMs: deadline + 5_000, cwd: this.cwd, environment: opts.environment },
      );
      if (localAbort.signal.aborted) {
        emit({
          type: "result", sessionId: this.sessionId, turnId, seq: 0,
          at: new Date().toISOString(), text: "", status: "interrupted", final: true,
        } as StreamEvent);
        return;
      }
      if (promptRes.exitCode !== 0) {
        const blocked = /agent_blocked|blocked/i.test(promptRes.stderr || promptRes.stdout);
        emit({
          type: "error", sessionId: this.sessionId, turnId, seq: 0,
          at: new Date().toISOString(),
          message: blocked
            ? "agent is blocked (review Herdr pane for permission prompt)"
            : adapterDiagnostic(`herdr agent prompt failed: ${promptRes.stderr || promptRes.stdout}`),
          status: "failed", final: true,
        } as StreamEvent);
        return;
      }

      // 抓 pane 最近输出作为 turn 的 message（best-effort）。
      const text = await this.readPaneText();
      if (text) {
        emit({
          type: "message", sessionId: this.sessionId, turnId, seq: 0,
          at: new Date().toISOString(), role: "assistant", text, delta: false,
        } as StreamEvent);
      }
      emit({
        type: "result", sessionId: this.sessionId, turnId, seq: 0,
        at: new Date().toISOString(), text: text ?? "", status: "completed", final: true,
      } as StreamEvent);
    } finally {
      if (opts.signal) opts.signal.removeEventListener("abort", forwardAbort);
      this.currentAbort = undefined;
    }
  }

  /** 建 workspace（自带 root pane）+ 启动 agent。两步走：先 workspace create 拿 pane_id，再 agent start --pane。 */
  private async bootstrapWorkspace(opts: SendOptions): Promise<void> {
    // Step 1: workspace create --cwd 自动建一个 root pane。
    const wsRes = await runHerdr(this.env, ["workspace", "create", "--cwd", this.cwd, "--label", this.agentName, "--no-focus"], {
      timeoutMs: 30_000,
      cwd: this.cwd,
      environment: opts.environment,
    });
    if (wsRes.exitCode !== 0) {
      throw new Error(`herdr workspace create failed: ${wsRes.stderr || wsRes.stdout || "(no output)"}`);
    }
    const paneId = this.extractRootPaneId(wsRes.json, wsRes.stdout);
    if (!paneId) throw new Error(`herdr workspace create: cannot find root_pane id in response: ${wsRes.stdout.slice(0, 200)}`);
    this.paneId = paneId;

    // Step 2: agent start --pane <pane_id>，后面透传 --model 等。
    const startArgs = ["--kind", this.kind, "--pane", paneId, "--timeout", "30000", "--"];
    if (this.model && this.model !== "default") startArgs.push("--model", this.model);
    const startRes = await runHerdr(this.env, ["agent", "start", this.agentName, ...startArgs], {
      timeoutMs: 45_000,
      cwd: this.cwd,
      environment: opts.environment,
    });
    if (startRes.exitCode !== 0) {
      // 启动期可能被 Claude Code 的 workspace trust 对话框拦下（新目录都会问）。
      // 按 "1" 确认（只接受 default accept key，避免替用户决策）。
      // 注：send-keys 会让原本 start 失败的 agent_name 被临时占用，
      // 所以这里不能直接重试 start——必须让已有的那个 agent 进入 interactive_ready。
      if (/agent_not_ready|blocked during startup/.test(startRes.stderr || startRes.stdout)) {
        const trustKeyRes = await runHerdr(this.env, ["agent", "send-keys", this.agentName, "1"], { timeoutMs: 5_000 });
        if (trustKeyRes.exitCode !== 0) {
          throw new Error(`herdr agent start blocked, trust send-keys failed: ${trustKeyRes.stderr || trustKeyRes.stdout}`);
        }
        // 等 agent 转 idle（trust 对话框 accept 后会进 prompt 屏）。
        for (let i = 0; i < 30; i++) {
          const s = await runHerdr(this.env, ["agent", "get", this.agentName], { timeoutMs: 5_000 });
          const state = /"state"\s*:\s*"(\w+)"/.exec(s.stdout)?.[1] ?? /"agent_status"\s*:\s*"(\w+)"/.exec(s.stdout)?.[1];
          if (state === "idle") break;
          await new Promise((r) => setTimeout(r, 500));
        }
      } else {
        throw new Error(`herdr agent start failed: ${startRes.stderr || startRes.stdout || "(no output)"}`);
      }
    }
  }

  /** 从 workspace create 的响应里抠出 root_pane id。响应形如
   *  {"result":{"workspace":..., "tab":..., "root_pane":{"pane_id":"w1:p1"}}, ...} */
  private extractRootPaneId(json: unknown, raw: string): string | undefined {
    const tryObj = (o: unknown): string | undefined => {
      if (!o || typeof o !== "object") return undefined;
      const r = (o as { result?: unknown }).result ?? o;
      const rp = (r as { root_pane?: unknown }).root_pane;
      const pid = (rp as { pane_id?: unknown } | undefined)?.pane_id;
      return typeof pid === "string" ? pid : undefined;
    };
    return tryObj(json) ?? tryObj(JSON.parse(raw));
  }

  /** 抓 pane 屏幕最近一段，去 ANSI 色。文本会含 TUI 控件字符，做 best-effort。 */
  private async readPaneText(): Promise<string | undefined> {
    if (!this.paneId) return undefined;
    const r = await runHerdr(this.env, ["pane", "read", this.paneId, "--source", "recent-unwrapped", "--lines", "200"], { timeoutMs: 10_000 });
    if (r.exitCode !== 0) return undefined;
    return r.stdout.replace(/\u001b\[[0-9;?]*[a-zA-Z]/g, "").trim() || undefined;
  }

  async interrupt(): Promise<void> {
    // 先按 esc 让 agent 中断当前 prompt；不行再走强杀。
    const soft = await runHerdr(this.env, ["agent", "send-keys", this.agentName, "esc"], { timeoutMs: 5_000 });
    if (soft.exitCode !== 0) {
      await runHerdr(this.env, ["agent", "release", this.agentName], { timeoutMs: 5_000 });
    }
    this.currentAbort?.abort("interrupted");
  }

  async inject(context: ContextItem[]): Promise<void> {
    for (const c of context) this.pendingInject.push(`[${c.role}] ${c.content}`);
  }

  async switchModel(model: string): Promise<{ warnings?: string[] }> {
    // 切模型需要 agent restart + resume；保守返回警告。
    this.model = model;
    return { warnings: ["herdr adapter does not hot-swap models; restart the session to apply"] };
  }

  async terminate(): Promise<void> {
    this.currentAbort?.abort("terminate");
    await runHerdr(this.env, ["agent", "release", this.agentName], { timeoutMs: 5_000 }).catch(() => undefined);
    // workspace 在 Herdr 自己的 server-side 生命周期管理；这里不强删。
  }
}

export class HerdrAdapter implements AgentAdapter {
  readonly name = "herdr";
  readonly capabilities = CAPABILITIES;
  private readonly env: HerdrEnv;
  private cachedVersion?: string;
  private cachedAvailable?: boolean;

  constructor(opts: { env?: HerdrEnv } = {}) {
    this.env = opts.env ?? {};
  }

  async discoverAgents(signal?: AbortSignal): Promise<AgentDescriptor[]> {
    const version = await this.probeVersion(signal);
    const available = version !== null;
    this.cachedVersion = version ?? undefined;
    this.cachedAvailable = available;
    if (!available) {
      // 诚实：不可用就只返回一个 unavailable descriptor，不假装多个 kind。
      return [{
        agentId: "herdr" as AgentDescriptor["agentId"],
        displayName: "Herdr (multi-agent runtime)",
        adapter: "herdr",
        available: false,
        unavailableReason: "herdr CLI not found on PATH; install from https://herdr.dev",
        models: [],
        capabilities: CAPABILITIES,
        scannedAt: new Date().toISOString(),
      }];
    }
    // 每个 kind 暴露一个 agentId（herdr:<kind>）；composite agentId 与 D32 一致。
    // models 是 conservative 占位——herdr agent start 时再决定透传 --model。
    const models: ModelInfo[] = this.env.defaultModel
      ? [{ id: this.env.defaultModel, available: true }]
      : [{ id: "default", available: true }];
    const now = new Date().toISOString();
    return HERDR_KINDS.map((kind) => ({
      agentId: `herdr:${kind}` as AgentDescriptor["agentId"],
      displayName: `Herdr · ${kind}`,
      adapter: "herdr",
      available: true,
      ...(version ? { version } : {}),
      models,
      capabilities: CAPABILITIES,
      scannedAt: now,
    }));
  }

  async createSession(params: CreateSessionParams): Promise<AdapterSession> {
    const kind = parseHerdrKind(params.agentId) ?? this.env.defaultKind;
    if (!kind) {
      throw new Error(
        `herdr adapter: cannot infer kind from agentId="${params.agentId}"; ` +
        `expected 'herdr:<kind>' (one of: ${HERDR_KINDS.join(", ")}) or set env.defaultKind`,
      );
    }
    const model = params.model && params.model !== "default" ? params.model : (this.env.defaultModel ?? "default");
    return new HerdrSession(
      params.sessionId,
      model,
      params.cwd,
      this.env,
      kind,
      params.initialContext,
      params.reattach ?? false,
    );
  }

  private async probeVersion(signal?: AbortSignal): Promise<string | null> {
    const out = await discoveryProbe(this.env.binPath ?? "herdr", ["--version"], signal);
    return out ? parseHerdrVersion(out) ?? null : null;
  }
}

// 静默：probeVersion 的同步版本给非 async context（doctor 等）用；不影响 ABI。
export function probeHerdrSync(binPath?: string): { available: boolean; version?: string } {
  const r = spawnSyncAgent(binPath ?? "herdr", ["--version"], { timeout: 8000 });
  if (r.status !== 0) return { available: false };
  const out = (r.stdout?.toString() ?? "").trim().split(/\r?\n/)[0];
  return { available: true, ...(out ? { version: out } : {}) };
}