import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { LaunchdService } from "./launchd.js";

test("launchd native: plist, PATH, crash recovery, restart, stop and uninstall", {
  skip: process.platform !== "darwin" || process.env.PHONON_TEST_LAUNCHD !== "1",
  timeout: 60_000,
}, async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "phonon-launchd native & ")));
  const label = `ai.phonon.test.${randomUUID()}`;
  const cli = join(home, "fixture.mjs"), configPath = join(home, "config.json"), marker = join(home, "started.json");
  const customBin = join(home, "custom bin"); mkdirSync(customBin);
  writeFileSync(configPath, "{}", { mode: 0o600 });
  writeFileSync(cli, `import { writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { PhononDaemon } from ${JSON.stringify(new URL("./daemon.js", import.meta.url).href)};
const home = process.env.HOME;
const daemon = new PhononDaemon({deviceId:'launchd-fixture',dbPath:join(home,'state.sqlite'),workspaceRoot:home,
  adapters:[],servers:[],rescueAgent:{enabled:false},hookBridge:{port:0},obs:{enabled:true,port:0},logLevel:'error'}, {adapters:[]});
await daemon.start();
writeFileSync(join(home, 'started.json'), JSON.stringify({pid:process.pid,home,path:process.env.PATH,config:process.env.PHONON_CONFIG,port:daemon.obsPort}));
appendFileSync(join(home, 'lifecycle.jsonl'), JSON.stringify({event:'start',pid:process.pid})+'\\n');
console.log('fixture started');
process.on('SIGTERM', async () => {
  await daemon.stop();
  setTimeout(() => {
  appendFileSync(join(home, 'lifecycle.jsonl'), JSON.stringify({event:'stop',pid:process.pid})+'\\n');
  process.exit(0);
  }, 200);
});
`);
  const options = { home, node: process.execPath, cli, configPath, path: customBin, uid: process.getuid!(), label };
  const service = new LaunchdService(options);
  async function started(previous?: number): Promise<{ pid: number; home: string; path: string; config: string; port: number }> {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      if (existsSync(marker)) {
        const value = JSON.parse(readFileSync(marker, "utf8"));
        if (value.pid && value.pid !== previous) return value;
      }
      await sleep(100);
    }
    assert.fail("launchd fixture did not start");
  }
  try {
    await service.run("install");
    assert.ok(!existsSync(marker), "install does not launch the job");
    const parsed = spawnSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", service.plist], { encoding: "utf8" });
    assert.equal(parsed.status, 0, parsed.stderr);
    const plist = JSON.parse(parsed.stdout);
    assert.deepEqual(plist.ProgramArguments, [process.execPath, cli, "start"]);
    assert.equal(plist.Label, label); assert.equal(plist.Umask, 63);
    assert.deepEqual(Object.keys(plist.EnvironmentVariables).sort(), ["HOME", "PATH", "PHONON_CONFIG"]);
    await service.run("start"); const first = await started();
    assert.equal(first.home, home); assert.equal(first.config, configPath); assert.ok(first.path.split(":").includes(customBin));
    const health = await fetch(`http://127.0.0.1:${first.port}/health`, { signal: AbortSignal.timeout(2000) });
    assert.equal(health.status, 200);
    assert.equal((await health.json() as { ok: boolean }).ok, true);
    assert.ok(existsSync(join(home, "state.sqlite")));
    assert.equal(statSync(join(home, ".agent-phonon", "daemon.out.log")).mode & 0o777, 0o600);
    await service.run("status");
    await service.run("start"); assert.equal((await started()).pid, first.pid);
    process.kill(first.pid, "SIGKILL"); const recovered = await started(first.pid);
    const newBin = join(home, "updated bin"); mkdirSync(newBin);
    const updated = new LaunchdService({ ...options, path: newBin });
    await updated.run("install", { force: true });
    assert.equal((await started()).pid, recovered.pid, "force install preserves the running process");
    await updated.run("restart"); const restarted = await started(recovered.pid);
    assert.ok(restarted.path.split(":").includes(newBin), "restart loads the new plist");
    assert.ok(!restarted.path.split(":").includes(customBin));
    assert.throws(() => process.kill(recovered.pid, 0), { code: "ESRCH" });
    await service.run("stop");
    assert.throws(() => process.kill(restarted.pid, 0), { code: "ESRCH" });
    await sleep(6000);
    assert.equal((await started()).pid, restarted.pid, "KeepAlive cannot respawn a stopped job");
    const lifecycle = readFileSync(join(home, "lifecycle.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
    assert.deepEqual(lifecycle.map(e => [e.event, e.pid]), [["start", first.pid], ["start", recovered.pid],
      ["stop", recovered.pid], ["start", restarted.pid], ["stop", restarted.pid]]);
    await service.run("start"); const last = await started(restarted.pid);
    await service.run("uninstall");
    assert.throws(() => process.kill(last.pid, 0), { code: "ESRCH" });
    assert.ok(!existsSync(service.plist)); assert.ok(existsSync(configPath));
    await service.run("status");
  } finally {
    await service.run("uninstall");
    rmSync(home, { recursive: true, force: true });
  }
});
