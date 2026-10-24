import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { pathToFileURL, fileURLToPath } from "node:url";
import { AdapterRegistry, GatewayClient, OpenClawGatewayAdapter, PhononStore } from "@agent-phonon/core";
import { NativeInteractionTools, BIND_METHOD, RELEASE_METHOD, REQUEST_TOOL, ACK_TOOL, BOARD_TOOL, WORKFLOW_TOOL,MESSAGE_TOOL,NATIVE_TOOLS,COORDINATION_TOOL, type NativeInteractionApi } from "@agent-phonon/openclaw-plugin/native-interactions";
import { TestConn } from "./harness.js";

const form = { title: "Review changes", fields: [{ key: "approved", label: "Approve?", type: "boolean", required: true }] };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }

class Host {
  readonly bridge = new NativeInteractionTools();
  readonly connection = new AbortController();
  readonly client = { connId: randomUUID(), connect: { role: "operator", scopes: ["operator.admin"] }, connectionSignal: this.connection.signal, invalidated: false };
  readonly methods = new Map<string, any>();
  readonly hooks = new Map<string, any[]>();
  factory!: Parameters<NativeInteractionApi["registerTool"]>[0];
  cleanup!: (ctx: { sessionKey?: string; runId?: string }) => void;
  constructor(register?: (api: NativeInteractionApi) => void,coordinationOnly=false) {
    const api: NativeInteractionApi = {
      registerGatewayMethod: (name, handler, opts) => { assert.equal(opts.scope, "operator.admin"); this.methods.set(name, handler); },
      registerTool: (factory, opts) => { assert.equal(opts.optional, true); assert.deepEqual(opts.names,coordinationOnly?[COORDINATION_TOOL]:NATIVE_TOOLS); this.factory = factory; },
      on: (name, handler) => this.hooks.set(name, [...(this.hooks.get(name) ?? []), handler]),
      lifecycle: { registerRuntimeLifecycle: value => { this.cleanup = value.cleanup; } },
    };
    if (register) register(api); else this.bridge.register(api,{coordinationOnly});
  }
  rpc(method: string, params: any, client: any = this.client): any {
    let result: any;
    this.methods.get(method)({ params, client, respond: (ok: boolean, payload: any, error: any) => { result = { ok, payload, error }; } });
    return result;
  }
  input(overrides: Record<string, unknown> = {}) {
    return { version: 1, sessionKey: "agent:employee:phonon-s-test", runId: randomUUID(),
      expiresAt: Date.now() + 60000, interactionUrl: "http://127.0.0.1:12345/interaction", receiptUrl: "http://127.0.0.1:12345/applied",
      token: randomBytes(32).toString("base64url"), ...overrides };
  }
  context(input: any) { return { sessionKey: input.sessionKey, agentId: input.sessionKey.split(":")[1], runId: input.runId }; }
  authorize(input: any, name: string, params: any, id = randomUUID()) {
    const event = { toolName: name, params, runId: input.runId, toolCallId: id };
    for (const hook of this.hooks.get("before_tool_call") ?? []) {
      const result = hook(event, { ...this.context(input), toolCallId: id });
      if (result?.block) throw new Error(result.blockReason);
    }
    return id;
  }
  async invoke(input: any, name: string, params: any, signal?: AbortSignal) {
    const tool = this.factory(this.context(input))?.find(value => value.name === name);
    assert.ok(tool, "tool is available only to an explicitly bound run");
    return tool.execute(this.authorize(input, name, params), params, signal);
  }
  close() { this.connection.abort(); this.cleanup?.({}); }
}

test("native plugin binding is admin-only, bounded, local, idempotent and never returns capabilities", () => {
  const host = new Host(), input = host.input();
  try {
    assert.equal(host.factory(host.context(input)), null);
    for (const client of [null, { ...host.client, connectionSignal: undefined }, { ...host.client, connect: { role: "operator", scopes: ["operator.write"] } }, { ...host.client, invalidated: true }]) {
      const result = host.rpc(BIND_METHOD, input, client); assert.equal(result.ok, false); assert.ok(!JSON.stringify(result).includes(input.token));
    }
    for (const override of [{ sessionKey: "agent:employee:personal" }, { runId: "invalid" }, { token: "bad" }, { version: 2 },
      { interactionUrl: "http://example.invalid/interaction" }, { interactionUrl: "http://127.0.0.1:12345/interaction?secret=x" },
      { interactionUrl: "http://127.0.0.1:12345/interaction#x" }, { receiptUrl: "http://127.0.0.1:12346/applied" },
      { boardUrl: "http://127.0.0.1:12346/board" }, { boardUrl: "http://example.invalid/board" },
      {workflowUrl:"http://127.0.0.1:12346/workflow"},{workflowUrl:"http://example.invalid/workflow"},{workflowUrl:"http://127.0.0.1:12345/board"},
      {messageUrl:"http://127.0.0.1:12346/message"},{messageUrl:"http://example.invalid/message"},{messageUrl:"http://127.0.0.1:12345/workflow"},
      {coordinationUrl:"http://example.invalid/coordination"},{coordinationUrl:"http://127.0.0.1:12346/coordination"},{coordinationUrl:"http://127.0.0.1:12345/message"},
      { expiresAt: Date.now() - 1 }, { expiresAt: Date.now() + 3600000 }, { tenantId: "forged" }]) {
      assert.equal(host.rpc(BIND_METHOD, { ...input, ...override }).ok, false, JSON.stringify(override));
    }
    assert.deepEqual(host.rpc(BIND_METHOD, input), { ok: true, payload: { version: 1, bound: true }, error: undefined });
    assert.equal(host.rpc(BIND_METHOD, input).ok, true);
    assert.equal(host.rpc(BIND_METHOD, { ...input, token: randomBytes(32).toString("base64url") }).ok, false);
    assert.equal(host.rpc(BIND_METHOD, { ...input, runId: randomUUID() }).ok, false);
    assert.equal(host.rpc(BIND_METHOD, input, { ...host.client, connId: "another-connection" }).ok, false);
    assert.equal(host.rpc(RELEASE_METHOD, { sessionKey: input.sessionKey, runId: input.runId }, { ...host.client, connId: "another-connection" }).ok, false);
    assert.equal(host.factory({ ...host.context(input), agentId: "other" }), null);
  } finally { host.close(); }
});

test("coordination-only native binding exposes no human/group tools or fabricated receipt endpoint",()=>{
  const host=new Host(undefined,true),input=host.input({coordinationOnly:true,interactionUrl:undefined,receiptUrl:undefined,coordinationUrl:"http://127.0.0.1:12345/coordination"});
  try{
    assert.equal(host.rpc(BIND_METHOD,{...input,coordinationOnly:undefined}).ok,false);
    assert.equal(host.rpc(BIND_METHOD,{...input,receiptUrl:"http://127.0.0.1:12345/applied"}).ok,false);
    assert.equal(host.rpc(BIND_METHOD,{...input,messageUrl:"http://127.0.0.1:12345/message"}).ok,false);
    assert.equal(host.rpc(BIND_METHOD,input).ok,true);
    assert.deepEqual(host.factory(host.context(input))?.map(tool=>tool.name),[COORDINATION_TOOL]);
    assert.throws(()=>host.authorize(input,REQUEST_TOOL,{form}),/project coordination authority only/);
  }finally{host.close();}
});

test("native tools require one-use host run proofs, reject route forgery and do not cross binding generations", async () => {
  const host = new Host(), input = host.input(); host.rpc(BIND_METHOD, input);
  try {
    const tool = host.factory(host.context(input))![0]!;
    await assert.rejects(tool.execute("unproven", { form }), /unauthorized/);
    assert.throws(() => host.authorize({ ...input, runId: randomUUID() }, REQUEST_TOOL, { form }), /not authorized/);
    const event = { toolName: REQUEST_TOOL, params: { form }, runId: input.runId, toolCallId: "test" };
    assert.equal((host.bridge.beforeToolCall(event, { ...host.context(input), runId: randomUUID() }) as any).block, true);
    assert.equal((host.bridge.beforeToolCall({ ...event, runId: undefined }, { ...host.context(input), runId: undefined }) as any).blockReason,
      "Native interaction is not authorized for this run (run_identity_missing)");
    const mismatched = host.bridge.beforeToolCall(event, { ...host.context(input), runId: randomUUID() }) as any;
    assert.equal(mismatched.blockReason, "Native interaction is not authorized for this run (run_identity_mismatch)");
    assert.ok(!JSON.stringify(mismatched).includes(input.token));
    assert.equal((host.bridge.beforeToolCall(event, { ...host.context(input), agentId: "other" }) as any).block, true);
    const changed = host.authorize(input, REQUEST_TOOL, { form });
    await assert.rejects(tool.execute(changed, { form, sessionId: "forged" }), /unauthorized/);
    await assert.rejects(tool.execute(changed, { form }), /unauthorized/);
    await assert.rejects(host.invoke(input, REQUEST_TOOL, { form, sessionId: "forged" }));
    const wrongTool = host.authorize(input, ACK_TOOL, { form });
    await assert.rejects(tool.execute(wrongTool, { form }), /unauthorized/);
    const oldPermit = host.authorize(input, REQUEST_TOOL, { form });
    host.rpc(RELEASE_METHOD, { sessionKey: input.sessionKey, runId: input.runId });
    const next = { ...input, runId: randomUUID() }; assert.equal(host.rpc(BIND_METHOD, next).ok, true);
    host.rpc(RELEASE_METHOD, { sessionKey: input.sessionKey, runId: input.runId });
    assert.ok(host.factory(host.context(next)));
    await assert.rejects(tool.execute(oldPermit, { form }), /unauthorized/);
    for (const hook of host.hooks.get("agent_end")!) hook({}, host.context(input));
    assert.ok(host.factory(host.context(next)));
    host.cleanup(host.context(next)); assert.equal(host.factory(host.context(next)), null);
  } finally { host.close(); }
});

test("native tool HTTP uses bounded authenticated no-redirect requests and revokes in-flight results on disconnect", async () => {
  const host = new Host(), received = deferred<void>(), release = deferred<void>();
  let mode = "success", calls = 0;
  const server = createServer(async (req, res) => {
    calls++; let body = ""; for await (const chunk of req) body += chunk;
    const raw = JSON.parse(body); assert.equal(req.headers.authorization, `Bearer ${input.token}`);
    if (mode === "oversized") { res.end("x".repeat(65537)); return; }
    if (mode === "redirect") { res.writeHead(302, { Location: "http://example.invalid/capture" }).end(); return; }
    if (mode === "hold") { received.resolve(); await release.promise; }
    if (req.url === "/applied") res.end(JSON.stringify({ applied: true }));
    else res.end(JSON.stringify({ requestId: raw.requestId ?? "generated", action: "submit", values: { approved: false }, decisionHash: "a".repeat(64) }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const input = host.input({ interactionUrl: `http://127.0.0.1:${port}/interaction`, receiptUrl: `http://127.0.0.1:${port}/applied` });
  host.rpc(BIND_METHOD, input);
  try {
    const response = await host.invoke(input, REQUEST_TOOL, { requestId: "review", form, timeoutSeconds: 0 });
    assert.equal((response.details as any).values.approved, false);
    assert.ok(!JSON.stringify(response).includes(input.token));
    assert.deepEqual((await host.invoke(input, ACK_TOOL, { requestId: "review", decisionHash: "a".repeat(64) })).details, { applied: true });
    mode = "oversized"; await assert.rejects(host.invoke(input, REQUEST_TOOL, { form }), /unavailable/);
    mode = "redirect"; await assert.rejects(host.invoke(input, REQUEST_TOOL, { form }), /unavailable/);
    const before = calls; await assert.rejects(host.invoke(input, REQUEST_TOOL, { form: { ...form, description: "x".repeat(65537) } }), /too large/); assert.equal(calls, before);
    mode = "hold";
    const waiting = host.invoke(input, REQUEST_TOOL, { form });
    await received.promise; host.connection.abort();
    await assert.rejects(waiting, /unavailable/);
    assert.equal(host.factory(host.context(input)), null);
  } finally {
    release.resolve(); host.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test("native board tool is optional, scoped, concise and returns conflicts without claiming a write", async () => {
  const host = new Host(), requests: any[] = [];
  const board = { conversationID: randomUUID(), goal: "Latest human edit", items: [], revision: 2, authorID: "human", updatedAt: new Date().toISOString() };
  const server = createServer(async (req, res) => {
    let body = ""; for await (const chunk of req) body += chunk;
    assert.equal(req.url, "/board"); assert.equal(req.headers.authorization, `Bearer ${input.token}`);
    const raw = JSON.parse(body); requests.push(raw);
    res.end(JSON.stringify({ status: raw.operation === "write" ? "conflict" : "ok", board }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port, input = host.input({
    interactionUrl: `http://127.0.0.1:${port}/interaction`, receiptUrl: `http://127.0.0.1:${port}/applied`, boardUrl: `http://127.0.0.1:${port}/board`,
  });
  try {
    host.rpc(BIND_METHOD, input);
    assert.ok(host.factory(host.context(input))!.some(tool => tool.name === BOARD_TOOL));
    assert.equal((await host.invoke(input, BOARD_TOOL, { operation: "read" })).details && requests.length, 1);
    const write = { operation: "write", requestId: randomUUID(), baseRevision: 1, goal: "Agent draft", items: [] };
    const result = await host.invoke(input, BOARD_TOOL, write);
    assert.equal((result.details as any).status, "conflict"); assert.equal((result.details as any).board.revision, 2);
    assert.deepEqual(requests[1], write);
    await assert.rejects(host.invoke(input, BOARD_TOOL, { ...write, conversationID: randomUUID() }));
    assert.equal(requests.length, 2);
    host.rpc(RELEASE_METHOD, { sessionKey: input.sessionKey, runId: input.runId });
    const noBoard = host.input({ sessionKey: input.sessionKey }); host.rpc(BIND_METHOD, noBoard);
    assert.ok(!host.factory(host.context(noBoard))!.some(tool => tool.name === BOARD_TOOL));
  } finally { host.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test("native workflow tools keep explicit review intent, reject route fields and never infer execution from transport failure",async()=>{
  const host=new Host(),requests:any[]=[];
  const server=createServer(async(req,res)=>{
    let body="";for await(const chunk of req)body+=chunk;
    assert.equal(req.url,"/workflow");assert.equal(req.headers.authorization,"Bearer "+input.token);
    const raw=JSON.parse(body);requests.push(raw);
    if(raw.operation==="status"){res.statusCode=503;res.end("{}");return;}
    res.end(JSON.stringify({status:raw.operation==="catalog"?"catalog":"finished",data:{state:"rejected"}}));
  });
  await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
  const port=(server.address() as {port:number}).port,input=host.input({interactionUrl:`http://127.0.0.1:${port}/interaction`,receiptUrl:`http://127.0.0.1:${port}/applied`,workflowUrl:`http://127.0.0.1:${port}/workflow`});
  try{
    assert.equal(host.rpc(BIND_METHOD,input).ok,true);
    assert.equal((await host.invoke(input,WORKFLOW_TOOL,{operation:"catalog"})).details&&(requests.length),1);
    const execute={operation:"execute",requestId:randomUUID(),plan:{projectID:randomUUID(),title:"Verify",goal:"Observe results",review:"request",maxParallel:1,nodes:[{id:"work",title:"Work",agentID:randomUUID(),bindingID:randomUUID(),input:"Verify",dependsOn:[]}]}};
    assert.equal(((await host.invoke(input,WORKFLOW_TOOL,execute)).details as any).data.state,"rejected");assert.deepEqual(requests[1],execute);
    await assert.rejects(host.invoke(input,WORKFLOW_TOOL,{...execute,nativeRunId:randomUUID()}));assert.equal(requests.length,2);
    await assert.rejects(host.invoke(input,WORKFLOW_TOOL,{operation:"status",requestId:execute.requestId}),/reconcile the same request identity/);
    host.rpc(RELEASE_METHOD,{sessionKey:input.sessionKey,runId:input.runId});
    const next=host.input({sessionKey:input.sessionKey});assert.equal(host.rpc(BIND_METHOD,next).ok,true);
    assert.ok(!host.factory(host.context(next))!.some(tool=>tool.name===WORKFLOW_TOOL));
  }finally{host.close();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});

test("native group message tools preserve rejection and identity and never infer acceptance from a transport error",async()=>{
  const host=new Host(),requests:any[]=[];let mode="reject";
  const server=createServer(async(req,res)=>{
    let body="";for await(const chunk of req)body+=chunk;
    assert.equal(req.url,"/message");assert.equal(req.headers.authorization,"Bearer "+input.token);
    const value=JSON.parse(body);requests.push(value);
    if(mode==="unavailable"){res.statusCode=503;res.end("{}");return;}
    res.end(JSON.stringify({status:"not_accepted",requestId:mode==="mismatch"?randomUUID():value.requestId,errorCode:"de_mentions_disabled"}));
  });
  await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
  const port=(server.address() as {port:number}).port,input=host.input({interactionUrl:`http://127.0.0.1:${port}/interaction`,receiptUrl:`http://127.0.0.1:${port}/applied`,messageUrl:`http://127.0.0.1:${port}/message`});
  try{
    assert.equal(host.rpc(BIND_METHOD,input).ok,true);
    const send={operation:"send",requestId:randomUUID(),text:"Review",mentionIDs:[randomUUID()],mode:"queue"};
    assert.equal(((await host.invoke(input,MESSAGE_TOOL,send)).details as any).status,"not_accepted");
    await assert.rejects(host.invoke(input,MESSAGE_TOOL,{...send,senderID:randomUUID()}));assert.equal(requests.length,1);
    mode="mismatch";await assert.rejects(host.invoke(input,MESSAGE_TOOL,send),/delivery is unconfirmed/);
    mode="unavailable";await assert.rejects(host.invoke(input,MESSAGE_TOOL,send),/reconcile the same request identity/);
    host.connection.abort();assert.equal(host.factory(host.context(input)),null);
  }finally{host.close();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});

test("Gateway refuses remote native binding, requires plugin proof and preserves ordinary chat without it", async () => {
  const remote = new GatewayClient({ baseUrl: "ws://remote.invalid", token: "secret" });
  await assert.rejects(remote.bindNativeInteractions("s", randomUUID(), {}), /local/);
  const client = new GatewayClient({ baseUrl: "ws://127.0.0.1:12345", token: "secret" });
  const calls: string[] = [];
  (client as any).rpc = async (method: string) => { calls.push(method); return { bound: true }; };
  await assert.rejects(client.bindNativeInteractions("s", randomUUID(), {}), /unavailable/);
  assert.deepEqual(calls, [BIND_METHOD]);
  const adapter = new OpenClawGatewayAdapter({ gateway: { baseUrl: "ws://127.0.0.1:12345", token: "secret" } });
  const fake = { async connect() {}, async bindNativeInteractions() { throw new Error("plugin disabled"); },
    supportsCapability:()=>true,
    async rpc(method: string, params: any) {
      calls.push(method);
      if(method==="chat.history")return {sessionKey:"agent:main:phonon-ordinary",sessionId:"11111111-1111-4111-8111-111111111111",messages:[],totalMessages:0,pendingInputs:{items:[],total:0},sessionInfo:{key:"agent:main:phonon-ordinary",sessionId:"11111111-1111-4111-8111-111111111111",createdAt:1,model:"m1",spawnedCwd:realpathSync("/tmp"),hasActiveRun:false,activeRunIds:[],activeLeafEntryId:null,archived:false}};
      if (method === "chat.send") queueMicrotask(() => (session as any).handleEvent("chat", { state: "final", runId: params.idempotencyKey, finalText: "ordinary" }));
      return {};
    } };
  (adapter as any).gw = fake;
  const session = await adapter.createSession({ sessionId: "ordinary", agentId: "openclaw:main", model: "m1", cwd: "/tmp" });
  const count = calls.filter(method => method === "chat.send").length;
  await assert.rejects(session.send("native", { turnId: "native", verbosity: "final", emit() {}, environment: { AGENT_PHONON_INTERACTION_TOKEN: "secret" } }), /plugin disabled/);
  assert.equal(calls.filter(method => method === "chat.send").length, count);
  const events: any[] = [];
  await session.send("ordinary", { turnId: "ordinary", verbosity: "final", emit: event => events.push(event) });
  assert.equal(events.at(-1).text, "ordinary");
});

test("native controller, Gateway transport and plugin tools preserve human response lineage and explicit acknowledgement", { timeout: 15000 }, async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "phonon-gateway-tools-"))), store = new PhononStore(join(root, "state.db"));
  const host = new Host(), wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>(resolve => wss.once("listening", resolve));
  const adapter = new OpenClawGatewayAdapter({ gateway: { baseUrl: `ws://127.0.0.1:${wss.address() && (wss.address() as any).port}`, token: "test" } });
  const registry = new AdapterRegistry(); registry.register(adapter);
  const tc = new TestConn({ registry, store, tenantId: "owner", workspaceRoot: root });
  const task = deferred<void>(), failure = deferred<Error>();
  let captured: any, priorTool: any, session: any, count = 0;
  const sentBodies: any[] = [];
  const nativeSessions=new Map<string,{id:string;cwd:string;createdAt:number;leaf:string|null;count:number;endedAt?:number}>();
  const deadline=setTimeout(()=>failure.resolve(new Error("Gateway native tool fixture did not complete")),10000);
  tc.setRequestResponder("interaction.request", async raw => {
    captured = raw as any;
    return { requestId: captured.requestId, action: "submit", values: { approved: false } };
  });
  wss.on("connection", ws => {
    ws.send(JSON.stringify({ type: "event", event: "connect.challenge", payload: {} }));
    ws.on("close", () => host.connection.abort());
    ws.on("message", raw => {
      void (async () => {
        const frame = JSON.parse(raw.toString()), params = frame.params;
        sentBodies.push({ method: frame.method, params });
        const send = (payload: unknown) => ws.send(JSON.stringify({ type: "res", id: frame.id, ok: true, payload }));
        if (frame.method === "connect") {
          assert.equal(params.client.id, "gateway-client"); assert.equal(params.client.mode, "backend");
          assert.deepEqual(params.caps, ["tool-events"]);
          assert.equal(params.toolBindings, undefined); send({ type: "hello-ok",features:{capabilities:["session-settings-cas-v1"]} }); return;
        }
        if(frame.method==="agents.list"){send({agents:[{id:"employee",workspace:root,model:"m1"}]});return;}
        if(frame.method==="models.list"){send({models:[{id:"m1",available:true}]});return;}
        if(frame.method==="sessions.create"){const row={id:randomUUID(),cwd:realpathSync(params.cwd),createdAt:Date.now(),leaf:null,count:0};nativeSessions.set(params.key,row);send({key:params.key,sessionId:row.id});return;}
        if(frame.method==="chat.history"){
          const row=nativeSessions.get(params.sessionKey)!;
          send({sessionKey:params.sessionKey,sessionId:row.id,messages:[],totalMessages:row.count,pendingInputs:{items:[],total:0},sessionInfo:{key:params.sessionKey,sessionId:row.id,createdAt:row.createdAt,model:"m1",spawnedCwd:row.cwd,hasActiveRun:false,activeRunIds:[],activeLeafEntryId:row.leaf,archived:false,...(row.endedAt?{status:"done",endedAt:row.endedAt}:{})}});return;
        }
        if (host.methods.has(frame.method)) {
          const result = host.rpc(frame.method, params);
          ws.send(JSON.stringify({ type: "res", id: frame.id, ...result })); return;
        }
        send({});
        if (frame.method !== "chat.send") return;
        const native=nativeSessions.get(params.sessionKey)!;assert.equal(params.sessionId,native.id);assert.equal(params.expectedLeafEntryId,native.leaf);
        assert.equal(params.toolBindings, undefined);
        const input = { sessionKey: params.sessionKey, runId: params.idempotencyKey };
        const tools = host.factory(host.context(input))!;
        assert.ok(tools);
        if (priorTool) await assert.rejects(priorTool.execute("old", { form }), /unauthorized/);
        priorTool = tools[0]; session = input;
        const requestId = `review-${++count}`;
        const response = await host.invoke(input, REQUEST_TOOL, { requestId, form, presentation: { kind: "approval", decisionField: "approved" } });
        assert.equal((response.details as any).values.approved, false);
        assert.equal((await tc.call("interaction.status", { requestId }) as any).state, "delivered");
        await host.invoke(input, ACK_TOOL, { requestId, decisionHash: (response.details as any).decisionHash });
        assert.equal((await tc.call("interaction.status", { requestId }) as any).state, "applied");
        native.count+=2;native.leaf=randomUUID();native.endedAt=Date.now();
        ws.send(JSON.stringify({ type: "event", event: "chat", payload: { sessionKey: params.sessionKey, runId: params.idempotencyKey, state: "final", finalText: "Rejection received" } }));
        task.resolve();
      })().catch(error => { failure.resolve(error); });
    });
  });
  try {
    const project = (await tc.call("project.create", { name: "gateway", git: false }) as any).project.projectId;
    const nativeRunId = randomUUID();
    const run = await tc.call("workflow.run", { project, metadata: { native_chat: true, native_run_id: nativeRunId },
      plan: { mode: "dag", nodes: [{ nodeId: "reply", agent: "openclaw:employee", model: "m1", input: "Request review" }], finalNodeId: "reply" } }) as any;
    await Promise.race([task.promise, failure.promise.then(error => { throw error; })]);
    for (let i = 0; i < 200; i++) {
      if ((await tc.call("workflow.status", { workflowId: run.workflowId }) as any).status === "completed") break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal((await tc.call("workflow.status", { workflowId: run.workflowId }) as any).status, "completed");
    assert.equal(captured.nativeRunId, nativeRunId); assert.equal(captured.workflowId, run.workflowId); assert.ok(captured.sessionId); assert.ok(captured.turnId);
    assert.equal(host.factory(host.context(session)), null);
    assert.ok(sentBodies.some(item => item.method === RELEASE_METHOD));
    const chat = sentBodies.find(item => item.method === "chat.send")!;
    assert.ok(!JSON.stringify(chat).includes("AGENT_PHONON_INTERACTION"));
    assert.ok(!JSON.stringify(chat).includes(sentBodies.find(item => item.method === BIND_METHOD).params.token));
  } finally {
    clearTimeout(deadline);
    adapter.close(); await tc.conn.dispose(); host.close();
    for (const ws of wss.clients) ws.terminate();
    await new Promise<void>(resolve => wss.close(() => resolve()));
    store.close(); rmSync(root, { recursive: true, force: true });
  }
});

test("installed OpenClaw SDK runs the native before-tool hook and revokes retained tools without inference", {
  skip: !process.env.PHONON_TEST_OPENCLAW_SDK,
}, async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "phonon-native-plugin-sdk-"))), previousHome = process.env.HOME;
  process.env.HOME = home;
  let host: Host | undefined, runtimeHost: Host | undefined;
  let requests = 0;
  const board = { conversationID: randomUUID(), goal: "Human update", items: [], revision: 2, authorID: "human", updatedAt: new Date().toISOString() };
  const workflowRequestID = randomUUID();
  const server = createServer(async (req, res) => {
    requests++;
    let body = ""; for await (const chunk of req) body += chunk;
    if (req.url === "/board") { res.end(JSON.stringify({ status: JSON.parse(body).operation === "write" ? "conflict" : "ok", board })); return; }
    if (req.url === "/workflow") {
      assert.deepEqual(JSON.parse(body), { operation: "status", requestId: workflowRequestID });
      res.end(JSON.stringify({ status: "finished", data: { state: "rejected" } })); return;
    }
    if(req.url==="/message"){const value=JSON.parse(body);res.end(JSON.stringify({status:"not_accepted",requestId:value.requestId,errorCode:"de_mentions_disabled"}));return;}
    res.end(JSON.stringify({ requestId: "sdk", action: "submit", values: { approved: false }, decisionHash: "b".repeat(64) }));
  });
  let hooks: any;
  try {
    const sdk = (name: string) => import(pathToFileURL(join(process.env.PHONON_TEST_OPENCLAW_SDK!, name)).href);
    hooks = await sdk("hook-runtime.js");
    const runtime = await sdk("agent-harness-runtime.js");
    const repo = fileURLToPath(new URL("../../../", import.meta.url)), artifact = join(home, "prepared");
    execFileSync(process.execPath, [join(repo, "packages/openclaw-plugin/scripts/prepare-artifact.mjs"), artifact]);
    const { registerHooks } = await import("node:module");
    const alias = registerHooks({ resolve(specifier, context, next) {
      return next(specifier === "openclaw/plugin-sdk/plugin-entry"
        ? pathToFileURL(join(process.env.PHONON_TEST_OPENCLAW_SDK!, "plugin-entry.js")).href : specifier, context);
    } });
    let entry: any;
    try { entry = await import(pathToFileURL(join(artifact, "dist/index.js")).href); } finally { alias.deregister(); }
    const disabled = new Host(api => entry.default.register({ ...api, pluginConfig: { nativeInteractions: false } }));
    assert.equal(disabled.methods.size, 0); assert.equal(disabled.factory, undefined); disabled.close();
    host = new Host(api => entry.default.register({ ...api, pluginConfig: { nativeInteractions: true } }));
    runtimeHost = new Host(api => entry.default.register({ ...api, pluginConfig: { nativeInteractions: true } }));
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    const input = host.input({ interactionUrl: `http://127.0.0.1:${port}/interaction`, receiptUrl: `http://127.0.0.1:${port}/applied`, boardUrl: `http://127.0.0.1:${port}/board`, workflowUrl: `http://127.0.0.1:${port}/workflow`, messageUrl:`http://127.0.0.1:${port}/message` });
    assert.equal(host.rpc(BIND_METHOD, input).ok, true);
    assert.ok(runtimeHost.factory(runtimeHost.context(input)), "startup and tool registry registrations must share connection-owned bindings");
    hooks.initializeGlobalHookRunner({ hooks: [], plugins: [{ id: "agent-phonon-hitl", status: "loaded" }],
      typedHooks: [...runtimeHost.hooks].flatMap(([hookName, handlers]) => handlers.map(handler => ({ pluginId: "agent-phonon-hitl", hookName, handler, priority: 1000 }))) });
    const tool = host.factory(host.context(input))![0]!;
    const wrapped = runtime.wrapToolWithBeforeToolCallHook(tool, host.context(input));
    const result = await wrapped.execute("sdk-call", { requestId: "sdk", form });
    assert.equal(result.details.values.approved, false);
    const nativeBoard = host.factory(host.context(input))!.find(value => value.name === BOARD_TOOL)!;
    const wrappedBoard = runtime.wrapToolWithBeforeToolCallHook(nativeBoard, host.context(input));
    assert.equal((await wrappedBoard.execute("sdk-board-read", { operation: "read" })).details.board.revision, 2);
    assert.equal((await wrappedBoard.execute("sdk-board-write", { operation: "write", requestId: randomUUID(), baseRevision: 1, goal: "Agent draft", items: [] })).details.status, "conflict");
    const nativeWorkflow = host.factory(host.context(input))!.find(value => value.name === WORKFLOW_TOOL)!;
    assert.ok(nativeWorkflow);
    const wrappedWorkflow = runtime.wrapToolWithBeforeToolCallHook(nativeWorkflow, host.context(input));
    assert.equal((await wrappedWorkflow.execute("sdk-workflow-status", { operation: "status", requestId: workflowRequestID })).details.data.state, "rejected");
    const nativeMessage=host.factory(host.context(input))!.find(value=>value.name===MESSAGE_TOOL)!;
    const wrappedMessage=runtime.wrapToolWithBeforeToolCallHook(nativeMessage,host.context(input)),message={operation:"send",requestId:randomUUID(),text:"Review",mentionIDs:[randomUUID()],mode:"queue"};
    assert.equal((await wrappedMessage.execute("sdk-message",message)).details.status,"not_accepted");
    const wrong = runtime.wrapToolWithBeforeToolCallHook(tool, { ...host.context(input), runId: randomUUID() });
    assert.equal((await wrong.execute("wrong-run", { form })).details.status, "blocked");
    host.connection.abort();
    assert.equal(runtimeHost.factory(runtimeHost.context(input)), null);
    assert.equal((await wrapped.execute("after-disconnect", { form })).details.status, "blocked");
    assert.equal((await wrappedBoard.execute("board-after-disconnect", { operation: "read" })).details.status, "blocked");
    assert.equal((await wrappedWorkflow.execute("workflow-after-disconnect", { operation: "status", requestId: workflowRequestID })).details.status, "blocked");
    assert.equal((await wrappedMessage.execute("message-after-disconnect",message)).details.status,"blocked");
    assert.equal(requests, 5);
  } finally {
    hooks?.resetGlobalHookRunner(); host?.close(); runtimeHost?.close(); server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
});

test("prepared plugin artifact is self-contained, minimal, checksummed and install-only without overwrite", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "phonon-plugin-artifact-")));
  const repo = fileURLToPath(new URL("../../../", import.meta.url));
  const artifact = join(root, "plugin"), exporter = join(repo, "packages/openclaw-plugin/scripts/prepare-artifact.mjs"), installer = join(repo, "scripts/update-plugin.sh");
  try {
    const prepared = JSON.parse(execFileSync(process.execPath, [exporter, artifact], { encoding: "utf8" }));
    assert.equal(prepared.path, artifact);
    const pkg = JSON.parse(readFileSync(join(artifact, "package.json"), "utf8"));
    assert.equal(pkg.dependencies, undefined); assert.equal(pkg.devDependencies, undefined); assert.equal(pkg.scripts, undefined);
    const manifest = JSON.parse(readFileSync(join(artifact, "openclaw.plugin.json"), "utf8"));
    assert.deepEqual(manifest.contracts.tools, NATIVE_TOOLS, "current OpenClaw discovers tools through manifest ownership, not runtime registration alone");
    assert.deepEqual(Object.keys(manifest.toolMetadata).sort(), [...NATIVE_TOOLS].sort());
    for (const name of NATIVE_TOOLS) assert.equal(manifest.toolMetadata[name].optional, true);
    assert.equal(manifest.configSchema.properties.nativeInteractions.default, false);
    assert.deepEqual(readdirSync(join(artifact, "dist")), ["index.js"]);
    const original = readFileSync(join(artifact, "dist/index.js"));
    const checksum = JSON.parse(readFileSync(prepared.checksumFile, "utf8"));
    assert.equal(checksum["dist/index.js"], createHash("sha256").update(original).digest("hex"));
    assert.ok(!original.toString().includes('from "@agent-phonon/protocol"'));
    assert.throws(() => execFileSync(process.execPath, [exporter, artifact], { stdio: "pipe" }));
    assert.deepEqual(readFileSync(join(artifact, "dist/index.js")), original);
    const fake = join(root, "openclaw");
    writeFileSync(fake, '#!/bin/sh\nprintf "%s\\n" "$@"\nexit "${PHONON_INSTALL_TEST_EXIT:-0}"\n', { mode: 0o700 });
    const env = { ...process.env, PATH: root + ":" + process.env.PATH };
    const installed = execFileSync("bash", [installer, artifact], { env, encoding: "utf8" });
    assert.match(installed, /plugins\ninstall\n--force/);
    assert.throws(() => execFileSync("bash", [installer, artifact], { env: { ...env, PHONON_INSTALL_TEST_EXIT: "17" }, stdio: "pipe" }), error => (error as any).status === 17);
    writeFileSync(join(artifact, "dist/index.js"), original.toString() + "\n// changed\n");
    assert.throws(() => execFileSync("bash", [installer, artifact], { env, stdio: "pipe" }), /Command failed/);
    writeFileSync(join(artifact, "dist/index.js"), original);
    writeFileSync(join(artifact, "unexpected.txt"), "unexpected");
    assert.throws(() => execFileSync("bash", [installer, artifact], { env, stdio: "pipe" }));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
