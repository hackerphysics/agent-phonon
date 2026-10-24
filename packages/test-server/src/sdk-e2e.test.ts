import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AdapterRegistry, PhononClient } from "@agent-phonon/core";
import { PhononServer, PhononDevice } from "@agent-phonon/server-sdk";
import { MockAdapter } from "./harness.js";

/**
 * Server-SDK e2e：用 SDK 写的 server 编排真实 phonon（core PhononClient）。
 * 验证 SDK 接口 + 多设备管理。
 */

function dialPhonon(serverUrl: string, deviceId: string, deviceKey?: string) {
  const reg = new AdapterRegistry();
  reg.register(new MockAdapter({ name: "mock", agentIds: ["mock:default"], reply: (i: string) => `echo:${i}` }));
  const cwd = mkdtempSync(join(tmpdir(), "phonon-sdk-"));
  return new PhononClient({ serverUrl, deviceId, registry: reg, trustLocal: true, workspaceRoot: cwd, deviceKey });
}

function dialPhononHR(serverUrl: string, deviceId: string, deviceKey?: string) {
  // 专给 v0.7 HITL 测试用的 phonon：executor 会 emit workflow.human_review directive
  const reg = new AdapterRegistry();
  reg.register(new MockAdapter({
    name: "mock",
    agentIds: ["mock:exec", "mock:w"],
    models: ["m1"],
    reply: (input: string) => {
      if (input.includes("EXECUTOR of a multi-agent workflow")) {
        return [
          "need review",
          "```phonon.workflow.human_review",
          JSON.stringify({ title: "Approve?", summary: "plan A", timeoutSeconds: 30 }),
          "```",
        ].join("\n");
      }
      return "worker out";
    },
  }));
  const cwd = mkdtempSync(join(tmpdir(), "phonon-sdk-hr-"));
  return new PhononClient({ serverUrl, deviceId, registry: reg, trustLocal: true, workspaceRoot: cwd, deviceKey });
}

test("server-sdk: orchestrate a device via clean SDK API", { timeout: 20000 }, async t => {
  const server = new PhononServer({ authenticate: (id) => ({ tenantId: `t-${id}` }) });
  const port = await server.listen();

  // SDK 用户代码：监听设备 → 编排
  const deviceReady = new Promise<import("@agent-phonon/server-sdk").PhononDevice>((resolve) => {
    server.on("device", (device: import("@agent-phonon/server-sdk").PhononDevice) => resolve(device));
  });

  const client = dialPhonon(`ws://127.0.0.1:${port}`, "dev-1", "key-1");
  t.after(async () => { await client.close(); await server.close(); });
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
  if (info.capabilities.some(flag=>["secure_file_broker_linux_v1","secure_file_transfer_darwin_v1"].includes(flag))) {
    await device.file.write({ projectId: proj.project.projectId, path: "hello.txt", data: "from-sdk" });
    const fileRead = await device.file.read({ projectId: proj.project.projectId, path: "hello.txt" }) as { data: string };
    assert.equal(fileRead.data, "from-sdk");
  } else {
    const unsupported = (error: { message?: string; data?: { appCode?: string } }) =>
      error.data?.appCode === "errPolicyDenied" && error.message === "secure file broker unsupported on this platform";
    await assert.rejects(device.file.write({ projectId: proj.project.projectId, path: "hello.txt", data: "from-sdk" }), unsupported);
    await assert.rejects(device.file.read({ projectId: proj.project.projectId, path: "hello.txt" }), unsupported);
  }
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

  await client.close();
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
  await client.close();
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

// v0.7: 用 TS SDK setInteractionHandler 走通 workflow.human_review 全链路
test("server-sdk: v0.7 HITL via device.setInteractionHandler + workflow.human_review", { timeout: 30000 }, async () => {
  const server = new PhononServer();
  const port = await server.listen();
  const deviceReady = new Promise<import("@agent-phonon/server-sdk").PhononDevice>((resolve) => server.on("device", resolve));
  const client = dialPhononHR(`ws://127.0.0.1:${port}`, "dev-hr");
  await client.connect();
  const device = await deviceReady;

  // 注册 interaction handler（同步 reply）
  const reviewSeen: unknown[] = [];
  device.setInteractionHandler((params: unknown) => {
    reviewSeen.push(params);
    return { values: { approved: true, feedback: "shipped by TS SDK handler", reviewer: "alice" } };
  });

  const proj = await device.project.create({ name: "p-hr", git: false });
  const wf = await device.workflow.run({
    project: proj.project.projectId,
    input: "do",
    plan: {
      mode: "graph",
      executor: { nodeId: "exec", agent: "mock:exec", model: "m1" },
      workers: [{ nodeId: "w", agent: "mock:w", model: "m1", role: "worker" }],
      communicationGraph: { edges: [{ from: "exec", to: "w" }], maxIterations: 3 },
    },
  });

  // 轮询 status 直到终态
  let st: { status: string; finalText?: string } | undefined;
  for (let i = 0; i < 200; i++) {
    st = await device.workflow.status(wf.workflowId) as { status: string; finalText?: string };
    if (["completed", "failed", "cancelled", "timeout"].includes(st.status)) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.equal(st?.status, "completed");
  assert.match(st?.finalText ?? "", /shipped by TS SDK handler/);
  assert.ok(reviewSeen.length >= 1, "interaction handler should have been called at least once");

  // v0.7: workflow.resume RPC 可达性验证（不存在的 wf 应报 errInvalidParams）
  let resumeErrMsg = "";
  try {
    await device.workflow.resume({ workflowId: "wf-does-not-exist", strategy: "failed_node" });
    throw new Error("workflow.resume on missing wf should have raised");
  } catch (e) {
    resumeErrMsg = (e as Error).message;
  }
  assert.ok(
    /no resumable checkpoint|errInvalidParams|invalid/i.test(resumeErrMsg),
    `unexpected error from workflow.resume: ${resumeErrMsg}`,
  );

  await client.close();
  await server.close();
});


test("SDK close shuts down its owned live authenticated sockets",{timeout:5000},async()=>{
 const server=new PhononServer({host:"127.0.0.1",port:0,authenticate:()=>({tenantId:"shutdown-test"})});const port=await server.listen();const client=dialPhonon(`ws://127.0.0.1:${port}`,"shutdown-device");
 try{
  await client.connect();
  const devices=server.listDevices();assert.equal(devices.length,1);
  let disconnected=0;devices[0]!.on('disconnect',()=>{disconnected++;});
  await Promise.all([server.close(),server.close()]);
  assert.equal(server.listDevices().length,0);assert.equal(disconnected,1);
  await server.close();assert.equal(disconnected,1);
 }finally{await client.close();await server.close();}
});

test("SDK stream consumer persists before ACK and leaves failed consumers unacknowledged",async()=>{
 const {PhononDevice,RpcPeer}=await import("@agent-phonon/server-sdk");const messages:string[]=[];
 const peer=new RpcPeer({send:s=>messages.push(s),close:()=>{}},()=>null);const device=new PhononDevice("d","tenant",peer);
 let commit=false;device.setStreamEventHandler(async()=>{await new Promise(r=>setTimeout(r,10));commit=true;return true;});
 const pending=device._handleInbound("stream.event",{sessionId:"s",seq:0,type:"message",text:"bounded"});assert.equal(messages.length,0);await pending;assert.equal(commit,true);assert.equal(JSON.parse(messages[0]!).method,"stream.ack");
 device.setStreamEventHandler(()=>{throw new Error("durability failure");});await assert.rejects(()=>device._handleInbound("stream.event",{sessionId:"s",seq:1}));assert.equal(messages.length,1);
});

// ACK is cumulative: the application supplies its persisted prefix cursor.
test("server-sdk: explicit persisted stream ACK cursor may cover a filled gap", async()=>{
  const acks:unknown[]=[];const device=new PhononDevice("owned","tenant",{notify:(...args:unknown[])=>acks.push(args)} as never);
  device.setStreamEventHandler(()=>({ackSeq:1}));await device._handleInbound("stream.event",{sessionId:"s",seq:0});
  assert.deepEqual(acks,[["stream.ack",{sessionId:"s",lastSeq:1}]]);
});
test("server-sdk: invalid cumulative cursor never produces an ACK", async()=>{
  const acks:unknown[]=[];const device=new PhononDevice("owned","tenant",{notify:(...args:unknown[])=>acks.push(args)} as never);
  for(const ackSeq of [-1,0,1.5,Number.NaN]){device.setStreamEventHandler(()=>({ackSeq}));await assert.rejects(device._handleInbound("stream.event",{sessionId:"s",seq:1}),/invalid cumulative/);}
  assert.deepEqual(acks,[]);
});
test("native proactive frames require a reliable consumer even when a Session object is registered",async()=>{
  const sent:unknown[]=[],device=new PhononDevice("device","tenant",{notify:(...args:unknown[])=>sent.push(args)} as never);
  (device as unknown as {sessions:Map<string,unknown>}).sessions.set("retained",{_onStream:()=>{throw new Error("must not reach ordinary Session routing");},_lastSeq:5});
  await device._handleInbound("stream.event",{sessionId:"retained",seq:5,nativeProactive:{}});assert.deepEqual(sent,[]);
});

test("server-sdk: a closed peer rejects retained calls and late inbound work without transport writes",async()=>{
  const {RpcPeer}=await import("@agent-phonon/server-sdk");const sent:string[]=[];let calls=0;
  const peer=new RpcPeer({send:value=>sent.push(value),close:()=>{}},()=>{calls++;return null;});
  const pending=peer.request("info",{});peer.rejectAll("device disconnected");
  await assert.rejects(pending,/disconnected/);await assert.rejects(peer.request("info",{}),/disconnected/);
  assert.throws(()=>peer.notify("stream.ack",{}),/disconnected/);
  await peer.handle(JSON.stringify({jsonrpc:"2.0",id:999,method:"execute",params:{}}));assert.equal(calls,0);assert.equal(sent.length,1);
});
test("server-sdk: send failures clean pending state and a handler cannot reply after its peer closes",async()=>{
  const {RpcPeer}=await import("@agent-phonon/server-sdk");
  const failing=new RpcPeer({send:()=>{throw new Error("send failed");},close:()=>{}},()=>null);
  try{await assert.rejects(failing.request("info",{}),/send failed/);assert.equal((failing as unknown as {pending:Map<unknown,unknown>}).pending.size,0);}finally{failing.rejectAll("cleanup");}
  const sent:string[]=[];let release!:(value:unknown)=>void;
  const peer=new RpcPeer({send:value=>sent.push(value),close:()=>{}},()=>new Promise(resolve=>{release=resolve;}));
  const active=peer.handle(JSON.stringify({jsonrpc:"2.0",id:1,method:"execute"}));peer.rejectAll("closed");release({ok:true});await active;assert.equal(sent.length,0);
});
