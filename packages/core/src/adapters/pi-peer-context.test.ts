import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { PeerContextJournal, PeerContextReceiver } from "../peer-context.js";
import { PeerContextBridge } from "../peer-context-bridge.js";
import { preparePiNativeTools } from "./pi-native-tools.js";
import type { SendOptions } from "../adapter.js";
import { withPeerFixture, closePeerServer } from "../testing/peer-fixture.js";
import { spawnSupervisedAgent } from "../process-supervisor.js";
import { PiAdapter } from "./pi.js";

async function fixture(work: (f: any) => Promise<void>, prepareAsset = true) {
  return withPeerFixture("pi-peer",async scope=>{
  const root = scope.root, previous = process.env.PHONON_STATE_DIR;
  process.env.PHONON_STATE_DIR = root;
  scope.defer(()=>{if(previous===undefined)delete process.env.PHONON_STATE_DIR;else process.env.PHONON_STATE_DIR=previous;});
  const journal = new PeerContextJournal(join(root, "peer.sqlite")), nativeSessionId = randomUUID();
  scope.defer(()=>journal.close());
  const self = { id: randomUUID(), position: "1", projectId: randomUUID(), ownerId: "owner", deviceId: randomUUID(), agentId: "pi",
    agentKind: "agent" as const, sourceKind: "native" as const, sessionId: "owned", label: "worker", activity: { summary: "", phase: "working" as const, impact: [], dependencies: "" },
    activityRevision: 0, lastSeenAt: null, presence: "active" as const };
  const message = { id: randomUUID(), position: "2", senderId: randomUUID(), recipientId: self.id, kind: "notice" as const,
    text: "PEER_UNPREDICTABLE_" + randomUUID(), references: [], inReplyTo: null, depth: 0, createdAt: null, expiresAt: null, state: "stored" as const, receivedAt: null };
  const state = { pending: false, active: true, inbox: 0,budgets:[] as any[] };
  const receiver = new PeerContextReceiver({ tenantId: "tenant", sessionId: "owned", turnId: "turn", runId: randomUUID(), nativeSessionId, journal,
    active: () => scope.active&&state.active, coordinate: async input => { assert.equal(input.operation, "inbox"); state.inbox++; return { self, messages: state.pending ? [message] : [], next: null }; } });
  const bridge = new PeerContextBridge({prepare:(boundary,signal)=>{state.budgets.push(boundary.budget);return receiver.prepare(boundary,signal);},observe:value=>receiver.observe(value)});scope.defer(()=>bridge.close());const environment=await bridge.listen();
  const options = { turnId: "turn", verbosity: "trace", emit: () => {}, peerContext: receiver, environment } as SendOptions;
  const asset = prepareAsset ? preparePiNativeTools(options)! : undefined;
  if(asset)scope.defer(()=>asset.cleanup());
  await work({scope,root,journal,nativeSessionId,message,state,receiver,environment,asset});
  });
}

test("Pi uses the same Phonon extension for peer checkpoints without requiring HITL or model tools", () => fixture(async f => {
  const values = { ...f.environment, AGENT_PHONON_PI_NATIVE_NONCE: f.asset.nonce, AGENT_PHONON_MCP_URL: "" };
  const previous = new Map(Object.keys(values).map(key => [key, process.env[key]]));
  const handlers = new Map<string, Array<(...args: any[]) => any>>();
  const pi = {getAllTools:()=>[],getActiveTools:()=>[], on: (name: string, fn: (...args: any[]) => any) => handlers.set(name, [...handlers.get(name) ?? [], fn]) };
  const call = async (name: string, event: any) => { let result; for (const fn of handlers.get(name) ?? []) result = await fn(event, {
    model:{contextWindow:32000,maxTokens:2000},getContextUsage:()=>({tokens:100,contextWindow:32000}),getSystemPrompt:()=>"Original system",
    sessionManager: { getSessionId: () => f.nativeSessionId } }); return result; };
  try {
    Object.assign(process.env, values);
    await (await import(pathToFileURL(f.asset.path).href)).default(pi);
    assert.equal(process.env.AGENT_PHONON_PEER_CONTEXT_TOKEN,undefined);
    assert.equal(handlers.has("context"), true);
    const messages = [{ role: "user", content: "Original authorized task" }];
    assert.equal(await call("context", { messages }), undefined);
    f.state.pending = true;
    const result = await call("context", { messages });
    assert.equal(messages.length, 1); assert.equal(result.messages.length, 2);
    const peer = result.messages[1]; assert.equal(peer.role, "custom"); assert.equal(peer.customType, "phonon.peer"); assert.equal(peer.display, false);
    assert.ok(peer.content.includes(f.message.text));
    await call("before_provider_request", { payload: { messages: [{ role: "user", content: peer.content }] } });
    assert.equal(f.journal.records("tenant", "owned")[0].state, "provider_payload");
    assert.equal(await call("context", { messages }), undefined);
    assert.equal(readFileSync(f.asset.path, "utf8").includes(f.environment.AGENT_PHONON_PEER_CONTEXT_TOKEN), false);
  } finally {
    for (const [key, value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
}));

for (const phase of ["retry", "exhausted", "cancel-backoff", "overflow-compaction"] as const) {
  test(`installed Pi adapter ${phase} preserves original native recovery and honest peer evidence`, {
    skip: !process.env.PHONON_TEST_PI_BIN || process.platform === "win32", timeout: 30000,
  }, () => fixture(async f => {
    const home = join(f.root, "home"), piHome = join(home, ".pi", "agent"), model = "phonon-fixture/m1";
    mkdirSync(piHome, { recursive: true });
    writeFileSync(join(f.root, "input.txt"), "Original native read\n");
    const environment = { HOME: home, PI_CODING_AGENT_DIR: piHome, PI_OFFLINE: "1", PI_TELEMETRY: "0",
      PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ""}` };
    const previous = new Map([...Object.keys(environment), "PI_CODING_AGENT_SESSION_DIR", "PI_CODING_AGENT_HOME"].map(key => [key, process.env[key]]));
    f.scope.defer(() => { for (const [key, value] of previous) if (value === undefined) delete process.env[key]; else process.env[key] = value; });
    Object.assign(process.env, environment);
    delete process.env.PI_CODING_AGENT_SESSION_DIR; delete process.env.PI_CODING_AGENT_HOME;
    writeFileSync(join(piHome, "settings.json"), JSON.stringify({ quietStartup: true,
      compaction: { enabled: phase === "overflow-compaction", reserveTokens: 1024, keepRecentTokens: 64 },
      retry: { enabled: true, maxRetries: 1, baseDelayMs: phase === "cancel-backoff" ? 5000 : 10, provider: { maxRetries: 0 } },
      projectTrust: { trustedDirectories: [f.root] } }), { mode: 0o600 });
    const requests: any[] = [], errors: unknown[] = [], nativeEvents: any[] = [], pids: number[] = [];
    let session: any, sending: Promise<void> | undefined, warming = phase === "overflow-compaction", failed = false, compacted = false, resuming = false;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000); f.scope.defer(() => clearTimeout(timer));
    const provider = createServer((req, res) => { void (async () => {
      let body = ""; for await (const chunk of req) body += String(chunk);
      const payload = JSON.parse(body); requests.push(payload); pids.push(session.current.pid);
      assert.ok(requests.length <= 6, "native retry/compaction must remain bounded");
      if (!warming && !failed) {
        failed = true;
        assert.equal(body.includes(f.message.text), phase === "exhausted");
        f.state.pending = true;
        res.writeHead(phase === "overflow-compaction" ? 400 : 500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: phase === "overflow-compaction"
          ? "maximum context length exceeded" : "server error: temporarily overloaded", type: "server_error" } }));
        return;
      }
      if (phase === "exhausted" && !resuming) {
        assert.equal(body.includes(f.message.text), false, "uncertain offered mail is not automatically replayed on a native retry");
        res.writeHead(500, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: { message: "server error: still overloaded" } }));
        return;
      }
      if (phase === "overflow-compaction" && !warming && !compacted) {
        compacted = true;
        assert.equal(body.includes(f.message.text), false, "peer mail is not offered to the independent summary request");
        assert.ok(body.includes("<conversation>"), "the native compactor must actually call its summary provider");
        assert.deepEqual(f.journal.records("tenant", "owned"), []);
      } else if (!warming && !resuming) {
        assert.equal(body.includes(f.message.text), phase !== "overflow-compaction" || requests.length === 5,
          "post-compaction unknown headroom defers mail until fresh original-root usage exists");
      }
      if (resuming) assert.equal(body.includes(f.message.text), false, "a later assigned continuation does not replay old peer mail");
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const send = (delta: unknown, finish_reason: string | null) => res.write("data: " + JSON.stringify({ id: "controlled-" + requests.length,
        object: "chat.completion.chunk", created: 1, model: "m1", choices: [{ index: 0, delta, finish_reason }] }) + "\n\n");
      if (phase === "overflow-compaction" && requests.length === 4) {
        send({ role: "assistant", tool_calls: [{ index: 0, id: "original-post-compact-read", type: "function",
          function: { name: "read", arguments: JSON.stringify({ path: join(f.root, "input.txt") }) } }] }, null);
        send({}, "tool_calls");
      } else {
        send({ role: "assistant", content: resuming ? "Original native continued after recovery" : warming ? "Original history ".repeat(200) : requests.length === 3 && phase === "overflow-compaction"
          ? "Original task summary; continue its pending read." : "Original native recovery complete" }, null);
        send({}, "stop");
      }
      res.write("data: " + JSON.stringify({ id: "controlled-" + requests.length, object: "chat.completion.chunk", created: 1, model: "m1", choices: [],
        usage: { prompt_tokens: 100, completion_tokens: warming ? 1000 : 20, total_tokens: warming ? 1100 : 120 } }) + "\n\n");
      res.end("data: [DONE]\n\n");
    })().catch(error => { errors.push(error); controller.abort(); res.destroy(); }); });
    f.scope.defer(() => closePeerServer(provider)); await new Promise<void>(resolve => provider.listen(0, "127.0.0.1", resolve));
    writeFileSync(join(piHome, "models.json"), JSON.stringify({ providers: { "phonon-fixture": {
      baseUrl: `http://127.0.0.1:${(provider.address() as { port: number }).port}/v1`, apiKey: "synthetic-provider-key", api: "openai-completions",
      models: [{ id: "m1", name: "Controlled native recovery", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 32000, maxTokens: 2000 }] } } }), { mode: 0o600 });
    const adapter = new PiAdapter({ env: { binPath: process.env.PHONON_TEST_PI_BIN!, defaultModel: model } });
    session = await adapter.createSession({ sessionId: f.nativeSessionId, agentId: "pi", model, cwd: f.root });
    f.scope.defer(async () => { f.state.active = false; controller.abort(); await session.terminate(); await sending; });
    let checkpoint: any;
    if (warming) {
      const warmEvents: any[] = [];
      sending = session.send("Prepare original native history.", { turnId: "warmup", verbosity: "tools", signal: controller.signal, emit: (event: any) => warmEvents.push(event) });
      f.scope.watch(session.current); await sending;
      assert.equal(warmEvents.at(-1)?.status, "completed"); checkpoint = session.recoveryCheckpoint(); assert.ok(checkpoint); warming = false;
    }
    const events: any[] = [];
    f.state.pending = phase === "exhausted";
    sending = session.send("Continue the original authorized task.", { turnId: "turn", verbosity: "tools", signal: controller.signal,
      peerContext: f.receiver, environment: f.environment, emit: (event: any) => events.push(event) });
    const child = session.current; assert.ok(child); f.scope.watch(child);
    let carry = "";
    const observe = (chunk: Buffer) => {
      carry += String(chunk); if (carry.length > 512000) { controller.abort(); return; }
      let end;
      while ((end = carry.indexOf("\n")) >= 0) {
        const line = carry.slice(0, end); carry = carry.slice(end + 1);
        try { const value = JSON.parse(line); nativeEvents.push(value);
          if (value.type === "auto_retry_start" && phase === "cancel-backoff") controller.abort();
        } catch {}
      }
    };
    child.stdout.on("data", observe); f.scope.defer(() => child.stdout.off("data", observe));
    await sending;
    assert.deepEqual(errors, []); assert.equal(events.filter(event => event.final).length, 1);
    assert.equal(events.at(-1)?.status, phase === "exhausted" ? "failed" : phase === "cancel-backoff" ? "interrupted" : "completed",
      JSON.stringify({ events, requests: requests.length, nativeEvents: nativeEvents.map(value => value.type) }));
    assert.equal(requests.length, phase === "cancel-backoff" ? 1 : phase === "overflow-compaction" ? 5 : 2);
    assert.equal(new Set(pids.slice(phase === "overflow-compaction" ? 1 : 0)).size, 1, "native recovery must retain its original RPC process");
    assert.equal(JSON.stringify(events).includes(f.message.text), false);
    const records = f.journal.records("tenant", "owned");
    assert.deepEqual(records.map((value: any) => ({ id: value.messageId, state: value.state })), phase === "cancel-backoff" ? []
      : [{ id: f.message.id, state: "provider_payload" }]);
    if (phase !== "exhausted" && phase !== "cancel-backoff") {
      assert.equal(events.at(-1)?.text, "Original native recovery complete");
      const saved = session.recoveryCheckpoint(); assert.ok(saved);
      if (checkpoint) assert.equal(saved.native.path, checkpoint.native.path);
      assert.equal(readFileSync(saved.native.path, "utf8").includes(f.message.text), false, "ephemeral peer mail must not persist into native summary/history");
      const beforeRecovery=requests.length,nativeBytes=readFileSync(saved.native.path);
      await session.terminate();
      session=await adapter.recoverSession({sessionId:f.nativeSessionId,agentId:"pi",model,cwd:f.root},saved);
      assert.equal(requests.length,beforeRecovery,"native recovery is observational, with no model request");
      assert.deepEqual(readFileSync(saved.native.path),nativeBytes,"native recovery cannot repair or rewrite history");
      resuming = true;
      const continued: any[] = [];
      sending = session.send("Continue after the recovered run.", { turnId: "continuation", verbosity: "tools", signal: controller.signal,
        emit: (event: any) => continued.push(event) });
      f.scope.watch(session.current); await sending;
      assert.equal(continued.at(-1)?.status, "completed");
      assert.equal(continued.at(-1)?.text, "Original native continued after recovery");
      assert.equal(session.recoveryCheckpoint()?.native.path, saved.native.path);
      assert.equal(session.recoveryCheckpoint()?.native.sessionId, saved.native.sessionId);
      const rows=readFileSync(saved.native.path,"utf8").trim().split("\n").map((line:string)=>JSON.parse(line));
      assert.ok(rows.some((row:any)=>row.message?.stopReason==="error"),"native failed-attempt history must stay intact after continuation");
    } else {
      const file=nativeEvents.find(value=>value.type==="response"&&value.command==="get_state")?.data?.sessionFile;
      assert.ok(file);const nativeBytes=readFileSync(file),beforeContinuation=requests.length;
      const saved=session.recoveryCheckpoint();assert.ok(saved);
      assert.equal(saved.native.path,file);assert.equal(saved.native.sessionId,f.nativeSessionId);
      assert.equal(saved.native.continuation,true);
      await session.terminate();
      session=await adapter.recoverSession({sessionId:f.nativeSessionId,agentId:"pi",model,cwd:f.root},saved);
      assert.equal(requests.length,beforeContinuation,"observing failed history must not replay the provider");
      assert.deepEqual(readFileSync(file),nativeBytes,"failed native history must not be repaired or rolled back");
      clearTimeout(timer);resuming=true;const continued:any[]=[];
      sending=session.send("Explicitly continue the original native session.",{turnId:"assigned-continuation",verbosity:"tools",signal:AbortSignal.timeout(15000),emit:(event:any)=>continued.push(event)});
      f.scope.watch(session.current);await sending;
      assert.equal(continued.at(-1)?.status,"completed");
      assert.equal(requests.length,beforeContinuation+1);
      assert.equal(session.recoveryCheckpoint()?.native.sessionId,saved.native.sessionId);
      assert.equal(session.recoveryCheckpoint()?.native.path,file);
      assert.deepEqual(readFileSync(file).subarray(0,nativeBytes.length),nativeBytes,"explicit continuation must preserve the complete failed prefix");
      assert.equal(events.at(-1)?.status,phase==="exhausted"?"failed":"interrupted","later assigned work cannot change the original outcome");
    }
    if (phase === "overflow-compaction") {
      assert.equal(compacted, true); assert.ok(f.state.budgets.some((budget: any) => budget?.state === "unknown"));
      assert.ok(nativeEvents.some(value => value.type === "compaction_end" && value.willRetry));
      assert.equal(events.filter(event => event.type === "tool_call").length, 1);
    } else assert.ok(nativeEvents.some(value => value.type === "auto_retry_start"));
    clearTimeout(timer);
  }, false));
}

test("Pi native headroom defers unknown/near-full context and recovers at a later qualified boundary",()=>fixture(async f=>{
  const values={...f.environment,AGENT_PHONON_PI_NATIVE_NONCE:f.asset.nonce},previous=new Map(Object.keys(values).map(key=>[key,process.env[key]]));
  const handlers=new Map<string,any>(),model={contextWindow:32000,maxTokens:2000};let tokens:number|null=null,system="system";
  const ctx={model,getContextUsage:()=>({tokens,contextWindow:model.contextWindow}),getSystemPrompt:()=>system,sessionManager:{getSessionId:()=>f.nativeSessionId}};
  const pi={on:(name:string,handler:any)=>handlers.set(name,handler),getAllTools:()=>[],getActiveTools:()=>[]};
  try{
    Object.assign(process.env,values);await(await import(pathToFileURL(f.asset.path).href)).default(pi);f.state.pending=true;
    const context=()=>handlers.get("context")({messages:[{role:"user",content:"Original task"}]},ctx);
    assert.equal(await context(),undefined);assert.equal(f.journal.records("tenant","owned").length,0);
    tokens=31000;assert.equal(await context(),undefined);assert.equal(f.journal.records("tenant","owned").length,0);
    tokens=100;system="s".repeat(31000);assert.equal(await context(),undefined);
    system="system";model.maxTokens=32000;assert.equal(await context(),undefined);model.maxTokens=2000;
    const all=pi.getAllTools;pi.getAllTools=()=>{throw new Error("native tools unavailable");};assert.equal(await context(),undefined);pi.getAllTools=all;
    system="system";const result=await context();assert.equal(result.messages.length,2);assert.ok(result.messages[1].content.includes(f.message.text));
    await handlers.get("before_provider_request")({payload:{messages:result.messages}},ctx);
    assert.equal(f.journal.records("tenant","owned")[0]?.state,"provider_payload");
  }finally{for(const[key,value]of previous){if(value===undefined)delete process.env[key];else process.env[key]=value;}}
}));

for(const constrained of [false,true])test(constrained?"installed Pi preserves pending mail when native usage leaves no headroom":"installed Pi receives peer data in a subsequent provider request of the same execution without polling tools", {
  skip: !process.env.PHONON_TEST_PI_BIN, timeout: 25000,
}, () => fixture(async f => {
  const payloads: any[] = [], errors: unknown[] = [];
  const provider = createServer((req, res) => {
    void (async () => {
      let body = ""; for await (const chunk of req) body += String(chunk);
      const payload = JSON.parse(body); payloads.push(payload);
      if (payloads.length > 2) { res.writeHead(500).end(); return; }
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const send = (delta: unknown, finish_reason: string | null) => res.write("data: " + JSON.stringify({ id: "controlled", object: "chat.completion.chunk", created: 1,
        model: "m1", choices: [{ index: 0, delta, finish_reason }] }) + "\n\n");
      if (payloads.length === 1) {
        assert.equal(body.includes(f.message.text), false);
        f.state.pending = true;
        send({ role: "assistant", tool_calls: [{ index: 0, id: "tool-boundary", type: "function", function: { name: "bash", arguments: JSON.stringify({ command: "printf peer-boundary" }) } }] }, null);
        send({}, "tool_calls");
      } else {
        assert.equal(body.includes(f.message.text),!constrained,"native headroom determines whether peer mail can enter the next actual request");
        send({ role: "assistant", content: "Original task finished" }, null); send({}, "stop");
      }
      res.write("data: "+JSON.stringify({id:"controlled",object:"chat.completion.chunk",created:1,model:"m1",choices:[],usage:{prompt_tokens:constrained?31000:100,completion_tokens:20,total_tokens:constrained?31020:120}})+"\n\n");
      res.end("data: [DONE]\n\n");
    })().catch(error => { errors.push(error); res.destroy(); });
  });
  f.scope.defer(()=>closePeerServer(provider));
  await new Promise<void>(resolve => provider.listen(0, "127.0.0.1", resolve));
  const port = (provider.address() as { port: number }).port;
  const home = join(f.root, "home"), piHome = join(home, ".pi", "agent"), extension = join(f.root, "provider.mjs");
  mkdirSync(piHome, { recursive: true });
  writeFileSync(join(piHome,"settings.json"),JSON.stringify({compaction:{enabled:false}}),{mode:0o600});
  writeFileSync(extension, `export default function(pi){pi.registerProvider("phonon-fixture",{baseUrl:"http://127.0.0.1:${port}/v1",apiKey:"controlled-local-provider",api:"openai-completions",models:[{id:"m1",name:"Controlled local response",reasoning:false,input:["text"],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:32000,maxTokens:2000}]});}`, { mode: 0o600 });
  const native = spawnSupervisedAgent(process.execPath, [process.env.PHONON_TEST_PI_BIN!, "--mode", "json", "--session-id", f.nativeSessionId,
    "--no-extensions", "--no-skills", "--extension", extension, "--extension", f.asset.path, "--model", "phonon-fixture/m1"],
  { cwd: f.root, env: { PATH: process.env.PATH, HOME: home, TMPDIR:f.root, TMP:f.root, TEMP:f.root, PI_CODING_AGENT_DIR: piHome, ...f.environment,
    AGENT_PHONON_PI_NATIVE_NONCE: f.asset.nonce }, stdio: ["pipe", "pipe", "pipe"] });
  const child=native.child;f.scope.watch(child,true);f.scope.defer(()=>native.terminate());
  let output = "", stderr = "";
  child.stdout.on("data", chunk => { output += String(chunk); }); child.stderr.on("data", chunk => { stderr += String(chunk); });
  const closed = new Promise<number | null>((resolve, reject) => { child.once("close", resolve); child.once("error", reject); });
  const timer = setTimeout(() => child.kill("SIGKILL"), 20000);
  try {
    child.stdin.end("Run printf once, then finish the original task.");
    assert.equal(await closed, 0, stderr);
    assert.deepEqual(errors, []); assert.equal(payloads.length, 2, stderr);
    assert.ok(f.state.inbox >= 2);
    assert.equal(f.journal.records("tenant", "owned")[0]?.state, constrained?undefined:"provider_payload");
    assert.ok(f.state.budgets.every((budget:any)=>budget?.state==="known"),"actual native context APIs must supply the budget");
    assert.ok(f.state.budgets.at(-1).inputTokens>=(constrained?31000:100));
    assert.equal(output.includes(f.message.text), false, "runtime-only peer data must not become a human transcript event");
    assert.ok(output.includes("Original task finished"));
  } finally {
    clearTimeout(timer); child.kill("SIGTERM"); await closed;
    provider.closeAllConnections(); await new Promise<void>(resolve => provider.close(() => resolve()));
  }
}));
