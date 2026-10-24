import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AdapterRegistry, PiAdapter, PhononStore, type AdapterSession, type CreateSessionParams } from "@agent-phonon/core";
import { TestConn } from "./harness.js";

// Native v3 records and extension lifecycle, not an inference/model mock server.
const CLI = String.raw`#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const args=process.argv.slice(2),home=process.env.PI_CODING_AGENT_DIR;
const control=JSON.parse(fs.readFileSync(path.join(home,'control.json'),'utf8'));
if(args.includes('--help')){console.log(control.help??'--session <path|id> --session-id <id> --extension <path>');process.exit(0);}
if(args.includes('--version')){console.log('0.84.1');process.exit(0);}
if(args.includes('--list-models')){console.log('fixture  m1');process.exit(0);}
const log=(name,data)=>fs.appendFileSync(path.join(home,name),JSON.stringify(data)+'\n');
log('calls.jsonl',{args,env:{home:process.env.HOME,piHome:home,nodeOptions:process.env.NODE_OPTIONS,bridge:process.env.AGENT_PHONON_HITL_BRIDGE}});
const cwd=process.cwd(),timestamp='2026-10-20T09:29:33.171Z';
const dir=path.join(home,'sessions','--'+cwd.replace(/^[/\\]/,'').replace(/[/\\:]/g,'-')+'--');
fs.mkdirSync(dir,{recursive:true,mode:0o700});
const resumed=args.includes('--session');
const selectedId=args.includes('--session-id')?args[args.indexOf('--session-id')+1]:'stateless-'+fs.readFileSync(path.join(home,'calls.jsonl'),'utf8').trim().split('\n').length;
const requested=args.includes('--model')?args[args.indexOf('--model')+1]:'fixture/m1';
const provider=requested.includes('/')?requested.split('/')[0]:'fixture',modelId=requested.includes('/')?requested.split('/').slice(1).join('/'):requested;
const file=resumed?args[args.indexOf('--session')+1]:path.join(dir,timestamp.replace(/[:.]/g,'-')+'_'+selectedId+'.jsonl');
let rows=resumed?fs.readFileSync(file,'utf8').trim().split('\n').map(JSON.parse):[{type:'session',version:3,id:selectedId,timestamp,cwd}];
const append=(type,extra)=>{rows.push({type,id:'e'+rows.length,parentId:rows.length===1?null:rows.at(-1).id,timestamp,...extra});fs.writeFileSync(file,rows.map(x=>JSON.stringify(x)).join('\n')+'\n',{mode:0o600});};
if(!resumed){append('model_change',{provider,modelId});append('thinking_level_change',{thinkingLevel:'off'});}
if(resumed&&control.race==='missing'){fs.unlinkSync(file);rows=[{type:'session',version:3,id:'fresh-wrong',timestamp,cwd}];}
if(resumed&&control.race==='identity')rows[0].id='different-native';
if(resumed&&control.race==='memory')rows[3].message.content[0].text='altered in memory';
const handlers=new Map();
const pi={on:(event,fn)=>{handlers.set(event,[...(handlers.get(event)||[]),fn]);}};
if(resumed&&control.race==='guard-load-failure')process.exit(1);
for(let i=0;i<args.length;i++)if(args[i]==='--extension'&&args[i+1].endsWith('guard.mjs'))(await import(pathToFileURL(args[++i]).href)).default(pi);
let input='';for await(const chunk of process.stdin)input+=chunk;
const ctx={cwd,model:{provider:control.race==='provider'?'other-provider':provider,id:control.race==='model'?'wrong':modelId},sessionManager:{getSessionId:()=>rows[0].id,getSessionFile:()=>file,getHeader:()=>rows[0],getEntries:()=>rows.slice(1)}};
const emit=event=>console.log(JSON.stringify(event));
const fire=async event=>{for(const fn of handlers.get(event)||[])await fn({type:event},ctx);};
emit(rows[0]);await fire('session_start');await fire('input');await fire('before_agent_start');
log('inferences.jsonl',{sid:rows[0].id,input,history:rows.filter(r=>r.message?.role==='user').map(r=>r.message.content[0].text)});
append('message',{message:{role:'user',content:[{type:'text',text:input.trim()}],timestamp:1}});
if(control.tool){
  append('message',{message:{role:'assistant',provider,model:modelId,stopReason:'toolUse',content:[{type:'toolCall',id:'tool-'+rows.length,name:'read',arguments:{path:'test'}}],timestamp:1}});
  const id=rows.at(-1).message.content[0].id;
  emit({type:'tool_execution_start',toolCallId:id,toolName:'read',args:{path:'test'}});
  if(control.tool==='settled'){
    append('message',{message:{role:'toolResult',toolCallId:id,toolName:'read',isError:false,content:[{type:'text',text:'ok'}],timestamp:1}});
    emit({type:'tool_execution_end',toolCallId:id,toolName:'read',result:{},isError:false});
  }
}
if(control.tool!=='pending')append('message',{message:{role:'assistant',provider,model:modelId,stopReason:'stop',content:[{type:'text',text:'retained reply'}],timestamp:1}});
emit({type:'message_update',assistantMessageEvent:{type:'text_delta',delta:'retained reply'}});
emit({type:'agent_settled',aborted:control.aborted===true});
if(control.afterSettled==='pending')append('message',{message:{role:'assistant',provider:'fixture',model:'m1',stopReason:'toolUse',content:[{type:'toolCall',id:'late-tool',name:'read',arguments:{}}],timestamp:1}});
if(control.afterSettled==='hold')await new Promise(resolve=>setTimeout(resolve,150));
process.exitCode=control.exitCode||0;
`;

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "phonon-pi-recovery-test-")));
  const home = join(root, "pi"), cwd = join(root, "work"), bin = join(root, "pi-cli.mjs");
  mkdirSync(home, { mode: 0o700 }); mkdirSync(cwd);
  writeFileSync(bin, CLI, { mode: 0o700 });
  const keys = ["PI_CODING_AGENT_DIR", "PI_CODING_AGENT_SESSION_DIR", "PHONON_STATE_DIR"];
  const previous = new Map(keys.map(key => [key, process.env[key]]));
  process.env.PI_CODING_AGENT_DIR = home; delete process.env.PI_CODING_AGENT_SESSION_DIR; process.env.PHONON_STATE_DIR = join(root, "state");
  const control = (value: Record<string, unknown>) => writeFileSync(join(home, "control.json"), JSON.stringify(value));
  control({});
  const adapter = () => new PiAdapter({ env: { binPath: bin, defaultModel: "fixture/m1" } });
  const params: CreateSessionParams = { sessionId: "retained-session", agentId: "pi", model: "fixture/m1", cwd };
  const read = (name: string): any[] => {
    if (!existsSync(join(home, name))) return [];
    const bytes = readFileSync(join(home, name), "utf8"), end = bytes.lastIndexOf("\n");
    // The child may still be appending its last record. Completed malformed lines remain errors.
    return end < 0 ? [] : bytes.slice(0, end).split("\n").filter(Boolean).map(line => JSON.parse(line));
  };
  return { root, home, cwd, bin, params, control, adapter, calls: () => read("calls.jsonl"), inferences: () => read("inferences.jsonl"),
    close() { for (const [key, value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } rmSync(root, { recursive: true, force: true }); },
  };
}

async function turn(session: AdapterSession, input = "original", environment?: Record<string, string>) {
  const events: any[] = [];
  await session.send(input, { turnId: "turn", verbosity: "trace", environment, emit: event => events.push(event) });
  return events;
}

test('Pi fixture reads only complete JSONL records while retaining malformed-record failures',()=>{
  const f=fixture();
  try{
    writeFileSync(join(f.home,'inferences.jsonl'),JSON.stringify({sid:'complete'})+'\n'+ '{"sid":"unfinished');
    assert.deepEqual(f.inferences(),[{sid:'complete'}]);
    writeFileSync(join(f.home,'inferences.jsonl'),'{"sid":"complete"}\nmalformed\n');
    assert.throws(()=>f.inferences(),SyntaxError);
  }finally{f.close();}
});

test("Pi read-only recovery retains exact native path/history and pending context across adapters", async () => {
  const f = fixture();
  try {
    const original = await f.adapter().createSession(f.params);
    f.control({ tool: "settled" });
    assert.equal((await turn(original)).at(-1).status, "completed");
    await original.inject!([{ role: "system", content: "pending after reconnect" }]);
    const saved = original.recoveryCheckpoint!() as any; assert.ok(saved);
    const bytes = readFileSync(saved.native.path), info = statSync(saved.native.path);
    await original.terminate();
    const recovered = await f.adapter().recoverSession(f.params, saved);
    assert.deepEqual(recovered.recoveryCheckpoint!(), saved);
    assert.equal(f.calls().length, 1); assert.equal(f.inferences().length, 1);
    assert.deepEqual(readFileSync(saved.native.path), bytes); assert.equal(statSync(saved.native.path).ino, info.ino);
    f.control({});
    assert.equal((await turn(recovered, "next", { HOME: "/hostile", NODE_OPTIONS: "--require=hostile", PI_CODING_AGENT_DIR: "/wrong", PI_CODING_AGENT_SESSION_DIR: "/wrong" })).at(-1).status, "completed");
    const next = f.calls()[1];
    assert.equal(next.args[next.args.indexOf("--session") + 1], saved.native.path);
    assert.ok(!next.args.includes("--session-id") && !next.args.includes("--continue"));
    assert.equal(next.env.piHome, f.home); assert.notEqual(next.env.home, "/hostile"); assert.equal(next.env.nodeOptions, undefined);
    assert.match(f.inferences()[1].input, /pending after reconnect/);
    assert.deepEqual(f.inferences()[1].history, ["original"]);
    assert.equal(f.inferences()[1].sid, saved.native.sessionId);
    assert.ok(recovered.recoveryCheckpoint!());
    assert.equal(existsSync(next.args[next.args.indexOf("--extension") + 1]), false);
    await recovered.terminate();
  } finally { f.close(); }
});

test("Pi rejects altered checkpoint bindings and unsafe native stores without launching or creating files", async () => {
  for (const variant of ["missing", "replace", "symlink", "hardlink", "permissions", "truncated", "header-id", "cwd", "model", "pending-tool", "unknown", "branch", "home", "checkpoint-owner", "checkpoint-inode", "checkpoint-model", "phonon-id", "agent", "workspace"]) {
    const f = fixture();
    try {
      const session = await f.adapter().createSession(f.params); await turn(session);
      const saved = session.recoveryCheckpoint!() as any; assert.ok(saved, variant);
      const path = saved.native.path, bytes = readFileSync(path), params = { ...f.params };
      if (variant === "missing") rmSync(path);
      else if (variant === "replace") { writeFileSync(path + ".new", bytes); renameSync(path + ".new", path); }
      else if (variant === "symlink") { writeFileSync(path + ".real", bytes); rmSync(path); symlinkSync(path + ".real", path); }
      else if (variant === "hardlink") linkSync(path, path + ".link");
      else if (variant === "permissions") chmodSync(path, 0o666);
      else if (variant === "truncated") writeFileSync(path, bytes.subarray(0, bytes.length - 1));
      else if (["header-id", "cwd", "model", "pending-tool", "unknown", "branch"].includes(variant)) {
        const rows = bytes.toString().trim().split("\n").map(line => JSON.parse(line));
        if (variant === "header-id") rows[0].id = "wrong-id";
        if (variant === "cwd") rows[0].cwd = f.root;
        if (variant === "model") rows[1].modelId = "wrong-model";
        if (variant === "pending-tool") { rows.at(-1).message.stopReason = "toolUse"; rows.at(-1).message.content = [{ type: "toolCall", id: "pending", name: "read", arguments: {} }]; }
        if (variant === "unknown") rows.at(-1).type = "future-record";
        if (variant === "branch") rows.at(-1).parentId = null;
        writeFileSync(path, rows.map(row => JSON.stringify(row)).join("\n") + "\n");
      } else if (variant === "home") { const other = join(f.root, "other-home"); mkdirSync(other); process.env.PI_CODING_AGENT_DIR = other; }
      else if (variant === "checkpoint-owner") saved.native.owner++;
      else if (variant === "checkpoint-inode") saved.native.inode = "1";
      else if (variant === "checkpoint-model") params.model = "fixture/other";
      else if (variant === "phonon-id") params.sessionId = "another-session";
      else if (variant === "agent") params.agentId = "hermes";
      else if (variant === "workspace") params.cwd = f.root;
      await assert.rejects(f.adapter().recoverSession(params, saved), /could not be verified/, variant);
      assert.equal(f.calls().length, 1, variant); assert.equal(f.inferences().length, 1, variant);
      if (variant === "missing") assert.equal(existsSync(path), false);
      await session.terminate();
    } finally { f.close(); }
  }
});

test("Pi continuation guard prevents inference on create-if-missing races, switched identities and failed guard loads", async () => {
  for (const race of ["missing", "identity", "memory", "model", "guard-load-failure"]) {
    const f = fixture();
    try {
      const session = await f.adapter().createSession(f.params); await turn(session);
      const saved = session.recoveryCheckpoint!() as any;
      const recovered = await f.adapter().recoverSession(f.params, saved);
      f.control({ race });
      assert.equal((await turn(recovered, "must not infer")).at(-1).status, "failed", race);
      assert.equal(f.inferences().length, 1, race);
      if(race==="missing"){
        assert.equal(recovered.recoveryCheckpoint!(),undefined);
        await assert.rejects(turn(recovered,"no fresh fallback"));
        assert.equal(existsSync(saved.native.path),false);
      }else{
        const retained=recovered.recoveryCheckpoint!() as any;
        if(retained)assert.equal(retained.native.sessionId,saved.native.sessionId);
        else await assert.rejects(turn(recovered,"no guessed native fallback"));
        f.control({});
        const retry=retained?recovered:await f.adapter().recoverSession(f.params,saved);
        assert.equal((await turn(retry,"retry original native identity")).at(-1).status,"completed");
        assert.equal(f.inferences().length,2);assert.equal(f.inferences()[1].sid,saved.native.sessionId);
      }
    } finally { f.close(); }
  }
});

test("Pi recovered default/unqualified models pin the saved provider even when another provider offers the same id", async () => {
  for (const model of ["m1", "default"]) {
    const f = fixture();
    try {
      const params = { ...f.params, model };
      const adapter = new PiAdapter({ env: { binPath: f.bin } });
      const original = await adapter.createSession(params); await turn(original);
      const saved = original.recoveryCheckpoint!() as any; assert.equal(saved.native.nativeModel, "fixture/m1");
      const recovered = await adapter.recoverSession(params, saved); f.control({ race: "provider" });
      assert.equal((await turn(recovered, "must not change provider")).at(-1).status, "failed");
      const args = f.calls()[1].args;
      assert.equal(args[args.indexOf("--model") + 1], "fixture/m1");
      assert.equal(f.inferences().length, 1);
      assert.equal((recovered.recoveryCheckpoint!() as any).native.nativeModel,"fixture/m1");
      f.control({});assert.equal((await turn(recovered,"retry pinned provider")).at(-1).status,"completed");
      assert.equal((recovered.recoveryCheckpoint!() as any).native.nativeModel,"fixture/m1");
    } finally { f.close(); }
  }
});

test("Pi permits a deliberate live provider/model switch and pins the new native selection afterward", async () => {
  const f = fixture();
  try {
    const session = await f.adapter().createSession({ ...f.params, model: "m1" }); await turn(session);
    await session.switchModel!("other-provider/m1");
    assert.equal((await turn(session, "switch intentionally")).at(-1).status, "completed");
    const saved = session.recoveryCheckpoint!() as any;
    assert.equal(saved.native.nativeModel, "other-provider/m1"); assert.equal(saved.modelSwitchPending, false);
    assert.equal(f.inferences().length, 2);
    const args = f.calls()[1].args; assert.equal(args[args.indexOf("--model") + 1], "other-provider/m1");
    const recovered = await f.adapter().recoverSession({ ...f.params, model: "other-provider/m1" }, saved);
    assert.equal((await turn(recovered, "keep switched provider")).at(-1).status, "completed");
    assert.equal((recovered.recoveryCheckpoint!() as any).native.nativeModel, "other-provider/m1");
  } finally { f.close(); }
});

test("Pi without an exact session-path flag remains truthfully stateless and ordinary second sends still work", async () => {
  for (const help of ["--mode json", "--mode json --session-id <id> --continue"]) {
    const f = fixture();
    try {
      f.control({ help }); const adapter = f.adapter();
      assert.equal(adapter.capabilities.nativeSession, false);
      const session = await adapter.createSession(f.params);
      assert.equal((await turn(session, "one")).at(-1).status, "completed");
      assert.equal((await turn(session, "two")).at(-1).status, "completed");
      assert.equal(session.recoveryCheckpoint!(), undefined);
      assert.notEqual(f.inferences()[0].sid, f.inferences()[1].sid);
      for (const call of f.calls()) assert.ok(!call.args.includes("--session") && !call.args.includes("--session-id") && !call.args.includes("--continue"));
      await assert.rejects(adapter.recoverSession(f.params, {}));
    } finally { f.close(); }
  }
});

test("Pi preserves continuation of failed, interrupted and incomplete histories after native tree exit", async () => {
  for (const control of [{ tool: "pending" }, { afterSettled: "pending" }, { exitCode: 1 }, { aborted: true }]) {
    const f = fixture();
    try {
      const session = await f.adapter().createSession(f.params); f.control(control);
      await turn(session);
      const saved=session.recoveryCheckpoint!() as any;assert.ok(saved);
      const bytes=readFileSync(saved.native.path);
      f.control({});assert.equal((await turn(session,"continue original history")).at(-1).status,"completed");
      assert.equal(f.inferences().length,2);assert.equal(f.inferences()[1].sid,saved.native.sessionId);
      assert.deepEqual(readFileSync(saved.native.path).subarray(0,bytes.length),bytes);
    } finally { f.close(); }
  }
});

test("Pi verifies again before send and preserves the device HITL bridge on continuation", async () => {
  const f = fixture();
  try {
    const adapter = f.adapter(); adapter.setHitl({ bridgeUrl: "http://127.0.0.1:1", failMode: "closed" });
    const session = await adapter.createSession(f.params); await turn(session); await turn(session, "second");
    assert.equal(f.calls()[1].env.bridge, "http://127.0.0.1:1");
    assert.equal(f.calls()[1].args.filter((arg: string) => arg === "--extension").length, 2);
    const saved = session.recoveryCheckpoint!() as any;
    const recovered = await adapter.recoverSession(f.params, saved);
    rmSync(saved.native.path);
    await assert.rejects(turn(recovered, "missing after reattach"));
    assert.equal(f.calls().length, 2); assert.equal(existsSync(saved.native.path), false);
    await assert.rejects(adapter.createSession({ ...f.params, reattach: true }));
  } finally { f.close(); }
});

test("Pi waits for native process exit, not agent_settled, before exposing a checkpoint", async () => {
  const f = fixture();
  try {
    const session = await f.adapter().createSession(f.params); f.control({ afterSettled: "hold" });
    let completed = false;
    const pending = turn(session).then(events => { completed = true; return events; });
    for (let i = 0; i < 500 && !f.inferences().length; i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(f.inferences().length, 1);
    assert.equal(completed, false); assert.equal(session.recoveryCheckpoint!(), undefined);
    assert.equal((await pending).at(-1).status, "completed");
    assert.ok(session.recoveryCheckpoint!());
  } finally { f.close(); }
});

test("Pi engine persists a settled checkpoint and reattaches without inference after daemon restart", async () => {
  const f = fixture();
  let store = new PhononStore(join(f.root, "phonon.db"));
  const registry = new AdapterRegistry(); registry.register(f.adapter());
  let conn = new TestConn({ store, registry, workspaceRoot: f.root, tenantId: "owner" });
  try {
    const project = (await conn.call("project.create", { name: "recovery", git: false }) as any).project.projectId;
    const sessionId = ((await conn.call("session.create", { project, agent: "pi", model: "fixture/m1" })) as any).sessionId;
    const sent = await conn.call("session.send", { sessionId, input: "engine history" }) as any;
    const final = await conn.waitTurnEnd(sent.turnId);
    assert.equal(final.status, "completed", JSON.stringify({final,calls:f.calls(),inferences:f.inferences().length}));
    for (let i = 0; i < 100 && !(JSON.parse(String(store.loadSessions("owner")[0]?.recovery_json || "null"))?.settled); i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(JSON.parse(String(store.loadSessions("owner")[0]!.recovery_json)).settled, true);
    await conn.conn.dispose(); store.close();
    store = new PhononStore(join(f.root, "phonon.db")); conn = new TestConn({ store, registry, workspaceRoot: f.root, tenantId: "owner" });
    assert.equal(((await conn.call("session.status", { sessionId })) as any).recovery.canAttempt, true);
    await conn.call("session.recover", { sessionId, project, agent: "pi", model: "fixture/m1" });
    assert.equal(f.inferences().length, 1); assert.equal(f.calls().length, 1);
    assert.equal(conn.streamEvents.length, 0);
    const next = await conn.call("session.send", { sessionId, input: "engine next" }) as any;
    assert.equal((await conn.waitTurnEnd(next.turnId) as any).status, "completed");
    assert.deepEqual(f.inferences()[1].history, ["engine history"]);
  } finally { await conn.conn.dispose(); store.close(); f.close(); }
});
