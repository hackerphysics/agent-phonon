import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { AgentInteractionBridge } from "../../core/dist/agent-interaction-bridge.js";
import { preparePiNativeTools } from "../../core/dist/adapters/pi-native-tools.js";
import { PiAdapter, type SendOptions } from "@agent-phonon/core";

const form = { title: "Native test", fields: [{ key: "flag", label: "Flag", type: "boolean" as const, required: true }, { key: "count", label: "Count", type: "number" as const, required: true }] };
const names = ["phonon_request_interaction", "phonon_acknowledge_interaction"];
async function fixture(work: (f: any) => Promise<void>, full = false) {
  const root = mkdtempSync(join(tmpdir(), "phonon-pi-native-")), old = process.env.PHONON_STATE_DIR;
  process.env.PHONON_STATE_DIR = root;
  const applied: string[] = [], requested: string[] = [];
  const bridge = new AgentInteractionBridge(async input => { requested.push(input.requestId!); return { requestId: input.requestId!, action: "submit", values: { flag: false, count: 0 } }; }, id => applied.push(id),
    ...(full ? [async () => ({ status: "ok" }), async () => ({ status: "catalog", data: {} }), async () => ({ status: "not_accepted" }), async () => ({ delivered: [] })] as any : []));
  const environment = await bridge.listen();
  const options = { environment, requestInteraction: async () => ({ action: "cancel" }), emit: () => {}, verbosity: "trace", turnId: "owned-turn",
    ...(full?{conversationBoard:async()=>({}),conversationWorkflow:async()=>({}),conversationMessage:async()=>({}),publishDocument:async()=>({})}:{}) } as unknown as SendOptions;
  const asset = preparePiNativeTools(options)!;
  try { await work({ root, bridge, environment, options, asset, requested, applied }); }
  finally { asset.cleanup(); await bridge.close(); if (old === undefined) delete process.env.PHONON_STATE_DIR; else process.env.PHONON_STATE_DIR = old; rmSync(root, { recursive: true, force: true }); }
}
async function activate(f: any, existing: any[] = [], view: Record<string, unknown> = {}) {
  const keys = [...Object.keys(f.environment), "AGENT_PHONON_PI_NATIVE_NONCE","AGENT_PHONON_PI_NATIVE_TOOL_NAMES"], previous = new Map(keys.map(key => [key, process.env[key]]));
  for (const [key, value] of Object.entries(f.environment)) process.env[key] = value as string;
  process.env.AGENT_PHONON_PI_NATIVE_NONCE = f.asset.nonce;
  process.env.AGENT_PHONON_PI_NATIVE_TOOL_NAMES = JSON.stringify(f.asset.names);
  const tools: any[] = [], original = process.stderr.write, lines: string[] = [];
  f.piView = { active: true, source: f.asset.path, ...view };
  const handlers = new Map<string, () => void>(), originalExit = process.exit;
  process.stderr.write = ((value: any) => { lines.push(String(value)); return true; }) as typeof process.stderr.write;
  process.exit = (() => { throw new Error("Native registration unconfirmed"); }) as typeof process.exit;
  try {
    const module = await import(pathToFileURL(f.asset.path).href);
    let started = false;
    await module.default({ getAllTools: () => { assert.ok(started, "tool selection must be inspected after the runtime binds"); return [...existing, ...tools.map(tool => ({ ...tool, sourceInfo: { path: f.piView.source } }))]; }, getActiveTools: () => f.piView.active ? tools.map(tool => tool.name) : [], registerTool: (tool: any) => tools.push(tool), on: (event: string, handler: () => void) => handlers.set(event, handler) });
    assert.ok(lines.includes(f.asset.acknowledgement + "\n")); started = true; handlers.get("session_start")!(); handlers.get("before_provider_request")!(); return tools;
  } finally {
    process.stderr.write = original; process.exit = originalExit;
    for (const [key, value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
}
function result(value: any) { return JSON.parse(value.content[0].text); }

test("Pi native registration is invocation-scoped, independent from HITL, and never writes a capability to disk/argv", () => fixture(async f => {
  const source = readFileSync(f.asset.path, "utf8");
  assert.equal(source.includes(f.environment.AGENT_PHONON_INTERACTION_TOKEN), false); assert.equal(source.includes(f.asset.nonce), false);
  assert.equal(statSync(f.asset.path).mode & 0o777, 0o600);
  const tools = await activate(f); assert.deepEqual(tools.map((tool: any) => tool.name), names);
  assert.deepEqual(tools[0].parameters.type, "object");
  const decision = result(await tools[0].execute("request", { requestId: "one", form }));
  assert.deepEqual(decision.values, { flag: false, count: 0 }); assert.deepEqual(f.applied, []);
  await tools[1].execute("ack", { requestId: "one", decisionHash: decision.decisionHash }); assert.deepEqual(f.applied, ["one"]);
}));

test("Pi registers only the actual turn catalog, including all scoped chat channels when offered", () => fixture(async f => {
  const tools = await activate(f); assert.deepEqual(tools.map((tool: any) => tool.name), [...names, "phonon_conversation_board", "phonon_workflow", "phonon_conversation_message", "phonon_publish_document"]);
}, true));

test("parallel Pi calls keep distinct RPC identities and exact false/zero responses", () => fixture(async f => {
  const tools = await activate(f), decisions = await Promise.all(["left", "right"].map(requestId => tools[0].execute(requestId, { requestId, form }).then(result)));
  assert.deepEqual(decisions.map(value => value.requestId), ["left", "right"]);
  await Promise.all(decisions.map(value => tools[1].execute("ack-" + value.requestId, { requestId: value.requestId, decisionHash: value.decisionHash })));
  assert.deepEqual([...f.applied].sort(), ["left", "right"]);
}));

test("Pi does not override an existing reserved tool or infer permission from a closed/cancelled channel", () => fixture(async f => {
  await assert.rejects(activate(f, [{ name: names[0] }]), /unconfirmed/); assert.deepEqual(f.requested, []);
  const tools = await activate(f), controller = new AbortController(); controller.abort();
  await assert.rejects(tools[0].execute("aborted", { requestId: "aborted", form }, controller.signal), /unconfirmed/); assert.deepEqual(f.applied, []);
  await f.bridge.close(); await assert.rejects(tools[0].execute("closed", { requestId: "closed", form }), /unconfirmed/); assert.deepEqual(f.applied, []);
}));

test("ordinary Pi invocations do not gain tools, and malformed/foreign endpoints fail before process launch", () => {
  assert.equal(preparePiNativeTools({ requestInteraction: undefined } as unknown as SendOptions), undefined);
  for (const environment of [{}, { AGENT_PHONON_MCP_URL: "https://foreign.invalid/mcp" }, { AGENT_PHONON_MCP_URL: "http://127.0.0.1:1234/mcp", AGENT_PHONON_INTERACTION_URL: "http://127.0.0.1:1235/interaction", AGENT_PHONON_INTERACTION_TOKEN: "x".repeat(43) }]) {
    assert.throws(() => preparePiNativeTools({ requestInteraction: () => {}, environment } as unknown as SendOptions), (error: any) => error.appCode === "errCapabilityUnsupported");
  }
});

test("native registration respects exclusions and changed tool provenance without enabling or invoking a tool", () => fixture(async f => {
  await assert.rejects(activate(f, [], { active: false }), /unconfirmed/);
  await assert.rejects(activate(f, [], { source: "/foreign/extension.mjs" }), /unconfirmed/);
  const tools = await activate(f); f.piView.active = false;
  await assert.rejects(tools[0].execute("disabled", { requestId: "disabled", form }), /unconfirmed/);
  assert.deepEqual(f.requested, []); assert.deepEqual(f.applied, []);
}));

test("controller capabilities use direct loopback HTTP instead of the model process proxy environment", () => fixture(async f => {
  const keys = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy", "NODE_USE_ENV_PROXY"], old = new Map(keys.map(key => [key, process.env[key]]));
  try {
    for (const key of keys) process.env[key] = key === "NODE_USE_ENV_PROXY" ? "1" : "http://127.0.0.1:1";
    const tools = await activate(f), decision = result(await tools[0].execute("direct", { requestId: "direct", form }));
    await tools[1].execute("ack-direct", { requestId: "direct", decisionHash: decision.decisionHash }); assert.deepEqual(f.applied, ["direct"]);
  } finally { for (const [key, value] of old) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
}));

const CLI = String.raw`#!/usr/bin/env node
import fs from 'node:fs';import{pathToFileURL}from'node:url';
const args=process.argv.slice(2),log=process.env.PHONON_PI_FIXTURE_LOG;
if(args.includes('--help')){console.log('--session <path> --session-id <id> --extension <path>');process.exit(0);}
if(args.includes('--version')){console.log('0.84.1');process.exit(0);}
if(args.includes('--list-models')){console.log('fixture  m1');process.exit(0);}
fs.appendFileSync(log,JSON.stringify({stage:'launch',args})+'\n');
const tools=[],handlers=new Map();let extensionPath;
const pi={getAllTools:()=>tools.map(tool=>({...tool,sourceInfo:{path:extensionPath}})),getActiveTools:()=>tools.map(tool=>tool.name),registerTool:tool=>tools.push(tool),on:(event,handler)=>handlers.set(event,handler)};
for(let i=0;i<args.length;i++)if(args[i]==='--extension'&&args[i+1].includes('pi-native-tools-')){
 if(process.env.PHONON_PI_FIXTURE_DROP==='1'){process.stderr.write('wrong-ready-marker\n');process.exit(0);}
 extensionPath=args[++i];await(await import(pathToFileURL(extensionPath).href)).default(pi);
}
let input='';for await(const value of process.stdin)input+=value;
handlers.get('session_start')?.();handlers.get('before_provider_request')?.();
fs.appendFileSync(log,JSON.stringify({stage:'prompt',input})+'\n');
const emit=value=>console.log(JSON.stringify(value));
for(const [name,key]of [['phonon_request_interaction','request'],['phonon_acknowledge_interaction','ack']]){
 const tool=tools.find(tool=>tool.name===name);if(!tool)continue;
 emit({type:'tool_execution_start',toolCallId:key,toolName:name,args:{}});
 const params=key==='request'?{requestId:'adapter-native',form:{title:'Adapter native',fields:[{key:'flag',label:'Flag',type:'boolean'}]}}:{requestId:'adapter-native',decisionHash:globalThis.decision.decisionHash};
 const value=await tool.execute(key,params);if(key==='request')globalThis.decision=JSON.parse(value.content[0].text);
 emit({type:'tool_execution_end',toolCallId:key,toolName:name,result:value,isError:false});
}
emit({type:'message_update',assistantMessageEvent:{type:'text_delta',delta:'native ready'}});emit({type:'agent_settled',aborted:false});
`;

async function adapterCase(drop: boolean) {
  await fixture(async f => {
    const bin = join(f.root, "pi-cli.mjs"), log = join(f.root, "calls.jsonl"), cwd = join(f.root, "work"); mkdirSync(cwd); writeFileSync(bin, CLI, { mode: 0o700 });
    const oldLog = process.env.PHONON_PI_FIXTURE_LOG, oldDrop = process.env.PHONON_PI_FIXTURE_DROP;
    process.env.PHONON_PI_FIXTURE_LOG = log; process.env.PHONON_PI_FIXTURE_DROP = drop ? "1" : "0";
    const events: any[] = [];
    try {
      const adapter = new PiAdapter({ env: { binPath: bin, defaultModel: "fixture/m1" } });
      const session = await adapter.createSession({ sessionId: "native-pi-adapter", agentId: "pi", model: "fixture/m1", cwd });
      await session.send("Only after registration", { ...f.options, emit: (event: any) => events.push(event) });
      const calls = readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line));
      assert.equal(JSON.stringify(calls).includes(f.environment.AGENT_PHONON_INTERACTION_TOKEN), false);
      const launch = calls.find(row => row.stage === "launch"), extension = launch.args[launch.args.indexOf("--extension") + 1];
      assert.ok(extension); assert.equal(existsSync(extension), false, "invocation assets are cleaned after settlement");
      if (drop) { assert.equal(calls.some(row => row.stage === "prompt"), false); assert.equal(events.at(-1).status, "failed"); assert.deepEqual(f.applied, []); }
      else { assert.equal(calls.filter(row => row.stage === "prompt").length, 1); assert.equal(events.at(-1).status, "completed"); assert.deepEqual(f.applied, ["adapter-native"]); }
      await session.terminate();
    } finally {
      if (oldLog === undefined) delete process.env.PHONON_PI_FIXTURE_LOG; else process.env.PHONON_PI_FIXTURE_LOG = oldLog;
      if (oldDrop === undefined) delete process.env.PHONON_PI_FIXTURE_DROP; else process.env.PHONON_PI_FIXTURE_DROP = oldDrop;
    }
  });
}
test("the actual Pi adapter waits for scoped native registration before releasing stdin, without HITL configuration", () => adapterCase(false));
test("a missing native registration acknowledgement never sends model input", () => adapterCase(true));

test("installed Pi prepares the scoped catalog before stdin and registers active native tools without inference", { skip: !process.env.PHONON_TEST_PI_BIN, timeout: 20000 }, () => fixture(async f => {
  const provider = join(f.root, "provider.mjs"), home = join(f.root, "isolated-home"), piHome = join(home, ".pi", "agent"); mkdirSync(piHome, { recursive: true });
  writeFileSync(provider, `export default function(pi){pi.registerProvider("phonon-fixture",{baseUrl:"http://127.0.0.1:1/v1",apiKey:"synthetic-not-a-provider-key",api:"openai-completions",models:[{id:"m1",name:"No inference fixture",reasoning:false,input:["text"],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:10000,maxTokens:1000}]});}`, { mode: 0o600 });
  const child = spawn(process.execPath, [process.env.PHONON_TEST_PI_BIN!, "--mode", "json", "--no-session", "--no-extensions", "--no-skills", "--extension", provider, "--extension", f.asset.path, "--model", "phonon-fixture/m1"],
    { cwd: f.root, env: { PATH: process.env.PATH, HOME: home, PI_CODING_AGENT_DIR: piHome, ...f.environment, AGENT_PHONON_PI_NATIVE_NONCE: f.asset.nonce,AGENT_PHONON_PI_NATIVE_TOOL_NAMES:JSON.stringify(f.asset.names) }, stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "", released = false;
  const closed = new Promise<void>(resolve => child.once("close", () => resolve()));
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Installed Pi native extension acknowledgement unavailable: " + stderr.replaceAll(f.environment.AGENT_PHONON_INTERACTION_TOKEN, "[redacted]"))), 10000);
      child.once("error", error => { clearTimeout(timer); reject(error); });
      child.once("close", () => { if (!released) { clearTimeout(timer); reject(new Error("Installed Pi exited before native registration: " + stderr)); } });
      let ended = false;
      child.stderr.on("data", chunk => {
        stderr += String(chunk);
        if (!ended && stderr.includes(f.asset.acknowledgement + "\n")) { ended = true; child.stdin.end(); }
        if (stderr.includes("PHONON_PI_NATIVE_TOOLS_ACTIVE_" + f.asset.nonce + "\n")) { released = true; clearTimeout(timer); resolve(); }
      });
    });
    assert.equal(stderr.includes(f.environment.AGENT_PHONON_INTERACTION_TOKEN), false); assert.deepEqual(f.requested, []); assert.deepEqual(f.applied, []);
  } finally { child.stdin.destroy(); child.kill("SIGTERM"); await closed; }
}));
