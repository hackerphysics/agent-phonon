import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir, platform, userInfo } from "node:os";
import { basename, dirname, join } from "node:path";
import type {
  MaintenanceConfigGetResult,
  MaintenanceConfigEditParams,
  MaintenanceConfigPatchParams,
  MaintenanceConfigPatchResult,
  MaintenanceDiagnoseResult,
  MaintenancePackageUpdateResult,
  MaintenanceRollbackResult,
  MaintenanceServiceRestartResult,
  MaintenanceServiceStatusResult,
  MaintenanceTargetsResult,
} from "@agent-phonon/protocol";
import { readConfigBytes, decodeConfig, parseConfig, plainMapping, comparable, equalConfig, assertRootChanges, editConfigText, formatMergePatch, uncertainText, type ConfigFormat } from "./maintenance-file.js";
import { PhononError } from "./rpc.js";
import { spawnAgent } from "./proc.js";
import type { PolicyEnforcer } from "./policy.js";

export interface MaintenanceConfigTarget {
  configId: string;
  label?: string;
  path: string;
  format: ConfigFormat;
  /** Owner attests this exact file contains only public text. Default hidden. */
  textVisibility?: "hidden" | "public";
  /** Required in addition to writable for unstructured text, never grants paths. */
  wholeFileWritable?: boolean;
  /** Default false. Sensitive host configs must opt in explicitly. */
  writable?: boolean;
  /** Root structured keys that a merge patch may touch. Required when writable=true. */
  allowedRootKeys?: string[];
}

export interface MaintenancePackageTarget {
  manager: "npm" | "pnpm";
  packageName: string;
}

export interface MaintenanceServiceTarget {
  serviceId: string;
  label?: string;
  linuxUserUnit?: string;
  macLabel?: string;
  windowsService?: string;
}

export interface MaintenanceTargetConfig {
  targetId: string;
  label: string;
  command?: string;
  versionArgs?: string[];
  configs?: MaintenanceConfigTarget[];
  package?: MaintenancePackageTarget;
  services?: MaintenanceServiceTarget[];
}

export interface MaintenanceManagerConfig {
  backupDir?: string;
  /** Maximum backups retained per target/config bucket. Default 20. */
  backupRetentionPerConfig?: number;
  targets: MaintenanceTargetConfig[];
}

export interface MaintenanceRuntime {
  targets(): Promise<MaintenanceTargetsResult>;
  diagnose(targetId?: string, signal?: AbortSignal): Promise<MaintenanceDiagnoseResult>;
  configGet(targetId: string, configId: string): Promise<MaintenanceConfigGetResult>;
  configEdit(params: MaintenanceConfigEditParams): Promise<MaintenanceConfigPatchResult>;
  configPatch(params: MaintenanceConfigPatchParams): Promise<MaintenanceConfigPatchResult>;
  rollback(backupId: string, expectedCurrentSha256: string, reason?: string): Promise<MaintenanceRollbackResult>;
  packageUpdate(targetId: string, version?: string, signal?: AbortSignal): Promise<MaintenancePackageUpdateResult>;
  serviceStatus(targetId: string, serviceId: string, signal?: AbortSignal): Promise<MaintenanceServiceStatusResult>;
  serviceRestart(targetId: string, serviceId: string, signal?: AbortSignal): Promise<MaintenanceServiceRestartResult>;
}

interface BackupMetadata {
  backupId: string;
  targetId: string;
  configId: string;
  originalPath: string;
  sha256: string;
  createdAt: string;
  reason?: string;
}

const SECRET_KEY = /(api[-_]?key|device[-_]?key|private[-_]?key|access[-_]?key|client[-_]?key|\bkey$|token|secret|password|authorization|cookie|credential)/i;

function sha256(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

function redact(value: unknown, key = ""): unknown {
  if (SECRET_KEY.test(key) && value !== undefined && value !== null) return "***";
  if (value instanceof Date) return value;
  if (Array.isArray(value)) return value.map((v) => redact(v));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, redact(v, k)]));
  }
  return value;
}

function containsRedactedSecret(value: unknown, key = ""): boolean {
  if (SECRET_KEY.test(key) && value === "***") return true;
  if (Array.isArray(value)) return value.some((v) => containsRedactedSecret(v));
  if (value && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).some(([k, v]) => containsRedactedSecret(v, k));
  }
  return false;
}

/** RFC 7396 JSON Merge Patch. */
export function applyJsonMergePatch(target: unknown, patch: unknown): unknown {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) return structuredClone(patch);
  const base = target && typeof target === "object" && !Array.isArray(target)
    ? structuredClone(target as Record<string, unknown>)
    : {};
  for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
    if (value === null) delete (base as Record<string, unknown>)[key];
    else (base as Record<string, unknown>)[key] = applyJsonMergePatch((base as Record<string, unknown>)[key], value);
  }
  return base;
}

function sanitizeVersion(version?: string): string {
  if (!version || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new PhononError("errInvalidParams", "package update requires an exact semver version");
  }
  return version;
}

async function runBounded(command: string, args: string[], opts: { timeoutMs?: number; maxBytes?: number; signal?: AbortSignal } = {}): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const safeEnv: NodeJS.ProcessEnv = { NO_COLOR: "1" };
    for (const key of ["PATH", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "TMP", "TEMP", "NPM_CONFIG_PREFIX", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS"]) {
      if (process.env[key] !== undefined) safeEnv[key] = process.env[key];
    }
    const child = spawnAgent(command, args, { env: safeEnv });
    const max = opts.maxBytes ?? 256 * 1024;
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const append = (old: string, chunk: unknown): string => (old + String(chunk)).slice(-max);
    child.stdout.on("data", (d) => { stdout = append(stdout, d); });
    child.stderr.on("data", (d) => { stderr = append(stderr, d); });
    child.on("error", reject);
    const terminate = (): void => {
      child.kill("SIGTERM");
      setTimeout(() => { if (child.exitCode === null) child.kill("SIGKILL"); }, 5_000).unref();
    };
    const onAbort = (): void => terminate();
    if (opts.signal?.aborted) onAbort();
    else opts.signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, opts.timeoutMs ?? 60_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      if (timedOut) stderr = append(stderr, "\ncommand timed out");
      resolve({ exitCode: typeof code === "number" ? code : 1, stdout: stdout.trim(), stderr: stderr.trim() });
    });
  });
}

export class MaintenanceManager implements MaintenanceRuntime {
  private readonly policy: PolicyEnforcer;
  private readonly targetsById = new Map<string, MaintenanceTargetConfig>();
  private readonly backupDir: string;
  private readonly backupRetentionPerConfig: number;
  private readonly configLocks = new Map<string, Promise<void>>();

  constructor(policy: PolicyEnforcer, config?: MaintenanceManagerConfig) {
    this.policy = policy;
    for (const target of config?.targets ?? []) {
      this.assertLocalId(target.targetId, "targetId");
      if (this.targetsById.has(target.targetId)) throw new Error(`duplicate maintenance target: ${target.targetId}`);
      const configIds = new Set<string>();
      for (const entry of target.configs ?? []) {
        this.assertLocalId(entry.configId, "configId");
        if (configIds.has(entry.configId)) throw new Error(`duplicate config ${target.targetId}/${entry.configId}`);
        configIds.add(entry.configId);
        if (!["json", "jsonc", "yaml", "toml", "text"].includes(entry.format)) throw new Error("unsupported maintenance config format");
        if (entry.textVisibility !== undefined && !["hidden", "public"].includes(entry.textVisibility)) throw new Error("invalid textVisibility");
        if (entry.format === "text" && entry.writable && (entry.wholeFileWritable !== true || entry.textVisibility !== "public")) throw new Error("writable text requires explicit public visibility and wholeFileWritable");
      }
      const serviceIds = new Set<string>();
      for (const service of target.services ?? []) {
        this.assertLocalId(service.serviceId, "serviceId");
        if (serviceIds.has(service.serviceId)) throw new Error(`duplicate service ${target.targetId}/${service.serviceId}`);
        serviceIds.add(service.serviceId);
      }
      this.targetsById.set(target.targetId, target);
    }
    this.backupDir = config?.backupDir ?? join(homedir(), ".agent-phonon", "maintenance-backups");
    this.backupRetentionPerConfig = Math.max(1, Math.min(config?.backupRetentionPerConfig ?? 20, 200));
  }

  async targets(): Promise<MaintenanceTargetsResult> {
    this.policy.assertMaintenanceRead();
    return {
      permissions: this.policy.maintenancePermissions(),
      targets: [...this.targetsById.values()].map((target) => ({
        targetId: target.targetId,
        label: target.label,
        ...(target.command ? { command: basename(target.command) } : {}),
        packageUpdateConfigured: !!target.package,
        configs: (target.configs ?? []).map((config) => ({
          configId: config.configId,
          label: config.label,
          format: config.format,
          textVisibility: config.textVisibility ?? "hidden",
          wholeFileWritable: config.wholeFileWritable === true,
          allowedRootKeys: config.allowedRootKeys,
          exists: existsSync(config.path),
          writable: config.writable === true,
        })),
        services: (target.services ?? []).map((service) => ({
          serviceId: service.serviceId,
          label: service.label,
          configured: !!this.serviceName(service),
        })),
      })),
    };
  }

  async diagnose(targetId?: string, signal?: AbortSignal): Promise<MaintenanceDiagnoseResult> {
    this.policy.assertMaintenanceRead();
    const targets = targetId ? [this.getTarget(targetId)] : [...this.targetsById.values()];
    const diagnostics = [];
    for (const target of targets) {
      let available = false;
      let version: string | undefined;
      let versionError: string | undefined;
      if (target.command) {
        const probe = await runBounded(target.command, target.versionArgs ?? ["--version"], { timeoutMs: 15_000, maxBytes: 32_000, signal }).catch((err) => ({ exitCode: 1, stdout: "", stderr: (err as Error).message }));
        available = probe.exitCode === 0;
        version = available ? (probe.stdout || probe.stderr).split(/\r?\n/)[0] : undefined;
        versionError = available ? undefined : (probe.stderr || `exited ${probe.exitCode}`).slice(0, 500);
      }
      const configs = [];
      for (const config of target.configs ?? []) {
        if (!existsSync(config.path)) {
          configs.push({ configId: config.configId, exists: false });
          continue;
        }
        try {
          const raw = await readConfigBytes(config.path);
          parseConfig(decodeConfig(raw), config.format);
          configs.push({ configId: config.configId, exists: true, valid: true, sha256: sha256(raw) });
        } catch (err) {
          configs.push({ configId: config.configId, exists: true, valid: false, error: (err as Error).message.slice(0, 500) });
        }
      }
      const services = [];
      for (const service of target.services ?? []) services.push(await this.serviceStatusInternal(target, service, signal));
      diagnostics.push({ targetId: target.targetId, available, version, versionError, configs, services });
    }
    return { diagnostics, at: new Date().toISOString() };
  }

  async configGet(targetId: string, configId: string): Promise<MaintenanceConfigGetResult> {
    this.policy.assertMaintenanceRead();
    const config = this.getConfig(this.getTarget(targetId), configId);
    if (!existsSync(config.path)) return { targetId, configId, format: config.format, exists: false };
    const raw = await readConfigBytes(config.path);
    const text = decodeConfig(raw);
    const parsed = parseConfig(text, config.format);
    const publicText = config.textVisibility === "public" && !uncertainText(text) && (config.format === "text" || equalConfig(parsed, redact(parsed)));
    return { targetId, configId, format: config.format, exists: true, sha256: sha256(raw),
      ...(config.format !== "text" ? { value: comparable(redact(parsed)) } : {}),
      ...(publicText ? { text } : { textWithheld: true }) };
  }

  async configPatch(params: MaintenanceConfigPatchParams): Promise<MaintenanceConfigPatchResult> {
    this.policy.assertMaintenanceConfigWrite();
    if (containsRedactedSecret(params.patch)) {
      throw new PhononError("errInvalidParams", "patch contains redacted secret placeholder; omit unchanged secrets");
    }
    const config = this.getConfig(this.getTarget(params.targetId), params.configId);
    if (!plainMapping(params.patch)) throw new PhononError("errInvalidParams", "patch must be a mapping");
    const allowed = new Set(config.allowedRootKeys ?? []);
    if (!allowed.size || Object.keys(params.patch).some(k => !allowed.has(k))) throw new PhononError("errPolicyDenied", "patch touches non-allowlisted root keys");
    return this.mutateConfig(config, params, (text, current) => {
      if (!plainMapping(current)) throw new PhononError("errInvalidParams", "maintenance config root must remain a plain mapping");
      // Validate keys/types before RFC 7396 recursion, including prototype keys.
      const formatted = formatMergePatch(text, config.format, current, params.patch);
      const expected = applyJsonMergePatch(current, params.patch);
      if (!equalConfig(parseConfig(formatted, config.format), expected)) throw new PhononError("errInvalidParams", "merge patch could not preserve config semantics");
      return equalConfig(current, expected) ? text : formatted;
    });
  }

  async configEdit(params: MaintenanceConfigEditParams): Promise<MaintenanceConfigPatchResult> {
    this.policy.assertMaintenanceConfigWrite();
    const config = this.getConfig(this.getTarget(params.targetId), params.configId);
    return this.mutateConfig(config, params, (text, current) => {
      // Secret-bearing files are edited structurally from server-owned originals,
      // never by matching model-visible redacted text or hidden secret spans.
      if (config.textVisibility !== "public" || uncertainText(text) || (config.format !== "text" && !equalConfig(current, redact(current)))) {
        throw new PhononError("errPolicyDenied", "exact editing requires public text with no uncertain secret fragments; use structured patch");
      }
      if (config.format === "text" && config.wholeFileWritable !== true) throw new PhononError("errPolicyDenied", "text requires whole-file authorization");
      const next = editConfigText(text, params.edits);
      if (uncertainText(next)) throw new PhononError("errPolicyDenied", "edited text contains uncertain secret fragments");
      return next;
    });
  }

  private async mutateConfig(config: MaintenanceConfigTarget, params: { targetId: string; configId: string; expectedSha256: string; reason?: string }, transform: (text: string, current: unknown) => string): Promise<MaintenanceConfigPatchResult> {
    if (config.writable !== true) throw new PhononError("errPolicyDenied", `config ${params.targetId}/${params.configId} is read-only`);
    return this.withConfigLock(config.path, async () => {
      await this.assertNoSymlinkTarget(config.path);
      const raw = await readConfigBytes(config.path);
      const previousSha256 = sha256(raw);
      if (previousSha256 !== params.expectedSha256) throw new PhononError("errInvalidParams", `config changed since read (expected ${params.expectedSha256}, got ${previousSha256})`);
      const text = decodeConfig(raw);
      const current = parseConfig(text, config.format);
      const formatted = transform(text, current);
      const next = parseConfig(formatted, config.format);
      if (config.format !== "text") {
        assertRootChanges(current, next, config.allowedRootKeys ?? []);
        if (containsRedactedSecret(next)) throw new PhononError("errInvalidParams", "config contains redacted secret placeholder");
      }
      const nextSha256 = sha256(formatted);
      if (nextSha256 === previousSha256) return { targetId: params.targetId, configId: params.configId, format: config.format, changed: false, previousSha256, sha256: previousSha256 };
      const backup = await this.createBackup(params.targetId, params.configId, config.path, raw, params.reason);
      // Recheck after backup I/O as well as under the per-path broker lock.
      if (sha256(await readConfigBytes(config.path)) !== previousSha256) throw new PhononError("errInvalidParams", "config changed during write preparation");
      await this.atomicWrite(config.path, formatted);
      return { targetId: params.targetId, configId: params.configId, format: config.format, changed: true, previousSha256, sha256: nextSha256, backupId: backup.backupId };
    });
  }

  async rollback(backupId: string, expectedCurrentSha256: string, _reason?: string): Promise<MaintenanceRollbackResult> {
    this.policy.assertMaintenanceConfigWrite();
    this.assertBackupId(backupId);
    const metadata = JSON.parse(await readFile(join(this.backupDir, `${backupId}.meta.json`), "utf8")) as BackupMetadata;
    const target = this.getTarget(metadata.targetId);
    const config = this.getConfig(target, metadata.configId);
    if (config.writable !== true) throw new PhononError("errPolicyDenied", `config ${metadata.targetId}/${metadata.configId} is read-only`);
    if (config.path !== metadata.originalPath) throw new PhononError("errPolicyDenied", "backup target path no longer matches local configuration");
    return this.withConfigLock(config.path, async () => {
      const current = await readConfigBytes(config.path);
      const currentSha = sha256(current);
      if (currentSha !== expectedCurrentSha256) {
        throw new PhononError("errInvalidParams", `config changed before rollback (expected ${expectedCurrentSha256}, got ${currentSha})`);
      }
      const raw = await readFile(join(this.backupDir, `${backupId}.data`));
      if (sha256(raw) !== metadata.sha256) throw new PhononError("errInternal", "backup checksum mismatch");
      const before = parseConfig(decodeConfig(current), config.format);
      const after = parseConfig(decodeConfig(raw), config.format);
      if (config.format !== "text") assertRootChanges(before, after, config.allowedRootKeys ?? []);
      else if (config.wholeFileWritable !== true || config.textVisibility !== "public" || uncertainText(decodeConfig(raw))) throw new PhononError("errPolicyDenied", "rollback lacks public whole-file authorization");
      // Preserve the state being replaced so rollback is itself reversible.
      const reversible = await this.createBackup(metadata.targetId, metadata.configId, config.path, current, `pre-rollback ${backupId}`);
      if (sha256(await readConfigBytes(config.path)) !== currentSha) throw new PhononError("errInvalidParams", "config changed during rollback preparation");
      await this.atomicWrite(config.path, raw);
      return { backupId, targetId: metadata.targetId, configId: metadata.configId, restored: true as const, sha256: metadata.sha256, reversibleBackupId: reversible.backupId };
    });
  }

  async packageUpdate(targetId: string, version?: string, signal?: AbortSignal): Promise<MaintenancePackageUpdateResult> {
    this.policy.assertMaintenancePackageUpdate();
    const target = this.getTarget(targetId);
    if (!target.package) throw new PhononError("errInvalidParams", `package update not configured for ${targetId}`);
    const requestedVersion = sanitizeVersion(version);
    const spec = `${target.package.packageName}@${requestedVersion}`;
    const args = target.package.manager === "npm" ? ["install", "-g", spec] : ["add", "-g", spec];
    const result = await runBounded(target.package.manager, args, { timeoutMs: 10 * 60_000, maxBytes: 1024 * 1024, signal });
    let versionAfter: string | undefined;
    if (result.exitCode === 0 && target.command) {
      const probe = await runBounded(target.command, target.versionArgs ?? ["--version"], { timeoutMs: 15_000, maxBytes: 32_000, signal }).catch(() => undefined);
      if (probe?.exitCode === 0) versionAfter = (probe.stdout || probe.stderr).split(/\r?\n/)[0];
    }
    return { targetId, manager: target.package.manager, packageName: target.package.packageName, requestedVersion, exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr, versionAfter };
  }

  async serviceStatus(targetId: string, serviceId: string, signal?: AbortSignal): Promise<MaintenanceServiceStatusResult> {
    this.policy.assertMaintenanceRead();
    const target = this.getTarget(targetId);
    return this.serviceStatusInternal(target, this.getService(target, serviceId), signal);
  }

  async serviceRestart(targetId: string, serviceId: string, signal?: AbortSignal): Promise<MaintenanceServiceRestartResult> {
    this.policy.assertMaintenanceServiceRestart();
    const target = this.getTarget(targetId);
    const service = this.getService(target, serviceId);
    const name = this.serviceName(service);
    if (!name) return { targetId, serviceId, restarted: false, status: "not_configured" };
    let result: { exitCode: number; stdout: string; stderr: string };
    if (platform() === "linux") {
      result = await runBounded("systemctl", ["--user", "restart", name], { timeoutMs: 60_000, signal });
    } else if (platform() === "darwin") {
      result = await runBounded("launchctl", ["kickstart", "-k", `gui/${userInfo().uid}/${name}`], { timeoutMs: 60_000, signal });
    } else if (platform() === "win32") {
      const stop = await runBounded("sc.exe", ["stop", name], { timeoutMs: 60_000, signal });
      for (let i = 0; i < 30; i++) {
        const state = await runBounded("sc.exe", ["query", name], { timeoutMs: 5_000, maxBytes: 32_000, signal });
        if (/STATE\s*:\s*1\s+STOPPED/i.test(`${state.stdout}\n${state.stderr}`)) break;
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
      const start = await runBounded("sc.exe", ["start", name], { timeoutMs: 60_000, signal });
      result = { exitCode: start.exitCode, stdout: [stop.stdout, start.stdout].filter(Boolean).join("\n"), stderr: [stop.stderr, start.stderr].filter(Boolean).join("\n") };
    } else {
      throw new PhononError("errInternal", `service restart unsupported on ${platform()}`);
    }
    const status = await this.serviceStatusInternal(target, service, signal);
    return { targetId, serviceId, restarted: result.exitCode === 0, status: status.status, detail: [result.stderr, status.detail].filter(Boolean).join("\n").slice(0, 2000) || undefined };
  }

  private getTarget(targetId: string): MaintenanceTargetConfig {
    const target = this.targetsById.get(targetId);
    if (!target) throw new PhononError("errInvalidParams", `unknown maintenance target: ${targetId}`);
    return target;
  }

  private getConfig(target: MaintenanceTargetConfig, configId: string): MaintenanceConfigTarget {
    const config = (target.configs ?? []).find((c) => c.configId === configId);
    if (!config) throw new PhononError("errInvalidParams", `unknown config ${target.targetId}/${configId}`);
    return config;
  }

  private getService(target: MaintenanceTargetConfig, serviceId: string): MaintenanceServiceTarget {
    const service = (target.services ?? []).find((s) => s.serviceId === serviceId);
    if (!service) throw new PhononError("errInvalidParams", `unknown service ${target.targetId}/${serviceId}`);
    return service;
  }

  private serviceName(service: MaintenanceServiceTarget): string | undefined {
    if (platform() === "linux") return service.linuxUserUnit;
    if (platform() === "darwin") return service.macLabel;
    if (platform() === "win32") return service.windowsService;
    return undefined;
  }

  private async serviceStatusInternal(target: MaintenanceTargetConfig, service: MaintenanceServiceTarget, signal?: AbortSignal): Promise<MaintenanceServiceStatusResult> {
    const name = this.serviceName(service);
    if (!name) return { targetId: target.targetId, serviceId: service.serviceId, status: "not_configured" };
    let result: { exitCode: number; stdout: string; stderr: string };
    if (platform() === "linux") result = await runBounded("systemctl", ["--user", "is-active", name], { timeoutMs: 15_000, maxBytes: 32_000, signal });
    // launchctl print includes job environment and may expose secrets; `list`
    // gives status without dumping the environment.
    else if (platform() === "darwin") result = await runBounded("launchctl", ["list", name], { timeoutMs: 15_000, maxBytes: 32_000, signal });
    else if (platform() === "win32") result = await runBounded("sc.exe", ["query", name], { timeoutMs: 15_000, maxBytes: 32_000, signal });
    else return { targetId: target.targetId, serviceId: service.serviceId, status: "unknown", detail: `unsupported platform ${platform()}` };
    const combined = `${result.stdout}\n${result.stderr}`.trim();
    const running = platform() === "linux" ? result.stdout.trim() === "active" : platform() === "win32" ? /STATE\s*:\s*4\s+RUNNING/i.test(combined) : result.exitCode === 0;
    const stopped = platform() === "linux" ? ["inactive", "failed", "deactivating"].includes(result.stdout.trim()) : platform() === "win32" ? /STATE\s*:\s*1\s+STOPPED/i.test(combined) : result.exitCode !== 0;
    return { targetId: target.targetId, serviceId: service.serviceId, status: running ? "running" : stopped ? "stopped" : "unknown", detail: combined.slice(0, 2000) || undefined };
  }

  private async withConfigLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.configLocks.get(path) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const chain = previous.then(() => current);
    this.configLocks.set(path, chain);
    await previous;
    try {
      return await fn();
    } finally {
      release();
      if (this.configLocks.get(path) === chain) this.configLocks.delete(path);
    }
  }

  private async createBackup(targetId: string, configId: string, originalPath: string, raw: string | Buffer, reason?: string): Promise<BackupMetadata> {
    await mkdir(this.backupDir, { recursive: true, mode: 0o700 });
    const backupId = `${targetId}-${configId}-${Date.now()}-${randomBytes(4).toString("hex")}`.replace(/[^A-Za-z0-9._-]/g, "_");
    const metadata: BackupMetadata = { backupId, targetId, configId, originalPath, sha256: sha256(raw), createdAt: new Date().toISOString(), reason };
    await writeFile(join(this.backupDir, `${backupId}.data`), raw, { mode: 0o600 });
    await writeFile(join(this.backupDir, `${backupId}.meta.json`), JSON.stringify(metadata, null, 2) + "\n", { mode: 0o600 });
    await this.pruneBackups(targetId, configId);
    return metadata;
  }

  private async pruneBackups(targetId: string, configId: string): Promise<void> {
    const entries = await readdir(this.backupDir).catch(() => [] as string[]);
    const metadata = [] as Array<{ id: string; createdAt: string }>;
    for (const name of entries.filter((entry) => entry.endsWith(".meta.json"))) {
      try {
        const value = JSON.parse(await readFile(join(this.backupDir, name), "utf8")) as BackupMetadata;
        if (value.targetId === targetId && value.configId === configId) metadata.push({ id: value.backupId, createdAt: value.createdAt });
      } catch { /* corrupt metadata is left for manual inspection */ }
    }
    metadata.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    for (const old of metadata.slice(this.backupRetentionPerConfig)) {
      await rm(join(this.backupDir, `${old.id}.data`), { force: true });
      await rm(join(this.backupDir, `${old.id}.meta.json`), { force: true });
    }
  }

  private async atomicWrite(path: string, data: string | Buffer): Promise<void> {
    await this.assertNoSymlinkTarget(path);
    await mkdir(dirname(path), { recursive: true });
    const mode = await stat(path).then((s) => s.mode & 0o777).catch(() => 0o600);
    const temp = join(dirname(path), `.${basename(path)}.phonon-${process.pid}-${randomBytes(4).toString("hex")}.tmp`);
    try {
      await writeFile(temp, data, { mode, flag: "wx" });
      // Fail closed on platforms that cannot atomically replace; never copy-over.
      await rename(temp, path);
    } finally {
      await rm(temp, { force: true }).catch(() => {});
    }
  }

  private async assertNoSymlinkTarget(path: string): Promise<void> {
    const { lstat } = await import("node:fs/promises");
    // Do not reject normal platform aliases such as macOS /var → /private/var;
    // the configured target path is device-local trusted configuration. What
    // matters is that the final config entry itself is not an attacker-swapped symlink.
    const st = await lstat(path).catch(() => undefined);
    if (st?.isSymbolicLink()) throw new PhononError("errPolicyDenied", `maintenance config must not be a symlink: ${path}`);
  }

  private assertBackupId(backupId: string): void {
    if (!/^[A-Za-z0-9._-]+$/.test(backupId)) throw new PhononError("errInvalidParams", "invalid backup id");
  }

  private assertLocalId(value: string, label: string): void {
    if (!/^[A-Za-z0-9._-]+$/.test(value)) throw new Error(`invalid maintenance ${label}: ${value}`);
  }
}
