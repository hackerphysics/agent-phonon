import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { spawnAgent, spawnSyncAgent } from "../../core/dist/proc.js";

function captureLaunches(t: TestContext, platform: NodeJS.Platform, run: (calls: unknown[][]) => void): void {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
  const calls: unknown[][] = [];
  const record = (...args: unknown[]) => { calls.push(args); return {}; };
  t.mock.method(childProcess, "spawn", record);
  t.mock.method(childProcess, "spawnSync", record);
  syncBuiltinESMExports();
  Object.defineProperty(process, "platform", { ...descriptor, value: platform });
  try {
    run(calls);
  } finally {
    Object.defineProperty(process, "platform", descriptor);
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
}

test("Windows native executables bypass the shell without quoting or expanding arguments", t => {
  captureLaunches(t, "win32", calls => {
    const command = "C:\\Program Files\\Agent & Tools\\codex.EXE";
    const args = ["exec", "-c", 'provider.name="agent & tool"', "%USERPROFILE%", "", "a|b", "\u6d4b\u8bd5"];
    const options = { cwd: "C:\\Project space", windowsHide: true, shell: true, windowsVerbatimArguments: true };
    spawnAgent(command, args, options);
    spawnSyncAgent(command, args, options);
    assert.equal(calls.length, 2);
    for (const call of calls) assert.deepEqual(call, [command, args, { ...options, shell: false, windowsVerbatimArguments: false }]);
    assert.equal(options.shell, true, "caller options must not be mutated");
    assert.equal(options.windowsVerbatimArguments, true);
  });
});

test("Windows cmd shims retain their quoted shell launch", t => {
  captureLaunches(t, "win32", calls => {
    const command = "C:\\Program Files\\nodejs\\pi.cmd";
    const args = ["--model", "model name", "a&b", ""];
    const options = { windowsHide: true };
    spawnAgent(command, args, options);
    spawnSyncAgent(command, args, options);
    for (const call of calls) assert.deepEqual(call, ['"'+command+'"', ["--model", '"model name"', '"a&b"', '""'], { ...options, shell: true, windowsVerbatimArguments: true }]);
  });
});

test("Windows bare commands still resolve through the existing shim-compatible path", t => {
  captureLaunches(t, "win32", calls => {
    spawnAgent("codex", ["--version"]);
    spawnSyncAgent("codex", ["--version"]);
    for (const call of calls) assert.deepEqual(call, ["codex", ["--version"], { shell: true, windowsVerbatimArguments: true }]);
  });
});

test("POSIX launches preserve caller arguments and options", t => {
  captureLaunches(t, "darwin", calls => {
    const command = "/Applications/Agent Tools/agent.exe", args = ["a&b", "%HOME%", "a b"];
    const options = { detached: true, env: { TEST: "value" } };
    spawnAgent(command, args, options);
    spawnSyncAgent(command, args, options);
    for (const call of calls) assert.deepEqual(call, [command, args, options]);
  });
});
