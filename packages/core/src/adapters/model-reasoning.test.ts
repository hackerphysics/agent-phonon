import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createServer } from "node:http";
import { ModelInfo, ReasoningConfirmation, SessionSendParams, TurnReasoning } from "@agent-phonon/protocol";
import { nativeReasoning, reportedReasoningLevels } from "../reasoning.js";
import { DiscoveryRPC } from "../discovery-rpc.js";
import { withPeerFixture, closePeerServer } from "../testing/peer-fixture.js";
import { CodexAdapter } from "./codex.js";
import { PiAdapter } from "./pi.js";
import { parseHermesReasoningLevels } from "./hermes.js";
import { discoverCodexNativeModels, parseCodexNativeModels } from "./codex-models.js";
import { discoverPiNativeModels, parsePiNativeModels, piModelReasoningLevels } from "./pi-models.js";
import { ClaudeCodeAdapter,parseClaudeReasoningLevels } from "./claude-code.js";

test("Claude advertises only an installed effort flag and retains native named levels",()=>{
  assert.equal(parseClaudeReasoningLevels("--model <id>"),undefined);
  assert.deepEqual(parseClaudeReasoningLevels("  --effort <level>  Effort level (choices: low, medium, high, max, ultracode)\n  --model <id>"),["low","standard","high","max","ultracode"]);
});

test("Claude sends native efforts on the original CLI invocation without inventing confirmation",()=>withPeerFixture("claude-native-efforts",async scope=>{
  const bin=join(scope.root,"claude.mjs"),calls=join(scope.root,"calls.jsonl");
  writeFileSync(bin,"#!"+process.execPath+"\n"+String.raw`
import fs from 'node:fs';const args=process.argv.slice(2);
if(args.includes('--version')){console.log('2.1.203');process.exit(0);}
if(args.includes('--help')){console.log('  --effort <level>  Effort (choices: low, medium, high, max, ultracode)');process.exit(0);}
let input='';for await(const chunk of process.stdin)input+=chunk;
fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify({args,input})+'\n');
const id=args[args.indexOf(args.includes('--resume')?'--resume':'--session-id')+1];
console.log(JSON.stringify({type:'result',session_id:id,subtype:'success',is_error:false,result:'actual result',num_turns:1}));
`,{mode:0o700});
  const adapter=new ClaudeCodeAdapter({env:{binPath:bin,defaultModel:"native"}});
  const descriptor=(await adapter.discoverAgents())[0]!;
  assert.equal(descriptor.capabilities.reasoningControl,true);
  assert.deepEqual(descriptor.models[0]?.reasoningLevels,["low","standard","high","max","ultracode"]);
  const session=await adapter.createSession({sessionId:"fixture",agentId:"claude-code",model:"native",cwd:scope.root});scope.defer(()=>session.terminate());
  for(const level of ["standard","max","ultracode"]){
    const events:any[]=[],proof:unknown[]=[];
    await session.send("original "+level,{turnId:level,verbosity:"final",reasoning:{level},emit:event=>events.push(event),acknowledgeReasoning:value=>proof.push(value)});
    assert.equal(events.at(-1)?.status,"completed");assert.deepEqual(proof,[]);
  }
  const sent=readFileSync(calls,"utf8").trim().split("\n").map(line=>JSON.parse(line));
  assert.deepEqual(sent.map(row=>row.args[row.args.indexOf("--effort")+1]),["medium","max","ultracode"]);
  assert(sent.every(row=>!row.args.includes("--dangerously-skip-permissions")));
}));

const cli = String.raw`
import fs from 'node:fs';import path from 'node:path';import {fileURLToPath} from 'node:url';
const root=path.dirname(fileURLToPath(import.meta.url)),args=process.argv.slice(2),control=JSON.parse(fs.readFileSync(path.join(root,'control.json'),'utf8'));
if(args.includes('--version')){console.log('0.84.1');process.exit(0);}
if(args.includes('--help')){console.log('--mode text, json, rpc --thinking <level> --session <path> --session-id <id> --no-session');process.exit(0);}
if(args.includes('--list-models')){for(const m of control.models)console.log(m.provider+'  '+m.id+'  32K  8K  '+(m.reasoning?'yes':'no')+'  text');process.exit(0);}
const emit=value=>console.log(JSON.stringify(value));
let carry='';for await(const chunk of process.stdin){carry+=chunk;let end;
 while((end=carry.indexOf('\n'))>=0){const line=carry.slice(0,end);carry=carry.slice(end+1);if(!line)continue;const q=JSON.parse(line);
 fs.appendFileSync(path.join(root,'queries.jsonl'),JSON.stringify({args,query:q})+'\n');
 const name=q.method??q.type;if(name==='initialized')continue;
 if(control.hang)continue;
 if(name==='initialize')emit({id:q.id,result:{}});
 else if(name==='model/list'){
  const page=control.pages?.[q.params?.cursor??'first']??{data:[{id:'model',model:'model',supportedReasoningEfforts:[{reasoningEffort:'low'},{reasoningEffort:'medium'},{reasoningEffort:'high'},{reasoningEffort:'xhigh'},{reasoningEffort:'max'}]}],nextCursor:null};
  emit({id:q.id,result:page});
 }else if(name==='get_available_models')emit({type:'response',id:q.id,command:name,success:true,data:{models:control.models}});
 else if(name==='get_state')emit({type:'response',id:q.id,command:name,success:true,data:{model:control.models[0]}});
 else throw Error('No task or unreviewed native command may run in a metadata fixture');
 }
}
`;

const models = [
  { provider: "fixture", id: "ordinary", reasoning: true, contextWindow: 32000 },
  { provider: "fixture", id: "advanced", reasoning: true, thinkingLevelMap: { xhigh: "xhigh", max: "max" } },
  { provider: "fixture", id: "limited", reasoning: true, thinkingLevelMap: { low: null, medium: null, high: "high", xhigh: null, max: null } },
  { provider: "fixture", id: "plain", reasoning: false },
];
function setup(root: string, control: Record<string, unknown> = {}) {
  const bin = join(root, "metadata.mjs");
  writeFileSync(bin, "#!" + process.execPath + "\n" + cli, { mode: 0o700 });
  writeFileSync(join(root, "control.json"), JSON.stringify({ models, ...control }), { mode: 0o600 });
  return { bin, queries: () => readFileSync(join(root, "queries.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line) as any) };
}

test("reasoning protocol and canonical mapping preserve max as a distinct native value", () => {
  assert.deepEqual(TurnReasoning.parse({ level: "max" }), { level: "max" });
  assert.equal(SessionSendParams.parse({ sessionId: "session", input: "task", reasoning: { level: "max" } }).reasoning?.level, "max");
  assert.equal(nativeReasoning("max"), "max");
  assert.deepEqual(reportedReasoningLevels(["medium", "xhigh", "max", "max", "ultra"]), ["standard", "xhigh", "max", "ultra"]);
  assert.deepEqual(reportedReasoningLevels(["medium", "standard", "high"]), ["standard", "high"]);
  assert.equal(ReasoningConfirmation.parse({ requestedLevel: "max", nativeValue: "max", effectiveLevel: "max" }).effectiveLevel, "max");
  assert.equal(ModelInfo.parse({ id: "model", reasoningLevels: ["low", "standard", "high", "xhigh", "max"] }).reasoningLevels?.length, 5);
  const native = ["off", "none", "minimal", "low", "standard", "high", "xhigh", "max", "ultra", "auto", "adaptive", "ultracode", "native-next"];
  assert.deepEqual(ModelInfo.parse({ id: "model", reasoningLevels: native }).reasoningLevels, native);
  for (const level of native) {
    assert.equal(TurnReasoning.parse({ level }).level, level);
    assert.equal(nativeReasoning(level), level === "standard" ? "medium" : level);
    assert.equal(ReasoningConfirmation.parse({ requestedLevel: level, nativeValue: nativeReasoning(level), effectiveLevel: level }).effectiveLevel, level);
  }
  for (const invalid of ["", " high", "HIGH", "high\n", "--help", "high;cmd", "x".repeat(65)]) {
    assert.equal(TurnReasoning.safeParse({ level: invalid }).success, false);
  }
  assert.equal(ModelInfo.safeParse({ id: "model", reasoningLevels: ["low", "low"] }).success, false);
});

test("Pi native maps advertise advanced effort only for the exact supporting model", () => {
  assert.deepEqual(models.map(model => piModelReasoningLevels(model)), [["off", "minimal", "low", "standard", "high"], ["off", "minimal", "low", "standard", "high", "xhigh", "max"], ["off", "minimal", "high"], ["off"]]);
  assert.equal(piModelReasoningLevels({ reasoning: true, thinkingLevelMap: { max: 123 } }), undefined);
  assert.equal(piModelReasoningLevels({}), undefined);
  assert.deepEqual(piModelReasoningLevels({ reasoning: true, thinkingLevelMap: { xhigh: "", max: "" } }), ["off", "minimal", "low", "standard", "high", "xhigh", "max"]);
  assert.deepEqual(piModelReasoningLevels({ reasoning: true, thinkingLevelMap: { off: null, minimal: null } }), ["low", "standard", "high"]);
  const parsed = parsePiNativeModels({ models: [{ ...models[1], headers: { Authorization: "synthetic-not-a-secret" } }] });
  assert.deepEqual(parsed[0]?.reasoningLevels, ["off", "minimal", "low", "standard", "high", "xhigh", "max"]);
  assert.equal("headers" in parsed[0]!, false);
});

test("Hermes derives CLI-accepted levels from its native help without adding unrelated options", () => {
  const help = "  --reasoning LEVEL     Reasoning effort for this session: none, minimal, low,\n                        medium, high, xhigh, max, or ultra. Overrides\n                        agent.reasoning_effort for this run only.\n  --max-turns N         Maximum turns\n";
  assert.deepEqual(parseHermesReasoningLevels(help), ["none", "minimal", "low", "standard", "high", "xhigh", "max", "ultra"]);
  assert.deepEqual(parseHermesReasoningLevels("  --reasoning LEVEL     Choose low, medium, high\n  --max-turns N\n"), ["low", "standard", "high"]);
  assert.equal(parseHermesReasoningLevels("--reasoning LEVEL\n--max-turns N"), undefined);
});

test("Codex native camel-case efforts survive normalization without merging different model IDs", () => {
  const result = parseCodexNativeModels({ data: [{ id: "alias", model: "actual", supportedReasoningEfforts: [{ reasoningEffort: "medium" }, { reasoningEffort: "max" }], apiKey: "synthetic" }], nextCursor: null });
  assert.deepEqual(result.models, [{ id: "actual", available: true, reasoningLevels: ["standard", "max"] }]);
  assert.throws(() => parseCodexNativeModels({ data: [{ id: "model" }, { id: "model" }] }));
  assert.throws(() => parsePiNativeModels({ models: [models[0], models[0]] }));
});

test("Codex metadata paginates on one owned process without starting a task", { skip: process.platform === "win32" }, () => withPeerFixture("codex-models", async scope => {
  const f = setup(scope.root, { pages: { first: { data: [{ id: "one", supportedReasoningEfforts: ["high"] }], nextCursor: "second" }, second: { data: [{ id: "two", supportedReasoningEfforts: ["max"] }], nextCursor: null } } });
  const result = await discoverCodexNativeModels({ bin: f.bin, args: [], env: process.env, onRuntime: runtime => scope.watch(runtime.child, true) });
  assert.deepEqual(result.map(model => [model.id, model.reasoningLevels]), [["one", ["high"]], ["two", ["max"]]]);
  assert.deepEqual(f.queries().map(row => row.query.method), ["initialize", "initialized", "model/list", "model/list"]);
}));

test("Codex rejects a nonadvancing native catalog cursor and releases its process", { skip: process.platform === "win32" }, () => withPeerFixture("codex-model-cursor", async scope => {
  const f = setup(scope.root, { pages: { first: { data: [], nextCursor: "repeat" }, repeat: { data: [], nextCursor: "repeat" } } });
  await assert.rejects(discoverCodexNativeModels({ bin: f.bin, args: [], env: process.env, onRuntime: runtime => scope.watch(runtime.child, true) }), /cursor did not advance/);
}));

test("compatible model IDs do not erase current native Codex reasoning metadata", { skip: process.platform === "win32" }, () => withPeerFixture("codex-compatible-effort", async scope => {
  const f = setup(scope.root), home = join(scope.root, "codex"); mkdirSync(home);
  const server = createServer((_request, reply) => { reply.setHeader("Content-Type", "application/json"); reply.end(JSON.stringify({ data: [{ id: "model" }, { id: "unknown" }] })); });
  scope.defer(() => closePeerServer(server));
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = "http://127.0.0.1:" + (server.address() as { port: number }).port;
  const adapter = new CodexAdapter({ env: { binPath: f.bin, codexHome: home, defaultModel: "model", baseUrl, apiKey: "synthetic", providerId: "fixture" } });
  const result = (await adapter.discoverAgents())[0]!;
  assert.deepEqual(result.models[0]?.reasoningLevels, ["low", "standard", "high", "xhigh", "max"]);
  assert.equal(result.models[1]?.reasoningLevels, undefined);
  assert(f.queries().every(row => row.args.includes("model_provider=fixture")));
}));

test("Pi metadata discovery has no prompt or persistent session and keeps model identities", { skip: process.platform === "win32" }, () => withPeerFixture("pi-models", async scope => {
  const f = setup(scope.root);
  const result = await discoverPiNativeModels({ bin: f.bin, env: process.env, onRuntime: runtime => scope.watch(runtime.child, true) });
  assert.equal(result.selectedID, "fixture/ordinary");
  assert.deepEqual(result.models[1]?.reasoningLevels, ["off", "minimal", "low", "standard", "high", "xhigh", "max"]);
  assert.deepEqual(f.queries().map(row => row.query.type), ["get_available_models", "get_state"]);
  assert(f.queries().every(row => row.args.includes("--no-session") && row.args.includes("--no-context-files") && row.args.includes("--no-extensions")));
}));

test("Codex quoted provider configuration beats an incomplete invocation override", { skip: process.platform === "win32" }, () => withPeerFixture("codex-model-provider", async scope => {
  const f = setup(scope.root), home = join(scope.root, "codex"); mkdirSync(home);
  let foreignReads = 0;
  const configured = createServer((_request, reply) => { reply.setHeader("Content-Type", "application/json"); reply.end(JSON.stringify({ data: [{ id: "model" }, { id: "native-config-only" }] })); });
  const foreign = createServer((_request, reply) => { foreignReads++; reply.end(JSON.stringify({ data: [{ id: "foreign" }] })); });
  scope.defer(() => closePeerServer(configured)); scope.defer(() => closePeerServer(foreign));
  await new Promise<void>(resolve => configured.listen(0, "127.0.0.1", resolve));
  await new Promise<void>(resolve => foreign.listen(0, "127.0.0.1", resolve));
  const url = (server: typeof configured) => "http://127.0.0.1:" + (server.address() as { port: number }).port;
  writeFileSync(join(home, "config.toml"), 'model = "model"\nmodel_provider = "fixture.custom"\n[model_providers."fixture.custom"]\nbase_url = ' + JSON.stringify(url(configured)) + '\n[profiles.unselected]\nmodel = "other"\n', { mode: 0o600 });
  const adapter = new CodexAdapter({ env: { binPath: f.bin, codexHome: home, defaultModel: "default", baseUrl: url(foreign) } });
  const result = (await adapter.discoverAgents())[0]!;
  assert.deepEqual(result.models.map(model => model.id), ["model", "native-config-only"]);
  assert.equal(foreignReads, 0);
  assert.deepEqual(result.models[0]?.reasoningLevels, ["low", "standard", "high", "xhigh", "max"]);
  const aliased = new CodexAdapter({ env: { binPath: f.bin, codexHome: home, defaultModel: "default", models: [{ id: "default", available: true }] } });
  assert.deepEqual((await aliased.discoverAgents())[0]?.models[0], { id: "default", available: true, reasoningLevels: ["low", "standard", "high", "xhigh", "max"] });
}));

test("Pi catalog enriches its native selected alias without mutating owner model configuration", { skip: process.platform === "win32" }, () => withPeerFixture("pi-model-alias", async scope => {
  const f = setup(scope.root), explicit = [{ id: "ordinary", available: true }];
  const adapter = new PiAdapter({ env: { binPath: f.bin, defaultModel: "ordinary", models: explicit } });
  const result = (await adapter.discoverAgents())[0]!;
  assert.deepEqual(result.models[0]?.reasoningLevels, ["off", "minimal", "low", "standard", "high"]);
  assert.deepEqual(explicit, [{ id: "ordinary", available: true }]);
}));

test("an unavailable native metadata response is not native stop evidence", { skip: process.platform === "win32" }, () => withPeerFixture("metadata-timeout", async scope => {
  const f = setup(scope.root, { hang: true });
  let runtime: import("../process-supervisor.js").ProcessSupervisor | undefined;
  const channel = new DiscoveryRPC(f.bin, [], { timeoutMs: 80, onRuntime: value => { runtime = value; scope.watch(value.child, true); } });
  try { await assert.rejects(channel.request({ method: "model/list" }), /timed out/); }
  finally { await channel.close(); }
  assert.equal(runtime?.hasStopped(), true);
}));
