import { readFileSync } from "node:fs";
import { ToolLoopAgent, stepCountIs, tool } from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { z } from "zod";
import type { AgentAdapter, AdapterSession, CreateSessionParams, SendOptions } from "../adapter.js";
import { formatInitialContextLines } from "../adapter.js";
import type { MaintenanceRuntime } from "../maintenance.js";
import type { AgentCapabilities, AgentDescriptor, ContextItem, StreamEvent } from "@agent-phonon/protocol";

const CAPABILITIES: AgentCapabilities = {
  nativeSession: false,
  nativeCompression: false,
  contextInjection: true,
  proactiveOutput: false,
  modelSwitch: false,
  interrupt: true,
  injectMidTurn: false,
  skillManagement: false,
  hooks: ["pre_tool", "pre_command"],
  streaming: true,
  workflowRoles: ["executor", "worker"],
  limits: { maxConcurrentSessions: 2 },
};

export interface RescueAdapterOptions {
  baseUrl?: string;
  apiKey?: string;
  apiKeyEnv?: string;
  apiKeyRef?: string;
  defaultModel?: string;
  maxSteps?: number;
  timeoutMs?: number;
}

const SYSTEM = `You are phonon-rescue, the built-in recovery agent inside agent-phonon.
Your only purpose is diagnosing and repairing locally registered AI-agent runtimes.

Hard rules:
- Use only the provided semantic maintenance tools. You do not have a shell or arbitrary file access.
- Local device policy is authoritative. Never claim a denied operation succeeded.
- Start with list_targets or diagnose before changing anything.
- Before patching JSON, call get_config and pass its exact sha256 to patch_config.
- Never guess targetId, configId, serviceId, package name, path, or secret.
- Config reads are redacted. Never replace a redacted secret ("***") unless the user explicitly supplied a real new value.
- For changes: explain the plan briefly, patch one logical change, diagnose/verify, and rollback on failed verification.
- Package updates and service restarts are high impact. Use them only when the task requires them and policy allows them.
- You cannot use sudo/root, install arbitrary system packages, delete files, push code, or modify agent-phonon itself outside configured maintenance operations.
- Be concise and report concrete evidence from tool results.`;

class RescueSession implements AdapterSession {
  readonly sessionId: string;
  model: string;
  private readonly opts: RescueAdapterOptions;
  private readonly maintenance: MaintenanceRuntime;
  private pendingContext: string[] = [];
  private currentAbort?: AbortController;

  constructor(params: CreateSessionParams, opts: RescueAdapterOptions, maintenance: MaintenanceRuntime) {
    this.sessionId = params.sessionId;
    this.model = params.model && params.model !== "default" ? params.model : (opts.defaultModel ?? "default");
    this.opts = opts;
    this.maintenance = maintenance;
    this.pendingContext.push(...formatInitialContextLines(params.initialContext));
  }

  async send(input: string, opts: SendOptions): Promise<void> {
    const key = this.resolveApiKey();
    if (!this.opts.baseUrl || !key || !this.model || this.model === "default") {
      throw new Error("phonon-rescue is not configured: baseUrl, API key, and model are required");
    }
    let prompt = input;
    if (this.pendingContext.length) {
      prompt = this.pendingContext.join("\n") + "\n\n" + prompt;
      this.pendingContext = [];
    }
    const provider = createOpenAICompatible({
      name: "phonon-rescue",
      baseURL: this.opts.baseUrl.replace(/\/+$/, ""),
      apiKey: key,
      includeUsage: true,
    });
    const tools = this.createTools();
    const agent = new ToolLoopAgent({
      model: provider(this.model),
      instructions: SYSTEM,
      tools,
      stopWhen: stepCountIs(Math.max(1, Math.min(this.opts.maxSteps ?? 12, 30))),
    });
    const localAbort = new AbortController();
    this.currentAbort = localAbort;
    const forwardAbort = (): void => localAbort.abort(opts.signal?.reason);
    if (opts.signal?.aborted) forwardAbort();
    else opts.signal?.addEventListener("abort", forwardAbort, { once: true });
    const { turnId, emit } = opts;
    let acc = "";
    try {
      const result = await agent.stream({
        prompt,
        abortSignal: localAbort.signal,
        timeout: this.opts.timeoutMs ?? 300_000,
      });
      for await (const part of result.fullStream) {
        const at = new Date().toISOString();
        if (part.type === "text-delta") {
          acc += part.text;
          emit({ type: "message", sessionId: this.sessionId, turnId, seq: 0, at, role: "assistant", text: part.text, delta: true } as StreamEvent);
        } else if (part.type === "tool-call") {
          emit({ type: "tool_call", sessionId: this.sessionId, turnId, seq: 0, at, toolName: part.toolName, args: part.input, toolCallId: part.toolCallId } as StreamEvent);
        } else if (part.type === "tool-result") {
          emit({ type: "tool_result", sessionId: this.sessionId, turnId, seq: 0, at, toolName: part.toolName, toolCallId: part.toolCallId, ok: true, output: part.output } as StreamEvent);
        } else if (part.type === "tool-error") {
          emit({ type: "tool_result", sessionId: this.sessionId, turnId, seq: 0, at, toolName: part.toolName, toolCallId: part.toolCallId, ok: false, output: String(part.error) } as StreamEvent);
        } else if (part.type === "error") {
          throw part.error;
        }
      }
      emit({ type: "result", sessionId: this.sessionId, turnId, seq: 0, at: new Date().toISOString(), text: acc, status: "completed", final: true } as StreamEvent);
    } finally {
      this.currentAbort = undefined;
      opts.signal?.removeEventListener("abort", forwardAbort);
    }
  }

  async interrupt(): Promise<void> {
    this.currentAbort?.abort("interrupted");
  }

  async inject(context: ContextItem[]): Promise<void> {
    for (const item of context) this.pendingContext.push(`[${item.role}] ${item.content}`);
  }

  async terminate(): Promise<void> {
    await this.interrupt();
  }

  private resolveApiKey(): string | undefined {
    if (this.opts.apiKeyEnv && process.env[this.opts.apiKeyEnv]) return process.env[this.opts.apiKeyEnv];
    if (this.opts.apiKeyRef) {
      try { return readFileSync(this.opts.apiKeyRef, "utf8").trim() || this.opts.apiKey; } catch { /* unavailable */ }
    }
    return this.opts.apiKey ?? process.env.PHONON_RESCUE_API_KEY;
  }

  private createTools() {
    const maintenance = this.maintenance;
    return {
      list_targets: tool({
        description: "List locally registered maintenance targets and current permissions.",
        inputSchema: z.object({}),
        execute: async () => maintenance.targets(),
      }),
      diagnose: tool({
        description: "Diagnose one registered target or all targets: executable, config validity, and service status.",
        inputSchema: z.object({ targetId: z.string().optional() }),
        execute: async ({ targetId }, toolOpts) => maintenance.diagnose(targetId, toolOpts.abortSignal),
      }),
      get_config: tool({
        description: "Read a registered JSON config with secret-looking values redacted. Returns sha256 for optimistic locking.",
        inputSchema: z.object({ targetId: z.string(), configId: z.string() }),
        execute: async ({ targetId, configId }) => maintenance.configGet(targetId, configId),
      }),
      patch_config: tool({
        description: "Apply an RFC 7396 JSON merge patch to a registered config. Creates a checksum-verified rollback backup.",
        inputSchema: z.object({ targetId: z.string(), configId: z.string(), expectedSha256: z.string(), patch: z.record(z.unknown()), reason: z.string().max(500).optional() }),
        execute: async (input) => maintenance.configPatch(input),
      }),
      rollback_config: tool({
        description: "Restore a config from a backupId returned by patch_config. Requires the current config sha256 so stale rollback cannot overwrite later edits.",
        inputSchema: z.object({ backupId: z.string(), expectedCurrentSha256: z.string(), reason: z.string().max(500).optional() }),
        execute: async ({ backupId, expectedCurrentSha256, reason }) => maintenance.rollback(backupId, expectedCurrentSha256, reason),
      }),
      update_package: tool({
        description: "Update the pre-registered user-level npm/pnpm package for a target. Cannot choose arbitrary package names.",
        inputSchema: z.object({ targetId: z.string(), version: z.string().optional() }),
        execute: async ({ targetId, version }, toolOpts) => maintenance.packageUpdate(targetId, version, toolOpts.abortSignal),
      }),
      service_status: tool({
        description: "Get status for a pre-registered user service.",
        inputSchema: z.object({ targetId: z.string(), serviceId: z.string() }),
        execute: async ({ targetId, serviceId }, toolOpts) => maintenance.serviceStatus(targetId, serviceId, toolOpts.abortSignal),
      }),
      restart_service: tool({
        description: "Restart a pre-registered user service, then return its status.",
        inputSchema: z.object({ targetId: z.string(), serviceId: z.string() }),
        execute: async ({ targetId, serviceId }, toolOpts) => maintenance.serviceRestart(targetId, serviceId, toolOpts.abortSignal),
      }),
    };
  }
}

export class RescueAdapter implements AgentAdapter {
  readonly name = "phonon-rescue";
  readonly capabilities = CAPABILITIES;
  private readonly opts: RescueAdapterOptions;

  constructor(opts: RescueAdapterOptions = {}) {
    this.opts = opts;
  }

  async discoverAgents(): Promise<AgentDescriptor[]> {
    let key = this.opts.apiKeyEnv ? process.env[this.opts.apiKeyEnv] ?? this.opts.apiKey : this.opts.apiKey ?? process.env.PHONON_RESCUE_API_KEY;
    if (!key && this.opts.apiKeyRef) {
      try { key = readFileSync(this.opts.apiKeyRef, "utf8").trim(); } catch { /* unavailable */ }
    }
    const configured = !!this.opts.baseUrl && !!key && !!this.opts.defaultModel;
    return [{
      agentId: "phonon-rescue" as AgentDescriptor["agentId"],
      displayName: "phonon-rescue (built-in)",
      adapter: this.name,
      available: configured,
      ...(configured ? {} : { unavailableReason: "configure rescueAgent.baseUrl, rescueAgent.model, and API key/apiKeyEnv/apiKeyRef" }),
      models: this.opts.defaultModel ? [{ id: this.opts.defaultModel, available: configured }] : [],
      capabilities: CAPABILITIES,
      scannedAt: new Date().toISOString(),
    }];
  }

  async createSession(params: CreateSessionParams): Promise<AdapterSession> {
    if (!params.runtimeContext?.maintenance) throw new Error("phonon-rescue requires tenant-bound maintenance runtime");
    const requested = params.model && params.model !== "default" ? params.model : this.opts.defaultModel;
    if (!requested || (this.opts.defaultModel && requested !== this.opts.defaultModel)) {
      throw new Error(`phonon-rescue only allows the locally configured model ${this.opts.defaultModel ?? "(none)"}`);
    }
    return new RescueSession({ ...params, model: requested }, this.opts, params.runtimeContext.maintenance);
  }
}
