import type { ChildProcess } from "node:child_process";
import { nativeVersionAtLeast } from "@agent-phonon/protocol";
import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import { spawnSyncAgent } from "../proc.js";
import { spawnSupervisedAgent, type ProcessSupervisor } from "../process-supervisor.js";
import { buildChildProcessEnvironment } from "../child-env.js";
import { adapterDiagnostic } from "../adapter-diagnostic.js";
import type {
  AgentAdapter,
  AdapterSession,
  AdapterHitlContext,
  CreateSessionParams,
  InsertionOptions,
  SendOptions,
} from "../adapter.js";
import { formatInitialContextLines } from "../adapter.js";
import { materializePiHitlExtension, piHitlStateDir } from "../pi-hitl-extension.js";
import { PiCheckpoint, materializePiRecoveryGuard, observePiRpcSession, piRecoveryFailure, piSessionLocation, verifyPiSession, type PiNativeObservation } from "./pi-recovery.js";
import { preparePiNativeTools } from "./pi-native-tools.js";
import { PiRpcChannel } from "./pi-rpc.js";
import { discoverPiNativeModels } from "./pi-models.js";
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
 * Transport follows the installed Pi CLI/RPC contract:
 *
 *   pi --mode rpc --session-id <id>       # verified >=0.84.1 lifecycle
 *   pi --mode json --session-id <id>      # older/unknown versions, no steering
 *
 * 关键约定（踩过坑的照抄官方文档）：
 *  - **严格 JSONL，只按 LF 切**。官方明确说 Node.js `readline` 不适用——它会把
 *    Unicode 行/段分隔符(U+2028/U+2029) 也当记录边界，而 Pi 允许这些字符出现在
 *    JSON 字符串内。所以这里用 `indexOf("\n")` 手工切，不用 readline。
 *  - **prompt 走 stdin 不走 argv**。这样任务内容不会出现在进程列表里
 *    （与 copilot adapter 同一理由）。
 *  - `--session-id` 可确定性续接同一 project 会话（比 `--resume` 交互选择器好用）。
 *    Pi 要求 session id 首尾为字母数字，可含 `A-Za-z0-9._-`，故需 sanitize。
 *  - RPC steering resolves only after queue acceptance AND a matching native
 *    user message. agent_settled closes stdin; actual process exit settles a turn.
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
  /** 单轮硬超时（毫秒）。默认 2 小时；可用 AGENT_PHONON_PI_TURN_TIMEOUT_MS 覆盖。 */
  turnTimeoutMs?: number;
}

/** A killed turn is recoverable now, but a long test suite still needs headroom. */
const DEFAULT_TURN_TIMEOUT_MS = 7_200_000;
function turnTimeoutMs(env: PiEnv): number {
  const raw = env.turnTimeoutMs ?? Number(process.env.AGENT_PHONON_PI_TURN_TIMEOUT_MS);
  return Number.isFinite(raw) && raw >= 60_000 ? Math.min(raw, 86_400_000) : DEFAULT_TURN_TIMEOUT_MS;
}

/** 解析后的 Pi JSONL 事件子集（本 adapter 关心的部分）。 */
export type ParsedPiEvent =
  | { kind: "session"; nativeSessionId: string; cwd?: string }
  | { kind: "text_delta"; text: string }
  | { kind: "thinking_delta"; text: string }
  | { kind: "tool_call"; toolCallId: string; toolName: string; args?: unknown }
  | { kind: "tool_result"; toolCallId: string; toolName?: string; ok: boolean; output?: unknown }
  | { kind: "turn_end"; text?: string }
  | { kind: "assistant_message"; text: string; stopReason?: string; errorMessage?: string }
  | { kind: "user_message"; text: string }
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
      if (inner.type === "error") {
        const error = inner.error as Record<string, unknown> | string | undefined;
        const message = typeof error === "string" ? error : error?.errorMessage;
        if (typeof message === "string") return { kind: "stream_error", message };
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

    case "message_end": {
      const message = ev.message as Record<string, unknown> | undefined;
      if (message?.role === "user" && Array.isArray(message.content)) {
        const blocks = message.content as Array<Record<string, unknown>>;
        if (blocks.every(block => block?.type === "text" && typeof block.text === "string")) {
          return { kind: "user_message", text: blocks.map(block => block.text).join("") };
        }
        return { kind: "ignore" };
      }
      if (message?.role !== "assistant" || !Array.isArray(message.content)) return { kind: "ignore" };
      const text = (message.content as Array<Record<string, unknown>>)
        .filter(block => block && typeof block === "object" && block.type === "text" && typeof block.text === "string").map(block => block.text).join("");
      return { kind: "assistant_message", text, ...(typeof message.stopReason === "string" ? { stopReason: message.stopReason } : {}),
        ...(typeof message.errorMessage === "string" ? { errorMessage: message.errorMessage } : {}) };
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
  rpc: boolean;
}

export function parsePiSessionFlags(help: string): PiSessionFlags {
  return {
    sessionId: /--session-id\b/.test(help),
    name: /(?:^|\s)-n,\s*--name\b|--name\b/.test(help),
    session: /--session\s+<|--session\s+[a-z]/i.test(help),
    continueFlag: /--continue\b/.test(help),
    rpc: /--mode[^\n]*\brpc\b/.test(help),
  };
}

/** Best-effort capability probe; an unreadable help yields all-false (no session flags). */
export function probePiSessionFlags(binPath = "pi"): PiSessionFlags {
  try {
    const r = spawnSyncAgent(binPath, ["--help"], { timeout: 10_000, encoding: "utf8" });
    if (r.status !== 0) return { sessionId: false, name: false, session: false, continueFlag: false, rpc: false };
    return parsePiSessionFlags(`${r.stdout ?? ""}\n${r.stderr ?? ""}`);
  } catch {
    return { sessionId: false, name: false, session: false, continueFlag: false, rpc: false };
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
/** Catalog rows whose `thinking` column is yes; the same row feed as parsePiModels. */
export function parsePiThinkingModels(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.replace(/\u001b\[[0-9;]*m/g, "").split(/\r?\n/)) {
    const cols = raw.trim().split(/\s{2,}|\t/).map(c => c.trim()).filter(Boolean);
    if (cols.length < 5) continue;
    const [provider, model] = cols;
    if (!provider || !model || /^provider$/i.test(provider)) continue;
    if (!/^[a-z0-9_-]+$/i.test(provider) || !/^[a-z0-9._:-]+$/i.test(model)) continue;
    if (/^y/i.test(cols[cols.length - 2] ?? "")) out.add(`${provider}/${model}`);
  }
  return out;
}

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
  /** Once attempted, a turn may only continue its verified native file. */
  private started = false;
  private pendingInject: string[] = [];
  private native?: PiNativeObservation;
  private continuationTarget?: { id: string; path: string };
  /** Last provider-exact context reading; pi exits after each turn, so this is cached. */
  private usage?: { contextWindow?: number; usedTokens?: number };
  private modelSwitchPending = false;
  private modelRevision = 0;
  private current?: ChildProcess;
  private stopCurrent?: () => void;
  /** Supervised tree of the most recent turn; passive stop evidence for the engine. */
  private lastNative?: { turnId: string; supervisor: ProcessSupervisor };
  private rpcCurrent?: { turnId: string; channel: PiRpcChannel };

  constructor(sessionId: string, model: string, cwd: string, env: PiEnv, initialContext: ContextItem[] | undefined, sessionFlags: PiSessionFlags, recovered?: PiCheckpoint) {
    this.sessionId = sessionId;
    this.model = model;
    this.cwd = realpathSync(cwd);
    this.env = env;
    this.sessionFlags = sessionFlags;
    this.piSessionId = toPiSessionId(sessionId);
    this.pendingInject.push(...formatInitialContextLines(initialContext));
    if (recovered) {
      this.native = recovered.native;
      this.pendingInject = [...recovered.pendingInject];
      this.started = true;
      this.modelSwitchPending = recovered.modelSwitchPending;
    }
  }

  async send(input: string, opts: SendOptions): Promise<void> {
    if (this.current || opts.signal?.aborted) throw piRecoveryFailure();
    this.captureContinuation();
    if (this.native) this.native = verifyPiSession(this.native, this.cwd);
    else if (this.started && this.sessionFlags.session) throw piRecoveryFailure();
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

  peerContextCapability() {
    if (!this.sessionFlags.rpc || !this.sessionFlags.session || !this.sessionFlags.sessionId) return undefined;
    return { mode: "context_hook", boundary: "before_model", visibility: "hidden", evidence: "provider_payload",
      budget:"native_estimate",nativeSessionId: this.native?.sessionId ?? this.piSessionId } as const;
  }

  private run(prompt: string, opts: SendOptions): Promise<void> {
    const nativeTools = preparePiNativeTools(opts);
    return new Promise<void>((resolve) => {
      const { turnId, emit } = opts;
      const rpcMode = this.sessionFlags.rpc;
      const args = ["--mode", rpcMode ? "rpc" : "json"];
      // Only pass session flags this Pi build actually accepts; older builds abort
      // on an unknown option instead of ignoring it.
      const previous = this.native;
      const modelRevision = this.modelRevision;
      // An unqualified model name must not drift to a different provider after
      // config changes. Only an explicit live switch may choose a new model.
      const launchModel = previous && !this.modelSwitchPending ? previous.nativeModel : this.model;
      const recoveryGuard = previous ? materializePiRecoveryGuard(previous, launchModel) : undefined;
      if (previous) args.push("--session", previous.path, "--extension", recoveryGuard!.path);
      // A known CLI without an exact path selector remains stateless, including
      // ordinary second sends. Never label those calls as native continuation.
      else if (this.sessionFlags.session && this.sessionFlags.sessionId) args.push("--session-id", this.piSessionId);
      else if (this.sessionFlags.session && this.sessionFlags.name) args.push("--name", this.piSessionId);
      const reasoningLevel = opts.reasoning?.level;
      const nativeReasoning = reasoningLevel
        ? ({ low: "low", standard: "medium", high: "high", xhigh: "xhigh", max: "max" } as const)[reasoningLevel] : undefined;
      if (launchModel && launchModel !== "default") args.push("--model", launchModel);
      if (nativeReasoning) args.push("--thinking", nativeReasoning);
      if (this.env.appendSystemPrompt) args.push("--append-system-prompt", this.env.appendSystemPrompt);

      const hitl = this.env.hitl;
      const childEnv: NodeJS.ProcessEnv = buildChildProcessEnvironment(opts.environment);
      // Remote/inherited environment alone cannot enable a runtime checkpoint capability.
      childEnv.AGENT_PHONON_PEER_CONTEXT_URL = opts.peerContext ? opts.environment?.AGENT_PHONON_PEER_CONTEXT_URL : "";
      childEnv.AGENT_PHONON_PEER_CONTEXT_TOKEN = opts.peerContext ? opts.environment?.AGENT_PHONON_PEER_CONTEXT_TOKEN : "";
      if (!nativeTools?.names.length) childEnv.AGENT_PHONON_MCP_URL = "";
      if (nativeTools) {
        args.push("--extension", nativeTools.path);
        childEnv.AGENT_PHONON_PI_NATIVE_NONCE = nativeTools.nonce;
        childEnv.AGENT_PHONON_PI_NATIVE_TOOL_NAMES = JSON.stringify(nativeTools.names);
      }
      // Pi's native directories are device configuration, never a remote turn override.
      for (const key of ["PI_CODING_AGENT_DIR", "PI_CODING_AGENT_SESSION_DIR", "PI_CODING_AGENT_HOME"]) {
        delete childEnv[key];
        if (process.env[key] !== undefined) childEnv[key] = process.env[key];
      }
      if (hitl?.bridgeUrl) {
        // Load the blocking tool_call extension so a human decision actually gates tools.
        args.push("--extension", materializePiHitlExtension(piHitlStateDir()));
        childEnv.AGENT_PHONON_HITL_BRIDGE = hitl.bridgeUrl;
        childEnv.AGENT_PHONON_HITL_SESSION = this.sessionId;
        childEnv.AGENT_PHONON_HITL_FAIL_MODE = hitl.failMode ?? "closed";
        if (hitl.timeoutMs !== undefined) childEnv.AGENT_PHONON_HITL_TIMEOUT_MS = String(hitl.timeoutMs);
        if (hitl.token) childEnv.AGENT_PHONON_HITL_TOKEN = hitl.token;
      }

      // A process-group leader is what makes "the tree stopped" observable later:
      // the engine asks this adapter for passive proof instead of trusting a signal.
      const supervisor = spawnSupervisedAgent(this.env.binPath ?? "pi", args, { cwd: this.cwd, env: childEnv }, { graceMs: 1_000 });
      const child = supervisor.child;
      this.lastNative = { turnId, supervisor };
      this.current = child;
      this.started = true;
      this.native = undefined;
      this.continuationTarget = undefined;

      let buf = "";
      let stderr = "";
      let acc = "";
      let finalMessage: string | undefined;
      let assistantOutcome: "completed" | "failed" | undefined;
      let toolNames = new Map<string, string>();
      let settled = false;
      let recoveryReady = !recoveryGuard, nativeToolsReady = !nativeTools;
      let terminal: "completed" | "failed" | "interrupted" | "timeout" | undefined;
      let failure: string | undefined;
      let nativeHeader: { id: string; timestamp: string; cwd: string } | undefined;
      let promptSent = false;
      let promptAccepted = false, inputObserved = false, inputReceiptEmitted = false;
      const confirmInput = (): void => {
        if (!rpcMode || settled || !promptAccepted || !inputObserved || inputReceiptEmitted) return;
        inputReceiptEmitted = true;
        emit({ type: "message", sessionId: this.sessionId, turnId, seq: 0, at: new Date().toISOString(),
          role: "user", source: "native_input_accepted", text: "", delta: false } as StreamEvent);
      };
      let stderrLines = "";
      let shutdownGuard: ReturnType<typeof setTimeout> | undefined;
      let rpcIdentity: { id: string; path: string } | undefined;
      const rpc = rpcMode ? new PiRpcChannel(value => {
        if (child.stdin.destroyed || child.stdin.writableEnded) throw piRecoveryFailure();
        child.stdin.write(JSON.stringify(value) + "\n");
      }) : undefined;
      if (rpc) this.rpcCurrent = {turnId, channel: rpc};
      const stop = (): void => {
        rpc?.close();
        // Graceful, then forced after the supervisor's grace window.
        void supervisor.terminate();
      };

      const finish = (status: "completed" | "failed" | "interrupted" | "timeout", message?: string): void => {
        if (settled) return;
        settled = true;
        clearTimeout(guard);
        clearTimeout(startupGuard);
        clearTimeout(shutdownGuard);
        rpc?.close();
        opts.signal?.removeEventListener("abort", abort);
        recoveryGuard?.cleanup();
        if (this.current === child) { this.current = undefined; this.stopCurrent = undefined; }
        if (this.rpcCurrent?.channel === rpc) this.rpcCurrent = undefined;
        // Task failure does not invalidate the conversation. Snapshot the exact
        // native file once its supervised tree stops, without changing history.
        if (promptSent && this.sessionFlags.session && (nativeHeader || rpcIdentity)) {
          this.continuationTarget = rpcIdentity ?? { id: nativeHeader!.id, path: join(piSessionLocation(this.cwd).sessionDir,
            nativeHeader!.timestamp.replace(/[:.]/g, "-") + "_" + nativeHeader!.id + ".jsonl") };
          this.captureContinuation();
          if (this.native && modelRevision === this.modelRevision) this.modelSwitchPending = false;
        } else if (!promptSent) {
          try {
            if (previous) this.native = verifyPiSession(previous, this.cwd);
            else if (!rpcIdentity && !nativeHeader) this.started = false;
          } catch { this.native = undefined; }
        }
        const at = new Date().toISOString();
        if (status === "failed") {
          emit({
            type: "error", sessionId: this.sessionId, turnId, seq: 0, at,
            message: adapterDiagnostic(message ?? "pi failed"), status: "failed", final: true,
          } as StreamEvent);
        } else {
          emit({ type: "result", sessionId: this.sessionId, turnId, seq: 0, at, text: status === "completed" ? (finalMessage ?? acc) : acc, status, final: true } as StreamEvent);
        }
        resolve();
      };

      const guard = setTimeout(() => {
        terminal = "timeout";
        stop();
      }, turnTimeoutMs(this.env));
      const startupGuard = setTimeout(() => {
        if ((rpcMode || recoveryGuard || nativeTools) && !promptSent) {
          terminal = "failed";
          failure = nativeTools && !nativeToolsReady ? "Pi native tools did not register; input was not sent"
            : !recoveryReady ? "Pi native recovery guard did not register; input was not sent" : "Pi native RPC identity was not confirmed; input was not sent";
          stop();
        }
      }, 10_000);

      const abort = (): void => {
        terminal = "interrupted";
        stop();
      };
      this.stopCurrent = abort;
      if (opts.signal?.aborted) abort();
      else opts.signal?.addEventListener("abort", abort, { once: true });

      const handleLine = (line: string): void => {
        // 官方要求：只按 LF 切；\r 需剥掉，但 U+2028/U+2029 必须保留在 JSON 字符串内。
        const clean = line.endsWith("\r") ? line.slice(0, -1) : line;
        if (!clean.trim()) return;
        let raw: unknown;
        try { raw = JSON.parse(clean); } catch { return; }
        rpc?.observe(raw);
        if (rpcMode && raw && typeof raw === "object" && (raw as Record<string, unknown>).type === "extension_error") {
          terminal = "failed"; failure = "Pi extension failed; native execution is unconfirmed"; stop(); return;
        }
        const parsed = parsePiEvent(raw);
        const at = new Date().toISOString();

        switch (parsed.kind) {
          case "user_message":
            if (promptSent && parsed.text === prompt) { inputObserved = true; confirmInput(); }
            break;
          case "session":
            if (nativeHeader || parsed.cwd !== this.cwd || typeof (raw as Record<string, unknown>).timestamp !== "string"
              || (previous && parsed.nativeSessionId !== previous.sessionId)) {
              terminal = "failed";
              failure = "Pi returned a different native session; continuation rejected";
              stop();
            } else nativeHeader = { id: parsed.nativeSessionId, cwd: parsed.cwd, timestamp: (raw as { timestamp: string }).timestamp };
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
            // Usage is provider-exact only after a response; pi exits at settlement, so read it now.
            if (rpc) void rpc.usage().then(value => this.captureUsage(value)).catch(() => {});
            break;
          case "assistant_message":
            if (parsed.stopReason === "aborted") {
              terminal = "interrupted";
              failure = "Pi assistant execution did not complete";
              stop();
            } else if (parsed.stopReason === "error") {
              assistantOutcome = "failed"; finalMessage = undefined;
              failure = parsed.errorMessage ?? "Pi assistant execution did not complete";
              // Qualified RPC can recover this attempt through native retry or
              // compaction. Only agent_settled declares its final outcome.
              if (!rpc) { terminal = "failed"; stop(); }
            } else if (parsed.stopReason === "stop" || parsed.stopReason === "length") {
              assistantOutcome = "completed"; finalMessage = parsed.text;
              if (!terminal) failure = undefined;
            } else {
              assistantOutcome = undefined; finalMessage = undefined;
            }
            break;
          case "stream_error":
            assistantOutcome = "failed"; finalMessage = undefined;
            failure = parsed.message;
            if (!rpc) { terminal = "failed"; stop(); }
            break;
          case "settled":
            terminal ??= parsed.aborted ? "interrupted" : rpc ? assistantOutcome ?? "failed" : "completed";
            if (rpc) {
              child.stdin.end();
              shutdownGuard ??= setTimeout(() => {
                terminal = "failed"; failure = "Pi native RPC did not close after settlement"; stop();
              }, 10_000);
            }
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
      const sendPrompt = (): void => {
        if (promptSent || settled || terminal === "failed" || opts.signal?.aborted) return;
        if (rpc && !rpcIdentity) return;
        promptSent = true;
        clearTimeout(startupGuard);
        if (rpc) void rpc.prompt(prompt).then(() => { promptAccepted = true; confirmInput(); }).catch(() => {
          if (settled || terminal) return;
          terminal = "failed"; failure = "Pi did not accept the original native prompt"; stop();
        });
        else child.stdin.end(prompt + "\n");
      };
      let stateRequested = false;
      const ready = (): void => {
        if (!recoveryReady || !nativeToolsReady || settled || terminal || opts.signal?.aborted) return;
        if (!rpc) { sendPrompt(); return; }
        if (stateRequested) return;
        stateRequested = true;
        void rpc.state().then(value => {
          if (settled || terminal || opts.signal?.aborted) return;
          const state = value as Record<string, unknown> | undefined;
          const model = state?.model as Record<string, unknown> | undefined;
          if (!state || typeof state.sessionId !== "string" || typeof state.sessionFile !== "string"
            || !isAbsolute(state.sessionFile)
            || state.isStreaming !== false || state.isCompacting !== false || state.pendingMessageCount !== 0
            || !model || typeof model.provider !== "string" || typeof model.id !== "string"
            || (launchModel !== "default" && launchModel !== model.id && launchModel !== `${model.provider}/${model.id}`)
            || (!previous && this.sessionFlags.sessionId && state.sessionId !== this.piSessionId)) throw piRecoveryFailure();
          // A new native file need not exist yet. Resolve its existing parent
          // so device-configured aliases cannot change the frozen file identity.
          const path = join(realpathSync(dirname(state.sessionFile)), basename(state.sessionFile));
          if (dirname(path) !== piSessionLocation(this.cwd).sessionDir || !basename(path).endsWith(`_${state.sessionId}.jsonl`)
            || (previous && (state.sessionId !== previous.sessionId || path !== previous.path))) throw piRecoveryFailure();
          rpcIdentity = {id: state.sessionId, path};
          const window = model.contextWindow ?? model.contextTokens;
          if (typeof window === "number" && Number.isSafeInteger(window) && window > 0) {
            this.usage = { ...this.usage, contextWindow: window };
          }
          if (nativeReasoning) {
            const applied = typeof state.thinkingLevel === "string" ? state.thinkingLevel : "";
            // Report only native evidence. A clamped/missing optional setting must not drop input.
            if (applied) try { opts.acknowledgeReasoning?.(applied); } catch { /* Setting remains unconfirmed. */ }
          }
          sendPrompt();
        }).catch(() => {
          if (settled || terminal) return;
          terminal = "failed"; failure = "Pi native RPC identity was not confirmed; input was not sent"; stop();
        });
      };
      child.stdin.on("error", () => { /* Process close supplies the authoritative failure. */ });
      child.stderr.on("data", (chunk: string) => {
        stderr = (stderr + chunk).slice(-16_000);
        if ((!recoveryGuard && !nativeTools) || promptSent) return;
        stderrLines += chunk;
        let nl: number;
        while ((nl = stderrLines.indexOf("\n")) >= 0) {
          const line = stderrLines.slice(0, nl);
          stderrLines = stderrLines.slice(nl + 1);
          if (line === recoveryGuard?.acknowledgement) recoveryReady = true;
          if (line === nativeTools?.acknowledgement) nativeToolsReady = true;
          if (recoveryReady && nativeToolsReady) ready();
        }
        stderrLines = stderrLines.slice(-16_000);
      });
      child.on("error", (err) => finish("failed", err.message));
      child.on("close", (code) => {
        if (settled) return;
        if (buf.trim()) handleLine(buf);
        if (terminal === "interrupted" || terminal === "timeout") finish(terminal);
        else if (code === 0 && terminal !== "failed" && promptSent && toolNames.size === 0
          && (!rpc || terminal === "completed" && !!finalMessage?.trim())) finish("completed");
        else finish("failed", failure || stderr.trim() || `pi exited ${code} without settled tools`);
      });

      if (!settled && !recoveryGuard && !nativeTools) {
        // prompt 走 stdin：不出现在进程列表里。
        ready();
      }
    }).finally(() => nativeTools?.cleanup());
  }

  async interrupt(): Promise<void> {
    this.stopCurrent?.();
  }

  /** Passive evidence: a sent signal is not proof, only an ended tree is. */
  async observeNativeStop(turnId: string): Promise<"process_tree_exit" | undefined> {
    const native = this.lastNative;
    if (!native || native.turnId !== turnId) return undefined;
    return native.supervisor.hasStopped() ? "process_tree_exit" : undefined;
  }

  async insertAtToolGap(input: string, options: InsertionOptions): Promise<void> {
    const rpc = this.rpcCurrent;
    if (!rpc || rpc.turnId !== options.turnId || !this.current || options.signal.aborted) throw piRecoveryFailure();
    options.beforeApply?.();
    await rpc.channel.insert(input, options.signal);
  }

  async switchModel(model: string): Promise<{ warnings?: string[] }> {
    this.model = model;
    this.modelSwitchPending = true;
    this.modelRevision++;
    return {};
  }

  async inject(context: ContextItem[]): Promise<void> {
    for (const item of context) this.pendingInject.push(`[${item.role}] ${item.content}`);
  }

  async terminate(): Promise<void> {
    await this.interrupt();
  }

  private captureContinuation(): void {
    if (this.native || !this.continuationTarget || !this.lastNative?.supervisor.hasStopped()) return;
    const target = this.continuationTarget;
    this.continuationTarget = undefined;
    try {
      this.native = observePiRpcSession(this.cwd, target.id, target.path, true);
    } catch { /* Never replace a changed or damaged identity with a fresh conversation. */ }
  }

  private captureUsage(value: unknown): void {
    const usage = (value as Record<string, unknown> | undefined)?.contextUsage as Record<string, unknown> | undefined;
    const used = usage?.tokens, window = usage?.contextWindow;
    if (typeof used === "number" && Number.isSafeInteger(used) && used >= 0) this.usage = { ...this.usage, usedTokens: used };
    if (typeof window === "number" && Number.isSafeInteger(window) && window > 0) this.usage = { ...this.usage, contextWindow: window };
  }

  /** Real context reading for the client; omits what pi has not reported yet. */
  async describe(): Promise<{ contextWindow?: number; usedTokens?: number }> {
    return { ...this.usage };
  }

  /** Session metadata is assembled synchronously; report the last provider-exact reading. */
  contextSnapshot(): { contextWindow?: number; usedTokens?: number } | undefined {
    return this.usage ? { ...this.usage } : undefined;
  }

  recoveryCheckpoint(): Record<string, unknown> | undefined {
    this.captureContinuation();
    if (this.current || !this.native) return undefined;
    try {
      verifyPiSession(this.native, this.cwd);
      return PiCheckpoint.parse({ phononSessionId: this.sessionId, model: this.model, native: { ...this.native }, pendingInject: [...this.pendingInject], modelSwitchPending: this.modelSwitchPending });
    } catch { return undefined; }
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
  private rpcAvailable: boolean | undefined;
  private capabilityVersion?: string;

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

  private thinkingProbe: boolean | undefined;
  /** `--thinking` exists in builds from the same era as the RPC steering contract. */
  private thinkingSupported(): boolean {
    this.thinkingProbe ??= !!probePi(this.env.binPath ?? "pi", ["--help"])?.includes("--thinking");
    return this.thinkingProbe;
  }

  private rpcSupported(): boolean {
    if (this.rpcAvailable === undefined) {
      const version = this.flags().rpc ? probePi(this.env.binPath ?? "pi", ["--version"])?.trim().replace(/^v/, "") : undefined;
      // This is the first verified lifecycle with agent_settled and exact
      // user-message delivery events. Older RPC versions remain JSON-only.
      this.rpcAvailable = nativeVersionAtLeast(version, "0.84.1");
    }
    return this.rpcAvailable;
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
      nativeSession: flags.session && (flags.sessionId || flags.name),
      injectMidTurn: this.rpcSupported(),
      // Settings controls need both native flag and RPC evidence. Plain sends remain available.
      reasoningControl: this.thinkingSupported() && this.rpcSupported(),
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
    if (version !== this.capabilityVersion) {
      this.sessionFlags = undefined;
      this.rpcAvailable = undefined;
      this.thinkingProbe = undefined;
      this.capabilities = this.deriveCapabilities();
      this.capabilityVersion = version;
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
    if (params.reattach) throw piRecoveryFailure();
    const model = params.model && params.model !== "default" ? params.model : (this.env.defaultModel ?? "default");
    return new PiSession(params.sessionId, model, params.cwd, this.env, params.initialContext, {...this.flags(), rpc: this.rpcSupported()});
  }

  async recoverSession(params: CreateSessionParams, checkpoint: Record<string, unknown>): Promise<AdapterSession> {
    try {
      const saved = PiCheckpoint.parse(checkpoint);
      const model = params.model && params.model !== "default" ? params.model : (this.env.defaultModel ?? "default");
      if (params.agentId !== "pi" || params.employee || !this.flags().session || saved.phononSessionId !== params.sessionId || saved.model !== model) throw piRecoveryFailure();
      const cwd = realpathSync(params.cwd);
      verifyPiSession(saved.native, cwd);
      return new PiSession(params.sessionId, saved.model, params.cwd, this.env, undefined, {...this.flags(), rpc: this.rpcSupported()}, saved);
    } catch { throw piRecoveryFailure(); }
  }

  async observeSessionCheckpoint(params: CreateSessionParams): Promise<Record<string, unknown> | undefined> {
    if (params.agentId !== "pi" || params.employee || !this.flags().session) return undefined;
    try {
      const id = toPiSessionId(params.sessionId), location = piSessionLocation(params.cwd);
      const matches = readdirSync(location.sessionDir).filter(name => name.endsWith("_" + id + ".jsonl"));
      if (matches.length !== 1) return undefined;
      const native = observePiRpcSession(location.cwd, id, join(location.sessionDir, matches[0]!), true);
      const model = params.model && params.model !== "default" ? params.model : (this.env.defaultModel ?? "default");
      if (model !== "default" && model !== native.nativeModel && model !== native.nativeModel.slice(native.nativeModel.indexOf("/") + 1)) return undefined;
      return PiCheckpoint.parse({ phononSessionId: params.sessionId, model, native, pendingInject: [], modelSwitchPending: false });
    } catch { return undefined; }
  }

  private async resolveModels(signal?: AbortSignal): Promise<ModelInfo[]> {
    signal?.throwIfAborted();
    if (this.env.models?.length && this.env.models.every(model => model.reasoningLevels !== undefined)) return this.env.models;
    const out = probePi(this.env.binPath ?? "pi", ["--list-models"]);
    const parsed = this.env.models?.length ? this.env.models.map(model => ({ ...model })) : out ? parsePiModels(out) : [];
    const preferred = this.env.defaultModel ?? this.configuredModel();
    if (preferred && !parsed.some((m) => m.id === preferred)) parsed.unshift({ id: preferred, available: true });
    if (this.thinkingSupported() && this.rpcSupported()) {
      try {
        const native = await discoverPiNativeModels({ bin: this.env.binPath ?? "pi", env: buildChildProcessEnvironment(), ...(signal ? { signal } : {}) });
        const observed = new Map(native.models.map(model => [model.id, model]));
        const values = parsed.length ? parsed : native.models;
        return values.map(model => {
          const selected = native.selectedID && (model.id === "default" || model.id === preferred && native.selectedID.endsWith("/" + model.id)) ? native.selectedID : model.id;
          const known = observed.get(selected);
          return known ? { ...known, ...model, ...(model.reasoningLevels === undefined && known.reasoningLevels !== undefined ? { reasoningLevels: known.reasoningLevels } : {}) } : model;
        });
      } catch { signal?.throwIfAborted(); }
    }
    // A reasoning boolean/table column is not model-specific effort evidence.
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
