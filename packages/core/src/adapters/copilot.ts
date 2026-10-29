import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSupervisedAgent, type ProcessSupervisor } from "../process-supervisor.js";
import { discoveryProbe } from "../discovery-probe.js";
import { buildChildProcessEnvironment } from "../child-env.js";
import { prepareCopilotPeerContext } from "./copilot-peer-context.js";
import { discoverCopilotNativeModels } from "./copilot-models.js";
import { nativeReasoning } from "../reasoning.js";
import { CurrentTurnInput } from "../current-turn-input.js";
import type {
  AgentAdapter,
  AdapterSession,
  CreateSessionParams,
  SendOptions,
  InsertionOptions,
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
 * GitHub Copilot CLI adapter.
 *
 * Current official CLI entrypoint: `copilot` (not the retired `gh copilot`
 * extension). Programmatic turns use piped stdin plus JSONL streaming:
 *
 *   copilot --name=<name> --output-format json --stream on
 *   copilot --resume=<name> ...
 *
 * The prompt is deliberately sent over stdin rather than `-p` so task content
 * does not appear in the process list. A stable, phonon-owned session name
 * provides native multi-turn resume and daemon-restart reattachment.
 */

const CAPABILITIES: AgentCapabilities = {
  nativeSession: true, // --name / --resume=<name>
  nativeCompression: false,
  contextInjection: true,
  proactiveOutput: false,
  modelSwitch: true, // --model on each turn
  interrupt: true, // kill child process
  injectMidTurn: false,
  skillManagement: true, // Copilot CLI loads Agent Skills/custom agents
  // Copilot CLI exposes tool events, but no blocking pre-tool hook in this adapter.
  // Be honest so orchestrators do not assume HITL can stop a command.
  hooks: [],
  streaming: true, // --output-format json --stream on
  workflowRoles: ["executor", "worker"],
  limits: { maxConcurrentSessions: 4 },
};

export interface CopilotEnv {
  /** Copilot executable path. Prefer an absolute path for services. */
  binPath?: string;
  /** `default` means use ~/.copilot/settings.json / the CLI default. */
  defaultModel?: string;
  /** Optional explicit model inventory supplied by the user/server. */
  models?: ModelInfo[];
  /** Owner opt-in to invocation-scoped peer hooks. Does not grant native extension access. */
  peerContext?: boolean;
}

export type ParsedCopilotEvent =
  | { kind: "message_delta"; text: string }
  | { kind: "tool_call"; toolName: string; toolCallId?: string; args?: unknown }
  | { kind: "tool_result"; toolName?: string; toolCallId?: string; ok: boolean; output?: unknown }
  | { kind: "result"; nativeSessionId?: string }
  | { kind: "ignore" };

/** Normalize one Copilot JSONL object into the subset phonon consumes. */
export function parseCopilotEvent(value: unknown): ParsedCopilotEvent {
  if (!value || typeof value !== "object") return { kind: "ignore" };
  const event = value as Record<string, unknown>;
  const type = event.type;
  const data = event.data && typeof event.data === "object"
    ? event.data as Record<string, unknown>
    : undefined;

  if (type === "assistant.message_delta" && typeof data?.deltaContent === "string") {
    return { kind: "message_delta", text: data.deltaContent };
  }
  if (type === "tool.execution_start") {
    return {
      kind: "tool_call",
      toolName: typeof data?.toolName === "string" ? data.toolName : "?",
      ...(typeof data?.toolCallId === "string" ? { toolCallId: data.toolCallId } : {}),
      ...(data && "arguments" in data ? { args: data.arguments } : {}),
    };
  }
  if (type === "tool.execution_complete") {
    const result = data?.result && typeof data.result === "object"
      ? data.result as Record<string, unknown>
      : undefined;
    return {
      kind: "tool_result",
      ...(typeof data?.toolName === "string" ? { toolName: data.toolName } : {}),
      ...(typeof data?.toolCallId === "string" ? { toolCallId: data.toolCallId } : {}),
      ok: data?.success !== false,
      ...(result && "content" in result ? { output: result.content } : data && "result" in data ? { output: data.result } : {}),
    };
  }
  if (type === "result") {
    return {
      kind: "result",
      ...(typeof event.sessionId === "string" ? { nativeSessionId: event.sessionId } : {}),
    };
  }
  return { kind: "ignore" };
}

/** Parse the documented model list emitted by `copilot help config`. */
export function parseCopilotModelsHelp(text: string): ModelInfo[] {
  const modelSection = text.match(/`model`:[\s\S]*?(?=\n\s*`[^`]+`:\s|$)/)?.[0] ?? "";
  const models: ModelInfo[] = [];
  const seen = new Set<string>();
  for (const match of modelSection.matchAll(/^\s*-\s+"([^"]+)"\s*$/gm)) {
    const id = match[1]!;
    if (seen.has(id)) continue;
    seen.add(id);
    models.push({ id, available: true });
  }
  return models;
}

/** Offline CLI builds include a banner and update advice rather than a bare version. */
export function parseCopilotVersion(text: string): string | undefined {
  const line = text.trim().split(/\r?\n/)[0] ?? "";
  const value = line.startsWith("GitHub Copilot CLI ") ? line.slice("GitHub Copilot CLI ".length).replace(/\.$/, "") : line;
  return /^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(value) ? value : undefined;
}

function configuredModel(): string | undefined {
  const home = process.env.COPILOT_HOME ?? join(homedir(), ".copilot");
  const path = existsSync(join(home,"config.json"))?join(home,"config.json"):join(home, "settings.json");
  if (!existsSync(path)) return undefined;
  try {
    const settings = JSON.parse(readFileSync(path, "utf8")) as { model?: unknown };
    return typeof settings.model === "string" && settings.model ? settings.model : undefined;
  } catch {
    return undefined;
  }
}

class CopilotSession implements AdapterSession {
  readonly sessionId: string;
  model: string;
  private readonly cwd: string;
  private readonly env: CopilotEnv;
  private readonly nativeName: string;
  private started: boolean;
  private current?: ProcessSupervisor;
  private stopTurn?: () => void;
  private pendingInject: string[] = [];
  private nativeSessionId?: string;
  private peerQualified = false;
  private peer?: ReturnType<typeof prepareCopilotPeerContext>;
  private readonly currentTurnInput=new CurrentTurnInput();

  async preparePeerContext(environment?: Record<string, string>, signal?: AbortSignal): Promise<void> {
    this.peerQualified = false;
    if (this.env.peerContext !== true || this.started && !this.nativeSessionId) return;
    try {
      const version = await discoveryProbe(this.env.binPath ?? "copilot", ["--no-auto-update", "--version"], signal,
        { cwd: this.cwd, env: buildChildProcessEnvironment(environment) });
      this.peerQualified = version !== null && parseCopilotVersion(version) === "1.0.82";
      if (this.peerQualified) {
        this.nativeSessionId ??= randomUUID();
        if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(this.nativeSessionId)) this.peerQualified = false;
      }
    } catch { /* Native receive is optional; preserve the original CLI path. */ }
  }

  peerContextCapability() {
    if (!this.peerQualified) return undefined;
    const ready = this.peer?.isReady() ?? false;
    return { mode: "context_hook", boundary: "after_tools", visibility: "collapsed", evidence: "context_hook",
      budget:"native_estimate", readiness: ready ? "ready" : "pending", ...(ready ? { nativeSessionId: this.nativeSessionId } : {}) } as const;
  }

  constructor(
    sessionId: string,
    model: string,
    cwd: string,
    env: CopilotEnv,
    initialContext?: ContextItem[],
    reattach = false,
    private readonly reasoningFlag=false,
    private readonly nativeInput=false,
  ) {
    this.sessionId = sessionId;
    this.model = model;
    this.cwd = cwd;
    this.env = env;
    this.nativeName = `agent-phonon-${sessionId}`;
    // Reattached sessions already exist in Copilot's Chronicle and must resume
    // instead of creating a duplicate session with the same display name.
    this.started = reattach;
    this.pendingInject.push(...formatInitialContextLines(initialContext));
  }

  async send(input: string, opts: SendOptions): Promise<void> {
    return this.currentTurnInput.run(opts,{enabled:this.nativeInput&&this.peerQualified,capability:()=>this.peerContextCapability(),receipt:"native_context"},
      options=>this.sendNative(input,options));
  }

  insertAtToolGap(input:string,options:InsertionOptions):Promise<void>{return this.currentTurnInput.insert(input,options);}

  private async sendNative(input: string, opts: SendOptions): Promise<void> {
    if (this.current) throw new Error("Copilot session already has an active turn");
    if (opts.signal?.aborted) {
      opts.emit({ type: "result", sessionId: this.sessionId, turnId: opts.turnId, seq: 0, at: new Date().toISOString(),
        text: "", status: "interrupted", final: true } as StreamEvent);
      return;
    }
    let prompt = input;
    if (this.pendingInject.length > 0) {
      prompt = this.pendingInject.join("\n") + "\n\n" + prompt;
      this.pendingInject = [];
    }
    if (opts.skills?.length) {
      prompt = `[Use these skills for this turn: ${opts.skills.join(", ")}]\n\n${prompt}`;
    }

    const args = [
      this.started ? `--resume=${this.peerQualified ? this.nativeSessionId : this.nativeName}` : `--name=${this.nativeName}`,
      "--output-format", "json",
      "--stream", "on",
      "--no-ask-user",
      "--no-remote",
      "--no-auto-update",
      "--no-color",
    ];
    if (opts.peerContext && this.peerQualified && this.nativeSessionId) {
      try {
        this.peer = prepareCopilotPeerContext(opts, { sessionId: this.nativeSessionId, cwd: this.cwd, prompt: prompt + "\n",nativeInput:this.nativeInput });
        args.push("--plugin-dir", this.peer.path);
        if (!this.started) args.push("--session-id", this.nativeSessionId);
      } catch { this.peerQualified = false; }
    }
    if (this.model && this.model !== "default") args.push("--model", this.model);
    if(this.reasoningFlag&&opts.reasoning?.level)args.push("--reasoning-effort",nativeReasoning(opts.reasoning.level)!);
    const peer = this.peer;
    try { await this.run(args, prompt + "\n", opts); }
    finally { peer?.cleanup(); if (this.peer === peer) this.peer = undefined; }
  }

  private run(args: string[], stdin: string, opts: SendOptions): Promise<void> {
    let runtime: ProcessSupervisor | undefined;
    return new Promise<void>((resolve) => {
      const { turnId, emit } = opts;
      const environment = buildChildProcessEnvironment(opts.environment);
      delete environment.AGENT_PHONON_PEER_CONTEXT_URL;
      delete environment.AGENT_PHONON_PEER_CONTEXT_TOKEN;
      const supervisor = spawnSupervisedAgent(this.env.binPath ?? "copilot", args, {
        cwd: this.cwd,
        env: environment,
      });
      runtime = supervisor;
      const child = supervisor.child;
      this.current = supervisor;
      let stdoutBuf = "";
      let stderr = "";
      let acc = "";
      let finalText = "", nativeResult = false, nativeFailure = false;
      let settled = false;
      const startedAt=Date.now();
      let reasoningEvidence:{sessionId:string;value:string}|undefined;
      const toolNames = new Map<string, string>();

      const finish = (status: "completed" | "failed" | "interrupted" | "timeout", message?: string): void => {
        if (settled) return;
        settled = true;
        clearTimeout(guard);
        opts.signal?.removeEventListener("abort", abort);
        if (status === "completed") this.started = true;
        if(status==="completed"&&reasoningEvidence&&reasoningEvidence.sessionId===this.nativeSessionId&&opts.reasoning?.level&&reasoningEvidence.value===nativeReasoning(opts.reasoning.level)){
          try{opts.acknowledgeReasoning?.(reasoningEvidence.value);}catch{/* Optional evidence cannot replace the native outcome. */}
        }
        const now = new Date().toISOString();
        if (status === "failed") {
          emit({
            type: "error", sessionId: this.sessionId, turnId, seq: 0, at: now,
            message: message ?? "copilot failed", status: "failed", final: true,
          } as StreamEvent);
        } else {
          emit({
            type: "result", sessionId: this.sessionId, turnId, seq: 0, at: now,
            text: status === "completed" ? finalText : acc, status, final: true,
          } as StreamEvent);
        }
        resolve();
      };

      const guard = setTimeout(() => {
        void supervisor.terminate();
        finish("timeout", "copilot turn timed out");
      }, 1800000);
      const abort = (): void => {
        void supervisor.terminate();
        finish("interrupted");
      };
      this.stopTurn = abort;
      if (opts.signal?.aborted) abort();
      else opts.signal?.addEventListener("abort", abort, { once: true });

      const handleLine = (line: string): void => {
        if (!line.trim()) return;
        let raw: unknown;
        try { raw = JSON.parse(line); } catch { return; }
        if (!raw || typeof raw !== "object") return;
        const event = raw as { type?: unknown; agentId?: unknown; exitCode?: unknown; timestamp?:unknown; data?: { parentToolCallId?: unknown; content?: unknown; toolRequests?: unknown; sessionId?:unknown;selectedModel?:unknown;reasoningEffort?:unknown } };
        if (event.agentId || event.data?.parentToolCallId) return;
        if(this.reasoningFlag&&["session.start","session.resume"].includes(String(event.type))&&typeof event.timestamp==="string"&&Date.parse(event.timestamp)>=startedAt
          &&event.data?.selectedModel===this.model&&typeof event.data.sessionId==="string"&&typeof event.data.reasoningEffort==="string"){
          reasoningEvidence={sessionId:event.data.sessionId,value:event.data.reasoningEffort};
        }
        if (event.type === "user.message" && this.peer && !this.peer.isReady()) this.peer.deactivate();
        if (event.type === "session.error") nativeFailure = true;
        if (event.type === "assistant.message") {
          finalText = typeof event.data?.content === "string" && !(Array.isArray(event.data?.toolRequests) && event.data.toolRequests.length)
            ? event.data.content : "";
        }
        if (event.type === "result") { nativeResult = true; nativeFailure ||= event.exitCode !== 0; }
        const parsed = parseCopilotEvent(raw);
        const at = new Date().toISOString();
        if (parsed.kind === "message_delta") {
          acc += parsed.text;
          emit({
            type: "message", sessionId: this.sessionId, turnId, seq: 0, at,
            role: "assistant", text: parsed.text, delta: true,
          } as StreamEvent);
        } else if (parsed.kind === "tool_call") {
          if (parsed.toolCallId) toolNames.set(parsed.toolCallId, parsed.toolName);
          emit({
            type: "tool_call", sessionId: this.sessionId, turnId, seq: 0, at,
            toolName: parsed.toolName, args: parsed.args, toolCallId: parsed.toolCallId,
          } as StreamEvent);
        } else if (parsed.kind === "tool_result") {
          const toolName = parsed.toolName ?? (parsed.toolCallId ? toolNames.get(parsed.toolCallId) : undefined) ?? "";
          if (parsed.toolCallId) toolNames.delete(parsed.toolCallId);
          emit({
            type: "tool_result", sessionId: this.sessionId, turnId, seq: 0, at,
            toolName, toolCallId: parsed.toolCallId ?? "",
            ok: parsed.ok, output: parsed.output,
          } as StreamEvent);
        } else if (parsed.kind === "result") {
          if (!parsed.nativeSessionId || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(parsed.nativeSessionId)) {
            nativeFailure = true; return;
          }
          if (this.peer && parsed.nativeSessionId !== this.nativeSessionId) {
            void supervisor.terminate(); finish("failed", "Copilot native session identity changed"); return;
          }
          this.nativeSessionId = parsed.nativeSessionId;
        }
      };

      child.stdout.on("data", (chunk) => {
        stdoutBuf += chunk.toString();
        let nl: number;
        while ((nl = stdoutBuf.indexOf("\n")) >= 0) {
          const line = stdoutBuf.slice(0, nl);
          stdoutBuf = stdoutBuf.slice(nl + 1);
          handleLine(line);
        }
      });
      child.stderr.on("data", (chunk) => { stderr = (stderr + chunk.toString()).slice(-16000); });
      child.on("error", (error) => finish("failed", error.message));
      child.on("close", (code) => {
        if (settled) return;
        if (stdoutBuf.trim()) handleLine(stdoutBuf);
        const completed = code === 0 && nativeResult && !nativeFailure && !!finalText.trim();
        finish(completed ? "completed" : "failed", completed
          ? undefined : code === 0 ? "Copilot native final result is unconfirmed"
          : (stderr.trim() || `copilot exited ${code}`));
      });

      if (!settled) {
        child.stdin.write(stdin);
        child.stdin.end();
      }
    }).finally(async () => {
      await runtime?.terminate();
      if (this.current === runtime) { this.current = undefined; this.stopTurn = undefined; }
    });
  }

  async interrupt(): Promise<void> {
    if (this.current) {
      const current = this.current;
      this.stopTurn?.();
      await current.terminate();
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

export class CopilotAdapter implements AgentAdapter {
  readonly name = "copilot";
  readonly capabilities = {...CAPABILITIES,reasoningControl:false};
  private readonly env: CopilotEnv;

  constructor(opts: { env?: CopilotEnv } = {}) {
    this.env = opts.env ?? {};
  }

  async discoverAgents(signal?: AbortSignal): Promise<AgentDescriptor[]> {
    const version = await this.probeVersion(signal);
    const available = version !== null;
    this.capabilities.injectMidTurn=available&&version==="1.0.82"&&this.env.peerContext===true;
    this.capabilities.reasoningControl=false;
    if(available){
      try{const help=await discoveryProbe(this.env.binPath??"copilot",["--no-auto-update","--help"],signal);this.capabilities.reasoningControl=/--reasoning-effort\s+<level>/.test(help??"");}
      catch{this.capabilities.reasoningControl=false;}
    }
    const models = available ? await this.discoverModels(signal) : this.fallbackModels();
    return [{
      agentId: "copilot" as AgentDescriptor["agentId"],
      displayName: "GitHub Copilot CLI",
      adapter: "copilot",
      available,
      ...(available ? {} : { unavailableReason: "copilot CLI not found" }),
      ...(version ? { version } : {}),
      models,
      capabilities: this.capabilities,
      scannedAt: new Date().toISOString(),
    }];
  }

  async createSession(params: CreateSessionParams): Promise<AdapterSession> {
    const model = params.model && params.model !== "default"
      ? params.model
      : (this.env.defaultModel ?? "default");
    const session=new CopilotSession(
      params.sessionId,
      model,
      params.cwd,
      this.env,
      params.initialContext,
      params.reattach,
      this.capabilities.reasoningControl,
      this.capabilities.injectMidTurn,
    );
    if(this.capabilities.injectMidTurn)await session.preparePeerContext();
    return session;
  }

  private fallbackModels(): ModelInfo[] {
    const model = this.env.defaultModel ?? "default";
    return [{ id: model, displayName: model === "default" ? "Native CLI default selection" : model, available: true }];
  }

  private async discoverModels(signal?: AbortSignal): Promise<ModelInfo[]> {
    let native:ModelInfo[]=[];
    try{native=await discoverCopilotNativeModels({bin:this.env.binPath??"copilot",...(signal?{signal}:{}),env:buildChildProcessEnvironment()});}
    catch{/* Optional model discovery must not prevent the original CLI path. */}
    if (this.env.models?.length)return this.env.models.map(model=>{
      const id=model.id==="default"?(this.env.defaultModel&&this.env.defaultModel!=="default"?this.env.defaultModel:configuredModel()):model.id;
      const levels=native.find(row=>row.id===id)?.reasoningLevels;
      return model.reasoningLevels||!levels?model:{...model,reasoningLevels:levels};
    });
    if(native.length){
      const preferred=this.fallbackModels().map(model=>{
        const id=model.id==="default"?configuredModel():model.id,found=native.find(row=>row.id===id);
        return {...model,...(found?.reasoningLevels?{reasoningLevels:found.reasoningLevels}:{})};
      });
      return [...preferred,...native.filter(model=>!preferred.some(row=>row.id===model.id))];
    }
    const out = await discoveryProbe(this.env.binPath ?? "copilot", ["--no-auto-update", "help", "config"], signal);
    // Static help is not the authenticated user's model availability.
    const parsed = parseCopilotModelsHelp(out ?? "").map((model) => ({ ...model, available: false }));
    const configured = configuredModel();
    if (configured && !parsed.some((m) => m.id === configured)) parsed.push({ id: configured, available: false });
    const preferred = this.fallbackModels();
    return [...preferred, ...parsed.filter((m) => !preferred.some((p) => p.id === m.id))];
  }

  private async probeVersion(signal?: AbortSignal): Promise<string | null> {
    const version = await discoveryProbe(this.env.binPath ?? "copilot", ["--no-auto-update", "--version"], signal);
    return version === null ? null : parseCopilotVersion(version) ?? null;
  }
}
