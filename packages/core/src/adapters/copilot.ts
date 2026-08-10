import type { ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawnAgent } from "../proc.js";
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
 * GitHub Copilot CLI adapter.
 *
 * Current official CLI entrypoint: `copilot` (not the retired `gh copilot`
 * extension). Programmatic turns use piped stdin plus JSONL streaming:
 *
 *   copilot --name=<name> --output-format json --stream on --allow-all
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
  hooks: ["pre_tool", "pre_command"],
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

function configuredModel(): string | undefined {
  const home = process.env.COPILOT_HOME ?? join(homedir(), ".copilot");
  const path = join(home, "settings.json");
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
  private current?: ChildProcess;
  private pendingInject: string[] = [];
  private nativeSessionId?: string;

  constructor(
    sessionId: string,
    model: string,
    cwd: string,
    env: CopilotEnv,
    initialContext?: ContextItem[],
    reattach = false,
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
    let prompt = input;
    if (this.pendingInject.length > 0) {
      prompt = this.pendingInject.join("\n") + "\n\n" + prompt;
      this.pendingInject = [];
    }
    if (opts.skills?.length) {
      prompt = `[Use these skills for this turn: ${opts.skills.join(", ")}]\n\n${prompt}`;
    }

    const args = [
      this.started ? `--resume=${this.nativeName}` : `--name=${this.nativeName}`,
      "--output-format", "json",
      "--stream", "on",
      "--allow-all",
      "--no-ask-user",
      "--no-remote",
      "--no-auto-update",
      "--no-color",
    ];
    if (this.model && this.model !== "default") args.push("--model", this.model);
    await this.run(args, prompt + "\n", opts);
  }

  private run(args: string[], stdin: string, opts: SendOptions): Promise<void> {
    return new Promise((resolve) => {
      const { turnId, emit } = opts;
      const child = spawnAgent(this.env.binPath ?? "copilot", args, {
        cwd: this.cwd,
        env: { ...process.env, ...(opts.environment ?? {}) } as NodeJS.ProcessEnv,
      });
      this.current = child;
      let stdoutBuf = "";
      let stderr = "";
      let acc = "";
      let settled = false;
      const toolNames = new Map<string, string>();

      const finish = (status: "completed" | "failed" | "interrupted" | "timeout", message?: string): void => {
        if (settled) return;
        settled = true;
        clearTimeout(guard);
        this.current = undefined;
        if (status === "completed") this.started = true;
        const now = new Date().toISOString();
        if (status === "failed") {
          emit({
            type: "error", sessionId: this.sessionId, turnId, seq: 0, at: now,
            message: message ?? "copilot failed", status: "failed", final: true,
          } as StreamEvent);
        } else {
          emit({
            type: "result", sessionId: this.sessionId, turnId, seq: 0, at: now,
            text: acc, status, final: true,
          } as StreamEvent);
        }
        resolve();
      };

      const guard = setTimeout(() => {
        child.kill("SIGTERM");
        finish("timeout", "copilot turn timed out");
      }, 1800000);
      const abort = (): void => {
        child.kill("SIGTERM");
        finish("interrupted");
      };
      if (opts.signal?.aborted) abort();
      else opts.signal?.addEventListener("abort", abort, { once: true });

      const handleLine = (line: string): void => {
        if (!line.trim()) return;
        let raw: unknown;
        try { raw = JSON.parse(line); } catch { return; }
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
        } else if (parsed.kind === "result" && parsed.nativeSessionId) {
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
      child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
      child.on("error", (error) => finish("failed", error.message));
      child.on("close", (code) => {
        if (settled) return;
        if (stdoutBuf.trim()) handleLine(stdoutBuf);
        finish(code === 0 ? "completed" : "failed", code === 0
          ? undefined
          : (stderr.trim() || `copilot exited ${code}`));
      });

      if (!settled) {
        child.stdin.write(stdin);
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

export class CopilotAdapter implements AgentAdapter {
  readonly name = "copilot";
  readonly capabilities = CAPABILITIES;
  private readonly env: CopilotEnv;

  constructor(opts: { env?: CopilotEnv } = {}) {
    this.env = opts.env ?? {};
  }

  async discoverAgents(): Promise<AgentDescriptor[]> {
    const version = await this.probeVersion();
    const available = version !== null;
    const models = available ? await this.discoverModels() : this.fallbackModels();
    return [{
      agentId: "copilot" as AgentDescriptor["agentId"],
      displayName: "GitHub Copilot CLI",
      adapter: "copilot",
      available,
      ...(available ? {} : { unavailableReason: "copilot CLI not found" }),
      ...(version ? { version } : {}),
      models,
      capabilities: CAPABILITIES,
      scannedAt: new Date().toISOString(),
    }];
  }

  async createSession(params: CreateSessionParams): Promise<AdapterSession> {
    const model = params.model && params.model !== "default"
      ? params.model
      : (this.env.defaultModel ?? "default");
    return new CopilotSession(
      params.sessionId,
      model,
      params.cwd,
      this.env,
      params.initialContext,
      params.reattach,
    );
  }

  private fallbackModels(): ModelInfo[] {
    const model = this.env.defaultModel ?? configuredModel() ?? "default";
    return [{ id: model, available: true }];
  }

  private discoverModels(): Promise<ModelInfo[]> {
    if (this.env.models?.length) return Promise.resolve(this.env.models);
    return new Promise((resolve) => {
      const child = spawnAgent(this.env.binPath ?? "copilot", ["help", "config"], {});
      let out = "";
      child.stdout.on("data", (chunk) => { out += chunk.toString(); });
      child.on("error", () => resolve(this.fallbackModels()));
      child.on("close", (code) => {
        const parsed = code === 0 ? parseCopilotModelsHelp(out) : [];
        const configured = this.env.defaultModel ?? configuredModel();
        if (configured && !parsed.some((m) => m.id === configured)) parsed.unshift({ id: configured, available: true });
        resolve(parsed.length ? parsed : this.fallbackModels());
      });
    });
  }

  private probeVersion(): Promise<string | null> {
    return new Promise((resolve) => {
      const child = spawnAgent(this.env.binPath ?? "copilot", ["--version"], {});
      let out = "";
      child.stdout.on("data", (chunk) => { out += chunk.toString(); });
      child.on("error", () => resolve(null));
      child.on("close", (code) => resolve(code === 0 ? out.trim().split(/\r?\n/)[0] ?? null : null));
    });
  }
}
