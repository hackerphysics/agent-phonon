import type {
  AgentAdapter,
  AdapterSession,
  CreateSessionParams,
  SendOptions,
  InsertionOptions,
  EmployeeProfileTarget,EmployeeProfileObservation,
} from "../adapter.js";
import { formatInitialContextLines } from "../adapter.js";
import type { AgentCapabilities, AgentDescriptor, StreamEvent, ContextItem, ModelInfo } from "@agent-phonon/protocol";
import { GatewayClient, type GatewayConfig } from "../gateway-client.js";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, basename, matchesGlob } from "node:path";
import { dropToolIOFromJsonlFiles } from "../custom-compress.js";
import { PhononError } from "../rpc.js";
import { createHash } from "node:crypto";
import { employeeDocuments } from "../employee-profiles.js";
import { open, lstat, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { nativeReasoning } from "../reasoning.js";
import {parseOpenClawNativeModels} from "./openclaw-models.js";
import { OpenClawCheckpoint,OpenClawNativeObservation,observeOpenClawSession,recoveryGatewayIdentity,sameOpenClawSession } from "./openclaw-recovery.js";
import { z } from "zod";
import { OpenClawPeerCapabilities, OpenClawInputCapabilities, projectOpenClawToolResult } from "./openclaw-peer-context.js";
import { CurrentTurnInput } from "../current-turn-input.js";

const PHONON_PLUGIN = "agent-phonon-hitl";
const PHONON_OPTIONAL_TOOLS = ["phonon_request_interaction", "phonon_acknowledge_interaction", "phonon_conversation_board", "phonon_workflow", "phonon_conversation_message", "phonon_publish_document", "phonon_project_coordination"];
const nativeToolPolicy = z.object({allow:z.array(z.string()).optional(),alsoAllow:z.array(z.string()).optional(),deny:z.array(z.string()).optional()}).passthrough();
const nativeConfigSnapshot = z.object({valid:z.literal(true),hash:z.string().min(1).max(512),config:z.object({
  plugins:z.object({enabled:z.boolean().optional(),allow:z.array(z.string()).optional(),entries:z.record(z.unknown())}).passthrough(),
  agents:z.object({entries:z.record(z.object({workspace:z.string().optional(),tools:nativeToolPolicy.optional()}).passthrough())}).passthrough(),
  tools:nativeToolPolicy.optional(),gateway:z.object({reload:z.object({mode:z.string().optional()}).passthrough().optional()}).passthrough().optional(),
}).passthrough()}).passthrough();
const coversNativeTool=(patterns:string[]|undefined,name:string)=>patterns?.some(pattern=>pattern===PHONON_PLUGIN||pattern==="group:plugins"||matchesGlob(name.toLowerCase(),pattern.toLowerCase()))??false;

/**
 * OpenClaw adapter（Gateway WS 版，design D10）。
 *
 * 连 OpenClaw Gateway 的 WebSocket（参考 LMA 传输层），拿到完整能力：
 *   - chat 事件 state=delta（增量流）→ verbosity=messages/trace 的流式
 *   - chat 事件 state=final → turn 终态
 *   - sessions.compact（原生压缩）、chat.abort（中断）、chat.inject（注入）
 *   - sessions.messages.subscribe（订阅自发输出，cron/心跳冒泡）→ proactiveOutput
 *
 * 实测（2026-06-20，直连本机 Gateway 18789）：
 *   - 握手 client.id 必须是 "gateway-client"
 *   - chat.send 必须带 idempotencyKey
 *   - 多 agent 共享 Gateway，事件按 sessionKey 区分，不串台
 */

const CAPABILITIES: AgentCapabilities = {
  reasoningControl:true,
  employeeProfiles:true,
  nativeSession: true,
  nativeCompression: true, // sessions.compact
  contextInjection: true, // chat.inject
  proactiveOutput: true, // sessions.messages.subscribe
  modelSwitch: true, // sessions.patch model
  interrupt: true, // chat.abort（真中断，非 kill 进程）
  injectMidTurn: false,
  skillManagement: true,
  hooks: ["pre_tool", "pre_command"],
  streaming: true, // chat delta
  workflowRoles: ["executor", "worker"],
  limits: { maxConcurrentSessions: 4, maxContextTokens: 1048576 },
};

class GatewaySession implements AdapterSession {
  readonly sessionId: string;
  model: string;
  private gw: GatewayClient;
  private sessionKey: string;
  private openclawAgent: string;
  /** 当前活动 turn 的 emit/runId 跟踪。 */
  private activeTurn?: { turnId: string; emit: (e: StreamEvent) => void; verbosity: string; done: () => void; accepted:()=>void; acc: string; runId: string; seenTools: Set<string>; peerProjection?:{projectionId:string;runId:string;sessionId:string} };
  /** 自发输出水槽（无 active turn 时用，D16 unsolicited）。 */
  private unsolicitedSink?: (event: StreamEvent) => void;
  private unsolicitedSeq = 0;
  private subscribedEpoch:number|undefined;
  private ownedRuns=new Set<string>();
  private nativeTurns=new Map<string,{runId:string;ended:boolean}>();
  private native:OpenClawNativeObservation|undefined;
  private originalNativeId:string|undefined;
  private originalCreatedAt:number|undefined;
  private historyStarted=false;
  private strictIdentity=false;
  private closed=false;
  private policyRelease?:()=>Promise<void>;
  private peerReady?:{epoch:number;native:OpenClawNativeObservation;nativeInput:boolean};
  private readonly currentTurnInput=new CurrentTurnInput();
  async preparePeerContext(_environment?:Record<string,string>,signal?:AbortSignal):Promise<void>{
    this.peerReady=undefined;
    if(this.closed||this.activeTurn||!this.gatewayIdentity||signal?.aborted)return;
    try{
      await this.gw.connect();const epoch=this.gw.connectionEpoch();
      const native=await this.verifyNative(!this.historyStarted);
      const capabilities=OpenClawPeerCapabilities.safeParse(await this.gw.rpc("phonon.peers.capabilities",{version:1,sessionKey:this.sessionKey,sessionId:native.sessionId,model:native.model},5000));
      if(!capabilities.success||signal?.aborted)return;
      if(!signal?.aborted&&this.gw.isConnected()&&this.gw.connectionEpoch()===epoch)this.peerReady={epoch,native,nativeInput:capabilities.data.nativeVersion==="2026.10.7"&&capabilities.data.currentTurnInput==="native_context_v1"};
    }catch{this.peerReady=undefined;}
  }
  peerContextCapability(){
    return !this.closed&&this.peerReady&&this.gw.isConnected()&&this.gw.connectionEpoch()===this.peerReady.epoch
      ?{mode:"context_hook",boundary:"after_tools",visibility:"collapsed",evidence:"context_hook",budget:"native_estimate",nativeSessionId:this.peerReady.native.sessionId} as const:undefined;
  }
  nativeInputAvailable(){return this.nativeInputEnabled&&!!this.peerContextCapability()&&this.peerReady?.nativeInput===true;}
  insertAtToolGap(input:string,options:InsertionOptions):Promise<void>{return this.currentTurnInput.insert(input,options);}
  async observeNativeStop(turnId:string){return this.nativeTurns.get(turnId)?.ended?"native_terminal" as const:undefined;}
  proactiveOutputReady(){return this.subscribedEpoch!==undefined&&this.gw.isConnected?.()===true&&this.gw.connectionEpoch?.()===this.subscribedEpoch;}
  async subscribe(){const epoch=this.gw.connectionEpoch?.();await this.gw.rpc("sessions.messages.subscribe",{key:this.sessionKey},10000);if(epoch!==undefined&&this.gw.isConnected()&&epoch===this.gw.connectionEpoch())this.subscribedEpoch=epoch;}

  setUnsolicitedSink(sink: (event: StreamEvent) => void): void {
    this.unsolicitedSink = sink;
  }

  constructor(gw: GatewayClient, sessionId: string, model: string, openclawAgent: string, initialContext: ContextItem[]|undefined,private upstreamRuns:CreateSessionParams["upstreamRuns"],private params:CreateSessionParams,private gatewayIdentity:string|undefined,restored?:OpenClawCheckpoint,private detach?:()=>void,private readonly nativeInputEnabled=false) {
    this.gw = gw;
    this.sessionId = sessionId;
    this.model = model;
    this.openclawAgent = openclawAgent;
    this.sessionKey = `agent:${openclawAgent}:phonon-${sessionId}`;
    // contextInjection: 暂存 initialContext（含 workflow systemPrompt），首轮 send 拼进 message。
    this.pendingInject.push(...(restored?.pendingInject??formatInitialContextLines(initialContext)));
    if(restored){this.native=restored.native;this.originalNativeId=restored.native.sessionId;this.originalCreatedAt=restored.native.createdAt;this.historyStarted=true;this.strictIdentity=true;}
  }

  private async verifyNative(allowEmpty=false){
    const current=await observeOpenClawSession(this.gw,this.sessionKey,this.openclawAgent,this.params.cwd,this.model,allowEmpty);
    if(this.originalNativeId&&current.sessionId!==this.originalNativeId||this.originalCreatedAt&&current.createdAt!==this.originalCreatedAt||this.native&&!sameOpenClawSession(this.native,current))throw new PhononError("errSessionBusy","OpenClaw native Session identity changed");
    if(this.closed)throw new PhononError("errSessionTerminated");
    this.originalNativeId=current.sessionId;this.originalCreatedAt=current.createdAt;return current;
  }
  bindCreatedIdentity(value:Record<string,unknown>){
    const entry=value.entry as {sessionId?:unknown}|undefined,id=OpenClawNativeObservation.shape.sessionId.safeParse(value.sessionId??entry?.sessionId);
    if(id.success)this.originalNativeId=id.data;
  }
  recoveryCheckpoint(){
    return this.native&&this.native.messageCount>0&&this.native.leafId&&this.gatewayIdentity&&!this.closed?{
      version:1,phononSessionId:this.sessionId,gateway:this.gatewayIdentity,model:this.model,native:this.native,
      pendingInject:[...this.pendingInject],...(this.params.employee?{employeeId:this.params.employee.employeeId}:{}),
    }:undefined;
  }

  /** 暂存的注入上下文（首轮 send 拼进 message，与其他 adapter 一致）。 */
  private pendingInject: string[] = [];

  get key(): string {
    return this.sessionKey;
  }

  /** 接收 Gateway 事件（由 adapter 路由进来，已按 sessionKey 过滤）。 */
  handleEvent(event: string, payload: Record<string, unknown>): void {
    if(this.closed)return;
    if(event==="chat"&&typeof payload.runId==="string"&&["final","error","aborted"].includes(String(payload.state))){
      for(const value of this.nativeTurns.values())if(value.runId===payload.runId)value.ended=true;
    }
    const turn = this.activeTurn;
    const now = new Date().toISOString();

    if (turn && payload.runId === turn.runId && (event === "agent" || event === "session.tool") && (payload.stream === "tool" || (payload.stream === "item" && (payload.data as { kind?: string })?.kind === "tool"))) {
      const data = (payload.data ?? {}) as Record<string, unknown>;
      if(data.name==="phonon_project_coordination"||data.toolName==="phonon_project_coordination")return;
      if (!["tools", "trace"].includes(turn.verbosity)) return;
      const phase = data.phase === "end" ? "result" : data.phase;
      const toolCallId = String(data.toolCallId ?? data.id ?? "");
      const key = `${payload.runId}:${toolCallId}:${phase}`;
      if (turn.seenTools.has(key)) return;
      turn.seenTools.add(key);
      const base = { sessionId: this.sessionId, turnId: turn.turnId, seq: 0, at: now, toolName: String(data.name ?? data.toolName ?? "?"), toolCallId };
      if (phase === "start") turn.emit({ ...base, type: "tool_call", args: data.args } as StreamEvent);
      else if (phase === "result") turn.emit({ ...base, type: "tool_result", ok: data.isError !== true && data.status !== "failed" && data.status !== "error", output: projectOpenClawToolResult(data.result,turn.peerProjection) } as StreamEvent);
      return;
    }
    if (event !== "chat") return;
    const state = payload.state as string;

    // 无 active turn 的 chat 输出 = 自发（D16 unsolicited）：OpenClaw cron/定时/心跳（修 P0#7）
    if (!turn || payload.runId&&payload.runId!==turn.runId) {
      const upstream=typeof payload.runId==="string"?payload.runId:undefined;
      if(upstream&&(this.ownedRuns.has(upstream)||this.upstreamRuns?.owns(upstream)))return;
      if (state === "final") {
        const text =
          (payload.message as { text?: string })?.text ?? (payload.finalText as string) ?? "";
        if (text && this.unsolicitedSink) {
          this.unsolicitedSink({
            type: "message",
            sessionId: this.sessionId,
            turnId: upstream?"u-"+upstream:`u-${Date.now()}-${this.unsolicitedSeq++}`,
            ...(upstream?{sourceEventId:upstream}:{}),
            origin: "unsolicited",
            source: (payload.source as string) ?? "openclaw",
            seq: 0,
            at: now,
            role: "assistant",
            text,
            delta: false,
          } as StreamEvent);
        }
      }
      return;
    }

    if (state === "error" || state === "aborted") {
      turn.accepted();
      turn.emit({ type: "result", sessionId: this.sessionId, turnId: turn.turnId, seq: 0, at: now,
        text: state === "error" ? String(payload.errorMessage ?? "OpenClaw run failed") : turn.acc,
        status: state === "error" ? "failed" : "aborted", final: true } as StreamEvent);
      this.activeTurn = undefined;
      turn.done();
    } else if (state === "delta") {
        const deltaText = payload.deltaText as string | undefined;
        if (deltaText) {
          turn.acc += deltaText;
          if (turn.verbosity === "messages" || turn.verbosity === "tools" || turn.verbosity === "trace") {
            turn.emit({
              type: "message", sessionId: this.sessionId, turnId: turn.turnId, seq: 0, at: now,
              role: "assistant", text: deltaText, delta: true,
            } as StreamEvent);
          }
        }
      } else if (state === "final") {
        turn.accepted();
        // final 文本优先取 payload，没有则用累积的 delta
        const finalText =
          (payload.message as { text?: string })?.text ??
          (payload.finalText as string) ??
          turn.acc;
        turn.emit({
          type: "result", sessionId: this.sessionId, turnId: turn.turnId, seq: 0, at: now,
          text: finalText, status: "completed", final: true,
        } as StreamEvent);
        turn.done();
        this.activeTurn = undefined;
    }
  }

  async send(input: string, opts: SendOptions): Promise<void> {
    const enabled=this.nativeInputAvailable();
    return this.currentTurnInput.run(opts,{enabled,capability:()=>this.peerContextCapability(),receipt:"native_context"},
      options=>this.sendNative(input,options,enabled&&options.peerContext!==opts.peerContext));
  }

  private async sendNative(input: string, opts: SendOptions,nativeInput:boolean): Promise<void> {
    const { turnId, emit } = opts;
    if(this.closed)throw new PhononError("errSessionTerminated");
    const native = opts.environment?.AGENT_PHONON_INTERACTION_TOKEN !== undefined;
    const coordinationOnly=!!opts.projectCoordination&&!(opts.requestInteraction||opts.conversationBoard||opts.conversationWorkflow||opts.conversationMessage||opts.publishDocument);
    if(native&&!this.gatewayIdentity)throw new PhononError("errPolicyDenied","Native interactions require a local OpenClaw Gateway");
    if(!this.gatewayIdentity)throw new PhononError("errPolicyDenied","Phonon noninteractive policy requires a local OpenClaw Gateway");
    const observed=await this.verifyNative(!this.historyStarted);
    this.native=undefined;
    if(!this.proactiveOutputReady())await this.subscribe().catch(()=>{});
    const runId = randomUUID();
    this.nativeTurns.set(turnId,{runId,ended:false});
    if(this.nativeTurns.size>256)this.nativeTurns.delete(this.nativeTurns.keys().next().value!);
    if(this.upstreamRuns)this.upstreamRuns.remember(runId);else this.ownedRuns.add(runId);
    if (opts.signal?.aborted) {
      emit({ type: "result", sessionId: this.sessionId, turnId, seq: 0, at: new Date().toISOString(), text: "", status: "interrupted", final: true } as StreamEvent);
      return;
    }
    const policy=await this.gw.bindNoninteractivePolicy({sessionKey:this.sessionKey,sessionId:observed.sessionId,runId,agentId:this.openclawAgent,model:this.model});
    let dispatched=false;
    const releasePolicy=()=>policy.release({dispatched});
    this.policyRelease=releasePolicy;
    let release:(()=>Promise<void>)|undefined;
    let releasePeer:(()=>Promise<void>)|undefined,peerProjection:{projectionId:string;runId:string;sessionId:string}|undefined;
    let confirmedThinking: string | null | undefined;
    try {
      if(native)release=await this.gw.bindNativeInteractions(this.sessionKey, runId, opts.environment!,{coordinationOnly});
      if(opts.peerContext&&observed&&this.peerContextCapability()){
        const projectionId=randomUUID();
        try{releasePeer=await this.gw.bindPeerContext({sessionKey:this.sessionKey,sessionId:observed.sessionId,runId,workspaceDir:observed.cwd,model:observed.model,projectionId,...(nativeInput?{nativeInput:true as const}:{})},opts.environment??{});
          peerProjection={projectionId,runId,sessionId:observed.sessionId};
        }catch{this.peerReady=undefined;console.warn("[openclaw-gateway] coordination.receiver_unavailable; retaining assigned task");}
      }
      if (opts.reasoning) {
        try {
          const value = nativeReasoning(opts.reasoning.level);
          const response = await this.gw.rpc("sessions.patch", {key:this.sessionKey,thinkingLevel:value},8000);
          const entry = response.entry as Record<string,unknown> | undefined;
          if (!opts.signal?.aborted && entry && (response.key === undefined || response.key === this.sessionKey) && (value === null ? entry.thinkingLevel == null : entry.thinkingLevel === value)) {
            confirmedThinking = value;
            try { opts.acknowledgeReasoning?.(value); } catch { /* Setting receipt remains unconfirmed. */ }
          }
        } catch { /* Attempt the original chat even when optional settings cannot be applied. */ }
      }
      if (opts.signal?.aborted) {
        emit({ type: "result", sessionId: this.sessionId, turnId, seq: 0, at: new Date().toISOString(), text: "", status: "interrupted", final: true } as StreamEvent);
        return;
      }
      let message = input;
      const pending=[...this.pendingInject];let accepted=false;
      const accept=()=>{if(!accepted){accepted=true;this.pendingInject.splice(0,pending.length);}};
      // 暂存的注入（含首轮 systemPrompt）先拼进本轮
      if (this.pendingInject.length > 0) {
        message = pending.join("\n") + "\n\n" + message;
      }
      if (opts.skills && opts.skills.length > 0) {
        message = `[必须本轮加载并使用这些 skill: ${opts.skills.join(", ")}]\n\n${message}`;
      }

      // Optional setting/peer awaits cannot retain stale mandatory execution authority.
      const current=await this.verifyNative(!this.historyStarted);
      if(current.sessionId!==observed.sessionId||current.leafId!==observed.leafId)throw new PhononError("errSessionBusy","OpenClaw native Session changed before dispatch");
      await policy.confirm();
      if(this.closed||opts.signal?.aborted){
        emit({type:"result",sessionId:this.sessionId,turnId,seq:0,at:new Date().toISOString(),text:"",status:"interrupted",final:true} as StreamEvent);
        return;
      }

      await new Promise<void>((resolve) => {
        let settled = false;
        let guard: ReturnType<typeof setTimeout> | undefined;
        const finish = () => {
          if (settled) return;
          settled = true;
          clearTimeout(guard);
          opts.signal?.removeEventListener("abort", abort);
          if (this.activeTurn?.turnId === turnId) this.activeTurn = undefined;
          resolve();
        };
        const abort = () => {
          emit({ type: "result", sessionId: this.sessionId, turnId, seq: 0, at: new Date().toISOString(), text: "", status: "interrupted", final: true } as StreamEvent);
          finish();
        };
        this.activeTurn = { turnId, emit, verbosity: opts.verbosity, done: finish, accepted:accept, acc: "", runId, seenTools: new Set(),...(peerProjection?{peerProjection}:{}) };
        guard = setTimeout(() => {
          if (settled) return;
          emit({ type: "result", sessionId: this.sessionId, turnId, seq: 0, at: new Date().toISOString(), text: "", status: "timeout", final: true } as StreamEvent);
          finish();
          void this.gw.rpcOnConnection(policy.epoch,"chat.abort", { sessionKey: this.sessionKey,runId }, 5000).catch(() => {});
        }, 1800000);
        if (opts.signal?.aborted) { abort(); return; }
        opts.signal?.addEventListener("abort", abort, { once: true });
        dispatched=true;
        this.gw.rpcOnConnection(policy.epoch,"chat.send", {
          sessionKey: this.sessionKey, message, deliver: false, idempotencyKey: runId,
          ...(observed?{sessionId:observed.sessionId,expectedLeafEntryId:observed.leafId}:{}),
          ...(confirmedThinking ? {thinking:confirmedThinking} : {}),
        }, 1800000).then(accept).catch((err) => {
          if (settled) return;
          emit({ type: "error", sessionId: this.sessionId, turnId, seq: 0, at: new Date().toISOString(),
            message: (err as Error)?.message ?? "chat.send failed", status: "failed", final: true } as StreamEvent);
          finish();
        });
      });
      if(this.nativeTurns.get(turnId)?.ended&&!opts.signal?.aborted){
        // Visible final text can precede native run settlement and terminal replay publication.
        // Join only this accepted run; a wait timeout never authorizes a replacement execution.
        try{await this.gw.rpcOnConnection(policy.epoch,"agent.wait",{runId,timeoutMs:5000},6000);}catch{ /* Fresh native history still decides readiness. */ }
        try{this.native=await this.verifyNative();this.historyStarted=true;}catch{this.native=undefined;}
      }
    } finally {
      if(this.policyRelease===releasePolicy)this.policyRelease=undefined;
      await releasePolicy();await releasePeer?.();await release?.();
    }
  }

  async interrupt(): Promise<void> {
    await this.policyRelease?.();
    const turn = this.activeTurn;
    const runId=turn?.runId??[...this.nativeTurns.values()].reverse().find(value=>!value.ended)?.runId;
    if(!runId)return;
    try { await this.gw.rpc("chat.abort", { sessionKey: this.sessionKey,runId }, 5000); }
    finally { turn?.done(); }
  }

  async switchModel(model: string): Promise<{ warnings?: string[] }> {
    if(this.strictIdentity||this.native)await this.verifyNative(!this.historyStarted);
    const response = await this.gw.patchSessionModel(this.sessionKey, model);
    const resolved = response.resolved as { model?: string; modelProvider?: string; provider?: string } | undefined;
    if (!resolved?.model) throw new Error("OpenClaw sessions.patch did not return a resolved model");
    this.model = [resolved.modelProvider ?? resolved.provider, resolved.model].filter(Boolean).join("/");
    this.native=undefined;
    if(this.historyStarted)try{this.native=await this.verifyNative();}catch{}
    return {};
  }

  async inject(context: ContextItem[]): Promise<void> {
    if (context.length === 0) return;
    // chat.inject is UI/transcript-only in current Gateways; queue actual model input.
    this.pendingInject.push(...context.map((c) => `[${c.role}] ${c.content}`));
  }

  async compressCustom(strategy = "dropToolIO", options?: { keepRecentToolCalls?: number }): Promise<{ summary?: string; filesChanged?: number; recordsChanged?: number; blocksRemoved?: number; bytesBefore?: number; bytesAfter?: number; backups?: string[] }> {
    if (strategy !== "dropToolIO") throw new Error(`unsupported custom compression strategy: ${strategy}`);
    const file = this.resolveSessionFile();
    if (!file) throw new PhononError("errCapabilityUnsupported", "OpenClaw custom dropToolIO requires a legacy JSONL transcript; current Gateway owns SQLite transcripts and exposes no custom dropToolIO API");
    const r = await dropToolIOFromJsonlFiles([file], options);
    return { summary: `dropToolIO removed ${r.blocksRemoved} tool blocks from ${r.filesChanged} files`, ...r };
  }

  async compressNative(): Promise<{ applied: boolean; summary?: string }> {
    const result = await this.gw.rpc("sessions.compact", { key: this.sessionKey }, 120000);
    if (result.ok === false) throw new Error(`OpenClaw compaction failed: ${String(result.reason ?? "unknown")}`);
    if(result.compacted===false)return {applied:false,summary:"OpenClaw reported no compaction was needed"};
    if (result.compacted !== true) throw new PhononError("errCapabilityUnsupported", "OpenClaw did not return a verified compaction result");
    this.native=undefined;
    if(this.historyStarted)this.native=await this.verifyNative();
    return { applied:true,summary: "OpenClaw sessions.compact confirmed compacted=true" };
  }

  private resolveSessionFile(): string | undefined {
    const sessionsJson = join(homedir(), ".openclaw", "agents", this.openclawAgent, "sessions", "sessions.json");
    try {
      if (existsSync(sessionsJson)) {
        const sessions = JSON.parse(readFileSync(sessionsJson, "utf8")) as Record<string, { sessionId?: string }>;
        const id = sessions[this.sessionKey]?.sessionId;
        if (id) {
          const p = join(homedir(), ".openclaw", "agents", this.openclawAgent, "sessions", `${id}.jsonl`);
          if (existsSync(p)) return p;
        }
      }
    } catch {
      // fall through
    }
    return undefined;
  }

  async terminate(): Promise<void> {
    if(this.activeTurn||[...this.nativeTurns.values()].some(value=>!value.ended))await this.interrupt();
    this.closed=true;this.unsolicitedSink=undefined;this.detach?.();
    // 不删 transcript：留痕。仅停活动。
  }

  async describe(): Promise<{ contextWindow?: number; usedTokens?: number; compactions?: number }> {
    try {
      const d = await this.gw.rpc("sessions.describe", { key: this.sessionKey }, 8000);
      const sess = (d.session ?? {}) as Record<string, unknown>;
      return {
        contextWindow: typeof sess.contextTokens === "number" ? sess.contextTokens : undefined,
        usedTokens: typeof sess.usedContextTokens === "number" ? sess.usedContextTokens : undefined,
        compactions: typeof sess.compactions === "number" ? sess.compactions : undefined,
      };
    } catch {
      return {};
    }
  }
}

export class OpenClawGatewayAdapter implements AgentAdapter {
  readonly name = "openclaw";
  readonly capabilities = {...CAPABILITIES};
  private gw: GatewayClient;
  private defaultAgent: string;
  private gatewayIdentity:string|undefined;
  private generation=0;
  private recovering=new Set<string>();
  private sessions = new Map<string, GatewaySession>(); // sessionKey → session
  /** agentId(openclaw:sub) → workspace 路径（从 agents.list 缓存，用于 global skill 目录）。 */
  private workspaceCache = new Map<string, string>();

  constructor(opts: { gateway: GatewayConfig; defaultAgent?: string }) {
    this.gw = new GatewayClient(opts.gateway);
    this.defaultAgent = opts.defaultAgent ?? "main";
    try{this.gatewayIdentity=recoveryGatewayIdentity(opts.gateway.baseUrl);}catch{}
    // 路由 Gateway 事件到对应 session（按 sessionKey 过滤，不串台）
    this.gw.onEvent((event, payload) => {
      const sk = payload.sessionKey as string | undefined;
      if (!sk) return;
      const session = this.sessions.get(sk);
      session?.handleEvent(event, payload);
    });
  }

  async discoverAgents(signal?: AbortSignal): Promise<AgentDescriptor[]> {
    signal?.throwIfAborted();
    this.capabilities.injectMidTurn=false;
    let connected = false;
    try {
      await this.gw.connect();
      connected = this.gw.isConnected();
    } catch {
      connected = false;
    }
    signal?.throwIfAborted();
    if (!connected) {
      return [
        {
          agentId: "openclaw" as AgentDescriptor["agentId"],
          displayName: "OpenClaw",
          adapter: "openclaw",
          available: false,
          unavailableReason: "OpenClaw Gateway not reachable",
          models: [],
          capabilities: this.capabilities,
          scannedAt: new Date().toISOString(),
        },
      ];
    }

    if(this.gatewayIdentity){
      try{this.capabilities.injectMidTurn=OpenClawInputCapabilities.safeParse(await this.gw.rpc("phonon.peers.capabilities",{version:1},5000)).success;}
      catch{/* Optional current-turn input must not block native inventory. */}
    }
    signal?.throwIfAborted();

    // 枚举该 Gateway 下所有 OpenClaw agent（按 workspace 分）
    let subAgents: Array<{ id: string; name?: string; workspace?: string; model?: { primary?: string } | string }> = [];
    const r = await this.gw.rpc("agents.list", {}, 8000);
    signal?.throwIfAborted();
    if (!Array.isArray(r.agents)) throw new Error("invalid Gateway agent inventory");
    subAgents = r.agents as typeof subAgents;
    if (subAgents.length === 0) subAgents = [{ id: this.defaultAgent }];

    const now = new Date().toISOString();
    const descriptors:AgentDescriptor[]=[];
    for (const a of subAgents) {
      const gatewayModels = await this.listGatewayModels(a.id);
      signal?.throwIfAborted();
      if (a.workspace) this.workspaceCache.set(`openclaw:${a.id}`, a.workspace);
      const primaryModel =
        typeof a.model === "string" ? a.model : a.model?.primary;
      // 优先报 Gateway 的完整可用模型目录；拿不到时退回 agents.list 的 primary。
      const models = gatewayModels.length > 0 ? gatewayModels : (primaryModel ? [{ id: primaryModel, available: true }] : []);
      descriptors.push({
        // 复合 agentId：openclaw:<subAgentId>（design D32）
        agentId: `openclaw:${a.id}` as AgentDescriptor["agentId"],
        displayName: `OpenClaw / ${a.name?.trim()&&a.name.trim()!==a.id?`${a.name.trim()} (${a.id})`:a.id}`,
        adapter: "openclaw",
        available: true,
        models,
        capabilities: this.capabilities,
        scannedAt: now,
      });
    }
    return descriptors;
  }

  private async listGatewayModels(agentId:string): Promise<ModelInfo[]> {
    try {
      const r = await this.gw.rpc("models.list", { view: "default", agentId }, 8000);
      return parseOpenClawNativeModels(r);
    } catch {
      // Preserve the shared inventory instead of manufacturing model removals.
      throw new Error("Gateway model inventory scan failed");
    }
  }

  async createSession(params: CreateSessionParams): Promise<AdapterSession> {
    if(params.reattach)throw new PhononError("errSessionBusy","OpenClaw recovery requires a verified native checkpoint");
    await this.gw.connect();
    // 从复合 agentId 解出 OpenClaw sub-agent：openclaw:phonon → phonon
    const subAgent = params.employee?.runtimeProfile??
      (params.agentConfig?.openclawAgent as string) ??
      (params.agentId.includes(":") ? params.agentId.split(":")[1]! : this.defaultAgent);
    const session = new GatewaySession(this.gw, params.sessionId, params.model, subAgent, params.initialContext,params.upstreamRuns,params,this.gatewayIdentity,undefined,()=>{if(this.sessions.get(session.key)===session)this.sessions.delete(session.key);},this.capabilities.injectMidTurn);
    // sessions.create 失败要外显（修 P0#6），不能静默吞
    try {
      session.bindCreatedIdentity(await this.gw.rpc("sessions.create", { key: session.key, model: params.model,cwd:params.cwd,worktree:false }, 15000));
    } catch (err) {
      throw new Error(`OpenClaw sessions.create failed: ${(err as Error)?.message ?? "?"}`);
    }
    // 订阅自发输出（proactiveOutput）；订阅失败不致命，记警告即可
    await session.subscribe().catch((e) => {
      console.warn(`[openclaw-gateway] subscribe failed for ${session.key}: ${(e as Error)?.message}`);
    });
    this.sessions.set(session.key, session);
    if(this.capabilities.injectMidTurn)await session.preparePeerContext();
    return session;
  }

  async recoverSession(params:CreateSessionParams,checkpoint:Record<string,unknown>):Promise<AdapterSession>{
    const parsed=OpenClawCheckpoint.safeParse(checkpoint);
    if(!parsed.success||!this.gatewayIdentity)throw new PhononError("errCapabilityUnsupported","OpenClaw native recovery checkpoint or Gateway is unsupported");
    const saved=parsed.data,agent=params.employee?.runtimeProfile??(params.agentConfig?.openclawAgent as string)??(params.agentId.includes(":")?params.agentId.split(":")[1]!:this.defaultAgent);
    if(saved.gateway!==this.gatewayIdentity||saved.phononSessionId!==params.sessionId||saved.model!==params.model||saved.native.agent!==agent||saved.employeeId!==params.employee?.employeeId||saved.native.sessionKey!==`agent:${agent}:phonon-${params.sessionId}`||this.sessions.has(saved.native.sessionKey)||this.recovering.has(saved.native.sessionKey))throw new PhononError("errSessionBusy","OpenClaw recovery identity changed or is already attached");
    const generation=this.generation;this.recovering.add(saved.native.sessionKey);
    try{
    await this.gw.connect();
    const current=await observeOpenClawSession(this.gw,saved.native.sessionKey,agent,params.cwd,params.model);
    if(!sameOpenClawSession(saved.native,current))throw new PhononError("errSessionBusy","OpenClaw native history identity changed");
    const session=new GatewaySession(this.gw,params.sessionId,params.model,agent,undefined,params.upstreamRuns,params,this.gatewayIdentity,{...saved,native:current},()=>{if(this.sessions.get(session.key)===session)this.sessions.delete(session.key);},this.capabilities.injectMidTurn);
    await session.subscribe().catch(()=>{});
    if(this.capabilities.injectMidTurn)await session.preparePeerContext();
    if(generation!==this.generation){await session.terminate();throw new PhononError("errSessionBusy","OpenClaw adapter closed during recovery");}
    this.sessions.set(session.key,session);return session;
    }finally{this.recovering.delete(saved.native.sessionKey);}
  }

  /** 关闭 Gateway 连接（daemon 退出时）。 */
  close(): void {
    this.generation++;
    this.gw.close();
  }

  /** OpenClaw 某 sub-agent 的 global skill 目录 = 该 agent workspace/skills。 */
  globalSkillDir(agentId: string): string | undefined {
    const ws = this.workspaceCache.get(agentId);
    return ws ? `${ws}/skills` : undefined;
  }
  async provisionEmployee(target:EmployeeProfileTarget):Promise<EmployeeProfileObservation>{
    const generation=this.generation;
    const active=()=>{if(generation!==this.generation)throw new PhononError("errSessionBusy","OpenClaw adapter closed during employee provisioning");};
    await this.gw.connect();
    active();
    const listing=await this.gw.rpc("agents.list",{},15000) as {agents:Array<{id:string;workspace?:string}>};
    active();
    const existing=listing.agents.find(agent=>agent.id===target.runtimeProfile);
    if(!existing){
      const created=await this.gw.rpc("agents.create",{name:target.runtimeProfile,workspace:target.workspace,model:target.input.model},20000) as {agentId?:string;workspace?:string};
      active();
      if(created.agentId!==target.runtimeProfile||created.workspace!==target.workspace)throw new PhononError("employee_profile_identity_changed");
      await this.waitForCreatedEmployee(target,active);
    }else await this.verifyEmployeeOwner(target,existing.workspace,!target.previousHashes);
    active();
    await this.gw.rpc("agents.update",{agentId:target.runtimeProfile,name:target.input.name,model:target.input.model},15000);
    active();
    const marker=this.employeeMarker(target);
    await this.gw.rpc("agents.files.set",{agentId:target.runtimeProfile,name:"IDENTITY.md",content:`# Identity\n\nName: ${target.input.name}\n${marker}`},15000);
    for(const [name,content]of Object.entries(employeeDocuments(target.input))){
      active();
      if(target.previousHashes){
        const current=await this.employeeFile(target,name),hash=this.fileHash(current??"");
        if(hash!==target.previousHashes[name]&&hash!==this.fileHash(content))throw new PhononError("employee_profile_local_changes");
      }
      active();
      try{await this.gw.rpc("agents.files.set",{agentId:target.runtimeProfile,name,content},15000);}
      catch(error){
        if(!this.unsupportedEmployeeFile(error,name))throw error;
        if(name!=="TOOLS.md"||content!=="")throw new PhononError("employee_profile_native_file_unsupported",`OpenClaw does not accept ${name}; nonempty guidance was not applied`);
      }
    }
    active();
    // Existing DEs require an operator-scoped migration; only a new, controller-
    // owned profile (including an interrupted first provision) inherits opt-in.
    if(!target.previousHashes&&/^phn-[a-f0-9]{40}$/.test(target.runtimeProfile))await this.enableNewEmployeeNativeTools(target,active);
    active();const observation=await this.inspectEmployee(target);active();return observation;
  }
  private async enableNewEmployeeNativeTools(target:EmployeeProfileTarget,active:()=>void):Promise<void>{
    const epoch=this.gw.connectionEpoch();
    let raw:Record<string,unknown>;
    try{raw=await this.gw.rpc("config.get",{},10000);}
    catch(error){
      const cause=error instanceof Error?error.cause as {code?:unknown;message?:unknown}|undefined:undefined;
      if(["FORBIDDEN","UNAUTHORIZED","METHOD_NOT_FOUND",-32601].some(code=>code===cause?.code)||cause?.code==="INVALID_REQUEST"&&/unknown method.*config\.get/i.test(String(cause.message)))return;
      throw error;
    }
    active();
    const optIn=(value:unknown):boolean=>{
      const config=(value as {config?:{plugins?:{enabled?:boolean;entries?:Record<string,{enabled?:boolean;config?:{nativeInteractions?:boolean}}>}}})?.config;
      const plugin=config?.plugins?.entries?.[PHONON_PLUGIN];
      return config?.plugins?.enabled!==false&&plugin?.enabled===true&&plugin.config?.nativeInteractions===true;
    };
    if(!optIn(raw))return; // Ordinary profile creation is independent of this plugin.
    if(!this.gatewayIdentity)throw new PhononError("errPolicyDenied","Managed native tools require a local Gateway");
    const parsed=nativeConfigSnapshot.safeParse(raw);
    if(!parsed.success)throw new PhononError("errCapabilityUnsupported","OpenClaw native tools require verified config.get/CAS support");
    const saved=parsed.data,config=saved.config,entry=config.agents.entries[target.runtimeProfile];
    const reloadMode=config.gateway?.reload?.mode;
    if(!config.plugins.allow?.includes(PHONON_PLUGIN)||reloadMode!==undefined&&!["hybrid","hot"].includes(reloadMode))throw new PhononError("errPolicyDenied","Native plugin policy or hot config application is not enabled");
    if(!entry||entry.workspace!==target.workspace||basename(target.workspace)!==target.input.employeeId)throw new PhononError("employee_profile_owner_conflict");
    const current=()=>{active();if(this.gw.connectionEpoch()!==epoch)throw new PhononError("errSessionBusy","OpenClaw transport changed during native tool provisioning");};
    current();
    const policies=[config.tools,entry.tools].filter(Boolean) as Array<z.infer<typeof nativeToolPolicy>>;
    for(const policy of [...policies])if(policy.byProvider!==undefined){
      const providers=z.record(nativeToolPolicy).safeParse(policy.byProvider);
      if(!providers.success)throw new PhononError("errPolicyDenied","Unrecognized provider tool policy");
      if(Object.values(providers.data).some(value=>value.allow&&PHONON_OPTIONAL_TOOLS.some(name=>!coversNativeTool(value.allow,name))))throw new PhononError("errPolicyDenied","Provider tool allowlist does not permit native tools");
      policies.push(...Object.values(providers.data));
    }
    for(const policy of policies)if(PHONON_OPTIONAL_TOOLS.some(name=>coversNativeTool(policy.deny,name)))throw new PhononError("errPolicyDenied","Explicit native tool denial was preserved");
    if(config.tools?.allow&&PHONON_OPTIONAL_TOOLS.some(name=>!coversNativeTool(config.tools?.allow,name)))throw new PhononError("errPolicyDenied","Global tool allowlist does not permit native tools");
    const tools=entry.tools??{};
    if(tools.allow&&tools.alsoAllow)throw new PhononError("errPolicyDenied","Ambiguous native tool allowlist");
    const field=tools.allow?"allow":"alsoAllow",before=tools[field]??[],merged=[...new Set([...before,...PHONON_OPTIONAL_TOOLS])];
    await this.verifyNativeToolOwner(target);current();
    await this.verifyEmployeeOwner(target,target.workspace);current();
    if(PHONON_OPTIONAL_TOOLS.every(name=>before.includes(name)))return;
    const rawPatch=JSON.stringify({agents:{entries:{[target.runtimeProfile]:{tools:{[field]:merged}}}}});
    let receipt:Record<string,unknown>;
    try{receipt=await this.gw.rpc("config.patch",{baseHash:saved.hash,raw:rawPatch},15000);}
    catch{throw new PhononError("employee_profile_native_tools_unconfirmed","Native tool policy change was rejected or unconfirmed; inspect the same owned profile before retrying");}
    current();
    if(receipt.ok!==true||typeof receipt.hash!=="string"||receipt.restart)throw new PhononError("employee_profile_native_tools_unconfirmed","Native tool policy was not confirmed as a hot configuration update");
    const observed=nativeConfigSnapshot.safeParse(await this.gw.rpc("config.get",{},10000));current();
    if(!observed.success||observed.data.hash!==receipt.hash||!optIn(observed.data))throw new PhononError("employee_profile_native_tools_unconfirmed","Native tool policy readback was not confirmed");
    const expected=structuredClone(config);expected.agents.entries[target.runtimeProfile]!.tools={...tools,[field]:merged};
    const canonical=(value:unknown):string=>JSON.stringify(value,(_key,item)=>item&&typeof item==="object"&&!Array.isArray(item)?Object.fromEntries(Object.entries(item).sort(([a],[b])=>a<b?-1:a>b?1:0)):item);
    const settings=(value:typeof config)=>{const copy=structuredClone(value),meta=copy.meta as Record<string,unknown>|undefined;if(meta&&typeof meta==="object"){delete meta.lastTouchedAt;delete meta.lastTouchedVersion;if(!Object.keys(meta).length)delete copy.meta;}return copy;};
    if(canonical(settings(observed.data.config))!==canonical(settings(expected)))throw new PhononError("employee_profile_native_tools_unconfirmed","Native config or ownership changed during scoped tool provisioning");
    await this.verifyNativeToolOwner(target);current();
    await this.verifyEmployeeOwner(target,target.workspace);current();
  }
  private async verifyNativeToolOwner(target:EmployeeProfileTarget):Promise<void>{
    const directory=await lstat(target.workspace);
    if(!directory.isDirectory()||directory.isSymbolicLink()||await realpath(target.workspace)!==target.workspace||typeof process.getuid!=="function"||directory.uid!==process.getuid()||(directory.mode&0o022)!==0)throw new PhononError("employee_profile_owner_conflict");
    const marker=await open(join(target.workspace,".phonon-employee"),constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
    try{const stat=await marker.stat();if(!stat.isFile()||stat.nlink!==1||stat.uid!==process.getuid()||(stat.mode&0o022)!==0||stat.size>256||await marker.readFile("utf8")!==target.nonce)throw new PhononError("employee_profile_owner_conflict");}finally{await marker.close();}
  }
  private async waitForCreatedEmployee(target:EmployeeProfileTarget,active:()=>void){
    const until=Date.now()+5000;let delay=50;
    while(Date.now()<until){
      active();
      const listing=await this.gw.rpc("agents.list",{},Math.max(1,until-Date.now())) as {agents:Array<{id:string;workspace?:string}>};
      active();
      const created=listing.agents.find(agent=>agent.id===target.runtimeProfile);
      if(created){if(created.workspace!==target.workspace)throw new PhononError("employee_profile_identity_changed");return;}
      // Creation persists config before the Gateway's runtime snapshot refreshes.
      await new Promise(resolve=>setTimeout(resolve,Math.min(delay,Math.max(1,until-Date.now()))));
      delay=Math.min(delay*2,500);
    }
    active();throw new PhononError("employee_profile_native_pending","Native profile creation was acknowledged but runtime visibility is unconfirmed");
  }
  async inspectEmployee(target:EmployeeProfileTarget):Promise<EmployeeProfileObservation>{
    await this.gw.connect();const listing=await this.gw.rpc("agents.list",{},15000) as {agents:Array<{id:string;workspace?:string}>};
    const agent=listing.agents.find(agent=>agent.id===target.runtimeProfile);if(!agent)throw new PhononError("employee_profile_missing");
    await this.verifyEmployeeOwner(target,agent.workspace);
    const documentHashes:Record<string,string>={};
    for(const name of Object.keys(employeeDocuments(target.input))){
      const content=await this.employeeFile(target,name);
      if(content===undefined&&(name!=="TOOLS.md"||target.input.documents.tools!==""))throw new PhononError("employee_profile_file_missing");
      documentHashes[name]=this.fileHash(content??"");
    }
    const memory=await this.employeeFile(target,"MEMORY.md");
    return {documentHashes,memoryBytes:Buffer.byteLength(memory??""),home:target.workspace};
  }
  private fileHash(content:string){return createHash("sha256").update(content).digest("hex");}
  private employeeMarker(target:EmployeeProfileTarget){return `<!-- phonon-employee:${target.input.employeeId}:${target.nonce} -->`;}
  private async employeeFile(target:EmployeeProfileTarget,name:string):Promise<string|undefined>{
    let result:{workspace?:string;file?:{missing?:boolean;content?:string}};
    try{result=await this.gw.rpc("agents.files.get",{agentId:target.runtimeProfile,name},15000) as typeof result;}
    catch(error){
      if(name==="TOOLS.md"&&target.input.documents.tools===""&&this.unsupportedEmployeeFile(error,name))return undefined;
      throw error;
    }
    if(result.workspace!==target.workspace)throw new PhononError("employee_profile_identity_changed");
    return result.file?.missing?undefined:result.file?.content;
  }
  private unsupportedEmployeeFile(error:unknown,name:string):boolean{
    const cause=error instanceof Error?error.cause as {code?:unknown;message?:unknown}|undefined:undefined;
    return cause?.code==="INVALID_REQUEST"&&cause.message===`unsupported file "${name}"`;
  }
  private async verifyEmployeeOwner(target:EmployeeProfileTarget,workspace?:string,bootstrap=false){
    if(workspace!==target.workspace)throw new PhononError("employee_profile_owner_conflict");
    const identity=await this.employeeFile(target,"IDENTITY.md");
    if(identity?.includes(this.employeeMarker(target)))return;
    if(bootstrap&&!identity?.includes("phonon-employee:")){
      const marker=await open(join(target.workspace,".phonon-employee"),constants.O_RDONLY|constants.O_NOFOLLOW);
      try{const stat=await marker.stat();if(stat.isFile()&&stat.nlink===1&&stat.size<=256&&await marker.readFile("utf8")===target.nonce)return;}finally{await marker.close();}
    }
    throw new PhononError("employee_profile_owner_conflict");
  }
}
