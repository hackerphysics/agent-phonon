import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import type { InsertionOptions } from "../adapter.js";
import { PhononError } from "../rpc.js";
import { spawnSupervisedAgent, type ProcessSupervisor } from "../process-supervisor.js";

export interface CodexNativeFrame { method: string; params: Record<string, any> }
interface PendingRPC {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}
interface Steering {
  text: string;
  accepted: boolean;
  observed: boolean;
  resolve: () => void;
  reject: (error: Error) => void;
}
const unavailable = () => new PhononError("errSessionBusy", "Codex input was not confirmed on the original active turn");
const nativeID = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 512;
const inputText = (content: unknown): string | undefined => {
  if (!Array.isArray(content) || content.length !== 1 || content[0]?.type !== "text" || typeof content[0].text !== "string") return undefined;
  return content[0].text;
};

/** One owned app-server and one original turn; no implicit start, fork or retry. */
export class CodexAppServer {
  readonly runtime: ProcessSupervisor;
  private readonly pending = new Map<string, PendingRPC>();
  private readonly steering = new Map<string, Steering>();
  private readonly serverRequests = new Map<string | number, AbortController>();
  private readonly answeredRequests = new Set<string | number>();
  private buffer = "";
  private failure?: Error;
  private closing?: Promise<void>;
  private threadId?: string;
  private turnId?: string;
  private phononTurnId?: string;
  private original?: { clientId: string; text: string; observed: boolean };
  private ended = false;
  private readonly abort = () => this.fail(unavailable());

  constructor(private options: {
    bin: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv; signal?: AbortSignal;
    onRuntime?: (runtime: ProcessSupervisor) => void;
    notify: (frame: CodexNativeFrame) => void;
    request: (frame: CodexNativeFrame, signal: AbortSignal) => Promise<unknown>;
    failed: (error: Error) => void;
    stderr?: (text: string) => void;
  }) {
    options.signal?.throwIfAborted();
    this.runtime = spawnSupervisedAgent(options.bin, ["app-server", ...options.args], { cwd: options.cwd, env: options.env });
    const child = this.runtime.child;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (text: string) => this.read(text));
    child.stderr.on("data", chunk => options.stderr?.(String(chunk)));
    child.once("error", () => this.fail(new Error("Codex native app-server could not start")));
    child.once("close", () => this.fail(new Error("Codex native app-server closed")));
    child.stdin.on("error", () => this.fail(new Error("Codex native input channel closed")));
    options.signal?.addEventListener("abort", this.abort, { once: true });
    try { options.onRuntime?.(this.runtime); }
    catch { this.fail(new Error("Codex native process ownership could not be registered")); }
    if (options.signal?.aborted) this.abort();
  }

  async initialize(): Promise<void> {
    await this.rpc("initialize", { clientInfo: { name: "agent_phonon_native", version: "1" }, capabilities: { experimentalApi: true } });
    this.write({ method: "initialized", params: {} });
  }

  bindThread(value: unknown, expected?: string): string {
    const thread = value as { id?: unknown; cwd?: unknown } | undefined;
    if (!nativeID(thread?.id) || expected && thread.id !== expected || this.threadId && thread.id !== this.threadId
      || typeof thread.cwd !== "string" || realpathSync(thread.cwd) !== realpathSync(this.options.cwd)) throw unavailable();
    this.threadId = thread.id;
    return thread.id;
  }

  arm(phononTurnId: string, text: string): string {
    if (!this.threadId || this.phononTurnId || this.failure || this.ended) throw unavailable();
    this.phononTurnId = phononTurnId;
    const clientId = randomUUID();
    this.original = { clientId, text, observed: false };
    return clientId;
  }

  acceptStart(value: any): void {
    if (!nativeID(value?.turn?.id) || !this.phononTurnId || this.turnId && this.turnId !== value.turn.id || this.ended) throw unavailable();
    this.turnId = value.turn.id;
  }

  nativeTurnId(): string | undefined { return this.ended ? undefined : this.turnId; }
  owns(frame: CodexNativeFrame): boolean {
    return !this.failure && !this.ended && !!this.turnId && frame.params.threadId === this.threadId && frame.params.turnId === this.turnId;
  }

  rpc(method: string, params: unknown, beforeSend?: () => void): Promise<any> {
    if (this.failure || this.closing || this.pending.size >= 64) return Promise.reject(this.failure ?? unavailable());
    const id = "phonon-native-" + randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error("Codex native " + method + " response is unconfirmed")); }, 30000);
      this.pending.set(id, { resolve, reject, timer });
      try { beforeSend?.(); this.write({ id, method, params }); }
      catch (error) {
        clearTimeout(timer); this.pending.delete(id); reject(error);
      }
    });
  }

  insert(text: string, options: InsertionOptions): Promise<void> {
    if (!this.turnId || !this.threadId || !this.original?.observed || this.phononTurnId !== options.turnId
      || this.failure || this.ended || options.signal.aborted || this.steering.size >= 32) return Promise.reject(unavailable());
    const threadId = this.threadId, turnId = this.turnId, clientId = randomUUID();
    return new Promise((resolve, reject) => {
      const finish = (error?: Error) => {
        if (!this.steering.delete(clientId)) return;
        options.signal.removeEventListener("abort", aborted);
        if (error) reject(error); else resolve();
      };
      const aborted = () => finish(unavailable());
      this.steering.set(clientId, { text, accepted: false, observed: false, resolve: () => finish(), reject: error => finish(error) });
      options.signal.addEventListener("abort", aborted, { once: true });
      if (options.signal.aborted) { aborted(); return; }
      void this.rpc("turn/steer", { threadId, expectedTurnId: turnId, clientUserMessageId: clientId,
        input: [{ type: "text", text }] }, () => {
        if (this.ended || this.turnId !== turnId || options.signal.aborted) throw unavailable();
        options.beforeApply?.();
      }).then(reply => {
        const pending = this.steering.get(clientId);
        if (!pending) return;
        if (reply?.turnId !== turnId || this.ended || this.turnId !== turnId || options.signal.aborted) { pending.reject(unavailable()); return; }
        pending.accepted = true;
        if (pending.observed) pending.resolve();
      }, error => this.steering.get(clientId)?.reject(error));
    });
  }

  private read(text: string): void {
    if (this.failure || this.closing) return;
    this.buffer += text;
    if (Buffer.byteLength(this.buffer) > 8 * 1024 * 1024) { this.fail(new Error("Codex native frame exceeds limit")); return; }
    let end: number;
    while ((end = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, end); this.buffer = this.buffer.slice(end + 1);
      if (!line.trim()) continue;
      try {
        const frame = JSON.parse(line);
        if (!frame || typeof frame !== "object" || Array.isArray(frame)) throw new Error("Invalid Codex native frame");
        if (typeof frame.method === "string") this.event(frame);
        else if (typeof frame.id === "string") {
          const pending = this.pending.get(frame.id);
          if (!pending) continue;
          this.pending.delete(frame.id); clearTimeout(pending.timer);
          if (frame.error || !("result" in frame)) pending.reject(new Error("Codex native request failed: " + String(frame.error?.message ?? "missing response")));
          else pending.resolve(frame.result);
        }
      } catch (error) { this.fail(error instanceof Error ? error : new Error("Invalid Codex native frame")); }
      if (this.failure) return;
    }
  }

  private event(raw: any): void {
    const frame: CodexNativeFrame = { method: raw.method, params: raw.params ?? {} };
    if (typeof raw.id === "string" || typeof raw.id === "number") {
      this.handleRequest(raw.id, frame); return;
    }
    if (frame.method === "serverRequest/resolved") {
      if (frame.params.threadId !== this.threadId) return;
      this.serverRequests.get(frame.params.requestId)?.abort();
      this.serverRequests.delete(frame.params.requestId);
      this.options.notify(frame); return;
    }
    if (frame.params.threadId !== this.threadId || !this.phononTurnId) return;
    if (frame.method === "turn/started") {
      this.acceptStart({ turn: frame.params.turn });
    } else if (frame.method === "item/completed" && this.owns(frame) && frame.params.item?.type === "userMessage") {
      const item = frame.params.item, text = inputText(item.content);
      if (this.original && item.clientId === this.original.clientId && text === this.original.text) this.original.observed = true;
      const pending = typeof item.clientId === "string" ? this.steering.get(item.clientId) : undefined;
      if (pending && text === pending.text) {
        pending.observed = true;
        if (pending.accepted) pending.resolve();
      }
    } else if (frame.method === "turn/completed") {
      if (frame.params.turn?.id !== this.turnId || this.ended) return;
      this.ended = true;
      for (const pending of this.steering.values()) pending.reject(unavailable());
      for (const controller of this.serverRequests.values()) controller.abort();
      this.serverRequests.clear();
    }
    if (frame.params.turnId !== undefined && frame.params.turnId !== this.turnId) return;
    this.options.notify(frame);
  }

  private handleRequest(id: string | number, frame: CodexNativeFrame): void {
    if (!this.owns(frame) || this.serverRequests.has(id) || this.answeredRequests.has(id) || this.serverRequests.size >= 16 || this.answeredRequests.size >= 4096) {
      this.write({ id, error: { code: -32600, message: "Native request is outside the original active turn" } }); return;
    }
    const controller = new AbortController(); this.serverRequests.set(id, controller);
    void Promise.resolve().then(() => this.options.request(frame, controller.signal)).then(result => {
      if (controller.signal.aborted || !this.owns(frame) || this.serverRequests.get(id) !== controller) return;
      this.write({ id, result });
      this.answeredRequests.add(id); this.serverRequests.delete(id);
    }, () => {
      if (controller.signal.aborted || !this.owns(frame) || this.serverRequests.get(id) !== controller) return;
      this.write({ id, error: { code: -32603, message: "Native request could not be confirmed" } });
      this.answeredRequests.add(id); this.serverRequests.delete(id);
    }).catch(error => this.fail(error instanceof Error ? error : unavailable()));
  }

  private write(frame: unknown): void {
    if (this.failure || this.closing || this.options.signal?.aborted) throw this.failure ?? unavailable();
    this.runtime.child.stdin.write(JSON.stringify(frame) + "\n");
  }

  private fail(error: Error, report = true): void {
    if (this.failure || this.closing) return;
    this.failure = error;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
    for (const pending of this.steering.values()) pending.reject(error);
    for (const controller of this.serverRequests.values()) controller.abort();
    this.serverRequests.clear();
    if (report) this.options.failed(error);
    void this.runtime.terminate();
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.fail(unavailable(), false);
    this.options.signal?.removeEventListener("abort", this.abort);
    this.closing = (async () => {
      await this.runtime.terminate();
      const deadline = Date.now() + 1000;
      while (!this.runtime.hasStopped() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
      if (!this.runtime.hasStopped()) throw new Error("Codex native app-server process tree has not stopped");
    })();
    return this.closing;
  }
}
