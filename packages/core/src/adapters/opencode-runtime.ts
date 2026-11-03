import { randomUUID } from "node:crypto";
import { lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoveryProbe } from "../discovery-probe.js";
import type { ProcessSupervisor } from "../process-supervisor.js";

/** Bun's embedded FFI loader can leave a shared library behind even for --version. */
export class OpenCodeRuntimeDirectory {
  readonly path = realpathSync(mkdtempSync(join(tmpdir(), "phonon-opencode-runtime-")));
  private readonly identity = lstatSync(this.path);
  private readonly nonce = randomUUID();
  private runtime?: ProcessSupervisor;
  private removed = false;

  constructor() {
    try { this.record(true); }
    catch (error) { rmSync(this.path, { recursive: true, force: true }); throw error; }
  }

  environment(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    return { ...base, BUN_TMPDIR: this.path, TMPDIR: this.path, TMP: this.path, TEMP: this.path };
  }

  watch(runtime: ProcessSupervisor): void {
    this.runtime = runtime;
    this.assertOwned();
    this.record();
  }

  cleanup(): void {
    if (this.removed) return;
    if (this.runtime && !this.runtime.hasStopped()) throw new Error("OpenCode process tree is still active; temporary assets retained");
    this.assertOwned();
    rmSync(this.path, { recursive: true });
    this.removed = true;
  }

  private assertOwned(): void {
    const directory = lstatSync(this.path), file = lstatSync(join(this.path, ".phonon-opencode-runtime.json"));
    if (!directory.isDirectory() || directory.isSymbolicLink() || directory.dev !== this.identity.dev || directory.ino !== this.identity.ino
      || process.platform !== "win32" && (directory.uid !== process.getuid?.() || (directory.mode & 0o077) !== 0)
      || !file.isFile() || file.isSymbolicLink() || file.nlink !== 1) throw new Error("OpenCode temporary directory ownership changed; refusing cleanup");
    const marker = JSON.parse(readFileSync(join(this.path, ".phonon-opencode-runtime.json"), "utf8"));
    if (marker.nonce !== this.nonce || marker.ownerPID !== process.pid) throw new Error("OpenCode temporary directory ownership changed; refusing cleanup");
  }

  private record(initial = false): void {
    writeFileSync(join(this.path, ".phonon-opencode-runtime.json"), JSON.stringify({ version: 1, nonce: this.nonce,
      ownerPID: process.pid, childPID: this.runtime?.child.pid ?? null, processGroup: process.platform !== "win32" }),
    { mode: 0o600, ...(initial ? { flag: "wx" } : {}) });
  }
}

export async function openCodeDiscoveryProbe(command: string, args: string[], signal?: AbortSignal): Promise<string | null> {
  signal?.throwIfAborted();
  const temporary = new OpenCodeRuntimeDirectory();
  try {
    return await discoveryProbe(command, args, signal, {
      env: temporary.environment(process.env), onRuntime: runtime => temporary.watch(runtime),
    });
  } finally { temporary.cleanup(); }
}
