import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AdapterRegistry, PhononClient } from "@agent-phonon/core";
import { PhononServer } from "@agent-phonon/server-sdk";
import { MockAdapter } from "./harness.js";

/**
 * Server-SDK e2e：用 SDK 写的 server 编排真实 phonon（core PhononClient）。
 * 验证 SDK 接口 + 多设备管理。
 */

function dialPhonon(serverUrl: string, deviceId: string, deviceKey?: string) {
  const reg = new AdapterRegistry();
  reg.register(new MockAdapter({ name: "mock", agentIds: ["mock:default"], reply: (i: string) => `echo:${i}` }));
  const cwd = mkdtempSync(join(tmpdir(), "phonon-sdk-"));
  return new PhononClient({ serverUrl, deviceId, registry: reg, trustLocal: true, resolveProjectCwd: () => cwd, deviceKey });
}

test("server-sdk: orchestrate a device via clean SDK API", { timeout: 20000 }, async () => {
  const server = new PhononServer({ authenticate: (id) => ({ tenantId: `t-${id}` }) });
  const port = await server.listen();

  // SDK 用户代码：监听设备 → 编排
  const deviceReady = new Promise<import("@agent-phonon/server-sdk").PhononDevice>((resolve) => {
    server.on("device", (device: import("@agent-phonon/server-sdk").PhononDevice) => resolve(device));
  });

  const client = dialPhonon(`ws://127.0.0.1:${port}`, "dev-1", "key-1");
  await client.connect();
  const device = await deviceReady;
  assert.equal(device.deviceId, "dev-1");
  assert.equal(device.tenantId, "t-dev-1");

  // discover
  const agents = await device.discover();
  assert.ok(agents.some((a) => a.agentId === "mock:default"));

  // resources + project + file + session + send（流式用事件）
  const info = await device.info() as { os: { platform: string }; capabilities: string[] };
  assert.equal(typeof info.os.platform, "string");
  assert.ok(Array.isArray(info.capabilities));
  const resources = await device.resources() as { memory: { totalBytes: number } };
  assert.ok(resources.memory.totalBytes > 0);
  await device.env.set({ scope: "global", name: "SDK_TOKEN", value: "secret-token" });
  const envs = await device.env.list() as { variables: Array<{ name: string; redacted: boolean }> };
  assert.ok(envs.variables.some((v) => v.name === "SDK_TOKEN" && v.redacted));
  const proj = await device.project.create({ name: "p", git: false });
  await device.file.write({ projectId: proj.project.projectId, path: "hello.txt", data: "from-sdk" });
  const fileRead = await device.file.read({ projectId: proj.project.projectId, path: "hello.txt" }) as { data: string };
  assert.equal(fileRead.data, "from-sdk");
  const session = await device.createSession({ project: proj.project.projectId, agent: "mock:default", model: "m1" });

  const streamed: string[] = [];
  const ended = new Promise<void>((resolve) => {
    session.on("stream", (ev) => { if ((ev as { type?: string }).type === "message") streamed.push((ev as { text: string }).text); });
    session.on("end", () => resolve());
  });
  await session.send("hello SDK");
  await ended;
  assert.ok(streamed.some((t) => t.includes("echo:hello SDK")));

  const st = await session.status();
  assert.equal(st.status, "idle");
  await session.terminate();

  client.close();
  await server.close();
});

test("server-sdk: HITL decision via device.setHookDecider", { timeout: 20000 }, async () => {
  const server = new PhononServer();
  const port = await server.listen();
  const deviceReady = new Promise<import("@agent-phonon/server-sdk").PhononDevice>((resolve) => server.on("device", resolve));
  const client = dialPhonon(`ws://127.0.0.1:${port}`, "dev-hitl");
  await client.connect();
  const device = await deviceReady;
  device.setHookDecider((hook) => {
    const cmd = String((hook.payload as { command?: string })?.command ?? "");
    return cmd.includes("rm -rf") ? { action: "abort", reason: "blocked" } : "continue";
  });
  // 模拟 phonon fireHook（经 connection）
  const conn = client.connection!;
  const dangerous = (await conn.fireHook({ sessionId: "s1", hookId: "h1", hookType: "pre_command", payload: { command: "rm -rf /" }, at: new Date().toISOString() })) as { action: string };
  assert.equal(dangerous.action, "abort");
  const safe = (await conn.fireHook({ sessionId: "s1", hookId: "h2", hookType: "pre_command", payload: { command: "ls" }, at: new Date().toISOString() })) as { action: string };
  assert.equal(safe.action, "continue");
  client.close();
  await server.close();
});

test("server-sdk: MULTI-DEVICE — one server manages multiple phonons", { timeout: 20000 }, async () => {
  const server = new PhononServer({ authenticate: (id) => ({ tenantId: `t-${id}` }) });
  const port = await server.listen();
  const seen: string[] = [];
  server.on("device", (d: import("@agent-phonon/server-sdk").PhononDevice) => seen.push(d.deviceId));

  const c1 = dialPhonon(`ws://127.0.0.1:${port}`, "device-A");
  const c2 = dialPhonon(`ws://127.0.0.1:${port}`, "device-B");
  const c3 = dialPhonon(`ws://127.0.0.1:${port}`, "device-C");
  await Promise.all([c1.connect(), c2.connect(), c3.connect()]);
  await new Promise((r) => setTimeout(r, 100));

  // server 同时管理 3 个设备
  assert.equal(server.listDevices().length, 3);
  assert.ok(seen.includes("device-A") && seen.includes("device-B") && seen.includes("device-C"));

  // 分别在每个设备上跑 agent，互不干扰（tenant 隔离）
  for (const id of ["device-A", "device-B", "device-C"]) {
    const dev = server.getDevice(id)!;
    const agents = await dev.discover();
    assert.ok(agents.length >= 1, `${id} should discover agents`);
    const proj = await dev.project.create({ name: "p", git: false });
    const s = await dev.createSession({ project: proj.project.projectId, agent: "mock:default", model: "m1" });
    const ended = new Promise<void>((resolve) => s.on("end", () => resolve()));
    await s.send(`hi from ${id}`);
    await ended;
  }

  c1.close(); c2.close(); c3.close();
  await server.close();
});
