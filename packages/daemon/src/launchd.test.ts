import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { LaunchdService, launchAgentContent, type LaunchdOptions } from "./launchd.js";

function fixture(t: TestContext) {
  const home = mkdtempSync(join(tmpdir(), "phonon-launchd-unit-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const cli = join(home, "cli.js"), configPath = join(home, ".agent-phonon", "config.json");
  mkdirSync(dirname(configPath));
  writeFileSync(cli, "// fixture\n");
  writeFileSync(configPath, '{"deviceId":"preserved","servers":[]}');
  const options: LaunchdOptions = { home, node: process.execPath, cli, configPath, uid: 501, path: "/usr/bin:/bin" };
  const calls: string[][] = [], logs: string[] = [], waited: number[] = [];
  const state = { loaded: false, pid: undefined as number | undefined, lastExit: undefined as number | undefined,
    fail: "", waitError: false, inspectCode: 0, domainCode: 0 };
  const service = new LaunchdService(options, {
    launchctl(args) {
      calls.push(args);
      if (args[0] === state.fail) return { status: 5, stdout: "" };
      if (args[0] === "print" && args[1] === "gui/501") return { status: state.domainCode, stdout: "" };
      if (args[0] === "print") return { status: state.inspectCode || (state.loaded ? 0 : 113),
        stdout: `gui/501/ai.phonon.agent = {\n${state.pid ? `  pid = ${state.pid}\n` : ""}${state.lastExit !== undefined ? `  last exit code = ${state.lastExit}\n` : ""}}\n` };
      if (args[0] === "bootout") state.loaded = false;
      if (args[0] === "bootstrap" || args[0] === "kickstart") state.loaded = true;
      return { status: 0, stdout: "" };
    },
    async waitForExit(pid) { waited.push(pid); if (state.waitError) throw new Error("daemon has not exited"); },
    log(message) { logs.push(message); },
  });
  return { options, service, calls, logs, state, waited };
}

test("launchd plist: absolute arguments, safe PATH and only explicit environment", () => {
  const options: LaunchdOptions = { home: "/Users/Example & <User>", node: "/opt/node/bin/node", cli: "/Apps/Agent Phonon/cli.js",
    configPath: "/Config/my & config.json", uid: 501, path: "/opt/node/bin:/custom/bin::.:relative:/custom/bin" };
  const content = launchAgentContent(options);
  assert.match(content, /<string>\/Apps\/Agent Phonon\/cli.js<\/string>/);
  assert.match(content, /Example &amp; &lt;User&gt;/);
  assert.match(content, /my &amp; config.json/);
  const path = /<key>PATH<\/key><string>(.*?)<\/string>/.exec(content)![1]!;
  assert.ok(path.startsWith("/opt/node/bin:/custom/bin:"));
  assert.equal(path.split(":").filter(p => p === "/custom/bin").length, 1);
  assert.ok(!path.split(":").includes(".") && !path.split(":").includes("relative"));
  const environment = /<key>EnvironmentVariables<\/key>\s*<dict>([\s\S]*?)<\/dict>/.exec(content)![1]!;
  assert.deepEqual([...environment.matchAll(/<key>(.*?)<\/key>/g)].map(m => m[1]), ["HOME", "PATH", "PHONON_CONFIG"]);
  for (const key of ["RunAtLoad", "KeepAlive", "ThrottleInterval", "ExitTimeOut", "Umask", "StandardOutPath", "StandardErrorPath"]) {
    assert.ok(content.includes(`<key>${key}</key>`));
  }
  assert.throws(() => launchAgentContent({ ...options, cli: "relative/cli.js" }), /absolute/);
  assert.throws(() => launchAgentContent({ ...options, cli: "/bad\0path" }), /invalid character/);
  assert.throws(() => new LaunchdService({ ...options, uid: 0 }), /without sudo/);
  assert.throws(() => new LaunchdService({ ...options, label: "../another-service" }), /label/);
});

test("launchd install: atomic private plist, no process startup or config changes", async t => {
  const { service, options, calls } = fixture(t);
  const config = readFileSync(options.configPath, "utf8");
  const log = join(options.home, ".agent-phonon", "daemon.out.log");
  writeFileSync(log, "existing log content", { mode: 0o644 });
  await service.run("install");
  assert.equal(readFileSync(service.plist, "utf8"), launchAgentContent(options));
  if (process.platform !== "win32") assert.equal(statSync(service.plist).mode & 0o777, 0o600);
  assert.deepEqual(calls, []);
  assert.equal(readFileSync(options.configPath, "utf8"), config);
  assert.equal(readFileSync(log, "utf8"), "existing log content");
  if (process.platform !== "win32") assert.equal(statSync(log).mode & 0o777, 0o600);
  await assert.rejects(service.run("install"), /already exists/);
  writeFileSync(service.plist, "old plist");
  await service.run("install", { force: true });
  assert.equal(readFileSync(service.plist, "utf8"), launchAgentContent(options));
  assert.deepEqual(calls, [], "force does not interrupt the loaded service");
});

test("launchd install: refuse symlink log targets without changing their content or permissions", { skip: process.platform === "win32" }, async t => {
  const { service, options, calls } = fixture(t);
  const target = join(options.home, "unrelated-file");
  writeFileSync(target, "untouched", { mode: 0o644 });
  symlinkSync(target, join(options.home, ".agent-phonon", "daemon.out.log"));
  await assert.rejects(service.run("install"));
  assert.equal(readFileSync(target, "utf8"), "untouched");
  assert.equal(statSync(target).mode & 0o777, 0o644);
  assert.ok(!existsSync(service.plist)); assert.deepEqual(calls, []);
});

test("launchd install: missing executables do not overwrite an existing plist", async t => {
  const { service, options } = fixture(t);
  await service.run("install");
  const original = readFileSync(service.plist, "utf8");
  rmSync(options.cli);
  await assert.rejects(service.run("install", { force: true }), /CLI is missing/);
  assert.equal(readFileSync(service.plist, "utf8"), original);
});

test("launchd start: enable and bootstrap once; repeated start is idempotent", async t => {
  const { service, calls, state, logs } = fixture(t);
  await service.run("install");
  await service.run("start");
  assert.deepEqual(calls.slice(-2), [["enable", "gui/501/ai.phonon.agent"], ["bootstrap", "gui/501", service.plist]]);
  state.pid = 123;
  const count = calls.length;
  await service.run("start");
  assert.deepEqual(calls.slice(count), [["print", "gui/501"], ["print", "gui/501/ai.phonon.agent"]]);
  assert.match(logs.at(-1)!, /already running.*123/);
});

test("launchd start: kickstart a loaded job without a PID", async t => {
  const { service, calls, state } = fixture(t);
  await service.run("install"); state.loaded = true;
  await service.run("start");
  assert.deepEqual(calls.at(-1), ["kickstart", "gui/501/ai.phonon.agent"]);
  assert.ok(!calls.some(c => c[0] === "bootstrap" || c[0] === "bootout"));
});

test("launchd stop: bootout defeats KeepAlive and waits for the old PID; repeated stop is safe", async t => {
  const { service, calls, state, waited } = fixture(t);
  await service.run("install"); state.loaded = true; state.pid = 123;
  await service.run("stop");
  assert.deepEqual(calls.at(-1), ["bootout", "gui/501/ai.phonon.agent"]);
  assert.deepEqual(waited, [123]);
  assert.ok(existsSync(service.plist));
  await service.run("stop");
  assert.equal(calls.filter(c => c[0] === "bootout").length, 1);
});

test("launchd restart: reload installed configuration only after the old process exits", async t => {
  const { service, calls, state, waited } = fixture(t);
  await service.run("install"); state.loaded = true; state.pid = 123;
  await service.run("restart");
  assert.deepEqual(calls.slice(-3), [["bootout", "gui/501/ai.phonon.agent"], ["enable", "gui/501/ai.phonon.agent"], ["bootstrap", "gui/501", service.plist]]);
  assert.deepEqual(waited, [123]);
});

test("launchd restart: an unexited old process prevents a second instance", async t => {
  const { service, calls, state } = fixture(t);
  await service.run("install"); state.loaded = true; state.pid = 123; state.waitError = true;
  await assert.rejects(service.run("restart"), /has not exited/);
  assert.ok(!calls.some(c => c[0] === "enable" || c[0] === "bootstrap"));
});

for (const operation of ["stop", "restart", "uninstall"]) {
  test(`launchd ${operation}: bootout failure is not reported as success`, async t => {
    const { service, state, calls, logs } = fixture(t);
    await service.run("install"); state.loaded = true; state.pid = 123; state.fail = "bootout";
    const count = logs.length;
    await assert.rejects(service.run(operation), /bootout.*failed/);
    assert.ok(existsSync(service.plist));
    assert.ok(!calls.some(c => c[0] === "bootstrap"));
    assert.equal(logs.length, count);
  });
}

test("launchd status: distinguish absent, stopped, crashed and running", async t => {
  const { service, state, logs } = fixture(t);
  await service.run("status"); assert.match(logs.at(-1)!, /not installed/);
  await service.run("install");
  await service.run("status"); assert.match(logs.at(-1)!, /stopped/);
  state.loaded = true; state.lastExit = 7;
  await service.run("status"); assert.match(logs.at(-1)!, /loaded but not running.*7/);
  state.pid = 123;
  await service.run("status"); assert.match(logs.at(-1)!, /running.*123/);
});

test("launchd errors: unavailable GUI and unexpected inspection failures fail closed", async t => {
  const { service, state, calls } = fixture(t);
  state.domainCode = 5;
  await assert.rejects(service.run("status"), /GUI session unavailable/);
  assert.equal(calls.length, 1);
  state.domainCode = 0; state.inspectCode = 5;
  await assert.rejects(service.run("uninstall"), /cannot inspect/);
  assert.ok(!calls.some(c => c[0] === "bootout"));
});

test("launchd start errors: require installation/config and propagate enable/bootstrap errors", async t => {
  const { service, options, state } = fixture(t);
  await assert.rejects(service.run("start"), /not installed/);
  await service.run("install");
  for (const command of ["enable", "bootstrap"]) {
    state.fail = command;
    await assert.rejects(service.run("start"), new RegExp(`${command}.*failed`));
  }
  rmSync(options.configPath);
  await assert.rejects(service.run("start"), /config not found/);
  await assert.rejects(service.run("restart"), /config not found/);
});

test("launchd uninstall: stop supervision and remove only the plist", async t => {
  const { service, options, state } = fixture(t);
  await service.run("install"); state.loaded = true;
  const database = join(options.home, ".agent-phonon", "state.sqlite"); writeFileSync(database, "preserved data");
  await service.run("uninstall");
  assert.ok(!existsSync(service.plist));
  assert.equal(readFileSync(database, "utf8"), "preserved data");
  assert.ok(existsSync(options.configPath));
  await service.run("uninstall");
});

test("launchd invalid subcommands cannot write files or call launchctl", async t => {
  const { service, calls } = fixture(t);
  await assert.rejects(service.run("unknown"), /usage/);
  assert.ok(!existsSync(service.plist)); assert.deepEqual(calls, []);
});
