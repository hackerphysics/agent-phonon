import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { PiAdapter, parsePiEvent } from "./pi.js";
import { verifyPiSession } from "./pi-recovery.js";
import { withPeerFixture } from "../testing/peer-fixture.js";
import { AdapterRegistry, SessionEngine } from "../session-engine.js";
import { PhononStore } from "../store.js";

const cli = String.raw`
import fs from 'node:fs';import path from 'node:path';import {pathToFileURL} from 'node:url';
const args=process.argv.slice(2),home=process.env.PI_CODING_AGENT_DIR;
const mode=JSON.parse(fs.readFileSync(path.join(home,'control.json'),'utf8')).mode;
if(mode==='probe-failure')process.exit(1);
if(args.includes('--help')){console.log('--mode text, json, rpc --session <path> --session-id <id> --extension <path>');process.exit(0);}
if(args.includes('--version')){console.log('0.84.1');process.exit(0);}
if(args.includes('--list-models')){console.log('fixture  m1  1M  16K  yes  text');process.exit(0);}
if(mode==='startup-failure')process.exit(1);
const timestamp='2026-10-24T00:00:00.000Z',cwd=process.cwd();
const directory=path.join(home,'sessions','--'+cwd.replace(/^[/\\]/,'').replace(/[/\\:]/g,'-')+'--');
fs.mkdirSync(directory,{recursive:true,mode:0o700});
const resumed=args.includes('--session'),id=args[args.indexOf('--session-id')+1];
const file=resumed?args[args.indexOf('--session')+1]:path.join(directory,timestamp.replace(/[:.]/g,'-')+'_'+id+'.jsonl');
let rows=resumed?fs.readFileSync(file,'utf8').trim().split('\n').map(JSON.parse):[{type:'session',version:3,id,timestamp,cwd}];
const append=(type,extra)=>{rows.push({type,id:'entry-'+rows.length,parentId:rows.length===1?null:rows.at(-1).id,timestamp,...extra});fs.writeFileSync(file,rows.map(r=>JSON.stringify(r)).join('\n')+'\n',{mode:0o600});};
if(!resumed)append('model_change',{provider:'fixture',modelId:'m1'});
const handlers=new Map(),pi={on:(event,fn)=>handlers.set(event,[...(handlers.get(event)||[]),fn])};
for(let i=0;i<args.length;i++)if(args[i]==='--extension'&&args[i+1].endsWith('guard.mjs'))(await import(pathToFileURL(args[++i]).href)).default(pi);
const context={cwd,model:{provider:'fixture',id:'m1'},sessionManager:{getSessionId:()=>rows[0].id,getSessionFile:()=>file,getHeader:()=>rows[0],getEntries:()=>rows.slice(1)}};
const fire=async event=>{for(const fn of handlers.get(event)||[])await fn({type:event},context);};
await fire('session_start');
const emit=event=>console.log(JSON.stringify(event));
const response=(command,data)=>emit({type:'response',id:command.id,command:command.type,success:true,data});
const assistant=(stopReason,content=[],extra={})=>{const message={role:'assistant',provider:'fixture',model:'m1',stopReason,content,...extra};append('message',{message});emit({type:'message_end',message});};
let carry='';for await(const chunk of process.stdin){carry+=chunk;let end;
 while((end=carry.indexOf('\n'))>=0){const line=carry.slice(0,end);carry=carry.slice(end+1);if(!line)continue;const command=JSON.parse(line);
  if(command.type==='get_state')response(command,{sessionId:rows[0].id,sessionFile:file,model:context.model,isStreaming:false,isCompacting:false,pendingMessageCount:0});
  else if(command.type==='get_usage')response(command,{});
  else if(command.type==='prompt'){
   if(mode==='prompt-rejected'){emit({type:'response',id:command.id,command:command.type,success:false,error:'original prompt rejected'});process.exit(0);}
   await fire('input');await fire('before_agent_start');if(mode!=='ack-after-user')response(command);
   const message={role:'user',content:[{type:'text',text:command.message}]};append('message',{message});
   fs.appendFileSync(path.join(home,'inputs.jsonl'),JSON.stringify({id:rows[0].id,file,input:command.message})+'\n');
   emit({type:'agent_start'});
   if(mode!=='missing-user')emit({type:'message_end',message:mode==='different-user'?{...message,content:[{type:'text',text:'not the original input'}]}:message});
   if(mode==='ack-after-user')response(command);
   if(mode==='user-tail')process.exit(1);
   if(mode==='pending-tool'){
    assistant('toolUse',[{type:'toolCall',id:'unreturned',name:'bash',arguments:{command:'original work'}}]);
    emit({type:'tool_execution_start',toolCallId:'unreturned',toolName:'bash',args:{command:'original work'}});
   }else{
    if(mode==='error'){
     const errorMessage='403: AccessDenied.Unpurchased request_id=test-original Bearer synthetic-secret-not-real';
     emit({type:'message_update',assistantMessageEvent:{type:'error',error:{role:'assistant',errorMessage}}});
     assistant('error',[],{errorMessage});
    }else if(mode==='aborted')assistant('aborted');
    else{emit({type:'message_update',assistantMessageEvent:{type:'text_delta',delta:'new message received'}});assistant('stop',[{type:'text',text:'new message received'}]);}
    emit({type:'agent_settled',aborted:mode==='aborted'});
   }
  }
 }
}
`;

async function fixture(work: (f: {
  adapter: PiAdapter; bin: string; session: Awaited<ReturnType<PiAdapter["createSession"]>>;
  params: { sessionId: string; agentId: string; model: string; cwd: string };
  mode: (value: string) => void; inputs: () => Array<{ id: string; file: string; input: string }>;
  send: (input: string, target?: Awaited<ReturnType<PiAdapter["createSession"]>>) => Promise<any[]>;
}) => Promise<void>) {
  await withPeerFixture("pi-continuation", async scope => {
    const home = join(scope.root, "pi"), bin = join(scope.root, "pi.mjs");
    mkdirSync(home, { mode: 0o700 });
    writeFileSync(bin, "#!" + process.execPath + "\n" + cli, { mode: 0o700 });
    const previous = new Map(["PI_CODING_AGENT_DIR", "PI_CODING_AGENT_SESSION_DIR", "PI_CODING_AGENT_HOME"].map(key => [key, process.env[key]]));
    scope.defer(() => { for (const [key, value] of previous) if (value === undefined) delete process.env[key]; else process.env[key] = value; });
    process.env.PI_CODING_AGENT_DIR = home; delete process.env.PI_CODING_AGENT_SESSION_DIR; delete process.env.PI_CODING_AGENT_HOME;
    const mode = (value: string) => writeFileSync(join(home, "control.json"), JSON.stringify({ mode: value }), { mode: 0o600 });
    mode("good");
    const adapter = new PiAdapter({ env: { binPath: bin } });
    const params = { sessionId: randomUUID(), agentId: "pi", model: "fixture/m1", cwd: scope.root };
    const session = await adapter.createSession(params);
    const controller = new AbortController(), pending = new Set<Promise<unknown>>(), sessions = new Set([session]);
    const timer = setTimeout(() => controller.abort(), 10000); scope.defer(() => clearTimeout(timer));
    scope.defer(async () => { controller.abort(); await Promise.allSettled([...sessions].map(value => value.terminate())); await Promise.allSettled([...pending]); });
    const send = async (input: string, target = session) => {
      sessions.add(target);
      const events: any[] = [];
      const job = target.send(input, { turnId: randomUUID(), verbosity: "tools", signal: controller.signal, emit: event => events.push(event) });
      void job.catch(() => {});
      pending.add(job);
      const deadline = Date.now() + 2000;
      while (!(target as any).current && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
      scope.watch((target as any).current, true);
      try { await job; return events; } finally { pending.delete(job); }
    };
    const inputs = () => readFileSync(join(home, "inputs.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
    await work({ adapter, bin, session, params, mode, inputs, send });
  });
}

for (const mode of ["error", "user-tail", "aborted", "pending-tool"]) {
  test(`Pi delivers a new message in the same native conversation after ${mode}`, { skip: process.platform === "win32", timeout: 15000 }, () => fixture(async f => {
    f.mode(mode);
    const original = f.send("original request");
    if (mode === "pending-tool") {
      const deadline = Date.now() + 4000;
      while (!(f.session as any).current || !(f.session as any).rpcCurrent?.channel) {
        if (Date.now() > deadline) throw new Error("Pi did not start");
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      // Wait until the native file actually contains the unfinished tool.
      while (!f.session.recoveryCheckpoint!() && Date.now() < deadline) {
        try { if (readFileSync(f.inputs()[0]!.file, "utf8").includes('"unreturned"')) break; } catch {}
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      await f.session.interrupt!();
    }
    const events = await original;
    assert.equal(events.filter(event => event.source === "native_input_accepted").length, 1);
    assert.equal(events.at(-1).status, ["aborted", "pending-tool"].includes(mode) ? "interrupted" : "failed");
    if (mode === "error") {
      assert.match(events.at(-1).message, /403.*AccessDenied\.Unpurchased/);
      assert.doesNotMatch(events.at(-1).message, /synthetic-secret-not-real/);
    }
    const saved = f.session.recoveryCheckpoint!() as any;
    assert.ok(saved, "failure must not destroy the native continuation checkpoint");
    const before = readFileSync(saved.native.path);
    f.mode("good");
    assert.equal((await f.send("new request, not a replay")).at(-1).status, "completed");
    assert.deepEqual(f.inputs().map(row => row.input), ["original request", "new request, not a replay"]);
    assert.equal(new Set(f.inputs().map(row => row.id)).size, 1);
    assert.equal(new Set(f.inputs().map(row => row.file)).size, 1);
    assert.deepEqual(readFileSync(saved.native.path).subarray(0, before.length), before);
    assert.ok(f.session.recoveryCheckpoint!());
  }));
}

test("Pi can reattach a failed conversation without inference or rewriting its history", { skip: process.platform === "win32" }, () => fixture(async f => {
  f.mode("error"); await f.send("original request");
  const saved = f.session.recoveryCheckpoint!() as any, before = readFileSync(saved.native.path);
  const recovered = await f.adapter.recoverSession(f.params, saved);
  try {
    assert.deepEqual(recovered.recoveryCheckpoint!(), saved);
    assert.deepEqual(readFileSync(saved.native.path), before);
    assert.equal(f.inputs().length, 1);
  } finally { await recovered.terminate(); }
  writeFileSync(saved.native.path, Buffer.concat([before, Buffer.from("{}\n")]));
  assert.throws(() => verifyPiSession(saved.native, f.params.cwd));
  await assert.rejects(f.adapter.recoverSession(f.params, saved));
  assert.equal(f.inputs().length, 1);
}));

test("Pi recovers a legacy failed conversation from its original file, not a new session", { skip: process.platform === "win32" }, () => fixture(async f => {
  f.mode("error"); await f.send("legacy request");
  const original = f.session.recoveryCheckpoint!() as any, before = readFileSync(original.native.path);
  const observed = await f.adapter.observeSessionCheckpoint({ ...f.params, reattach: true });
  assert.deepEqual(observed, original);
  assert.deepEqual(readFileSync(original.native.path), before);
  assert.equal(f.inputs().length, 1);
  for (const change of [{ sessionId: randomUUID() }, { model: "another-provider/m1" }, { cwd: join(f.params.cwd, "missing") }]) {
    assert.equal(await f.adapter.observeSessionCheckpoint({ ...f.params, ...change, reattach: true }), undefined);
  }
  const recovered = await f.adapter.recoverSession({ ...f.params, reattach: true }, observed!);
  f.mode("good");
  assert.equal((await f.send("new input after recovery", recovered)).at(-1).status, "completed");
  assert.deepEqual(f.inputs().map(row => row.input), ["legacy request", "new input after recovery"]);
  assert.deepEqual(readFileSync(original.native.path).subarray(0, before.length), before);
}));

test("Pi continues its selected native branch and retains custom context without using an abandoned model", { skip: process.platform === "win32" }, () => fixture(async f => {
  f.mode("error"); await f.send("original request");
  const original = f.session.recoveryCheckpoint!() as any;
  const rows = readFileSync(original.native.path, "utf8").trim().split("\n").map(line => JSON.parse(line));
  const user = rows.find(row => row.message?.role === "user"), timestamp = rows.at(-1).timestamp;
  rows.push({ type: "model_change", id: "abandoned-model", parentId: rows.at(-1).id, timestamp, provider: "other", modelId: "not-selected" });
  rows.push({ type: "branch_summary", id: "selected-branch", parentId: user.id, timestamp, fromId: "abandoned-model", summary: "Retained prior work" });
  rows.push({ type: "custom_message", id: "retained-context", parentId: "selected-branch", timestamp, customType: "context", content: "Retained custom context", display: false });
  const before = Buffer.from(rows.map(row => JSON.stringify(row)).join("\n") + "\n");
  writeFileSync(original.native.path, before);
  const observed = await f.adapter.observeSessionCheckpoint(f.params) as any;
  assert.equal(observed.native.nativeModel, "fixture/m1");
  const recovered = await f.adapter.recoverSession(f.params, observed);
  f.mode("good");
  assert.equal((await f.send("new input on the selected branch", recovered)).at(-1).status, "completed");
  assert.deepEqual(readFileSync(original.native.path).subarray(0, before.length), before);
}));

for (const missingCheckpoint of [false, true]) {
  test(`Pi engine recovers a failed conversation after restart (legacy=${missingCheckpoint})`, { skip: process.platform === "win32", timeout: 20000 }, () => fixture(async f => {
    const path = join(f.params.cwd, "engine.sqlite");
    let store = new PhononStore(path), engine: SessionEngine | undefined;
    const registry = new AdapterRegistry(); registry.register(f.adapter);
    const events: any[] = [], project = "original-project";
    try {
      engine = new SessionEngine(registry, event => events.push(event), undefined, store, undefined, "owner");
      const { sessionId: id } = await engine.create({ tenantId: "owner", project, cwd: f.params.cwd, agent: "pi", model: "fixture/m1", verbosity: "tools",
        workflowAttr: { workflowId: "original-workflow", nodeId: "reply", role: "worker" } });
      f.mode("error");
      const sent = await engine.send("owner", id, "engine original", {});
      await engine.settleTurn("owner", id, sent.turnId);
      assert.equal(events.at(-1).status, "failed");
      assert.equal(events.find(event => event.source === "native_input_accepted")?.role, "user", "workflow roles must not overwrite native input receipt roles");
      assert.equal(JSON.parse(String(store.loadSessions("owner")[0]!.recovery_json)).settled, true);
      await engine.dispose(); store.close();
      if (missingCheckpoint) {
        const { DatabaseSync } = await import("node:sqlite");
        const database = new DatabaseSync(path);
        try { database.prepare("UPDATE sessions SET recovery_json=NULL WHERE session_id=?").run(id); } finally { database.close(); }
      }
      store = new PhononStore(path);
      engine = new SessionEngine(registry, event => events.push(event), undefined, store, undefined, "owner");
      engine.resolveCwdForReattach = () => f.params.cwd;
      const status = await engine.status("owner", id);
      assert.equal(status.recovery.canAttempt, true);
      await engine.recover("owner", id, { project, agent: "pi", model: "fixture/m1" });
      assert.equal(f.inputs().length, 1, "recovery must not replay the failed input");
      f.mode("good");
      const next = await engine.send("owner", id, "engine new input", {});
      await engine.settleTurn("owner", id, next.turnId);
      assert.equal(events.at(-1).status, "completed");
      assert.equal(new Set(f.inputs().map(row => row.id)).size, 1);
      assert.deepEqual(f.inputs().map(row => row.input), ["engine original", "engine new input"]);
    } finally { await engine?.dispose(); store.close(); }
  }));
}

test("Pi startup failure before accepting input does not poison the conversation", { skip: process.platform === "win32" }, () => fixture(async f => {
  f.mode("startup-failure");
  assert.equal((await f.send("not accepted")).at(-1).status, "failed");
  f.mode("good");
  assert.equal((await f.send("try sending again")).at(-1).status, "completed");
  assert.deepEqual(f.inputs().map(row => row.input), ["try sending again"]);
}));

test("Pi parses native structured transport errors instead of losing the actual cause", () => {
  assert.deepEqual(parsePiEvent({ type: "message_update", assistantMessageEvent: { type: "error", error: { errorMessage: "502 response_header_timeout" } } }),
    { kind: "stream_error", message: "502 response_header_timeout" });
  assert.deepEqual(parsePiEvent({ type: "message_end", message: { role: "assistant", stopReason: "error", content: [], errorMessage: "403 model denied" } }),
    { kind: "assistant_message", text: "", stopReason: "error", errorMessage: "403 model denied" });
});

test("Pi discovery recovers capabilities after a transient startup probe failure", { skip: process.platform === "win32" }, () => fixture(async f => {
  f.mode("probe-failure");
  const adapter = new PiAdapter({ env: { binPath: f.bin, models: [{ id: "fixture/m1", available: true }] } });
  assert.equal(adapter.capabilities.nativeSession, false);
  assert.equal((await adapter.discoverAgents())[0]!.available, false);
  f.mode("good");
  const descriptor = (await adapter.discoverAgents())[0]!;
  assert.equal(descriptor.available, true);
  assert.equal(descriptor.capabilities.nativeSession, true);
  assert.equal(descriptor.capabilities.injectMidTurn, true);
  const session = await adapter.createSession(f.params);
  assert.equal((await f.send("send after discovery recovers", session)).at(-1).status, "completed");
}));

test("Pi auto-detection retains an installed executable even while its version probe fails", { skip: process.platform === "win32" }, () => fixture(async f => {
  const { autoDetectAdapters } = await import(new URL("../../../daemon/src/commands.ts", import.meta.url).href);
  const previous = process.env.HOME, directory = join(f.params.cwd, ".local", "bin"), bin = join(directory, "pi");
  mkdirSync(directory, { recursive: true, mode: 0o700 }); symlinkSync(f.bin, bin);
  f.mode("probe-failure"); process.env.HOME = f.params.cwd;
  try {
    const configured = [
      { type: "hermes", hermesBinPath: f.bin }, { type: "opencode", opencodeBinPath: f.bin },
      { type: "copilot", copilotBinPath: f.bin },
      { type: "claude-code", claudeBinPath: f.bin }, { type: "codex", codexBinPath: f.bin },
    ];
    const effective = autoDetectAdapters(configured);
    assert.deepEqual(effective.find((value: { type: string }) => value.type === "pi"), { type: "pi", piBinPath: bin });
  } finally { if (previous === undefined) delete process.env.HOME; else process.env.HOME = previous; }
}));

for (const mode of ["missing-user", "different-user", "prompt-rejected"]) {
  test(`Pi never invents input delivery from ${mode}`, { skip: process.platform === "win32" }, () => fixture(async f => {
    f.mode(mode);
    const events = await f.send("original input needing confirmation");
    assert.equal(events.some(event => event.source === "native_input_accepted"), false);
    assert.equal(events.at(-1).status, mode === "prompt-rejected" ? "failed" : "completed");
  }));
}

test("Pi confirms exact input once after both its native record and RPC acknowledgement", { skip: process.platform === "win32" }, () => fixture(async f => {
  f.mode("ack-after-user");
  const events = await f.send("exact original input");
  const receipts = events.filter(event => event.source === "native_input_accepted");
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].role, "user");
  assert.equal(receipts[0].text, "", "the receipt must not duplicate private input text");
  assert.equal(events.at(-1).status, "completed");
}));
