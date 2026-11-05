import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, normalize } from "node:path";
import { z } from "zod";
import { discoveryProbe } from "../discovery-probe.js";

export type HermesScheduleDiscoveryErrorCode =
  | "invalid_scope" | "runtime_unavailable" | "cron_unsupported" | "probe_failed"
  | "store_unreadable" | "store_invalid" | "job_not_found";

/** Messages deliberately exclude vendor diagnostics, paths and job contents. */
export class HermesScheduleDiscoveryError extends Error {
  override readonly name = "HermesScheduleDiscoveryError";
  constructor(readonly code: HermesScheduleDiscoveryErrorCode) {
    super(`Hermes native schedule discovery: ${code}`);
  }
}

export interface HermesScheduleScope {
  agentId?: string;
  profile?: string;
  signal?: AbortSignal;
}

export interface HermesNativeScheduleSummary {
  id: string;
  name?: string | null;
  enabled?: boolean | null;
  state?: string | null;
  nextRunAt?: string | null;
  lastRunAt?: string | null;
  lastStatus?: string | null;
  lastError?: string | null;
}

export interface HermesNativeScheduleDetail extends HermesNativeScheduleSummary {
  trigger: {
    kind: string;
    expr?: string | null;
    display?: string | null;
    timezone?: string | null;
    minutes?: number | null;
    runAt?: string | null;
    repeat?: { times?: number | null; completed?: number | null } | null;
  };
  context: {
    profile: string;
    agentId: string;
    home: string;
    origin?: {
      platform?: string | null;
      chat_id?: string | number | null;
      chat_name?: string | null;
      thread_id?: string | number | null;
    } | null;
    contextFrom?: string[] | null;
    workdir?: string | null;
    model?: string | null;
    provider?: string | null;
    attachToSession?: boolean | null;
  };
  delivery: {
    mode?: string | null;
    failureMode?: string | null;
    lastDeliveryError?: string | null;
  };
}

export interface HermesNativeScheduleInventory {
  runtime: "hermes";
  source: "cron/jobs.json";
  profile: string;
  agentId: string;
  home: string;
  updatedAt?: string | null;
  jobs: HermesNativeScheduleSummary[];
}

const text = z.string().nullish();
const number = z.number().finite().nullish();
const flag = z.boolean().nullish();
const jobSchema = z.object({
  id: z.string().min(1), name: text, enabled: flag, state: text,
  next_run_at: text, last_run_at: text, last_status: text, last_error: text,
  schedule: z.object({
    kind: z.string().min(1), expr: text, display: text, tz: text, timezone: text,
    minutes: number, run_at: text,
  }),
  schedule_display: text,
  repeat: z.object({ times: number, completed: number }).nullish(),
  origin: z.object({
    platform: text, chat_id: z.union([z.string(), z.number().finite()]).nullish(),
    chat_name: text, thread_id: z.union([z.string(), z.number().finite()]).nullish(),
  }).nullish(),
  context_from: z.array(z.string()).nullish(), workdir: text, model: text, provider: text,
  attach_to_session: flag, deliver: text, failure_deliver: text, last_delivery_error: text,
});
const storeSchema = z.object({ jobs: z.array(jobSchema), updated_at: text });
type NativeJob = z.infer<typeof jobSchema>;
const MAX_STORE_BYTES = 8 * 1024 * 1024;

function profileName(value: string): string {
  const name = value.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(name)) throw new HermesScheduleDiscoveryError("invalid_scope");
  return name;
}

function summary(job: NativeJob): HermesNativeScheduleSummary {
  return {
    id: job.id, name: job.name, enabled: job.enabled, state: job.state,
    nextRunAt: job.next_run_at, lastRunAt: job.last_run_at,
    lastStatus: job.last_status, lastError: job.last_error,
  };
}

/** Local-only configuration, never a caller-supplied path or executable from RPC. */
export interface HermesScheduleDiscoveryOptions {
  binPath?: string;
  home?: string;
  defaultProfile?: string;
  probe?: typeof discoveryProbe;
}

export class HermesScheduleDiscoverer {
  constructor(private readonly options: HermesScheduleDiscoveryOptions = {}) {}

  private resolveScope(scope: HermesScheduleScope) {
    const configuredHome = this.options.home ?? (process.env.HERMES_HOME?.trim() || join(homedir(), ".hermes"));
    if (!isAbsolute(configuredHome) || configuredHome.includes("\0")) throw new HermesScheduleDiscoveryError("invalid_scope");
    const home = normalize(configuredHome);
    const pinned = basename(dirname(home)) === "profiles";
    const root = pinned ? dirname(dirname(home)) : home;
    let agentProfile: string | undefined;
    if (scope.agentId !== undefined) {
      if (scope.agentId !== "hermes" && !scope.agentId.startsWith("hermes:")) throw new HermesScheduleDiscoveryError("invalid_scope");
      agentProfile = profileName(scope.agentId === "hermes" ? (this.options.defaultProfile ?? "default") : scope.agentId.slice(7));
    }
    const requestedProfile = scope.profile === undefined ? undefined : profileName(scope.profile);
    if (agentProfile && requestedProfile && agentProfile !== requestedProfile) throw new HermesScheduleDiscoveryError("invalid_scope");
    const selected = requestedProfile ?? agentProfile ?? (this.options.defaultProfile !== "default" ? this.options.defaultProfile : undefined);
    const profile = profileName(selected ?? (pinned ? basename(home) : "default"));
    const selectedHome = selected === undefined ? home : profile === "default" ? root : join(root, "profiles", profile);
    return { profile, agentId: `hermes:${profile}`, home: selectedHome };
  }

  private async read(scope: HermesScheduleScope) {
    const signal = scope.signal;
    signal?.throwIfAborted();
    const resolved = this.resolveScope(scope);
    let help: string | null;
    try {
      help = await (this.options.probe ?? discoveryProbe)(this.options.binPath ?? "hermes", ["cron", "--help"], signal, {
        env: { ...process.env, HERMES_HOME: resolved.home, HERMES_SUPERVISED_CHILD: "1", PYTHONDONTWRITEBYTECODE: "1" },
      });
    } catch (error) {
      signal?.throwIfAborted();
      throw new HermesScheduleDiscoveryError((error as NodeJS.ErrnoException)?.code === "ENOENT" ? "runtime_unavailable" : "probe_failed");
    }
    signal?.throwIfAborted();
    if (help === null) throw new HermesScheduleDiscoveryError("runtime_unavailable");
    const clean = help.replace(/\u001b\[[0-9;]*m/g, "");
    if (!/\busage:[^\r\n]*\bcron\b/i.test(clean) || !/^\s*list\s+/m.test(clean)) {
      throw new HermesScheduleDiscoveryError("cron_unsupported");
    }

    let raw: string;
    try {
      // Do not invoke Hermes' loader: it can normalize records and create lock files.
      if (basename(dirname(resolved.home)) === "profiles") {
        const tombstone = join(dirname(resolved.home), ".deleted", resolved.profile);
        try {
          await lstat(tombstone);
          throw new HermesScheduleDiscoveryError("store_unreadable");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
      for (const path of [resolved.home, join(resolved.home, "cron")]) {
        const stat = await lstat(path);
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw new HermesScheduleDiscoveryError("store_unreadable");
      }
      const file = await open(join(resolved.home, "cron", "jobs.json"), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_STORE_BYTES) throw new HermesScheduleDiscoveryError("store_unreadable");
        const buffer = Buffer.alloc(MAX_STORE_BYTES + 1);
        let length = 0;
        while (length < buffer.length) {
          signal?.throwIfAborted();
          const { bytesRead } = await file.read(buffer, length, buffer.length - length, null);
          if (!bytesRead) break;
          length += bytesRead;
        }
        if (length > MAX_STORE_BYTES) throw new HermesScheduleDiscoveryError("store_unreadable");
        raw = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, length));
      } finally { await file.close(); }
    } catch {
      signal?.throwIfAborted();
      throw new HermesScheduleDiscoveryError("store_unreadable");
    }
    signal?.throwIfAborted();
    try {
      const store = storeSchema.parse(JSON.parse(raw));
      if (new Set(store.jobs.map(job => job.id)).size !== store.jobs.length) throw new Error("duplicate identity");
      return { ...resolved, store };
    } catch { throw new HermesScheduleDiscoveryError("store_invalid"); }
  }

  async discoverNativeSchedules(scope: HermesScheduleScope = {}): Promise<HermesNativeScheduleInventory> {
    const { store, ...resolved } = await this.read(scope);
    return { runtime: "hermes", source: "cron/jobs.json", ...resolved, updatedAt: store.updated_at, jobs: store.jobs.map(summary) };
  }

  async getNativeSchedule(id: string, scope: HermesScheduleScope = {}): Promise<HermesNativeScheduleDetail> {
    const { store, ...resolved } = await this.read(scope);
    const job = store.jobs.find(job => job.id === id);
    if (!job) throw new HermesScheduleDiscoveryError("job_not_found");
    return {
      ...summary(job),
      trigger: {
        kind: job.schedule.kind, expr: job.schedule.expr,
        display: job.schedule.display ?? job.schedule_display,
        timezone: job.schedule.timezone ?? job.schedule.tz,
        minutes: job.schedule.minutes, runAt: job.schedule.run_at, repeat: job.repeat,
      },
      context: {
        ...resolved, origin: job.origin, contextFrom: job.context_from, workdir: job.workdir,
        model: job.model, provider: job.provider, attachToSession: job.attach_to_session,
      },
      delivery: { mode: job.deliver, failureMode: job.failure_deliver, lastDeliveryError: job.last_delivery_error },
    };
  }
}
