import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, lstatSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { OpenCodeAdapter } from "./opencode.js";
import { OpenCodeRuntimeDirectory, openCodeDiscoveryProbe } from "./opencode-runtime.js";
import type { ProcessSupervisor } from "../process-supervisor.js";
import { withPeerFixture } from "../testing/peer-fixture.js";

const temporaryKeys = ["BUN_TMPDIR", "TMPDIR", "TMP", "TEMP"];

function nativeFixture(root: string, hang = false): { bin: string; records: () => Array<{ path: string; args: string[] }> } {
  const bin = join(root, "native.mjs"), record = join(root, "invocations.jsonl");
  writeFileSync(bin, `#!${process.execPath}
import {appendFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
const path=process.env.TMPDIR;
if(!path||${JSON.stringify(temporaryKeys)}.some(key=>process.env[key]!==path))throw Error('temporary environment not isolated');
writeFileSync(join(path,'.native-00000000.so'),'synthetic native FFI artifact');
appendFileSync(${JSON.stringify(record)},JSON.stringify({path,args:process.argv.slice(2)})+'\\n');
if(${hang})setInterval(()=>{},1000);
else if(process.argv.includes('--version'))console.log('1.14.20');
else if(process.argv.includes('--help'))console.log('--variant');
else if(process.argv.includes('debug'))console.log('{}');
else if(process.argv.includes('models'))console.log('');
else {
 console.log(JSON.stringify({type:'text',sessionID:'ses_fixture',part:{text:'completed'}}));
 console.log(JSON.stringify({type:'step_finish',sessionID:'ses_fixture'}));
}
`, { mode: 0o700 });
  return { bin, records: () => existsSync(record) ? readFileSync(record, "utf8").trim().split("\n").map(line => JSON.parse(line)) : [] };
}

test("OpenCode discovery, session qualification and execution reclaim native FFI leftovers", () => withPeerFixture("opencode-runtime", async scope => {
  const fixture = nativeFixture(scope.root), before = Object.fromEntries(temporaryKeys.map(key => [key, process.env[key]]));
  const adapter = new OpenCodeAdapter({ env: { binPath: fixture.bin } });
  for (let n = 0; n < 3; n++) assert.equal((await adapter.discoverAgents())[0]?.available, true);
  assert.equal(fixture.records().length, 12, "all four native inventory commands must be contained");
  const session = await adapter.createSession({ sessionId: "fixture", agentId: "opencode", model: "default", cwd: scope.root });
  const events: any[] = [];
  try {
    await session.send("fixture", { turnId: "turn", verbosity: "tools", emit: event => events.push(event),
      environment: Object.fromEntries(temporaryKeys.map(key => [key, join(scope.root, "untrusted")])) });
    assert.equal(events.at(-1)?.status, "completed");
  } finally { await session.terminate(); }
  const records = fixture.records();
  assert.equal(records.length, 14);
  assert.equal(new Set(records.map(record => record.path)).size, records.length, "concurrent invocations never share writable scratch");
  for (const record of records) assert.equal(existsSync(record.path), false, record.path);
  assert.deepEqual(Object.fromEntries(temporaryKeys.map(key => [key, process.env[key]])), before);
  assert.equal(readdirSync(scope.root).some(name => name.startsWith("phonon-opencode-runtime-")), false);
}));

test("OpenCode failed and missing probes reclaim their owned directories", () => withPeerFixture("opencode-runtime", async scope => {
  const before = readdirSync(scope.root).sort();
  assert.equal(await openCodeDiscoveryProbe(join(scope.root, "missing"), ["--version"]), null);
  await assert.rejects(openCodeDiscoveryProbe(process.execPath, ["-e", "process.exit(1)"]), /probe failed/);
  assert.deepEqual(readdirSync(scope.root).sort(), before);
}));

test("OpenCode aborted probes stop before deleting native libraries", () => withPeerFixture("opencode-runtime", async scope => {
  const fixture = nativeFixture(scope.root, true), controller = new AbortController();
  const probe = openCodeDiscoveryProbe(fixture.bin, ["--version"], controller.signal);
  void probe.catch(() => {});
  try {
    for (let n = 0; n < 200 && !fixture.records().length; n++) await new Promise(resolve => setTimeout(resolve, 10));
    const record = fixture.records()[0];
    assert.ok(record, "native probe reached its owned directory");
    assert.equal(existsSync(join(record.path, ".native-00000000.so")), true);
    controller.abort();
    await assert.rejects(probe, /probe aborted/);
    assert.equal(existsSync(record.path), false);
  } finally { controller.abort(); await probe.catch(() => {}); }
}));

test("OpenCode scratch retains unconfirmed process trees and rejects changed ownership", () => withPeerFixture("opencode-runtime", async scope => {
  const temporary = new OpenCodeRuntimeDirectory();
  let stopped = false;
  const runtime = { child: { pid: process.pid }, hasStopped: () => stopped } as unknown as ProcessSupervisor;
  const marker = join(temporary.path, ".phonon-opencode-runtime.json");
  try {
    temporary.watch(runtime);
    assert.equal(JSON.parse(readFileSync(marker, "utf8")).childPID, process.pid);
    if (process.platform !== "win32") assert.equal(lstatSync(temporary.path).mode & 0o077, 0);
    assert.throws(() => temporary.cleanup(), /still active/);
    assert.equal(existsSync(temporary.path), true);
    stopped = true;
    const original = readFileSync(marker, "utf8");
    try {
      writeFileSync(marker, JSON.stringify({ ownerPID: process.pid, nonce: "not-the-owner" }));
      assert.throws(() => temporary.cleanup(), /ownership changed/);
    } finally { writeFileSync(marker, original); }
  } finally { stopped = true; temporary.cleanup(); }
  temporary.cleanup();
  assert.equal(existsSync(temporary.path), false);
}));
