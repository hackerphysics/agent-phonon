import { test } from "node:test";
import assert from "node:assert/strict";
import { PhononDevice, RpcPeer } from "@agent-phonon/server-sdk";

test("SDK device.call forwards explicit milliseconds and preserves the peer default", async () => {
  const calls: unknown[][] = [];
  const device = new PhononDevice("device", "tenant", {
    request: async (...args: unknown[]) => { calls.push(args); return { status: "idle" }; },
  } as unknown as RpcPeer);
  await device.call("session.status", { sessionId: "retained" }, 12_000);
  await device.call("session.status", { sessionId: "retained" });
  assert.deepEqual(calls, [
    ["session.status", { sessionId: "retained" }, 12_000],
    ["session.status", { sessionId: "retained" }, undefined],
  ]);
});

test("SDK device.call deadline removes pending work and ignores a late reply", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const sent: string[] = [];
  const peer = new RpcPeer({ send: data => { sent.push(data); }, close: () => {} }, () => null);
  const pending = (peer as unknown as { pending: Map<unknown, unknown> }).pending;
  const device = new PhononDevice("device", "tenant", peer);
  const request = device.call("session.status", { sessionId: "retained" }, 12_000);
  const outcome = assert.rejects(request, /rpc timeout: session.status/);
  assert.equal(pending.size, 1);
  t.mock.timers.tick(12_000);
  await outcome;
  assert.equal(pending.size, 0);
  await peer.handle(JSON.stringify({ id: JSON.parse(sent[0]!).id, result: { stale: true } }));
  assert.equal(pending.size, 0);
  const next = device.call("session.status", { sessionId: "retained" }, 12_000);
  await peer.handle(JSON.stringify({ id: JSON.parse(sent[1]!).id, result: { status: "idle" } }));
  assert.deepEqual(await next, { status: "idle" });
  assert.equal(pending.size, 0);
  t.mock.timers.reset();
});

test("SDK device.call preserves remote errors, and a control timeout never resubmits", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const sent: string[] = [];
  const peer = new RpcPeer({ send: data => { sent.push(data); }, close: () => {} }, () => null);
  const device = new PhononDevice("device", "tenant", peer);
  const request = device.call("session.status", { sessionId: "retained" }, 12_000);
  const remote = { code: -32000, message: "device disconnected", data: { appCode: "errUnauthorized" } };
  const outcome = assert.rejects(request, value => value === remote || JSON.stringify(value) === JSON.stringify(remote));
  await peer.handle(JSON.stringify({ id: JSON.parse(sent[0]!).id, error: remote }));
  await outcome;
  const control = device.call("workflow.run", { clientRequestId: "original-receipt" }, 12_000);
  const timedOut = assert.rejects(control, /rpc timeout: workflow.run/);
  t.mock.timers.tick(12_000);
  await timedOut;
  assert.equal(sent.length, 2);
  assert.equal((peer as unknown as { pending: Map<unknown, unknown> }).pending.size, 0);
  t.mock.timers.reset();
});
