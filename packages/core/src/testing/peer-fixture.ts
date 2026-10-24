import { createHash, randomUUID } from "node:crypto";
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statfsSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import type { ChildProcess } from "node:child_process";
import type { Server } from "node:http";

const checkout = realpathSync(fileURLToPath(new URL("../../../../", import.meta.url)));
const scopes = new Set<PeerFixture>();
let handlingSignal = false;
let signalsInstalled = false;
let temporaryOwner: PeerFixture | undefined;
type ProcessRef = { pid: number; group: boolean };
const alive = (value: ProcessRef) => {
  try { process.kill(value.group ? -value.pid : value.pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
};

export function peerFixtureBase(): string {
  const name = "agent-phonon-peer-tests-" + createHash("sha256").update(checkout).digest("hex").slice(0, 12);
  return join(tmpdir(), name);
}

function privateDirectory(path: string): string {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || process.platform !== "win32" && (stat.uid !== process.getuid?.() || (stat.mode & 0o022) !== 0)) {
    throw new Error("Peer fixture directory is not privately owned");
  }
  return realpathSync(path);
}

async function signalCleanup(signal: NodeJS.Signals) {
  if (handlingSignal) return;
  handlingSignal = true;
  for (const scope of [...scopes].reverse()) {
    try { await scope.dispose(); } catch { /* The owned manifest remains for an explicit audit. */ }
  }
  process.exit(signal === "SIGINT" ? 130 : 143);
}
const interrupt = () => { void signalCleanup("SIGINT"); };
const terminate = () => { void signalCleanup("SIGTERM"); };

process.once("exit", () => {
  for (const scope of scopes) {
    try { scope.cleanupFiles(); }
    catch { if (!process.exitCode) process.exitCode = 1; }
  }
});

/** Test-only ownership and cleanup; never imported by the production Core entry point. */
export class PeerFixture {
  readonly root: string;
  readonly base: string;
  active = true;
  private readonly nonce = randomUUID();
  private readonly callbacks: Array<() => unknown | Promise<unknown>> = [];
  private readonly processes: ProcessRef[] = [];
  private disposing?: Promise<void>;
  private removed = false;
  private readonly owner = (process.env.PHONON_TEST_OWNER ?? "local-test").slice(0, 128);
  private readonly identity: { dev: number; ino: number };

  constructor(readonly workflow: string, base = peerFixtureBase()) {
    if (!/^[a-z0-9-]{1,48}$/.test(workflow)) throw new Error("Invalid peer fixture workflow");
    if ([...scopes].some(scope => !scope.active && scope.processes.some(alive))) throw new Error("A previous owned native test process is still unsettled");
    this.base = privateDirectory(base);
    const disk = statfsSync(this.base);
    if (disk.bavail * disk.bsize < 128 * 1024 * 1024) throw new Error("Insufficient disk space for bounded peer fixtures");
    this.root = realpathSync(mkdtempSync(join(this.base, workflow + "-")));
    const identity = lstatSync(this.root); this.identity = { dev: identity.dev, ino: identity.ino };
    try { this.record(true); }
    catch (error) { rmSync(this.root, { recursive: true, force: true }); throw error; }
    scopes.add(this);
    if (!signalsInstalled) {
      signalsInstalled = true;
      process.on("SIGINT", interrupt); process.on("SIGTERM", terminate);
    }
  }

  private assertOwned() {
    const directory = lstatSync(this.root), path = join(this.root, ".peer-fixture.json"), file = lstatSync(path);
    if (!directory.isDirectory() || directory.isSymbolicLink() || directory.dev !== this.identity.dev || directory.ino !== this.identity.ino
      || !file.isFile() || file.isSymbolicLink() || file.nlink !== 1) throw new Error("Peer fixture ownership changed; refusing mutation");
    const marker = JSON.parse(readFileSync(path, "utf8"));
    if (marker.checkout !== checkout || marker.nonce !== this.nonce || marker.pid !== process.pid) throw new Error("Peer fixture ownership changed; refusing mutation");
  }
  private record(initial = false) {
    if (!initial) this.assertOwned();
    writeFileSync(join(this.root, ".peer-fixture.json"), JSON.stringify({ version: 1, checkout, workflow: this.workflow, owner: this.owner,
      nonce: this.nonce, pid: process.pid, active: this.active, processes: this.processes }), { mode: 0o600, ...(initial ? { flag: "wx" } : {}) });
  }

  defer(callback: () => unknown | Promise<unknown>): void {
    if (!this.active) throw new Error("Peer fixture is already closing");
    this.callbacks.push(callback);
  }

  watch(child: ChildProcess | undefined, group = false): void {
    if (!child?.pid || !Number.isInteger(child.pid)) return;
    this.processes.push({ pid: child.pid, group: group && process.platform !== "win32" });
    this.record();
  }

  /** Reuse a real, version-matched prepared tree; only its two small manifests are copied. */
  mountOpenCodeDependencies(source: string, version: string, target: string): void {
    const prepared = realpathSync(source);
    const metadata = () => {
      const plugin = readFileSync(join(prepared, "node_modules", "@opencode-ai", "plugin", "package.json"));
      if (JSON.parse(plugin.toString("utf8")).version !== version) throw new Error("Prepared OpenCode dependency version mismatch");
      return createHash("sha256").update(plugin).update(readFileSync(join(prepared, "package.json")))
        .update(readFileSync(join(prepared, "package-lock.json"))).digest("hex");
    };
    const before = metadata(), key = createHash("sha256").update(prepared).digest("hex").slice(0, 16);
    const lease = join(this.base, "cache-" + key + ".lease.json");
    const reference = join(this.base, "cache-" + key + ".json");
    if (!existsSync(reference) && readdirSync(this.base).filter(name => /^cache-[a-f0-9]+\.json$/.test(name)).length >= 2) {
      throw new Error("Bounded native dependency cache limit reached; reuse or explicitly audit existing caches");
    }
    if (existsSync(reference)) {
      const previous = JSON.parse(readFileSync(reference, "utf8"));
      if (previous.checkout !== checkout || previous.path !== prepared || previous.hash !== before) throw new Error("Prepared dependency metadata changed; explicit cache audit required");
    }
    writeFileSync(lease, JSON.stringify({ checkout, path: prepared, pid: process.pid, owner: this.owner, fixture: this.root, nonce: this.nonce }), { flag: "wx", mode: 0o600 });
    this.defer(() => {
      if (this.processes.some(alive)) throw new Error("Native process still uses the prepared dependency lease");
      const value = JSON.parse(readFileSync(lease, "utf8"));
      if (value.nonce !== this.nonce || value.pid !== process.pid) throw new Error("Dependency lease ownership changed");
      try { if (metadata() !== before) throw new Error("Native run changed prepared dependency metadata"); }
      finally { unlinkSync(lease); }
    });
    writeFileSync(reference, JSON.stringify({ checkout, path: prepared, version, hash: before, retained: true, purpose: "bounded prepared native-test dependencies" }), { mode: 0o600 });
    mkdirSync(target, { recursive: true });
    copyFileSync(join(prepared, "package.json"), join(target, "package.json"));
    copyFileSync(join(prepared, "package-lock.json"), join(target, "package-lock.json"));
    symlinkSync(join(prepared, "node_modules"), join(target, "node_modules"), process.platform === "win32" ? "junction" : "dir");
  }

  cleanupFiles(): void {
    if (this.removed) return;
    if (this.processes.some(alive)) throw new Error("Owned native process is still live; fixture retained");
    this.assertOwned();
    rmSync(this.root, { recursive: true, force: true });
    this.removed = true; scopes.delete(this);
    if (!scopes.size && signalsInstalled) {
      process.off("SIGINT", interrupt); process.off("SIGTERM", terminate); signalsInstalled = false;
    }
  }

  cleanupFailurePath(): string {
    return join(this.base, "cleanup-" + this.workflow + "-" + createHash("sha256").update(this.owner).digest("hex").slice(0, 10) + ".json");
  }
  clearOwnedCleanupFailure(): void {
    const path = this.cleanupFailurePath();
    if (!existsSync(path)) return;
    if (this.processes.some(alive)) throw new Error("Cannot clear a live native cleanup failure");
    const value = JSON.parse(readFileSync(path, "utf8"));
    if (value.nonce === this.nonce && value.root === this.root) unlinkSync(path);
  }

  async dispose(): Promise<void> {
    if (this.removed) return;
    if (this.disposing) return this.disposing;
    this.active = false;
    const task = (async () => {
      const errors: unknown[] = [];
      try { this.record(); } catch (error) { errors.push(error); }
      for (const callback of this.callbacks.splice(0).reverse()) {
        try { await callback(); } catch (error) { errors.push(error); }
      }
      try { this.cleanupFiles(); } catch (error) { errors.push(error); }
      if (errors.length) {
        writeFileSync(this.cleanupFailurePath(), JSON.stringify({ owner: this.owner, workflow: this.workflow, root: this.root, nonce: this.nonce,
          errors: errors.length, live: this.processes.filter(alive), recordedAt: new Date().toISOString() }), { mode: 0o600 });
        throw new AggregateError(errors, "Peer fixture cleanup failed");
      }
      this.clearOwnedCleanupFailure();
    })();
    this.disposing = task;
    try { await task; } finally { this.disposing = undefined; }
  }
}

export async function withPeerFixture<T>(workflow: string, work: (scope: PeerFixture) => Promise<T>): Promise<T> {
  if (temporaryOwner) throw new Error("Run peer fixtures serially within one test process");
  const scope = new PeerFixture(workflow);
  temporaryOwner = scope;
  const keys = ["TMPDIR", "TMP", "TEMP"], previous = new Map(keys.map(key => [key, process.env[key]]));
  for (const key of keys) process.env[key] = scope.root;
  scope.defer(() => {
    for (const [key, value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    temporaryOwner = undefined;
  });
  let failed = false;
  try { return await work(scope); }
  catch (error) { failed = true; throw error; }
  finally {
    try { await scope.dispose(); }
    catch (error) {
      if (!failed) throw error;
      process.emitWarning("Peer fixture cleanup also failed; original failure preserved and ownership record retained");
    }
  }
}

export async function closePeerServer(server: Server): Promise<void> {
  server.closeAllConnections();
  if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}
