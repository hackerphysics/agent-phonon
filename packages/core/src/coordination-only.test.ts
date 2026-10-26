import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { SessionEngine, AdapterRegistry } from "./session-engine.js";
import { AgentInteractionBridge } from "./agent-interaction-bridge.js";
import { preparePiNativeTools } from "./adapters/pi-native-tools.js";
import { PhononStore } from "./store.js";
import { selectedNativeControllerTools } from "./native-tool-channel.js";
import { withPeerFixture, closePeerServer } from "./testing/peer-fixture.js";
import { spawnSupervisedAgent } from "./process-supervisor.js";
import type { AgentAdapter, CreateSessionParams, SendOptions } from "./adapter.js";
import { SessionId } from "@agent-phonon/protocol";

test("controller tool selection never grants group or human capability through project coordination", () => {
  assert.deepEqual(selectedNativeControllerTools({}), []);
  assert.deepEqual(selectedNativeControllerTools({ projectCoordination: () => {} }), ["phonon_project_coordination"]);
  assert.deepEqual(selectedNativeControllerTools({ conversationMessage: () => {} }), ["phonon_conversation_message"]);
  assert.deepEqual(selectedNativeControllerTools({ requestInteraction: () => {} }), ["phonon_request_interaction", "phonon_acknowledge_interaction"]);
});

test("SessionEngine exposes the actual coordination-only MCP catalog without installing a human interaction callback", () => withPeerFixture("coordination-only", async scope => {
  const store = new PhononStore(join(scope.root, "state.sqlite")); scope.defer(() => store.close());
  const registry = new AdapterRegistry(), events: any[] = [], calls: any[] = [];
  const self = { id: randomUUID(), position: "1", projectId: randomUUID(), ownerId: "owner", deviceId: randomUUID(), agentId: "mock:default", agentKind: "agent" as const,
    sourceKind: "native" as const, sessionId: "unbound", label: "worker", activity: { summary: "", phase: "working" as const, impact: [], dependencies: "" },
    activityRevision: 0, lastSeenAt: null, presence: "active" as const };
  let endpoint = "", token = "";
  const adapter: AgentAdapter = { name: "mock", capabilities: { nativeSession: false, nativeCompression: false, contextInjection: false,
    proactiveOutput: false, modelSwitch: false, interrupt: false, injectMidTurn: false, skillManagement: false, hooks: [], streaming: true, workflowRoles: ["worker"] },
    discoverAgents: async () => [], createSession: async (params: CreateSessionParams) => ({ sessionId: params.sessionId, model: params.model,
    terminate: async () => {}, send: async (_input: string, options: SendOptions) => {
      assert.equal(options.requestInteraction, undefined); assert.equal(options.conversationMessage, undefined); assert.ok(options.projectCoordination);
      endpoint = options.environment!.AGENT_PHONON_MCP_URL!; token = options.environment!.AGENT_PHONON_INTERACTION_TOKEN!;
      const post = (method: string, params: unknown) => fetch(endpoint, { method: "POST", headers: { authorization: "Bearer " + token, "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
      const catalog = await (await post("tools/list", {})).json() as any;
      assert.deepEqual(catalog.result.tools.map((tool: any) => tool.name), ["phonon_project_coordination"]);
      assert.ok(catalog.result.tools[0].inputSchema.properties.operation.enum.includes("peers"));
      const malformed = await (await post("tools/call", {name:"phonon_project_coordination", arguments:{}})).json() as any;
      assert.equal(malformed.result.isError, true);
      const forged = await (await post("tools/call", {name:"phonon_project_coordination", arguments:{operation:"presence",senderId:randomUUID()}})).json() as any;
      assert.equal(forged.result.isError, true);
      const result = await (await post("tools/call", { name: "phonon_project_coordination", arguments: { operation: "presence" } })).json() as any;
      assert.notEqual(result.result.isError, true);
      const denied = await (await post("tools/call", { name: "phonon_request_interaction", arguments: {} })).json() as any;
      assert.equal(denied.result.isError, true);
      options.emit({ type: "result", sessionId: SessionId.parse(params.sessionId), turnId: options.turnId, seq: 0, at: new Date().toISOString(), origin: "solicited", text: "Original work complete", status: "completed", final: true });
    } }) };
  registry.register(adapter);
  const engine = new SessionEngine(registry, event => events.push(event), undefined, store, { projectCoordination: async request => {
    self.sessionId = request.sessionId; calls.push(request);
    if (request.receive) throw new Error("Legacy server rejects receive metadata");
    return request.action.operation === "peers" ? { self, participants: [], next: null } : { self, messages: [], next: null };
  } }, "owner"); scope.defer(() => engine.dispose());
  const session = await engine.create({ tenantId: "owner", project: "owned-project", cwd: scope.root, agent: "mock:default", model: "m1", verbosity: "tools",
    workflowAttr: { workflowId: "owned-workflow", nodeId: "worker", nativeRunId: randomUUID() } });
  await engine.send("owner", session.sessionId, "Original assigned task", {});
  for (let n = 0; n < 100 && !events.some(event => event.final); n++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(events.at(-1)?.status, "completed", JSON.stringify(events));
  assert.deepEqual(calls.map(call => call.action.operation), ["presence", "presence", "peers", "inbox", "presence"]);
  assert.ok(calls.every(call => call.workflowId === "owned-workflow" && call.sessionId === session.sessionId));
  assert.equal(calls[0].workspaceVersion,1);assert.equal(calls[1].workspaceVersion,undefined);
  assert.ok(calls.slice(2).every(call => !call.receive&&!call.workspaceVersion));
  await engine.dispose(); await assert.rejects(fetch(endpoint, { method: "POST", headers: { authorization: "Bearer " + token }, body: "{}" }));
}));

for(const legacy of [false,true])test(`SessionEngine preserves receive negotiation and original work with workspace legacy=${legacy}`,()=>withPeerFixture("workspace-context",async scope=>{
  const registry=new AdapterRegistry(),events:any[]=[],calls:any[]=[];let prompt="";
  const device=randomUUID(),peerID=randomUUID(),project=randomUUID();
  const workspace={state:"current" as const,deviceId:device,runtimeWorkspaceId:"runtime-project",path:"/owned/side",repositoryRoot:"/owned/side",
    branch:"feature/peer",isWorktree:true,worktreeId:"side",detached:false,observedAt:new Date().toISOString(),checkedAt:new Date().toISOString()};
  registry.register({name:"controlled",capabilities:{nativeSession:false,nativeCompression:false,contextInjection:false,proactiveOutput:false,
    modelSwitch:false,interrupt:false,injectMidTurn:false,skillManagement:false,hooks:[],streaming:true,workflowRoles:["worker"]},discoverAgents:async()=>[],
    createSession:async(params:CreateSessionParams)=>({sessionId:params.sessionId,model:params.model,terminate:async()=>{},send:async(input:string,options:SendOptions)=>{
      prompt=input;assert.ok(options.projectCoordination);
      const peers=await options.projectCoordination({operation:"peers",after:"0"});
      assert.equal(peers.participants?.[0]?.workspace?.state,legacy?undefined:"current");
      options.emit({type:"result",sessionId:SessionId.parse(params.sessionId),turnId:options.turnId,seq:0,at:new Date().toISOString(),origin:"solicited",
        text:"Original work",status:"completed",final:true});
    }})} as AgentAdapter);
  const engine=new SessionEngine(registry,event=>events.push(event),undefined,undefined,{projectCoordination:async request=>{
    calls.push(request);if(legacy&&request.workspaceVersion)throw Error("Old strict host");
    const self={id:randomUUID(),position:"1",projectId:project,ownerId:"owner",deviceId:device,agentId:"controlled",agentKind:"agent" as const,sourceKind:"native" as const,
      sessionId:request.sessionId,label:"Worker",activity:{summary:"",phase:"working" as const,impact:[],dependencies:""},activityRevision:0,lastSeenAt:null,presence:"active" as const};
    const peer={...self,id:peerID,sessionId:"peer-session",label:"Peer",deviceName:"Peer device",...(request.workspaceVersion?{workspace}: {})};
    return {self,receiveReporting:1 as const,...(request.workspaceVersion?{workspaceVersion:1 as const}:{}),
      ...(request.action.operation==="peers"?{participants:[peer],next:null}:request.action.operation==="inbox"?{messages:[],next:null}:{})};
  }},"owner");scope.defer(()=>engine.dispose());
  const created=await engine.create({tenantId:"owner",project:"owned",cwd:scope.root,agent:"controlled",model:"m1",verbosity:"tools",
    workflowAttr:{workflowId:"workflow",nodeId:"reply",nativeRunId:randomUUID()}});
  await engine.send("owner",created.sessionId,"Original assigned input",{});
  for(let n=0;n<100&&!events.some(e=>e.final);n++)await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal(events.at(-1)?.status,"completed",JSON.stringify(events));
  assert.match(prompt,/Original assigned input$/);assert.match(prompt,/do not establish no conflict/);
  assert.equal(prompt.includes('"path":"/owned/side"'),!legacy);assert.equal(prompt.includes('"deviceName":"Peer device"'),true);
  assert.ok(calls.filter(c=>c.action.operation==="peers").every(c=>c.receive&&c.workspaceVersion===(legacy?undefined:1)));
  assert.equal(calls.filter(c=>c.action.operation==="presence").length,legacy?2:1);
}));

test("Pi's existing Phonon extension registers only project coordination in a coordination-only execution", () => withPeerFixture("pi-coordination-only", async scope => {
  const old = process.env.PHONON_STATE_DIR; process.env.PHONON_STATE_DIR = scope.root;
  scope.defer(() => { if (old === undefined) delete process.env.PHONON_STATE_DIR; else process.env.PHONON_STATE_DIR = old; });
  const calls: unknown[] = [];
  const bridge = new AgentInteractionBridge(undefined, undefined, undefined, undefined, undefined, undefined, async input => { calls.push(input); return { status: "left", participantId: randomUUID() }; });
  scope.defer(() => bridge.close()); const environment = await bridge.listen();
  const asset = preparePiNativeTools({ turnId: "turn", verbosity: "tools", emit() {}, environment, projectCoordination: async () => ({}) })!;
  scope.defer(asset.cleanup); const tools: any[] = [], handlers = new Map<string, () => void>();
  const values = { ...environment, AGENT_PHONON_PI_NATIVE_NONCE: asset.nonce, AGENT_PHONON_PI_NATIVE_TOOL_NAMES: JSON.stringify(asset.names) };
  const previous = new Map(Object.keys(values).map(key => [key, process.env[key]]));
  scope.defer(() => { for (const [key, value] of previous) if (value === undefined) delete process.env[key]; else process.env[key] = value; }); Object.assign(process.env, values);
  await (await import(pathToFileURL(asset.path).href)).default({ on: (type: string, handler: () => void) => handlers.set(type, handler),
    registerTool: (tool: any) => tools.push(tool), getAllTools: () => tools.map(tool => ({ ...tool, sourceInfo: { path: asset.path } })), getActiveTools: () => tools.map(tool => tool.name) });
  handlers.get("session_start")!(); handlers.get("before_provider_request")!();
  assert.deepEqual(tools.map(tool => tool.name), ["phonon_project_coordination"]);
  const reply = await tools[0].execute("call", { operation: "leave" }); assert.equal(JSON.parse(reply.content[0].text).status, "left");
  assert.equal(calls.length, 1); await bridge.close(); await assert.rejects(tools[0].execute("late", { operation: "leave" }));
}));

test("installed Pi invokes project coordination without any human/group tool or model inbox polling", {
  skip: !process.env.PHONON_TEST_PI_BIN, timeout: 25000,
}, () => withPeerFixture("pi-coordination-native", async scope => {
  const old = process.env.PHONON_STATE_DIR; process.env.PHONON_STATE_DIR = scope.root;
  scope.defer(() => { if (old === undefined) delete process.env.PHONON_STATE_DIR; else process.env.PHONON_STATE_DIR = old; });
  const home = join(scope.root, "home"), piHome = join(home, ".pi", "agent"); mkdirSync(piHome, { recursive: true });
  const participantId = randomUUID(), calls: unknown[] = [], requests: any[] = [], errors: unknown[] = [];
  const bridge = new AgentInteractionBridge(undefined, undefined, undefined, undefined, undefined, undefined, async input => {
    calls.push(input); return { status: "left", participantId };
  }); scope.defer(() => bridge.close());
  const environment = await bridge.listen(), asset = preparePiNativeTools({ turnId: "native-turn", verbosity: "tools", emit() {}, environment, projectCoordination: async () => ({}) })!;
  scope.defer(asset.cleanup);
  const provider = createServer((req, res) => { void (async () => {
    let body = ""; for await (const chunk of req) body += String(chunk); const payload = JSON.parse(body); requests.push(payload);
    assert.ok(requests.length <= 2, "Native coordination fixture must not create a loop");
    const names = payload.tools.map((tool: any) => tool.function?.name);
    assert.ok(names.includes("phonon_project_coordination")); assert.equal(names.some((name: string) => /phonon_(request_interaction|acknowledge_interaction|conversation_message)/.test(name)), false);
    const schema=payload.tools.find((tool:any)=>tool.function?.name==="phonon_project_coordination").function.parameters;
    assert.deepEqual(schema.required,["operation"]);
    assert.equal(schema.properties.operation.type,"string");
    assert.ok(schema.properties.operation.enum.includes("send"));
    assert.equal(schema.properties.activity.properties.summary.type,"string");
    assert.equal(schema.anyOf.length,8,"native provider receives original branch validation as well as visible properties");
    if (requests.length === 2) assert.ok(body.includes(participantId), "The native tool's confirmed result must reach the original provider continuation");
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const send = (delta: unknown, finish_reason: string | null) => res.write("data: " + JSON.stringify({ id: "controlled", object: "chat.completion.chunk", created: 1,
      model: "m1", choices: [{ index: 0, delta, finish_reason }] }) + "\n\n");
    if (requests.length === 1) {
      send({ role: "assistant", tool_calls: [{ index: 0, id: "coordination-call", type: "function", function: { name: "phonon_project_coordination", arguments: '{"operation":"leave"}' } }] }, null);
      send({}, "tool_calls");
    } else { send({ role: "assistant", content: "Original native coordination task complete" }, null); send({}, "stop"); }
    res.end("data: [DONE]\n\n");
  })().catch(error => { errors.push(error); res.destroy(); }); });
  scope.defer(() => closePeerServer(provider)); await new Promise<void>(resolve => provider.listen(0, "127.0.0.1", resolve));
  const providerPath = join(scope.root, "provider.mjs");
  writeFileSync(providerPath, `export default function(pi){pi.registerProvider("phonon-fixture",{baseUrl:${JSON.stringify(`http://127.0.0.1:${(provider.address() as { port: number }).port}/v1`)},apiKey:"synthetic-provider-key",api:"openai-completions",models:[{id:"m1",name:"Controlled fixture",reasoning:false,input:["text"],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:10000,maxTokens:1000}]});}`, { mode: 0o600 });
  const native = spawnSupervisedAgent(process.execPath, [process.env.PHONON_TEST_PI_BIN!, "--mode", "json", "--session-id", randomUUID(), "--no-extensions", "--no-skills",
    "--extension", providerPath, "--extension", asset.path, "--model", "phonon-fixture/m1"], { cwd: scope.root,
    env: { PATH: process.env.PATH, HOME: home, TMPDIR: scope.root, TMP: scope.root, TEMP: scope.root, PI_CODING_AGENT_DIR: piHome, PI_OFFLINE: "1", PI_TELEMETRY: "0",
      ...environment, AGENT_PHONON_PI_NATIVE_NONCE: asset.nonce, AGENT_PHONON_PI_NATIVE_TOOL_NAMES: JSON.stringify(asset.names) } });
  scope.watch(native.child, true); scope.defer(() => native.terminate()); let stdout = "", stderr = "";
  native.child.stdout.on("data", chunk => { stdout = (stdout + String(chunk)).slice(-16000); }); native.child.stderr.on("data", chunk => { stderr = (stderr + String(chunk)).slice(-4000); });
  const closed = new Promise<number | null>((resolve, reject) => { native.child.once("close", resolve); native.child.once("error", reject); });
  const timer = setTimeout(() => { void native.terminate(); }, 20000); scope.defer(() => clearTimeout(timer));
  native.child.stdin.end("Complete the original assigned task.\n");
  const code = await closed; clearTimeout(timer);
  assert.equal(code, 0, stderr); assert.deepEqual(errors, []); assert.deepEqual(calls, [{ operation: "leave" }]); assert.equal(requests.length, 2);
  assert.ok(stdout.includes("Original native coordination task complete"));
}));
