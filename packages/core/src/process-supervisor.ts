import { spawn as nodeSpawn } from "node:child_process";
import type { ChildProcess, ChildProcessWithoutNullStreams, SpawnOptions } from "node:child_process";
import { spawnAgent } from "./proc.js";

export interface ProcessSupervisorOptions {
  /** Time between graceful and forced tree termination. */
  graceMs?: number;
  /** Dependency overrides used by platform-neutral tests. */
  platform?: NodeJS.Platform;
  killProcessGroup?: (pid: number, signal: NodeJS.Signals) => void;
  killWindowsTree?: (pid: number, force: boolean) => Promise<void> | void;
  /** True while any descendant in the supervised tree remains alive. */
  isTreeAlive?: (pid: number) => boolean;
}

/**
 * Owns one spawned command and terminates its entire descendant tree.
 *
 * POSIX children are process-group leaders (`detached: true`) and signals are
 * sent to `-pid`. Windows uses `taskkill /T`, escalating to `/F` after grace.
 * All callers (abort, timeout, explicit interrupt/terminate) use the same
 * graceful-then-force path.
 */
export class ProcessSupervisor {
  readonly child: ChildProcessWithoutNullStreams;
  private readonly platform: NodeJS.Platform;
  private readonly graceMs: number;
  private readonly killProcessGroup: (pid: number, signal: NodeJS.Signals) => void;
  private readonly killWindowsTree: (pid: number, force: boolean) => Promise<void> | void;
  private readonly isTreeAlive: (pid: number) => boolean;
  private termination?: Promise<void>;
  private resolveTermination?: () => void;
  private forceTimer?: ReturnType<typeof setTimeout>;
  private disposed = false;
  private exited = false;

  constructor(child: ChildProcessWithoutNullStreams, opts: ProcessSupervisorOptions = {}) {
    this.child = child;
    this.platform = opts.platform ?? process.platform;
    this.graceMs = opts.graceMs ?? 5_000;
    this.killProcessGroup = opts.killProcessGroup ?? ((pid, signal) => process.kill(-pid, signal));
    this.killWindowsTree = opts.killWindowsTree ?? killWindowsTree;
    this.isTreeAlive = opts.isTreeAlive ?? ((pid) => {
      if (this.platform === "win32") return this.termination !== undefined;
      try { process.kill(-pid, 0); return true; } catch { return false; }
    });
    child.once("close", this.onClose);
    child.once("error", this.onError);
  }

  /** Idempotently stop the full tree: graceful first, force after grace. */
  terminate(): Promise<void> {
    if (this.termination) return this.termination;
    const pid = this.child.pid;
    if (this.hasExited() && (!pid || !this.isTreeAlive(pid))) return Promise.resolve();
    this.termination = new Promise<void>((resolve) => { this.resolveTermination = resolve; });
    void this.signalTree(false);
    this.forceTimer = setTimeout(() => {
      this.forceTimer = undefined;
      const treePid = this.child.pid;
      if (treePid && this.isTreeAlive(treePid)) {
        // Leader exit is not tree exit. Keep the force escalation for any
        // surviving descendants in the original process group/tree.
        void this.signalTree(true);
      }
      this.dispose();
    }, this.graceMs);
    return this.termination;
  }

  /** Remove supervisor-owned listeners/timers after natural process exit. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.forceTimer) clearTimeout(this.forceTimer);
    this.forceTimer = undefined;
    this.child.off("close", this.onClose);
    this.child.off("error", this.onError);
    this.finishTermination();
  }

  private readonly onClose = (): void => {
    this.exited = true;
    const pid = this.child.pid;
    if (!pid || !this.isTreeAlive(pid)) {
      this.dispose();
      return;
    }
    // The leader exited but descendants remain. If termination was already in
    // progress, retain its force timer; otherwise take ownership now.
    if (!this.termination) void this.terminate();
  };

  private readonly onError = (): void => {
    // Node emits `close` after `error` for a spawned process. Keep waiting for
    // close when a pid exists so descendants still get the grace/force path.
    // A spawn failure has no pid and no process tree to supervise.
    if (!this.child.pid) {
      this.exited = true;
      this.dispose();
    }
  };

  private hasExited(): boolean {
    return this.exited || this.child.exitCode !== null || this.child.signalCode !== null;
  }

  private finishTermination(): void {
    const resolve = this.resolveTermination;
    this.resolveTermination = undefined;
    resolve?.();
  }

  private async signalTree(force: boolean): Promise<void> {
    const pid = this.child.pid;
    if (!pid) {
      try { this.child.kill(force ? "SIGKILL" : "SIGTERM"); } catch { /* already gone */ }
      return;
    }
    if (this.platform === "win32") {
      try { await this.killWindowsTree(pid, force); } catch {
        try { this.child.kill(); } catch { /* already gone */ }
      }
      return;
    }
    try {
      this.killProcessGroup(pid, force ? "SIGKILL" : "SIGTERM");
    } catch {
      // A child can exit between the status check and group signal. Fallback is
      // also useful when a caller injected a child that is not a group leader.
      try { this.child.kill(force ? "SIGKILL" : "SIGTERM"); } catch { /* already gone */ }
    }
  }
}

export function spawnSupervisedAgent(
  command: string,
  args: readonly string[] = [],
  options: SpawnOptions = {},
  supervisorOptions: ProcessSupervisorOptions = {},
): ProcessSupervisor {
  const platform = supervisorOptions.platform ?? process.platform;
  const child = spawnAgent(command, args, {
    ...options,
    // setsid(2) through Node's detached spawn makes the child a process-group
    // leader while its stdio pipes still keep normal ownership semantics.
    ...(platform === "win32" ? {} : { detached: true }),
  });
  return new ProcessSupervisor(child, { ...supervisorOptions, platform });
}

export function spawnSupervised(
  command: string,
  args: readonly string[] = [],
  options: SpawnOptions = {},
  supervisorOptions: ProcessSupervisorOptions = {},
): ProcessSupervisor {
  const platform = supervisorOptions.platform ?? process.platform;
  const child = nodeSpawn(command, args as string[], {
    ...options,
    ...(platform === "win32" ? {} : { detached: true }),
  }) as ChildProcessWithoutNullStreams;
  return new ProcessSupervisor(child, { ...supervisorOptions, platform });
}

function killWindowsTree(pid: number, force: boolean): Promise<void> {
  return new Promise((resolve) => {
    const args = ["/PID", String(pid), "/T", ...(force ? ["/F"] : [])];
    const killer: ChildProcess = nodeSpawn("taskkill", args, {
      windowsHide: true,
      stdio: "ignore",
      shell: false,
    });
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      try { killer.kill(); } catch { /* helper already gone */ }
      finish();
    }, 2_000);
    (timer as { unref?: () => void }).unref?.();
    killer.once("error", finish);
    killer.once("close", finish);
  });
}
