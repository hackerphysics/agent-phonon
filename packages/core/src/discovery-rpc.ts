import { randomUUID } from "node:crypto";
import { spawnSupervisedAgent, type ProcessSupervisor } from "./process-supervisor.js";

type Query = { method: string; params?: unknown } | { type: string };
type Pending = { query: Query; resolve: (value: unknown) => void; reject: (error: Error) => void };

/** A bounded, task-free native metadata exchange. Never handles native requests or tools. */
export class DiscoveryRPC {
  private readonly runtime: ProcessSupervisor;
  private readonly pending = new Map<string, Pending>();
  private readonly timer: ReturnType<typeof setTimeout>;
  private buffer = "";
  private framedBuffer = Buffer.alloc(0);
  private bytes = 0;
  private failure?: Error;
  private closed = false;
  private readonly aborted = () => this.fail(new Error("Native metadata discovery aborted"));

  constructor(command: string, args: string[], private readonly options: {
    cwd?: string; env?: NodeJS.ProcessEnv; signal?: AbortSignal; timeoutMs?: number;
    framing?: "content-length";
    onRuntime?: (runtime: ProcessSupervisor) => void;
  } = {}) {
    options.signal?.throwIfAborted();
    this.runtime = spawnSupervisedAgent(command, args, {
      ...(options.cwd ? { cwd: options.cwd } : {}), ...(options.env ? { env: options.env } : {}),
    }, { graceMs: 250 });
    const child = this.runtime.child;
    this.timer = setTimeout(() => this.fail(new Error("Native metadata discovery timed out")), options.timeoutMs ?? 8000);
    child.stderr.resume();
    if(options.framing==="content-length")child.stdout.on("data", (chunk: Buffer) => this.readFramed(chunk));
    else { child.stdout.setEncoding("utf8"); child.stdout.on("data", (chunk: string) => this.read(chunk)); }
    child.once("error", () => this.fail(new Error("Native metadata process could not start")));
    child.once("close", () => this.fail(new Error("Native metadata process closed")));
    child.stdin.on("error", () => this.fail(new Error("Native metadata input closed")));
    options.signal?.addEventListener("abort", this.aborted, { once: true });
    if (options.signal?.aborted) this.aborted();
    try { options.onRuntime?.(this.runtime); }
    catch { this.fail(new Error("Native metadata ownership registration failed")); }
  }

  request(query: Query): Promise<unknown> {
    if (this.failure || this.closed) return Promise.reject(this.failure ?? new Error("Native metadata process closed"));
    const id = "phonon-metadata-" + randomUUID();
    return new Promise((resolve, reject) => {
      this.pending.set(id, { query, resolve, reject });
      this.write({ ...query, id });
    });
  }

  initialized(): void { this.write({ method: "initialized", params: {} }); }

  private write(value: Record<string, unknown>): void {
    if (this.failure || this.closed) throw this.failure ?? new Error("Native metadata process closed");
    try {
      const json=JSON.stringify(this.options.framing?{jsonrpc:"2.0",...value}:value);
      this.runtime.child.stdin.write(this.options.framing?"Content-Length: "+Buffer.byteLength(json)+"\r\n\r\n"+json:json+"\n");
    }
    catch { this.fail(new Error("Native metadata write failed")); }
  }

  private read(chunk: string): void {
    if (this.failure || this.closed) return;
    this.bytes += Buffer.byteLength(chunk);
    if (this.bytes > 2 * 1024 * 1024) { this.fail(new Error("Native metadata exceeds the output limit")); return; }
    this.buffer += chunk;
    let end: number;
    while ((end = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, end); this.buffer = this.buffer.slice(end + 1);
      if (!line.trim()) continue;
      this.receive(line);
      if(this.failure)return;
    }
  }

  private readFramed(chunk:Buffer):void {
    if(this.failure||this.closed)return;
    this.bytes+=chunk.length;
    if(this.bytes>2*1024*1024){this.fail(new Error("Native metadata exceeds the output limit"));return;}
    this.framedBuffer=Buffer.concat([this.framedBuffer,chunk]);
    while(this.framedBuffer.length){
      const end=this.framedBuffer.indexOf("\r\n\r\n");
      if(end<0){if(this.framedBuffer.length>8192)this.fail(new Error("Native metadata header exceeds the limit"));return;}
      if(end>8192){this.fail(new Error("Native metadata header exceeds the limit"));return;}
      const headers=this.framedBuffer.subarray(0,end).toString("ascii").split("\r\n");
      const lengths=headers.filter(line=>/^content-length:/i.test(line));
      const raw=lengths[0]?.match(/^content-length:\s*([1-9][0-9]*)\s*$/i)?.[1];
      const length=raw?Number(raw):NaN;
      if(lengths.length!==1||!Number.isSafeInteger(length)||length>2*1024*1024){this.fail(new Error("Native metadata has an invalid content length"));return;}
      if(this.framedBuffer.length<end+4+length)return;
      const json=this.framedBuffer.subarray(end+4,end+4+length).toString("utf8");
      this.framedBuffer=this.framedBuffer.subarray(end+4+length);
      this.receive(json);if(this.failure)return;
    }
  }

  private receive(json:string):void {
      let frame: Record<string, unknown>;
      try {
        const value: unknown = JSON.parse(json);
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
        frame = value as Record<string, unknown>;
      } catch { this.fail(new Error("Native metadata contains invalid JSON")); return; }
      if (typeof frame.id !== "string") return;
      const pending = this.pending.get(frame.id);
      if (!pending) return;
      // A native request/notification is never a response, even if it repeats our ID.
      if ("method" in frame) return;
      this.pending.delete(frame.id);
      if ("type" in pending.query) {
        if (frame.type !== "response" || frame.command !== pending.query.type || frame.success !== true) {
          pending.reject(new Error("Native metadata command was not confirmed"));
        } else pending.resolve(frame.data);
      } else if ("error" in frame || !("result" in frame)) {
        pending.reject(new Error("Native metadata request was not confirmed"));
      } else pending.resolve(frame.result);
  }

  private fail(error: Error): void {
    this.failure ??= error;
    for (const pending of this.pending.values()) pending.reject(this.failure);
    this.pending.clear();
    if (!this.closed) void this.runtime.terminate();
  }

  async close(): Promise<void> {
    this.closed = true;
    clearTimeout(this.timer);
    this.options.signal?.removeEventListener("abort", this.aborted);
    this.fail(new Error("Native metadata process closed"));
    await this.runtime.terminate();
    const deadline = Date.now() + 1000;
    while (!this.runtime.hasStopped() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    if (!this.runtime.hasStopped()) throw new Error("Native metadata process tree has not stopped");
  }
}
