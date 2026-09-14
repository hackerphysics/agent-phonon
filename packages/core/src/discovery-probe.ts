import { spawnSupervisedAgent } from "./process-supervisor.js";

/** Read-only native inventory command: bounded output/deadline and owned tree. */
export async function discoveryProbe(command: string, args: string[], signal?: AbortSignal): Promise<string | null> {
  signal?.throwIfAborted();
  const supervisor = spawnSupervisedAgent(command, args, {}, { graceMs: 250 });
  const child = supervisor.child;
  let failure: Error | undefined;
  let termination: Promise<void> | undefined;
  const abort = () => {
    failure ??= new Error("native discovery probe aborted");
    termination ??= supervisor.terminate();
  };
  signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, 10_000);
  try {
    return await new Promise<string | null>((resolve, reject) => {
      let output = "";
      let bytes = 0;
      let missing = false;
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        bytes += Buffer.byteLength(chunk);
        if (bytes > 512 * 1024) { abort(); return; }
        output += chunk;
      });
      child.stderr.on("data", () => { /* drain, never log native diagnostics/secrets */ });
      child.once("error", (err: NodeJS.ErrnoException) => {
        missing = err.code === "ENOENT";
        if (!missing) failure ??= new Error("native discovery probe spawn failed");
      });
      child.once("close", (code) => {
        if (failure) reject(failure);
        else if (missing) resolve(null);
        else if (code !== 0) reject(new Error("native discovery probe failed"));
        else resolve(output.trim());
      });
    });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
    await termination;
  }
}
