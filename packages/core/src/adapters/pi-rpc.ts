import {randomUUID} from "node:crypto";
import {PhononError} from "../rpc.js";

const unavailable = () => new PhononError("errSessionBusy", "Pi steering was not confirmed on the original active turn");
type Pending = {command: string; resolve: (data: unknown) => void; reject: (error: Error) => void};
type Insertion = {input: string; accepted: boolean; consumed: boolean; resolve: () => void; reject: (error: Error) => void};

/** One native process/turn only. A steer response acknowledges queuing, not delivery. */
export class PiRpcChannel {
  private sequence = randomUUID();
  private requests = new Map<string, Pending>();
  private insertions = new Map<string, Insertion>();
  private active = false;
  private initialUserObserved = false;
  private promptAccepted = false;
  private closed = false;

  constructor(private write: (value: Record<string, unknown>) => void) {}

  state(): Promise<unknown> { return this.request("get_state"); }

  /** Provider-exact context usage; the session process may exit right after settlement. */
  usage(): Promise<unknown> { return this.request("get_usage"); }

  async prompt(message: string): Promise<void> {
    await this.request("prompt", {message});
  }

  async insert(input: string, signal: AbortSignal): Promise<void> {
    if (this.closed || signal.aborted || !this.active || !this.initialUserObserved || !this.promptAccepted
      || this.insertions.size >= 32) throw unavailable();
    const id = "phonon-steer-" + randomUUID();
    let abort!: () => void;
    const delivered = new Promise<void>((resolve, reject) => {
      const rejectInput = (error: Error) => {
        this.insertions.delete(id);
        this.requests.delete(id);
        reject(error);
      };
      abort = () => rejectInput(unavailable());
      signal.addEventListener("abort", abort, {once: true});
      this.insertions.set(id, {input, accepted: false, consumed: false,
        resolve: () => { this.insertions.delete(id); resolve(); }, reject: rejectInput});
      this.requests.set(id, {command: "steer", resolve: () => {
        const pending = this.insertions.get(id);
        if (pending) { pending.accepted = true; this.complete(pending); }
      }, reject: rejectInput});
      try { this.write({id, type: "steer", message: input}); }
      catch { rejectInput(unavailable()); }
    });
    try { await delivered; }
    finally { signal.removeEventListener("abort", abort); }
  }

  observe(raw: unknown): void {
    if (this.closed || !raw || typeof raw !== "object") return;
    const event = raw as Record<string, unknown>;
    if (event.type === "response" && typeof event.id === "string") {
      const pending = this.requests.get(event.id);
      if (!pending) return;
      this.requests.delete(event.id);
      if (event.command !== pending.command || event.success !== true) {
        pending.reject(new PhononError("errSessionBusy", "Pi rejected or did not confirm the original RPC command"));
      } else {
        if (pending.command === "prompt") this.promptAccepted = true;
        pending.resolve(event.data);
      }
    } else if (event.type === "agent_start") {
      this.active = true;
    } else if (event.type === "message_end") {
      const message = event.message as Record<string, unknown> | undefined;
      if (message?.role !== "user" || !Array.isArray(message.content)) return;
      if (!this.initialUserObserved) { this.initialUserObserved = true; return; }
      const blocks = message.content as Array<Record<string, unknown>>;
      if (!blocks.every(block => block && typeof block === "object" && block.type === "text" && typeof block.text === "string")) return;
      const text = blocks.map(block => block.text).join("");
      const pending = [...this.insertions.values()].find(value => !value.consumed && value.input === text);
      if (pending) { pending.consumed = true; this.complete(pending); }
    } else if (event.type === "agent_settled") {
      this.close();
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.active = false;
    for (const pending of this.requests.values()) pending.reject(unavailable());
    for (const pending of this.insertions.values()) pending.reject(unavailable());
    this.requests.clear();
    this.insertions.clear();
  }

  private complete(pending: Insertion): void {
    if (pending.accepted && pending.consumed && !this.closed) pending.resolve();
  }

  private request(type: string, params: Record<string, unknown> = {}): Promise<unknown> {
    if (this.closed) return Promise.reject(unavailable());
    const id = "phonon-" + this.sequence + "-" + randomUUID();
    return new Promise((resolve, reject) => {
      this.requests.set(id, {command: type, resolve, reject});
      try { this.write({id, type, ...params}); }
      catch { this.requests.delete(id); reject(unavailable()); }
    });
  }
}
