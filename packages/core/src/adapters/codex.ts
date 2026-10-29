import { adapterDiagnostic } from "../adapter-diagnostic.js";
import { spawnSupervisedAgent, type ProcessSupervisor } from "../process-supervisor.js";
import { discoveryProbe } from "../discovery-probe.js";
import { buildChildProcessEnvironment } from "../child-env.js";
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, readdirSync, statSync, lstatSync, realpathSync, constants, readFileSync,openSync,readSync,closeSync,fstatSync } from "node:fs";
import { z } from "zod";
import { parse as parseToml } from "smol-toml";
import { dropToolIOFromJsonlFiles } from "../custom-compress.js";
import { nativeReasoning, reportedReasoningLevels } from "../reasoning.js";
import { PhononError } from "../rpc.js";
import {codexNativeToolArgs} from "./codex-native-tools.js";
import {codexTerminalInput} from "./codex-terminal-guidance.js";
import {readCodexContext,resolveCodexContextFile} from "./codex-context.js";
import { CodexPeerContext, qualifyCodexPeerContext, stopCodexPeerProcess } from "./codex-peer-context.js";
import { discoverCodexNativeModels } from "./codex-models.js";
import { CodexAppServer, type CodexNativeFrame } from "./codex-app-server.js";
import { CodexNativeRequests } from "./codex-native-requests.js";
import type {
  AgentAdapter,
  AdapterSession,
  CreateSessionParams,
  InsertionOptions,
  SendOptions,
} from "../adapter.js";
import { formatInitialContextLines } from "../adapter.js";
import type { AgentCapabilities, AgentDescriptor, StreamEvent, ContextItem, ModelInfo } from "@agent-phonon/protocol";

/**
 * Codex adapter（design D10，单 agent runtime）。
 *
 * 调用（详见 docs/agent-cli-integration.md）：
 *   codex exec - --json -c model_provider=<id> -c model_providers.<id>.base_url=...
 *     -c model_providers.<id>.wire_api=responses --model X
 *   prompt 走 stdin（argv 用 "-"）；resume：codex exec resume <thread_id> - --json ...
 *
 * 网关由调用方通过 CodexEnv 传入（baseUrl/apiKey/wireApi），adapter 不绑定任何特定网关；
 * 用 -c 临时覆盖 provider（不动用户的 ~/.codex/config.toml）。
 */

const CODEX_FALLBACK_MODELS: ModelInfo[] = [
  { id: "gpt-5.5", available: true },
  { id: "gpt-5.4", available: true },
  { id: "gpt-5.3-codex", available: true },
];

const CAPABILITIES: AgentCapabilities = {
  reasoningControl:true,
  nativeSession: true, // exec resume <thread_id>
  nativeCompression: false,
  customCompression: true,
  contextInjection: true, // 拼进下轮 prompt
  proactiveOutput: false,
  modelSwitch: true,
  interrupt: true, // kill
  injectMidTurn: false,
  skillManagement: false,
  hooks: ["pre_command"],
  streaming: true, // --json 事件流
  // Executor routing is parsed from the assistant's text output
  // (parseRoutingDirectives), so any adapter that returns text can drive a graph.
  // The previous ["worker"] declaration was advisory-only metadata that misled
  // orchestrators into excluding codex from executor roles.
  workflowRoles: ["executor", "worker"],
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
      try { st = lstatSync(full); } catch { continue; }
      if (st.isDirectory()) walk(full);
      else if (st.isFile() && name.endsWith(`-${threadId}.jsonl`)) hits.push({ path: full, mtime: st.mtimeMs });
    }
  };
  walk(root);
  if (hits.length === 0) return undefined;
  hits.sort((a, b) => b.mtime - a.mtime);
  return hits[0]!.path;
}

function parseCodexConfig(configPath = join(homedir(), ".codex", "config.toml")): { model?: string; providerId?: string; baseUrl?: string } {
  if (!existsSync(configPath)) return {};
  try {
    if (statSync(configPath).size > 2_000_000) return {};
    const config = parseToml(readFileSync(configPath, "utf8"));
    const model = typeof config.model === "string" ? config.model : undefined;
    const providerId = typeof config.model_provider === "string" ? config.model_provider : undefined;
    const providers = config.model_providers as Record<string, unknown> | undefined;
    const provider = providerId ? providers?.[providerId] as Record<string, unknown> | undefined : undefined;
    const baseUrl = typeof provider?.base_url === "string" ? provider.base_url : undefined;
    return { ...(model ? { model } : {}), ...(providerId ? { providerId } : {}), ...(baseUrl ? { baseUrl } : {}) };
  } catch { return {}; }
}

function normalizeOpenAiModels(data: unknown): ModelInfo[] {
  if (!Array.isArray(data) && (!data || !Array.isArray((data as { data?: unknown }).data))) throw new Error("invalid model inventory");
  const rows = Array.isArray((data as { data?: unknown }).data)
    ? (data as { data: unknown[] }).data
    : (Array.isArray(data) ? data as unknown[] : []);
  const out: ModelInfo[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const obj = row as Record<string, unknown>;
    const id = typeof obj.id === "string" ? obj.id : undefined;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const levels=reportedReasoningLevels(obj.supported_reasoning_levels ?? obj.reasoning_levels);
    out.push({ id, ...(typeof obj.name === "string" ? { displayName: obj.name } : {}), ...(levels?{reasoningLevels:levels}:{}), available: true });
  }
  return out;
}

function fetchJson(url: string, headers?: Record<string, string>, signal?: AbortSignal): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = (u.protocol === "http:" ? import("node:http") : import("node:https"))
      .then((mod) => mod.request(url, { method: "GET", headers, timeout: 5000, signal }, (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("error", reject);
        res.on("data", (d) => {
          body += d;
          if (body.length > 2_000_000) res.destroy(new Error("inventory response too large"));
        });
        res.on("end", () => {
          if ((res.statusCode ?? 500) < 200 || (res.statusCode ?? 500) >= 300) {
            reject(new Error(`GET ${url} failed: ${res.statusCode}`));
            return;
          }
          try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
        });
      }));
    req.then((r) => {
      r.on("timeout", () => r.destroy(new Error(`GET ${url} timeout`)));
      r.on("error", reject);
      r.end();
    }, reject);
  });
}

export interface CodexEnv {
  /** Explicit native storage root; also passed as CODEX_HOME to the child. */
  codexHome?: string;
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

function codexProviderArgs(env: CodexEnv): string[] {
  if (!env.baseUrl || !env.apiKey) return [];
  const id = env.providerId ?? "phonon_gateway", name = env.providerName ?? "phonon-gateway";
  return ["-c", `model_provider=${id}`, "-c", `model_providers.${id}.name=${name}`,
    "-c", `model_providers.${id}.base_url=${env.baseUrl}`, "-c", `model_providers.${id}.wire_api=${env.wireApi ?? "responses"}`,
    "-c", `model_providers.${id}.env_key=OPENAI_API_KEY`];
}

function codexNativeEnvironment(env: CodexEnv, overlay?: Record<string, string>): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...buildChildProcessEnvironment(overlay), ...(env.codexHome ? { CODEX_HOME: env.codexHome } : {}), ...(env.apiKey ? { OPENAI_API_KEY: env.apiKey } : {}) };
  for (const key of ["AGENT_PHONON_PEER_CONTEXT_URL", "AGENT_PHONON_PEER_CONTEXT_TOKEN", "AGENT_PHONON_CODEX_PEER_URL", "AGENT_PHONON_CODEX_PEER_TOKEN"]) delete environment[key];
  return environment;
}

class CodexSession implements AdapterSession {
  readonly sessionId: string;
  model: string;
  private cwd: string;
  private env: CodexEnv;
  private threadId?: string; // Codex thread_id（= 会话），从 thread.started 抓
  private contextNotBefore?: number;
  private current?: ProcessSupervisor;
  private lastNative?:{turnId:string;supervisor:ProcessSupervisor};
  private pendingInject: string[] = [];
  private nativeToolCalls = new Set<string>();
  private nativeToolResults = new Set<string>();
  private peerSupported = false;
  private peerAbort?: AbortController;
  private appServer?: CodexAppServer;
  async preparePeerContext(environment?: Record<string,string>, signal?: AbortSignal): Promise<void> {
    if (this.current && !this.current.hasStopped()) throw new PhononError("errSessionBusy","Codex peer readiness cannot replace an active native runtime");
    this.peerSupported = false;
    try {
      this.peerSupported = await qualifyCodexPeerContext(this.env.binPath??"codex",{cwd:this.cwd,env:this.nativeEnvironment(environment),signal,
        onRuntime:runtime=>{this.current=runtime;}});
    } finally { if (this.current?.hasStopped()) this.current=undefined; }
  }
  peerContextCapability() {
    return this.peerSupported ? {mode:"context_hook",boundary:"after_tools",visibility:"collapsed",evidence:"context_hook",budget:"native_estimate",nativeSessionId:this.threadId} as const : undefined;
  }

  constructor(sessionId: string, model: string, cwd: string, env: CodexEnv, initialContext?: ContextItem[], recovered?: {threadId:string;pendingInject:string[];contextNotBefore?:number}, private readonly nativeSteering = false) {
    this.sessionId = sessionId;
    this.model = model;
    this.cwd = cwd;
    this.env = env;
    this.threadId = recovered?.threadId;
    this.contextNotBefore = recovered?.contextNotBefore;
    if (recovered) this.pendingInject.push(...recovered.pendingInject);
    // contextInjection: 注入 initialContext（含 workflow systemPrompt）进首轮 message
    this.pendingInject.push(...formatInitialContextLines(initialContext));
  }

  private providerArgs(): string[] {
    return codexProviderArgs(this.env);
  }

  async send(input: string, opts: SendOptions): Promise<void> {
    this.contextNotBefore=Date.now();
    const { turnId, emit } = opts;
    const nativeTools = codexNativeToolArgs(opts);
    this.nativeToolCalls.clear();this.nativeToolResults.clear();
    let prompt = codexTerminalInput(input,this.env.binPath);
    if (this.pendingInject.length > 0) {
      prompt = this.pendingInject.join("\n") + "\n\n" + prompt;
      this.pendingInject = [];
    }
    if (opts.skills && opts.skills.length > 0) {
      prompt = `[本轮请使用这些能力: ${opts.skills.join(", ")}]\n\n${prompt}`;
    }

    const args = this.threadId
      ? ["exec", "resume", this.threadId, "-", "--json", ...this.providerArgs(), ...(this.model !== "default" ? ["--model", this.model] : [])]
      : ["exec", "-", "--json", ...this.providerArgs(), ...(this.model !== "default" ? ["--model", this.model] : [])];
    // exec defaults to read-only; -c also works for resume, which has no --sandbox option.
    args.push("-c", 'sandbox_mode="workspace-write"');
    // Phonon authorizes the working directory; ordinary chats need no Git repo.
    args.push("--skip-git-repo-check");
    if(opts.reasoning?.level)args.push("-c",`model_reasoning_effort=${nativeReasoning(opts.reasoning.level)}`);
    args.push(...nativeTools);

    let peer: CodexPeerContext | undefined;
    const abort = new AbortController(); this.peerAbort = abort;
    const options = {...opts,signal:opts.signal?AbortSignal.any([opts.signal,abort.signal]):abort.signal};
    try {
      if (opts.peerContext && this.peerSupported) {
        peer = new CodexPeerContext({access:opts.peerContext,cwd:this.cwd,prompt,nativeThread:this.threadId,signal:options.signal,
          context:{home:this.env.codexHome??this.nativeEnvironment(options.environment).CODEX_HOME??join(homedir(),".codex"),model:this.model,notBefore:this.contextNotBefore!},
          onRuntime:runtime=>{this.current=runtime;}});
        try {
          await peer.listen();
          args.push(...await peer.nativeArguments(this.env.binPath??"codex",this.nativeEnvironment(options.environment)));
        } catch {
          await peer.close(); peer=undefined;
          // An optional receiver failure must not restart or replace the assigned task.
          console.warn("[codex] coordination.receiver_unavailable; retaining native task and policy");
        } finally { if (this.current?.hasStopped()) this.current=undefined; }
      }
      if (options.signal.aborted) {
        emit({type:"result",sessionId:this.sessionId,turnId,seq:0,at:new Date().toISOString(),text:"",status:"interrupted",final:true} as StreamEvent);
        return;
      }
      if (this.nativeSteering) await this.runAppServer(prompt, options);
      else await this.run(args,prompt,turnId,emit,options,peer);
    } finally {
      peer?.deactivate();
      if (this.lastNative?.turnId===turnId) await stopCodexPeerProcess(this.lastNative.supervisor);
      await peer?.close();
      if (this.peerAbort===abort) this.peerAbort=undefined;
    }
  }

  private nativeEnvironment(overlay?: Record<string,string>): NodeJS.ProcessEnv {
    return codexNativeEnvironment(this.env, overlay);
  }

  insertAtToolGap(input: string, options: InsertionOptions): Promise<void> {
    if (!this.appServer) return Promise.reject(new PhononError("errCapabilityUnsupported", "Native Codex steering is unavailable on this invocation"));
    return this.appServer.insert(input, options);
  }

  private async runAppServer(prompt: string, opts: SendOptions): Promise<void> {
    const tools = new CodexNativeRequests(opts);
    opts.beforeNativeEffect?.();
    const args = [...this.providerArgs(), "-c", 'sandbox_mode="workspace-write"', ...codexNativeToolArgs(opts)];
    if (opts.reasoning?.level) args.push("-c", `model_reasoning_effort=${nativeReasoning(opts.reasoning.level)}`);
    const environment = this.nativeEnvironment(opts.environment);
    let resolve!: (value: { status: "completed" | "failed" | "interrupted" | "timeout"; message?: string }) => void;
    let settled = false, finalMessage = "", acc = "", stderr = "", nativeEffort: string | undefined;
    let timedOut = false;
    const done = new Promise<{ status: "completed" | "failed" | "interrupted" | "timeout"; message?: string }>(yes => { resolve = yes; });
    const finish = (value: Parameters<typeof resolve>[0]) => { if (!settled) { settled = true; resolve(value); } };
    const observe = (frame: CodexNativeFrame) => {
      tools.observe(frame);
      if (frame.method === "turn/completed") {
        const status = frame.params.turn?.status;
        finish(status === "completed" && finalMessage.trim() ? { status: "completed" }
          : status === "interrupted" ? { status: "interrupted" }
          : { status: "failed", message: String(frame.params.turn?.error?.message ?? "Codex returned no successful final reply") });
        return;
      }
      if (!["item/started", "item/completed"].includes(frame.method)) return;
      const item = frame.params.item;
      if (!item || typeof item.id !== "string") return;
      let normalized: Record<string, unknown> | undefined;
      if (item.type === "agentMessage") normalized = { type: "agent_message", id: item.id, text: item.text };
      else if (item.type === "commandExecution") normalized = { type: "command_execution", id: item.id, command: item.command,
        aggregated_output: item.aggregatedOutput, exit_code: item.exitCode,
        status: item.status === "declined" ? "failed" : item.status };
      else if (item.type === "mcpToolCall") normalized = { ...item, type: "mcp_tool_call" };
      else if (item.type === "dynamicToolCall") normalized = { type: "mcp_tool_call", id: item.id, server: "phonon_current_turn", tool: item.tool,
        arguments: item.arguments, status: item.status,
        ...(Array.isArray(item.contentItems) && typeof item.success === "boolean" ? { result: {
          isError: !item.success, content: item.contentItems.map((part: any) => part.type === "inputText" ? { type: "text", text: part.text } : part),
        } } : {}) };
      if (normalized) this.handleEvent({ type: frame.method === "item/started" ? "item.started" : "item.completed", item: normalized },
        opts.turnId, opts.emit, text => { acc += text; finalMessage = text; });
    };
    const channel = new CodexAppServer({ bin: this.env.binPath ?? "codex", args, cwd: this.cwd, env: environment, signal: opts.signal,
      onRuntime: runtime => { this.current = runtime; this.lastNative = { turnId: opts.turnId, supervisor: runtime }; },
      notify: observe, request: (frame, signal) => tools.request(frame, signal), stderr: text => { stderr = (stderr + text).slice(-16000); },
      failed: error => finish({ status: opts.signal?.aborted ? "interrupted" : "failed", message: error.message }),
    });
    this.appServer = channel;
    const guard = setTimeout(() => { timedOut = true; finish({ status: "timeout" }); void channel.close(); }, 1800000);
    let outcome: Awaited<typeof done>;
    try {
      await channel.initialize();
      const model = this.model === "default" ? {} : { model: this.model };
      const resumed = this.threadId;
      const reply = await channel.rpc(resumed ? "thread/resume" : "thread/start", {
        ...model, cwd: this.cwd, ...(resumed ? { threadId: resumed, excludeTurns: true } : { historyMode: "legacy" }),
      }, opts.beforeNativeEffect);
      this.threadId = channel.bindThread(reply?.thread, resumed);
      nativeEffort = typeof reply?.reasoningEffort === "string" ? reply.reasoningEffort : undefined;
      const clientUserMessageId = channel.arm(opts.turnId, prompt);
      const started = await channel.rpc("turn/start", { threadId: this.threadId, clientUserMessageId, input: [{ type: "text", text: prompt }] }, opts.beforeNativeEffect);
      if (!settled) channel.acceptStart(started);
      outcome = await done;
    } catch (error) {
      finish({ status: timedOut ? "timeout" : opts.signal?.aborted ? "interrupted" : "failed", message: String(error) });
      outcome = await done;
    } finally {
      clearTimeout(guard);
      await channel.close();
      if (this.appServer === channel) this.appServer = undefined;
      if (this.current === channel.runtime) this.current = undefined;
    }
    const base = { sessionId: this.sessionId, turnId: opts.turnId, seq: 0, at: new Date().toISOString(), final: true };
    if (outcome.status === "failed") opts.emit({ ...base, type: "error", status: "failed", message: adapterDiagnostic([outcome.message, stderr].filter(Boolean).join(": ") || "Codex native execution failed",
      [this.env.apiKey, opts.environment?.AGENT_PHONON_INTERACTION_TOKEN]) } as StreamEvent);
    else {
      if (outcome.status === "completed" && opts.reasoning && nativeEffort !== undefined) {
        try { opts.acknowledgeReasoning?.(nativeEffort); } catch { /* Optional evidence never overrides native completion. */ }
      }
      opts.emit({ ...base, type: "result", status: outcome.status, text: outcome.status === "completed" ? finalMessage : acc } as StreamEvent);
    }
  }

  private run(args: string[], stdin: string, turnId: string, emit: (e: StreamEvent) => void, opts: SendOptions, peer?: CodexPeerContext): Promise<void> {
    const startedAt=Date.now();
    const prior=this.threadId?resolveCodexSessionFile(this.threadId,this.env.codexHome):undefined;
    const offset=prior?statSync(prior).size:0;
    const peerEnvironment = peer?.environment();
    return new Promise((resolve) => {
      const supervisor = spawnSupervisedAgent(this.env.binPath ?? "codex", args, {
        cwd: this.cwd,
        env: this.nativeEnvironment(opts.environment),
      });
      const child = supervisor.child;
      this.current = supervisor;
      this.lastNative={turnId,supervisor};
      const releaseCurrent = (): void => { if (this.current === supervisor) this.current = undefined; };
      child.once("close", releaseCurrent);
      child.once("error", releaseCurrent);
      let buf = "";
      let acc = "";
      let finalMessage = "";
      let stderr = "";
      let nativeError = "";
      let sawCompletion = false;
      child.stderr.on("data", (d) => { stderr = (stderr + String(d)).slice(-16000); });
      let settled = false;
      const abort = (): void => { void supervisor.terminate(); finish("interrupted", acc); };
      const finish = (status: "completed" | "failed" | "interrupted" | "timeout", text: string, message?: string) => {
        if (settled) return;
        settled = true;
        peer?.deactivate();
        clearTimeout(guard);
        opts.signal?.removeEventListener("abort", abort);
        if (status === "failed") {
          emit({ type: "error", sessionId: this.sessionId, turnId, seq: 0, at: new Date().toISOString(), message: message ?? "codex failed", status: "failed", final: true } as StreamEvent);
        } else {
          emit({ type: "result", sessionId: this.sessionId, turnId, seq: 0, at: new Date().toISOString(), text, status, final: true } as StreamEvent);
        }
        resolve();
      };
      const guard = setTimeout(() => { void supervisor.terminate(); finish("timeout", acc); }, 1800000);
      if (opts.signal?.aborted) abort();
      else opts.signal?.addEventListener("abort", abort, { once: true });

      const consume = (line: string): void => {
        if (settled || !line.trim()) return;
        let ev: Record<string, unknown>;
        try { ev = JSON.parse(line); } catch { return; }
        if (ev.type === "thread.started" && this.threadId && ev.thread_id !== this.threadId) {
          void supervisor.terminate();
          finish("failed", "", "Codex resumed a different native Session");
          return;
        }
        if (peer && ev.type === "thread.started") {
          try { peer.bindNativeThread(String(ev.thread_id)); }
          catch { void supervisor.terminate();finish("failed","","Codex native peer identity was not confirmed");return; }
        }
        if (ev.type === "turn.completed" || ev.type === "turn.failed") peer?.deactivate();
        if (ev.type === "turn.failed" || ev.type === "error") {
          nativeError = String((ev.error as { message?: string } | undefined)?.message ?? ev.message ?? "Codex turn failed");
        }
        if (ev.type === "turn.completed") { sawCompletion = true; nativeError = ""; }
        this.handleEvent(ev, turnId, emit, (text) => {
          acc += text;
          // Completed items contain whole messages. Like the native SDK, use
          // the last one for the result; earlier commentary remains streamed.
          finalMessage = text;
        });
      };
      child.stdout.on("data", (d) => {
        buf += d.toString();
        let nl;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl); buf = buf.slice(nl + 1); consume(line);
        }
      });
      child.on("error", (e) => finish("failed", "", e.message));
      child.on("close", (code) => {
        if (settled) return;
        consume(buf);
        if(opts.reasoning && code===0 && sawCompletion && !opts.signal?.aborted){
          try{
            const file=this.threadId?resolveCodexSessionFile(this.threadId,this.env.codexHome):undefined;
            if(!file)throw new PhononError("errReasoningUnconfirmed");
            const fd=openSync(file,"r");let bytes:Buffer;
            try{
              const start=file===prior?offset:0,size=fstatSync(fd).size-start;
              if(size<1||size>2000000)throw new PhononError("errReasoningUnconfirmed");
              bytes=Buffer.alloc(size);let read=0;
              while(read<size){const count=readSync(fd,bytes,read,size-read,start+read);if(!count)throw new PhononError("errReasoningUnconfirmed");read+=count;}
            }finally{closeSync(fd);}
            const contexts=bytes.toString("utf8").split("\n").flatMap(line=>{try{const row=JSON.parse(line);return row.type==="turn_context"&&Date.parse(row.timestamp)>=startedAt&&(this.model==="default"||row.payload?.model===this.model)?[row.payload]:[];}catch{return [];}});
            const context=contexts.at(-1);
            if(!context||typeof context.effort!=="string")throw new PhononError("errReasoningUnconfirmed");
            opts.acknowledgeReasoning?.(context.effort);
          }catch{ /* Preserve the actual execution outcome; optional setting stays unconfirmed. */ }
        }
        const failed = code !== 0 || !!nativeError || !sawCompletion || !finalMessage.trim();
        const detail = adapterDiagnostic(nativeError || stderr || "native CLI returned no completion or output", [this.env.apiKey,opts.environment?.AGENT_PHONON_INTERACTION_TOKEN,peerEnvironment?.AGENT_PHONON_CODEX_PEER_TOKEN]);
        finish(failed ? "failed" : "completed", failed ? acc : finalMessage, failed ? `codex exited ${code}: ${detail}` : undefined);
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
    } else if (type === "item.started" || type === "item.completed") {
      const item = ev.item as Record<string,unknown> | undefined;
      if (item?.type === "mcp_tool_call" && typeof item.id === "string" && typeof item.tool === "string") {
        const key = turnId + ":" + item.id, toolName = typeof item.server === "string" ? item.server + ":" + item.tool : item.tool;
        const base = {sessionId:this.sessionId,turnId,seq:0,at:now,toolName,toolCallId:item.id};
        if (!this.nativeToolCalls.has(key)) {
          this.nativeToolCalls.add(key);
          emit({...base,type:"tool_call",...(item.arguments !== undefined ? {args:item.arguments} : {})} as StreamEvent);
        }
        if (type === "item.completed" && !this.nativeToolResults.has(key) && (item.result !== undefined || item.error !== undefined)) {
          this.nativeToolResults.add(key);
          const failed = item.status === "failed" || item.error != null || (item.result as {isError?:unknown}|undefined)?.isError === true;
          emit({...base,type:"tool_result",ok:!failed,output:item.error ?? item.result} as StreamEvent);
        }
        return;
      }
      if (item?.type === "command_execution" && typeof item.command === "string") {
        const id = typeof item.id === "string" && item.id.length > 0 && item.id.length <= 512 ? item.id : undefined;
        // Older CLI frames without native IDs remain unpaired observations.
        if (!id) {
          if (type === "item.completed") emit({type:"tool_call",sessionId:this.sessionId,turnId,seq:0,at:now,toolName:"command_execution",args:{command:item.command}} as StreamEvent);
          return;
        }
        const key = turnId + ":command:" + id;
        const base = {sessionId:this.sessionId,turnId,seq:0,at:now,toolName:"command_execution",toolCallId:id};
        if (!this.nativeToolCalls.has(key)) {
          this.nativeToolCalls.add(key);
          emit({...base,type:"tool_call",args:{command:item.command}} as StreamEvent);
        }
        const exitKnown = typeof item.exit_code === "number" && Number.isInteger(item.exit_code);
        const statusKnown = item.status === undefined || item.status === "completed" || item.status === "failed";
        if (type === "item.completed" && !this.nativeToolResults.has(key) && statusKnown && (exitKnown || item.status === "failed")) {
          this.nativeToolResults.add(key);
          emit({...base,type:"tool_result",ok:item.status !== "failed" && item.exit_code === 0,
            output:{command:item.command,...(typeof item.aggregated_output === "string" ? {output:item.aggregated_output} : {}),
              ...(exitKnown ? {exitCode:item.exit_code} : {}),...(typeof item.status === "string" ? {status:item.status} : {})}} as StreamEvent);
        }
        return;
      }
      if (type !== "item.completed") return;
      if (item?.type === "agent_message" && typeof item.text === "string") {
        addText(item.text);
        emit({ type: "message", sessionId: this.sessionId, turnId, seq: 0, at: now, role: "assistant", text: item.text, delta: true } as StreamEvent);
      }
    }
    // turn.completed 由 close 收尾
  }

  async interrupt(): Promise<void> {
    this.peerAbort?.abort();
    if (this.current) { const current = this.current; this.current = undefined; await current.terminate(); }
  }
  async observeNativeStop(turnId:string){return this.lastNative?.turnId===turnId&&this.lastNative.supervisor.hasStopped()?"process_tree_exit" as const:undefined;}
  async switchModel(model: string): Promise<{ warnings?: string[] }> { this.model = model;this.contextNotBefore=Date.now();return {}; }
  async describe() {
    const threadID=this.threadId,model=this.model,notBefore=this.contextNotBefore,home=this.env.codexHome??join(homedir(),".codex");
    const file=threadID?await resolveCodexContextFile(home,threadID):undefined;
    const value=file&&threadID?await readCodexContext(file,{home,cwd:this.cwd,threadID,model,notBefore}):{};
    return this.threadId===threadID&&this.model===model&&this.contextNotBefore===notBefore?value:{};
  }
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
    const file = resolveCodexSessionFile(this.threadId,this.env.codexHome);
    if (!file) throw new Error(`Codex rollout file not found for thread ${this.threadId}`);
    const r = await dropToolIOFromJsonlFiles([file], {...options,invalidateCodexTokenUsage:true});
    return { summary: `dropToolIO removed ${r.blocksRemoved} tool records from Codex rollout`, ...r };
  }

  recoveryCheckpoint() { return this.threadId ? {threadId:this.threadId, nativeHome:realpathSync(this.env.codexHome ?? join(homedir(),".codex")), pendingInject:[...this.pendingInject],...(this.contextNotBefore!==undefined?{contextNotBefore:this.contextNotBefore}:{})} : undefined; }
  compressionModes(){return {native:false,custom:!this.current&&!!this.threadId&&!!resolveCodexSessionFile(this.threadId,this.env.codexHome)};}
  async terminate(): Promise<void> { await this.interrupt(); }
}

export class CodexAdapter implements AgentAdapter {
  readonly name = "codex";
  readonly capabilities = { ...CAPABILITIES };
  private env: CodexEnv;
  private modelCatalog?: { baseUrl: string; models: ModelInfo[] };

  constructor(opts: { env: CodexEnv }) {
    this.env = {...opts.env, codexHome:opts.env.codexHome ?? process.env.CODEX_HOME ?? join(homedir(), ".codex")};
  }

  async discoverAgents(signal?: AbortSignal): Promise<AgentDescriptor[]> {
    const version = await this.probeVersion(signal);
    const available = version !== null;
    this.capabilities.injectMidTurn = version?.trim() === "codex-cli 0.165.0-alpha.1.2";
    const models = await this.discoverModels(signal, available);
    return [{
      agentId: "codex" as AgentDescriptor["agentId"],
      displayName: "Codex",
      adapter: "codex",
      available,
      ...(available ? {} : { unavailableReason: "codex CLI not found" }),
      ...(version ? { version } : {}),
      models,
      capabilities: this.capabilities,
      scannedAt: new Date().toISOString(),
    }];
  }

  async createSession(params: CreateSessionParams): Promise<AdapterSession> {
    if (params.reattach) throw new PhononError("errSessionBusy", "Codex recovery requires a verified native checkpoint");
    return new CodexSession(params.sessionId,params.model,params.cwd,this.env,params.initialContext,undefined,this.capabilities.injectMidTurn);
  }

  async recoverSession(params: CreateSessionParams, checkpoint: Record<string, unknown>): Promise<AdapterSession> {
    const saved = z.object({threadId:z.string().uuid(), nativeHome:z.string().min(1), pendingInject:z.array(z.string()).max(256),contextNotBefore:z.number().int().nonnegative().safe().optional()}).strict().safeParse(checkpoint);
    if (!saved.success || params.employee) throw new PhononError("errSessionBusy", "Codex native recovery checkpoint is invalid");
    let fd:number | undefined;
    try {
      if (realpathSync(this.env.codexHome!) !== saved.data.nativeHome) throw new Error("native storage identity changed");
      const file = resolveCodexSessionFile(saved.data.threadId, this.env.codexHome);
      if (!file) throw new Error("original native Session is missing");
      fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
      if (!fstatSync(fd).isFile()) throw new Error("not a native session file");
      const bytes = Buffer.alloc(65536), count = readSync(fd, bytes, 0, bytes.length, 0);
      const end = bytes.subarray(0, count).indexOf(10);
      if (end < 0) throw new Error("native metadata is incomplete");
      const meta = z.object({type:z.literal("session_meta"),payload:z.object({id:z.string().uuid(),cwd:z.string().min(1)})}).parse(JSON.parse(bytes.subarray(0,end).toString("utf8")));
      if (meta.payload.id !== saved.data.threadId || realpathSync(meta.payload.cwd) !== realpathSync(params.cwd)) throw new Error("native identity changed");
    } catch {
      throw new PhononError("errSessionBusy", "Codex native Session identity could not be verified");
    } finally { if (fd !== undefined) closeSync(fd); }
    return new CodexSession(params.sessionId,params.model,params.cwd,this.env,undefined,saved.data,this.capabilities.injectMidTurn);
  }

  private async discoverModels(signal?: AbortSignal, available = true): Promise<ModelInfo[]> {
    const cfg = parseCodexConfig(join(this.env.codexHome!, "config.toml"));
    const baseUrl = this.env.baseUrl && this.env.apiKey ? this.env.baseUrl : cfg.baseUrl;
    let native: ModelInfo[] = [];
    // Use the same native provider arguments, HOME and credentials as real turns. A generic
    // compatible /models response often has IDs only; it must not erase native effort metadata.
    if (available && !(this.env.models?.length && this.env.models.every(model => model.reasoningLevels !== undefined))) {
      try {
        native = await discoverCodexNativeModels({ bin: this.env.binPath ?? "codex", args: codexProviderArgs(this.env),
          env: codexNativeEnvironment(this.env), ...(signal ? { signal } : {}) });
      } catch { signal?.throwIfAborted(); }
    }
    const enrich = (models: ModelInfo[]) => models.map(model => {
      const nativeID = model.id === "default" ? cfg.model : model.id;
      const levels = native.find(row => row.id === nativeID)?.reasoningLevels;
      return model.reasoningLevels !== undefined || levels === undefined ? model : { ...model, reasoningLevels: levels };
    });
    if (this.env.models?.length) return enrich(this.env.models);
    if (baseUrl) {
      let models: ModelInfo[] = [];
      try {
        const data = await fetchJson(`${baseUrl.replace(/\/$/, "")}/models`, this.env.apiKey ? { Authorization: `Bearer ${this.env.apiKey}` } : undefined, signal);
        models = normalizeOpenAiModels(data);
        this.modelCatalog = { baseUrl, models };
      } catch {
        signal?.throwIfAborted();
        models = this.modelCatalog?.baseUrl === baseUrl ? this.modelCatalog.models : [];
        console.warn("[codex] discovery.catalog_failed; retaining known/native-config models");
      }
      if (models.length > 0) {
        const configured = this.env.defaultModel !== "default" ? this.env.defaultModel : cfg.model;
        const preferred = configured && models.find((model) => model.id === configured);
        return enrich(preferred ? [preferred, ...models.filter((model) => model.id !== configured)] : models);
      }
    }
    const configured = this.env.defaultModel !== "default" ? this.env.defaultModel : cfg.model;
    if (native.length) {
      const preferred = native.find(model => model.id === configured);
      return preferred ? [preferred, ...native.filter(model => model.id !== configured)]
        : configured ? [{ id: configured, available: true }, ...native] : native;
    }
    const base = configured ? [{ id: configured, available: true }] : [];
    const seen = new Set(base.map((m) => m.id));
    for (const m of CODEX_FALLBACK_MODELS) if (!seen.has(m.id)) base.push(m);
    const result:ModelInfo[]=base.length > 0 ? base : CODEX_FALLBACK_MODELS;
    if(!baseUrl&&(!cfg.providerId||cfg.providerId==="openai")){
      try{
        const file=join(this.env.codexHome!,"models_cache.json");
        if(statSync(file).size>2000000)return result;
        const cache=JSON.parse(readFileSync(file,"utf8"));
        if(Array.isArray(cache.models))return result.map(model=>{
          const native=cache.models.find((row:{slug?:string})=>row.slug===model.id);
          const levels=reportedReasoningLevels(native?.supported_reasoning_levels);
          return {...model,...(levels?{reasoningLevels:levels}:{})};
        });
      }catch{ /* Missing native metadata leaves reasoning support unknown. */ }
    }
    return result;
  }

  private async probeVersion(signal?: AbortSignal): Promise<string | null> {
    return (await discoveryProbe(this.env.binPath ?? "codex", ["--version"], signal));
  }
}
