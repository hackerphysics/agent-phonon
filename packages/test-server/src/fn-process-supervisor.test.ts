import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { ProcessSupervisor } from "@agent-phonon/core";

class FakeChild extends EventEmitter {
  pid = 4242;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  killedSignals: Array<NodeJS.Signals | undefined> = [];

  kill(signal?: NodeJS.Signals): boolean {
    this.killedSignals.push(signal);
    return true;
  }

  close(code = 0): void {
    this.exitCode = code;
    this.emit("close", code, null);
  }
}

function asChild(child: FakeChild): ChildProcessWithoutNullStreams {
  return child as unknown as ChildProcessWithoutNullStreams;
}

test("ProcessSupervisor signals the POSIX process group with grace then force", async () => {
  const child = new FakeChild();
  const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
  const supervisor = new ProcessSupervisor(asChild(child), {
    platform: "linux",
    graceMs: 5,
    isTreeAlive: () => true,
    killProcessGroup: (pid, signal) => signals.push({ pid, signal }),
  });

  await supervisor.terminate();
  assert.deepEqual(signals, [
    { pid: 4242, signal: "SIGTERM" },
    { pid: 4242, signal: "SIGKILL" },
  ]);
  assert.deepEqual(child.killedSignals, [], "group signaling is preferred over killing only the direct child");
});

test("ProcessSupervisor cancels force escalation when the tree exits during grace", async () => {
  const child = new FakeChild();
  const signals: NodeJS.Signals[] = [];
  let treeAlive = true;
  const supervisor = new ProcessSupervisor(asChild(child), {
    platform: "darwin",
    graceMs: 50,
    isTreeAlive: () => treeAlive,
    killProcessGroup: (_pid, signal) => signals.push(signal),
  });

  const terminating = supervisor.terminate();
  treeAlive = false;
  child.close();
  await terminating;
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.deepEqual(signals, ["SIGTERM"]);
  assert.equal(child.listenerCount("close"), 0);
  assert.equal(child.listenerCount("error"), 0);
});

test("ProcessSupervisor does not treat a running child's error event as process-tree exit", async () => {
  const child = new FakeChild();
  const signals: NodeJS.Signals[] = [];
  let treeAlive = true;
  const supervisor = new ProcessSupervisor(asChild(child), {
    platform: "linux",
    graceMs: 100,
    isTreeAlive: () => treeAlive,
    killProcessGroup: (_pid, signal) => signals.push(signal),
  });

  child.emit("error", new Error("stdio failure"));
  let settled = false;
  const terminating = supervisor.terminate().then(() => { settled = true; });
  await Promise.resolve();
  assert.equal(settled, false, "error with a live pid must still wait for process close or force escalation");
  assert.deepEqual(signals, ["SIGTERM"]);
  treeAlive = false;
  child.close();
  await terminating;
  assert.equal(settled, true);
});

test("ProcessSupervisor keeps force escalation when leader exits but descendants survive", async () => {
  const child = new FakeChild();
  const signals: NodeJS.Signals[] = [];
  const supervisor = new ProcessSupervisor(asChild(child), {
    platform: "linux",
    graceMs: 5,
    isTreeAlive: () => true,
    killProcessGroup: (_pid, signal) => signals.push(signal),
  });

  const terminating = supervisor.terminate();
  child.close();
  await terminating;
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
});

test("ProcessSupervisor uses Windows tree termination and /F-equivalent escalation", async () => {
  const child = new FakeChild();
  const treeKills: Array<{ pid: number; force: boolean }> = [];
  const supervisor = new ProcessSupervisor(asChild(child), {
    platform: "win32",
    graceMs: 5,
    killWindowsTree: async (pid, force) => { treeKills.push({ pid, force }); },
  });

  const first = supervisor.terminate();
  assert.equal(supervisor.terminate(), first, "terminate is idempotent");
  await first;
  assert.deepEqual(treeKills, [
    { pid: 4242, force: false },
    { pid: 4242, force: true },
  ]);
});
