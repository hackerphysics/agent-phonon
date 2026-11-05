import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import {
  HermesAdapter, HermesScheduleDiscoverer, HermesScheduleDiscoveryError,
  type HermesScheduleDiscoveryOptions,
} from "@agent-phonon/core";

type DiscoveryProbe = NonNullable<HermesScheduleDiscoveryOptions["probe"]>;

const help = "usage: hermes cron [-h] {list,status,runs}\n  list   List scheduled jobs\n";
const fixtureJob = {
  id: "fixture-job", name: "Fixture report", enabled: true, state: "scheduled",
  schedule: { kind: "cron", expr: "0 9 * * *", display: "Daily at 09:00", tz: "Asia/Shanghai" },
  schedule_display: "fallback", repeat: { times: null, completed: 2 },
  next_run_at: "2026-11-06T09:00:00+08:00", last_run_at: "2026-11-05T09:00:00+08:00",
  last_status: "delivery_failed", last_error: null, last_delivery_error: "fixture delivery failure",
  deliver: "origin", failure_deliver: "local",
  origin: { platform: "fixture", chat_id: "redacted-chat", chat_name: "Fixture", thread_id: 7 },
  context_from: ["previous-fixture"], workdir: "/fixture/workspace", model: "fixture-model",
  provider: "fixture-provider", attach_to_session: true,
  prompt: "private instructions excluded", script: "private script excluded", token: "fixture-secret-excluded",
};
const fails = (code: string) => (error: unknown) => error instanceof HermesScheduleDiscoveryError && error.code === code;

async function fixture(t: TestContext) {
  const home = await mkdtemp(join(tmpdir(), "hermes-schedule-fixture-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const file = join(home, "cron", "jobs.json");
  await mkdir(join(home, "cron"));
  const save = (jobs: unknown = [fixtureJob]) => writeFile(file, JSON.stringify({ jobs, updated_at: "2026-11-05T00:00:00Z" }));
  await save();
  const calls: Array<{ args: string[]; home?: string }> = [];
  const probe: DiscoveryProbe = async (command, args, _signal, scope) => {
    assert.equal(command, "fixture-hermes");
    // An exact positive allowlist also rejects every mutating verb and argument.
    assert.deepEqual(args, ["cron", "--help"]);
    assert.equal(scope?.env?.HERMES_SUPERVISED_CHILD, "1");
    calls.push({ args, home: scope?.env?.HERMES_HOME });
    return help;
  };
  const discoverer = new HermesScheduleDiscoverer({ home, binPath: "fixture-hermes", probe });
  return { home, file, save, calls, probe, discoverer };
}

test("native list and detail preserve trigger/context/delivery without writes or raw secrets", async t => {
  const f = await fixture(t);
  const before = await readFile(f.file);
  const beforeStat = await stat(f.file);
  const inventory = await f.discoverer.discoverNativeSchedules();
  assert.equal(inventory.runtime, "hermes");
  assert.equal(inventory.source, "cron/jobs.json");
  assert.equal(inventory.profile, "default");
  assert.equal(inventory.updatedAt, "2026-11-05T00:00:00Z");
  assert.deepEqual(inventory.jobs, [{
    id: fixtureJob.id, name: fixtureJob.name, enabled: true, state: "scheduled",
    nextRunAt: fixtureJob.next_run_at, lastRunAt: fixtureJob.last_run_at,
    lastStatus: "delivery_failed", lastError: null,
  }]);
  const detail = await f.discoverer.getNativeSchedule(fixtureJob.id);
  assert.deepEqual(detail.trigger, {
    kind: "cron", expr: "0 9 * * *", display: "Daily at 09:00", timezone: "Asia/Shanghai",
    minutes: undefined, runAt: undefined, repeat: { times: null, completed: 2 },
  });
  assert.deepEqual(detail.context, {
    home: f.home, profile: "default", agentId: "hermes:default", origin: fixtureJob.origin,
    contextFrom: fixtureJob.context_from, workdir: fixtureJob.workdir,
    model: fixtureJob.model, provider: fixtureJob.provider, attachToSession: true,
  });
  assert.deepEqual(detail.delivery, { mode: "origin", failureMode: "local", lastDeliveryError: fixtureJob.last_delivery_error });
  assert.doesNotMatch(JSON.stringify([inventory, detail]), /private instructions|private script|fixture-secret/);
  assert.deepEqual(await readFile(f.file), before);
  assert.equal((await stat(f.file)).mtimeMs, beforeStat.mtimeMs);
  assert.equal(f.calls.length, 2);
  assert.ok(f.calls.every(call => call.home === f.home));
});

test("only a valid structured empty inventory succeeds; disabled and completed jobs are retained", async t => {
  const f = await fixture(t);
  await f.save([]);
  assert.deepEqual((await f.discoverer.discoverNativeSchedules()).jobs, []);
  await f.save([{ ...fixtureJob, enabled: false, state: "paused" }, {
    id: "once", state: "completed", schedule: { kind: "once", run_at: "2026-11-01T00:00:00Z" },
  }, { id: "interval", schedule: { kind: "interval", minutes: 30 }, schedule_display: "every 30m" }]);
  assert.equal((await f.discoverer.discoverNativeSchedules()).jobs.length, 3);
  assert.equal((await f.discoverer.getNativeSchedule("once")).trigger.runAt, "2026-11-01T00:00:00Z");
  const interval = await f.discoverer.getNativeSchedule("interval");
  assert.equal(interval.trigger.minutes, 30);
  assert.equal(interval.trigger.display, "every 30m");
  assert.equal(interval.trigger.timezone, undefined);
  await assert.rejects(f.discoverer.getNativeSchedule("unknown"), fails("job_not_found"));
});

test("missing executable, unsupported cron, and probe failures never return empty success", async t => {
  const f = await fixture(t);
  for (const [probe, code] of [
    [async () => null, "runtime_unavailable"],
    [async () => { throw Object.assign(new Error("secret diagnostic"), { code: "ENOENT" }); }, "runtime_unavailable"],
    [async () => "usage: hermes {chat,profile}\n  list  unrelated list", "cron_unsupported"],
    [async () => "", "cron_unsupported"],
    [async () => { throw new Error("secret diagnostic"); }, "probe_failed"],
  ] as const) {
    const discoverer = new HermesScheduleDiscoverer({ home: f.home, probe });
    await assert.rejects(discoverer.discoverNativeSchedules(), fails(code));
    await assert.rejects(discoverer.getNativeSchedule("fixture-job"), fails(code));
  }
  const actual = new HermesAdapter({ env: { binPath: join(f.home, "missing-binary"), nativeScheduleHome: f.home } });
  await assert.rejects(actual.discoverNativeSchedules(), fails("runtime_unavailable"));
});

test("corrupt, invalid, duplicate, missing and unsafe stores fail closed without exposing contents", async t => {
  const f = await fixture(t);
  for (const raw of ["{fixture-secret", "{}", '{"jobs":null}', '{"jobs":{}}', '{"jobs":[{}]}',
    JSON.stringify({ jobs: [{ ...fixtureJob, enabled: "false" }] }),
    JSON.stringify({ jobs: [fixtureJob, fixtureJob] })]) {
    await writeFile(f.file, raw);
    await assert.rejects(f.discoverer.discoverNativeSchedules(), error => {
      assert.doesNotMatch(String(error), /fixture-secret|fixture-job/);
      return fails("store_invalid")(error);
    });
  }
  await rm(f.file);
  await assert.rejects(f.discoverer.discoverNativeSchedules(), fails("store_unreadable"));
  const target = join(f.home, "other.json");
  await writeFile(target, '{"jobs":[]}');
  if (process.platform !== "win32") {
    await symlink(target, f.file);
    await assert.rejects(f.discoverer.discoverNativeSchedules(), fails("store_unreadable"));
    await rm(f.file);
  }
  await mkdir(f.file);
  await assert.rejects(f.discoverer.discoverNativeSchedules(), fails("store_unreadable"));
  await rm(f.file, { recursive: true });
  await writeFile(f.file, Buffer.alloc(8 * 1024 * 1024 + 1));
  await assert.rejects(f.discoverer.discoverNativeSchedules(), fails("store_unreadable"));
});

test("explicit profile, agentId, default profile and pinned HERMES_HOME stay isolated", async t => {
  const f = await fixture(t);
  const profile = `phn-${"a".repeat(40)}`;
  const home = join(f.home, "profiles", profile);
  await mkdir(join(home, "cron"), { recursive: true });
  await writeFile(join(home, "cron", "jobs.json"), JSON.stringify({ jobs: [{ ...fixtureJob, id: "profile-only" }] }));
  assert.equal((await f.discoverer.discoverNativeSchedules({ agentId: `hermes:${profile}` })).jobs[0]?.id, "profile-only");
  assert.equal((await f.discoverer.getNativeSchedule("profile-only", { profile })).context.home, home);
  await assert.rejects(f.discoverer.getNativeSchedule("fixture-job", { profile }), fails("job_not_found"));
  const pinned = new HermesScheduleDiscoverer({ home, binPath: "fixture-hermes", probe: f.probe, defaultProfile: "default" });
  assert.equal((await pinned.discoverNativeSchedules()).profile, profile);
  assert.equal((await pinned.discoverNativeSchedules({ profile: "default" })).jobs[0]?.id, "fixture-job");
  const preferred = new HermesScheduleDiscoverer({ home: f.home, binPath: "fixture-hermes", probe: f.probe, defaultProfile: profile });
  assert.equal((await preferred.discoverNativeSchedules()).home, home);
  const previous = process.env.HERMES_HOME;
  t.after(() => { if (previous === undefined) delete process.env.HERMES_HOME; else process.env.HERMES_HOME = previous; });
  process.env.HERMES_HOME = home;
  const environment = new HermesScheduleDiscoverer({ binPath: "fixture-hermes", probe: f.probe });
  assert.equal((await environment.discoverNativeSchedules()).home, home);
  const missingProfile = { profile: "missing" };
  await assert.rejects(f.discoverer.discoverNativeSchedules(missingProfile), fails("store_unreadable"));
  await mkdir(join(f.home, "profiles", ".deleted"));
  await writeFile(join(f.home, "profiles", ".deleted", profile), "deleted");
  await assert.rejects(f.discoverer.discoverNativeSchedules({ profile }), fails("store_unreadable"));
});

test("invalid scope and cancellation cannot produce observations", async t => {
  const f = await fixture(t);
  for (const scope of [{ profile: "../default" }, { agentId: "hermes:" }, { agentId: "other:default" },
    { agentId: "hermes:default:other" }, { agentId: "hermes:default", profile: "another" }]) {
    await assert.rejects(f.discoverer.discoverNativeSchedules(scope), fails("invalid_scope"));
  }
  assert.equal(f.calls.length, 0);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(f.discoverer.discoverNativeSchedules({ signal: controller.signal }), { name: "AbortError" });
  const next = new AbortController();
  const late = new HermesScheduleDiscoverer({ home: f.home, probe: async () => { next.abort(); return help; } });
  await assert.rejects(late.discoverNativeSchedules({ signal: next.signal }), { name: "AbortError" });
});

test("public Hermes adapter methods use configured home and profile with only the help probe", { skip: process.platform === "win32" }, async t => {
  const f = await fixture(t);
  const profile = "adapter-fixture";
  const home = join(f.home, "profiles", profile);
  await mkdir(join(home, "cron"), { recursive: true });
  await writeFile(join(home, "cron", "jobs.json"), JSON.stringify({ jobs: [fixtureJob] }));
  const binary = join(f.home, "fixture-hermes");
  await writeFile(binary, `#!${process.execPath}\nif (JSON.stringify(process.argv.slice(2)) !== '["cron","--help"]' || process.env.HERMES_HOME !== ${JSON.stringify(home)}) process.exit(41);\nprocess.stdout.write(${JSON.stringify(help)});\n`, { mode: 0o700 });
  const adapter = new HermesAdapter({ env: { binPath: binary, nativeScheduleHome: f.home }, defaultProfile: profile });
  assert.equal((await adapter.discoverNativeSchedules()).profile, profile);
  const detail = await adapter.getNativeSchedule(fixtureJob.id, { agentId: `hermes:${profile}` });
  assert.equal(detail.context.home, home);
  assert.equal(detail.delivery.mode, "origin");
});
