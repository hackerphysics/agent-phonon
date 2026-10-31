import { parse as parseYaml } from "yaml";
import { HERMES_BRIDGE } from "./hermes-bridge.js";
import { HERMES_PROFILE_BRIDGE } from "./hermes-profile-bridge.js";
import { inspectExistingHermesProfile } from "./hermes-existing-profile.js";
import { hermesNativeToolEnvironment } from "./hermes-native-tools.js";
import { hermesPeerContextEnvironment, hermesPeerContextSupported } from "./hermes-peer-context.js";
import { CurrentTurnInput } from "../current-turn-input.js";
import type { InsertionOptions } from "../adapter.js";
import { hermesCommand, hermesBridgeInvocation } from "./hermes-command.js";
import { NativeFileBroker } from "../native-file-broker.js";
import { HermesCheckpoint,observeHermesSession,sameHermesSession,type HermesNativeObservation } from "./hermes-recovery.js";
import { execFile } from "node:child_process";
import { employeeDocuments } from "../employee-profiles.js";
import { PhononError } from "../rpc.js";
import { adapterDiagnostic } from "../adapter-diagnostic.js";
import { spawnSupervisedAgent, type ProcessSupervisor } from "../process-supervisor.js";
import { discoveryProbe } from "../discovery-probe.js";
import { buildChildProcessEnvironment } from "../child-env.js";
import { DatabaseSync } from "node:sqlite";
import { homedir } from "node:os";
import { join, dirname, delimiter, isAbsolute, basename } from "node:path";
import { existsSync, readFileSync, realpathSync, constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { dropToolIORowsSqlite } from "../sqlite-compress.js";
import { nativeReasoning, reportedReasoningLevels } from "../reasoning.js";
import type {
  AgentAdapter,
  AdapterSession,
  CreateSessionParams,
  SendOptions,
  EmployeeProfileTarget,EmployeeProfileObservation,
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
  reasoningControl:true,
  employeeProfiles:true,
  employeeProfileBindings:process.platform!=="win32",
  nativeSession: true, // --resume / --pass-session-id
  nativeCompression: false,
  customCompression: true,
  contextInjection: true, // 拼进下轮 prompt
  proactiveOutput: false,
  modelSwitch: true, // -m 每轮可变
  interrupt: true, // kill
  injectMidTurn: false,
  skillManagement: true, // hermes skills
  hooks: ["pre_command"],
  // Hermes' run_conversation takes a native stream_callback invoked per text
  // delta; the bridge chains onto the CLI's own callback so deltas reach us
  // without disturbing Hermes' own TTS text queue.
  streaming: true,
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

export function parseHermesReasoningLevels(help: string): ModelInfo["reasoningLevels"] {
  const block = help.match(/^[ \t]*--reasoning[^\r\n]*(?:\r?\n(?![ \t]*-)[ \t]{6,}[^\r\n]*)*/m)?.[0];
  const values = block?.match(/\b(?:low|medium|high|xhigh|max)\b/g);
  return values?.length ? reportedReasoningLevels(values) : undefined;
}

/** Use the installed console script's own interpreter; never another Python's packages. */
function bridgeCommand(bin: string): { python: string; entry: string } {
  return hermesCommand(bin);
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
  /** Local operator opt-in; grants only newly created owned employee profiles. */
  managedProfileNativeTools?: boolean;
  /** Pinned, locally prepared runtime assets; never supplied by employee RPC. */
  profileFileBrokerRoot?: string;
}

class HermesSession implements AdapterSession {
  readonly sessionId: string;
  model: string;
  private cwd: string;
  private env: HermesEnv;
  private profile: string;
  private hermesSessionId?: string;
  private profileHome?: string;
  private expectedProfileHome?: string;
  private convName: string;
  private started = false;
  private current?: ProcessSupervisor;
  private lastNative?:{turnId:string;supervisor:ProcessSupervisor};
  private pendingInject: string[] = [];
  private nativeObservation?:HermesNativeObservation;
  private employeeId?:string;
  private peerSupported = false;
  private peerNativeSession?: string;
  private readonly currentTurnInput = new CurrentTurnInput();

  async qualifyPeerContext(): Promise<void> {
    this.peerSupported = await hermesPeerContextSupported(this.env.binPath ?? "hermes");
  }
  peerContextCapability() {
    return this.peerSupported ? {mode:"context_hook",boundary:"before_model",visibility:"hidden",evidence:"provider_payload",
      budget:"native_estimate",nativeSessionId:this.peerNativeSession} as const : undefined;
  }

  constructor(sessionId: string, model: string, cwd: string, env: HermesEnv, profile: string, initialContext?: ContextItem[],profileHome?:string,recovered?:HermesCheckpoint,employee?:CreateSessionParams["employee"]) {
    this.sessionId = sessionId;
    this.model = model;
    this.cwd = cwd;
    this.env = env;
    this.profile = profile;
    this.profileHome=profileHome;this.expectedProfileHome=profileHome;
    this.employeeId=employee?.employeeId;
    this.convName = `phonon-${sessionId.replace(/[^a-zA-Z0-9_-]/g, "")}`;
    // contextInjection: 注入 initialContext（含 workflow systemPrompt）进首轮 message
    this.pendingInject.push(...formatInitialContextLines(initialContext));
    if(recovered){this.hermesSessionId=recovered.native.sessionId;this.profileHome=recovered.native.nativeHome;this.expectedProfileHome=this.profileHome;
      this.nativeObservation=recovered.native;this.pendingInject=[...recovered.pendingInject];this.started=true;}
  }

  async send(input: string, opts: SendOptions): Promise<void> {
    return this.currentTurnInput.run(opts, { enabled: this.peerSupported, capability: () => this.peerContextCapability() },
      options => this.sendNative(input, options));
  }

  insertAtToolGap(input: string, options: InsertionOptions): Promise<void> {
    return this.currentTurnInput.insert(input, options);
  }

  private async sendNative(input: string, opts: SendOptions): Promise<void> {
    const { turnId, emit } = opts;
    if(this.hermesSessionId){
      const current=await observeHermesSession(this.env.binPath??"hermes",this.profile,this.hermesSessionId,this.cwd,this.env.profileFileBrokerRoot);
      if(current.nativeHome!==this.profileHome||this.nativeObservation&&!sameHermesSession(this.nativeObservation,current))throw new PhononError("errSessionBusy","Hermes native Session changed before send");
    }
    this.nativeObservation=undefined;
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
    if (opts.reasoning?.level) args.push("--reasoning",nativeReasoning(opts.reasoning.level)!);
    // Preserve native approval policy; do not auto-elevate tools.
    // Native chat creates the first session; resume only its observed real id.
    if (this.hermesSessionId) args.push("--resume", this.hermesSessionId);
    this.started = true;

    await this.run(args, turnId, emit, opts);
  }

  private run(args: string[], turnId: string, emit: (e: StreamEvent) => void, opts: SendOptions): Promise<void> {
    this.peerNativeSession = undefined;
    return new Promise((resolve) => {
      let command: ReturnType<typeof bridgeCommand>;
      try { command = bridgeCommand(this.env.binPath ?? "hermes"); }
      catch (e) {
        emit({ type: "error", sessionId: this.sessionId, turnId, seq: 0, at: new Date().toISOString(), message: adapterDiagnostic(String(e)), status: "failed", final: true } as StreamEvent);
        resolve(); return;
      }
      const invocation=hermesBridgeInvocation(HERMES_BRIDGE,[command.entry,...args]);
      const supervisor = spawnSupervisedAgent(command.python, invocation.args, {
        cwd: this.cwd,
        env: {...buildChildProcessEnvironment(opts.environment),...hermesNativeToolEnvironment(opts),...hermesPeerContextEnvironment(opts),PHONON_REASONING_REQUEST:opts.reasoning?JSON.stringify({level:nativeReasoning(opts.reasoning.level)}):"",
          PHONON_HERMES_EXPECTED_PROFILE_HOME:this.expectedProfileHome??"",
          PHONON_HERMES_EXPECTED_SESSION:this.hermesSessionId?JSON.stringify({sessionId:this.hermesSessionId,home:this.profileHome,cwd:this.cwd}):""},
      });
      // No interactive input is required by native chat -Q -q.
      supervisor.child.stdin.end(invocation.stdin);
      const child = supervisor.child;
      this.current = supervisor;
      this.lastNative={turnId,supervisor};
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
      /** True once at least one text delta was streamed, so finish() must not re-emit the full text. */
      let streamed = false;
      const abort = (): void => { void supervisor.terminate(); finish("interrupted", out); };
      const finish = (status: "completed" | "failed" | "interrupted" | "timeout", text: string, message?: string) => {
        if (settled) return;
        settled = true;
        this.peerNativeSession = undefined;
        clearTimeout(guard);
        opts.signal?.removeEventListener("abort", abort);
        if (status === "failed") {
          emit({ type: "error", sessionId: this.sessionId, turnId, seq: 0, at: new Date().toISOString(), message: message ?? "hermes failed", status: "failed", final: true } as StreamEvent);
        } else {
          // Native structured final text: one message and one terminal.
          // When deltas were already streamed, skip the full-text message — the
          // consumer has the same content and re-emitting would duplicate it.
          if (text && !streamed) emit({ type: "message", sessionId: this.sessionId, turnId, seq: 0, at: new Date().toISOString(), role: "assistant", text, delta: false } as StreamEvent);
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
        if(ev.type==="hermes_runtime"){
          try{
            const home=typeof ev.profile_home==="string"&&isAbsolute(ev.profile_home)?realpathSync(ev.profile_home):undefined;
            this.profileHome=home&&(!this.expectedProfileHome||realpathSync(this.expectedProfileHome)===home)?home:undefined;
          }catch{this.profileHome=undefined;}
        }else if (ev.type === "hermes_peer_ready" && opts.peerContext) {
          if (typeof ev.native_session_id === "string" && ev.native_session_id.length > 0 && ev.native_session_id.length <= 512
            && (!this.hermesSessionId || this.hermesSessionId === ev.native_session_id) && !this.peerNativeSession) this.peerNativeSession = ev.native_session_id;
        }else if (ev.type === "hermes_reasoning" && opts.reasoning) {
          try { opts.acknowledgeReasoning?.(ev.native_value); }
          catch { /* Optional setting evidence must not stop the native conversation. */ }
        }else if (ev.type === "hermes_result") {
          outcome = ev;
          out = typeof ev.final_response === "string" ? ev.final_response : "";
          if (typeof ev.session_id === "string") this.hermesSessionId = ev.session_id;
        } else if (ev.type === "hermes_text_delta") {
          // Hermes' native stream_callback delta (chained in hermes-bridge).
          if (typeof ev.text !== "string" || !ev.text) return;
          streamed = true;
          emit({ ...base, type: "message", role: "assistant", text: ev.text, delta: true } as StreamEvent);
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
          try { payload = typeof m.content === "string" ? JSON.parse(m.content) : m.content; } catch { /* native text result */ }
          emit({ ...base, type: "tool_result", toolName: calls.get(id)!, toolCallId: id, ok: !(payload?.error || payload?.success === false || m.is_error || calls.get(id) === "terminal" && typeof payload?.exit_code === "number" && payload.exit_code !== 0), output: m.content } as StreamEvent);
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
        const detail = adapterDiagnostic(String(outcome?.error || err || "Native CLI returned no successful structured completion/output"),[opts.environment?.AGENT_PHONON_INTERACTION_TOKEN]);
        const finishObserved=()=>finish(success ? "completed" : "failed", out.trim(), success ? undefined : `hermes exited ${code}: ${detail}`);
        if(success&&this.hermesSessionId&&this.profileHome){
          void observeHermesSession(this.env.binPath??"hermes",this.profile,this.hermesSessionId,this.cwd,this.env.profileFileBrokerRoot).then(native=>{
            if(!settled&&native.nativeHome===this.profileHome)this.nativeObservation=native;
          }).catch(()=>{}).finally(finishObserved);
        }else finishObserved();
      });
    });
  }

  async interrupt(): Promise<void> {
    if (this.current) { const current = this.current; this.current = undefined; await current.terminate(); }
  }
  async observeNativeStop(turnId:string){return this.lastNative?.turnId===turnId&&this.lastNative.supervisor.hasStopped()?"process_tree_exit" as const:undefined;}
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
    const target=this.compressionTarget();
    if(!target)throw new PhononError("errCapabilityUnsupported","Hermes compression requires the verified native profile and Session id");
    const {dbPath,sessionId:dbSessionId}=target;
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
    this.nativeObservation=await observeHermesSession(this.env.binPath??"hermes",this.profile,dbSessionId,this.cwd,this.env.profileFileBrokerRoot).catch(()=>undefined);
    return { summary: `dropToolIO trimmed ${r.blocksRemoved} tool rows from Hermes session ${dbSessionId}`, ...r };
  }

  private compressionTarget():{dbPath:string;sessionId:string}|undefined{
    if(!this.started||!this.profileHome||!this.hermesSessionId)return;
    const dbPath=join(this.profileHome,"state.db");if(!existsSync(dbPath))return;
    try{
      const db=new DatabaseSync(dbPath,{readOnly:true});
      try{if(db.prepare("SELECT 1 FROM sessions WHERE id=?").get(this.hermesSessionId))return {dbPath,sessionId:this.hermesSessionId};}finally{db.close();}
    }catch{return;}
  }
  compressionModes(){return {native:false,custom:!!this.compressionTarget()};}
  recoveryCheckpoint():HermesCheckpoint|undefined{
    if(!this.nativeObservation||this.lastNative&&!this.lastNative.supervisor.hasStopped())return;
    return {phononSessionId:this.sessionId,model:this.model,native:this.nativeObservation,pendingInject:[...this.pendingInject],...(this.employeeId?{employeeId:this.employeeId}:{})};
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
  readonly capabilities:AgentCapabilities;
  private env: HermesEnv;
  private defaultProfile: string;
  private modelCatalog?: { key: string; models: ModelInfo[] };

  constructor(opts: { env?: HermesEnv; defaultProfile?: string } = {}) {
    this.env = opts.env ?? {};
    if(this.env.profileFileBrokerRoot!==undefined&&(!isAbsolute(this.env.profileFileBrokerRoot)||this.env.profileFileBrokerRoot.includes("\0")))throw new PhononError("errInvalidParams","profileFileBrokerRoot must be an absolute local runtime path");
    this.capabilities={...CAPABILITIES,employeeProfiles:process.platform!=="win32"};
    if(this.env.managedProfileNativeTools!==undefined&&typeof this.env.managedProfileNativeTools!=="boolean")throw new PhononError("errInvalidParams","managedProfileNativeTools must be a boolean");
    this.defaultProfile = opts.defaultProfile ?? "default";
  }

  async discoverAgents(signal?: AbortSignal): Promise<AgentDescriptor[]> {
    const version = await this.probeVersion(signal);
    const available = version !== null;
    this.capabilities.injectMidTurn = available && await hermesPeerContextSupported(this.env.binPath ?? "hermes", { signal });
    if(available&&process.platform==="win32"){
      try{await this.windowsProfileRuntime();}catch{signal?.throwIfAborted();}
    }
    if (!available) {
      return [{
        agentId: "hermes" as AgentDescriptor["agentId"],
        displayName: "Hermes",
        adapter: "hermes",
        available: false,
        unavailableReason: "hermes CLI not found",
        models: [],
        capabilities: this.capabilities,
        scannedAt: new Date().toISOString(),
      }];
    }
    // 枚举所有 profile = 多个 agent（D32，同 OpenClaw）
    const profiles = await this.listProfiles(signal);
    const reasoningHelp = await discoveryProbe(this.env.binPath ?? "hermes",["chat","--help"],signal);
    const reasoningLevels = reasoningHelp ? parseHermesReasoningLevels(reasoningHelp) : undefined;
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
      models: this.modelsForProfile(p.model, [...catalogModels, ...providerFallbackModels], cfg.defaultModel).map(model=>({...model,...(model.reasoningLevels===undefined&&reasoningLevels?{reasoningLevels:[...reasoningLevels]}:{})})),
      capabilities: this.capabilities,
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
    if(params.reattach)throw new PhononError("errSessionBusy","Hermes recovery requires a verified native checkpoint");
    // 从复合 agentId 解出 profile：hermes:default → default
    const profile = params.employee?.runtimeProfile??(params.agentId.includes(":") ? params.agentId.split(":")[1]! : this.defaultProfile);
    const model = params.model && params.model !== "default" ? params.model : (this.env.defaultModel ?? "");
    const session = new HermesSession(params.sessionId, model, params.cwd, this.env, profile, params.initialContext,params.employee?.home,undefined,params.employee);
    await session.qualifyPeerContext();
    this.capabilities.injectMidTurn = !!session.peerContextCapability();
    return session;
  }
  async recoverSession(params:CreateSessionParams,checkpoint:Record<string,unknown>):Promise<AdapterSession>{
    const saved=HermesCheckpoint.safeParse(checkpoint);
    if(!saved.success)throw new PhononError("errSessionBusy","Hermes native recovery checkpoint is invalid");
    const profile=params.employee?.runtimeProfile??(params.agentId.includes(":")?params.agentId.split(":")[1]!:this.defaultProfile);
    const model=params.model&&params.model!=="default"?params.model:(this.env.defaultModel??"");
    if(saved.data.phononSessionId!==params.sessionId||saved.data.model!==model||saved.data.native.profile!==profile||saved.data.employeeId!==params.employee?.employeeId||params.employee&&realpathSync(params.employee.home)!==saved.data.native.nativeHome)throw new PhononError("errSessionBusy","Hermes employee recovery identity changed");
    const current=await observeHermesSession(this.env.binPath??"hermes",profile,saved.data.native.sessionId,params.cwd,this.env.profileFileBrokerRoot);
    if(!sameHermesSession(saved.data.native,current))throw new PhononError("errSessionBusy","Hermes native recovery identity changed");
    const session = new HermesSession(params.sessionId,model,params.cwd,this.env,profile,undefined,current.nativeHome,{...saved.data,native:current},params.employee);
    await session.qualifyPeerContext();
    this.capabilities.injectMidTurn = !!session.peerContextCapability();
    return session;
  }
  provisionEmployee(target:EmployeeProfileTarget){return this.employeeOperation("apply",target);}
  inspectEmployee(target:EmployeeProfileTarget){return this.employeeOperation("inspect",target);}
  async inspectHarnessProfile(agent:string){
    if(!agent.startsWith("hermes:"))throw new PhononError("employee_profile_source_unavailable");
    const runtimeProfile=agent.slice("hermes:".length);
    return {...await inspectExistingHermesProfile(this.env.binPath??"hermes",runtimeProfile),runtimeProfile};
  }
  private async windowsProfileRuntime():Promise<string>{
    this.capabilities.employeeProfiles=false;
    if(!this.env.profileFileBrokerRoot)throw new PhononError("employee_profile_platform_unsupported","Windows profiles require prepared native file runtime assets");
    const executable=await new NativeFileBroker(this.env.profileFileBrokerRoot).verifiedExecutable();
    this.capabilities.employeeProfiles=true;return executable;
  }
  private async verifyManagedToolOwner(target:EmployeeProfileTarget):Promise<void>{
    if(!/^phn-[a-f0-9]{40}$/.test(target.runtimeProfile)||!isAbsolute(target.workspace)||basename(target.workspace)!==target.input.employeeId||typeof process.getuid!=="function")throw new PhononError("employee_profile_owner_conflict");
    const directory=await lstat(target.workspace);
    if(!directory.isDirectory()||directory.isSymbolicLink()||await realpath(target.workspace)!==target.workspace||directory.uid!==process.getuid()||(directory.mode&0o022)!==0)throw new PhononError("employee_profile_owner_conflict");
    const marker=await open(join(target.workspace,".phonon-employee"),constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
    try{const stat=await marker.stat();if(!stat.isFile()||stat.nlink!==1||stat.uid!==process.getuid()||(stat.mode&0o022)!==0||stat.size>256||await marker.readFile("utf8")!==target.nonce)throw new PhononError("employee_profile_owner_conflict");}finally{await marker.close();}
  }
  private async employeeOperation(operation:string,target:EmployeeProfileTarget):Promise<EmployeeProfileObservation>{
    const managedProfileNativeTools=this.env.managedProfileNativeTools===true&&operation==="apply"&&!target.previousHashes;
    if(managedProfileNativeTools&&process.platform!=="win32")await this.verifyManagedToolOwner(target);
    const command=hermesCommand(this.env.binPath??"hermes");
    let broker:string|undefined;
    if(process.platform==="win32")broker=await this.windowsProfileRuntime();
    return new Promise((resolve,reject)=>{
      const payload=JSON.stringify({operation,employeeId:target.input.employeeId,nonce:target.nonce,runtimeProfile:target.runtimeProfile,
        base:target.input.agent.includes(":")?target.input.agent.split(":")[1]:this.defaultProfile,model:target.input.model,provider:this.env.provider,documents:employeeDocuments(target.input),previousHashes:target.previousHashes,previousIdentity:target.previousNativeIdentity,managedProfileNativeTools,workspace:target.workspace,workspaceIdentity:target.workspaceIdentity});
      const invocation=hermesBridgeInvocation(HERMES_PROFILE_BRIDGE,[command.entry,...(broker?[broker]:[])],payload);
      const child=execFile(command.python,invocation.args,{timeout:20000,maxBuffer:1048576,env:process.env},(error,stdout)=>{
        if(error){reject(new PhononError("employee_profile_native_failure","Hermes profile operation failed"));return;}
        try{const reply=JSON.parse(stdout);if(!reply.ok)throw new PhononError(String(reply.error),"Hermes profile operation refused");resolve(reply.result);}catch(error){reject(error);}
      });
      child.stdin?.end(invocation.stdin);
    });
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
    // The installed --version performs a synchronous remote update check on a cold home.
    // Read the same installed package version without starting that network operation.
    try{
      const command=hermesCommand(this.env.binPath??"hermes");
      const version=await discoveryProbe(command.python,["-c","import hermes_cli; print('Hermes Agent v' + hermes_cli.__version__)"],signal);
      if(version)return version.split("\n")[0]??null;
    }catch{signal?.throwIfAborted();}
    return (await discoveryProbe(this.env.binPath ?? "hermes", ["--version"], signal))?.split("\n")[0] ?? null;
  }
}
