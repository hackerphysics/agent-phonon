import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {PiAdapter, type AdapterSession} from "@agent-phonon/core";
import {PiRpcChannel} from "../../core/dist/adapters/pi-rpc.js";

const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const user = (text: string) => ({type: "message_end", message: {role: "user", content: [{type: "text", text}]}});
function channelFixture() {
  const commands: any[] = [], channel = new PiRpcChannel(command => commands.push(command));
  const answer = (command = commands.at(-1), extra = {}) => channel.observe({type: "response", id: command.id, command: command.type, success: true, ...extra});
  const ready = async () => {
    const prompted = channel.prompt("original"); answer();
    channel.observe({type: "agent_start"}); channel.observe(user("original")); await prompted;
  };
  return {commands, channel, answer, ready};
}

test("Pi RPC steering requires both native queue acceptance and exact user-message consumption", async () => {
  const f = channelFixture();
  try {
    await f.ready();
    let delivered = false;
    const input = "new\u2028instruction\u2029tail";
    const sent = f.channel.insert(input, new AbortController().signal).then(() => { delivered = true; });
    assert.equal(f.commands.at(-1).type, "steer"); assert.equal(f.commands.at(-1).message, input);
    f.answer(); await tick(); assert.equal(delivered, false, "queued is not inserted");
    f.channel.observe({type: "message_end", message: {role: "assistant", content: [{type: "text", text: input}]}});
    f.channel.observe(user("unrelated")); f.channel.observe(user("expanded " + input));
    f.channel.observe({type: "message_end", message: {role: "user", content: [null]}});
    await tick(); assert.equal(delivered, false);
    f.channel.observe(user(input)); await sent; assert.equal(delivered, true);
  } finally { f.channel.close(); }
});

test("Pi RPC accepts reversed consumption/response ordering and correlates identical inputs independently", async () => {
  const f = channelFixture();
  try {
    await f.ready();
    let delivered = 0;
    const first = f.channel.insert("same", new AbortController().signal).then(() => { delivered++; });
    const a = f.commands.at(-1);
    const second = f.channel.insert("same", new AbortController().signal).then(() => { delivered++; });
    const b = f.commands.at(-1);
    f.channel.observe(user("same")); f.answer(b); await tick(); assert.equal(delivered, 0);
    f.answer(a); await first; assert.equal(delivered, 1);
    f.channel.observe(user("same")); await second; assert.equal(delivered, 2);
  } finally { f.channel.close(); }
});

test("Pi RPC refuses early/idle/closed steering without writing another prompt", async () => {
  const f = channelFixture(), signal = new AbortController().signal;
  await assert.rejects(f.channel.insert("early", signal)); assert.equal(f.commands.length, 0);
  const prompted = f.channel.prompt("original"); f.answer(); f.channel.observe({type: "agent_start"});
  await prompted; await assert.rejects(f.channel.insert("before-user-record", signal));
  f.channel.observe(user("original")); f.channel.observe({type: "agent_settled"});
  await assert.rejects(f.channel.insert("late", signal)); await assert.rejects(f.channel.prompt("replacement"));
  assert.deepEqual(f.commands.map(command => command.type), ["prompt"]);
});

for (const ending of ["settled", "abort", "closed", "rejected", "wrong-command"]) {
  test(`Pi RPC never turns an unconfirmed steering operation into a later turn (${ending})`, async () => {
    const f = channelFixture(), abort = new AbortController();
    try {
      await f.ready();
      const sent = f.channel.insert("pending", abort.signal), rejected = assert.rejects(sent);
      const command = f.commands.at(-1);
      if (ending === "settled") { f.answer(); f.channel.observe({type: "agent_settled"}); }
      else if (ending === "abort") { f.answer(); abort.abort(); }
      else if (ending === "closed") f.channel.close();
      else if (ending === "rejected") f.answer(command, {success: false});
      else f.answer(command, {command: "prompt"});
      await rejected;
      f.channel.observe(user("pending")); f.answer(command);
      assert.deepEqual(f.commands.map(value => value.type), ["prompt", "steer"]);
    } finally { f.channel.close(); }
  });
}

const CLI = String.raw`#!/usr/bin/env node
import fs from 'node:fs';import path from 'node:path';import{pathToFileURL}from'node:url';
const args=process.argv.slice(2),home=process.env.PI_CODING_AGENT_DIR,control=JSON.parse(fs.readFileSync(path.join(home,'control.json'),'utf8'));
if(args.includes('--help')){console.log('--mode <mode> text, json, rpc\n--session <path|id> --session-id <id> --extension <path>');process.exit(0);}
if(args.includes('--version')){console.log(control.version||'0.84.1');process.exit(0);}
const emit=value=>process.stdout.write(JSON.stringify(value)+'\n'),log=row=>fs.appendFileSync(path.join(home,'calls.jsonl'),JSON.stringify(row)+'\n');
const cwd=process.cwd(),timestamp='2026-10-22T04:05:06.123Z';
const dir=path.join(home,'sessions','--'+cwd.replace(/^[/\\]/,'').replace(/[/\\:]/g,'-')+'--');fs.mkdirSync(dir,{recursive:true,mode:0o700});
const resumed=args.includes('--session'),id=args[args.indexOf('--session-id')+1];
const file=resumed?args[args.indexOf('--session')+1]:path.join(dir,timestamp.replace(/[:.]/g,'-')+'_'+id+'.jsonl');
let rows=resumed?fs.readFileSync(file,'utf8').trim().split('\n').map(JSON.parse):[{type:'session',version:3,id,timestamp,cwd}];
const modelArg=args[args.indexOf('--model')+1],provider=modelArg.split('/')[0],modelId=modelArg.split('/').slice(1).join('/');
const append=(type,extra)=>{rows.push({type,id:'entry-'+rows.length,parentId:rows.length===1?null:rows.at(-1).id,timestamp,...extra});fs.writeFileSync(file,rows.map(row=>JSON.stringify(row)).join('\n')+'\n',{mode:0o600});};
const handlers=new Map(),pi={on:(name,fn)=>handlers.set(name,[...(handlers.get(name)||[]),fn])};
for(let i=0;i<args.length;i++)if(args[i]==='--extension')(await import(pathToFileURL(args[++i]).href)).default(pi);
const ctx={cwd,model:{provider,id:modelId},sessionManager:{getSessionId:()=>rows[0].id,getSessionFile:()=>file,getHeader:()=>rows[0],getEntries:()=>rows.slice(1)}};
for(const fn of handlers.get('session_start')||[])await fn({type:'session_start'},ctx);
const response=(command,data)=>emit({id:command.id,type:'response',command:command.type,success:true,...(data?{data}:{})});
let timer,toolID,initial;
const finish=(text,steering)=>{
 if(toolID){append('message',{message:{role:'toolResult',toolCallId:toolID,toolName:'fixture_wait',isError:false,content:[{type:'text',text:'released'}]}});emit({type:'tool_execution_end',toolCallId:toolID,toolName:'fixture_wait',isError:false,result:{}});toolID=undefined;}
 if(steering!==undefined){const message={role:'user',content:[{type:'text',text:steering}]};append('message',{message});emit({type:'message_end',message});}
 const message={role:'assistant',provider,model:modelId,stopReason:'stop',content:[{type:'text',text}]};append('message',{message});
 emit({type:'message_update',assistantMessageEvent:{type:'text_delta',delta:text}});emit({type:'message_end',message});emit({type:'agent_settled',aborted:false});
};
let buffer='';for await(const bytes of process.stdin){buffer+=bytes;let end;while((end=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,end);buffer=buffer.slice(end+1);if(!line)continue;const command=JSON.parse(line);log(command);
 if(command.type==='get_state'&&!control.holdState)response(command,{sessionId:control.identity==='wrong'?'wrong':rows[0].id,sessionFile:file,model:{provider,id:control.model==='wrong'?'wrong':modelId},isStreaming:false,isCompacting:false,pendingMessageCount:control.pending?1:0});
 else if(command.type==='prompt'){
  initial=command.message;response(command);emit({type:'agent_start'});
  if(!resumed)append('model_change',{provider,modelId});
  const message={role:'user',content:[{type:'text',text:initial}]};append('message',{message});emit({type:'message_end',message});
  emit({type:'message_update',assistantMessageEvent:{type:'text_delta',delta:'Working'}});
  if(control.auto)finish('ORIGINAL '+initial);
  else{toolID='waiting-'+rows.length;append('message',{message:{role:'assistant',provider,model:modelId,stopReason:'toolUse',content:[{type:'toolCall',id:toolID,name:'fixture_wait',arguments:{}}]}});emit({type:'tool_execution_start',toolCallId:toolID,toolName:'fixture_wait',args:{}});}
 }else if(command.type==='steer'){
  response(command);
  if(control.delivery==='none')finish('ORIGINAL');
  else timer=setInterval(()=>{if(fs.existsSync(path.join(home,'release'))){clearInterval(timer);finish('STEERED '+command.message,command.message);}},10);
 }
}}
clearInterval(timer);
`;

function nativeFixture(control: Record<string, unknown> = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "phonon-pi-rpc-test-")));
  const home = join(root, "pi"), cwd = join(root, "Work space"), bin = join(root, "pi-cli.mjs");
  mkdirSync(home, {mode: 0o700}); mkdirSync(cwd);
  writeFileSync(bin, CLI, {mode: 0o700});
  const keys = ["PI_CODING_AGENT_DIR", "PI_CODING_AGENT_SESSION_DIR", "PHONON_STATE_DIR"];
  const previous = new Map(keys.map(key => [key, process.env[key]]));
  process.env.PI_CODING_AGENT_DIR = home; delete process.env.PI_CODING_AGENT_SESSION_DIR;
  process.env.PHONON_STATE_DIR = join(root, "state");
  const setControl = (value: Record<string, unknown>) => writeFileSync(join(home, "control.json"), JSON.stringify(value));
  setControl(control);
  const adapter = () => new PiAdapter({env: {binPath: bin, defaultModel: "fixture/model"}});
  const params = {sessionId: "owned-rpc-session", agentId: "pi", model: "fixture/model", cwd};
  return {root, home, params, adapter, setControl,
    calls: () => readFileSync(join(home, "calls.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line)),
    close() {
      for (const [key, value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
      rmSync(root, {recursive: true, force: true});
    }};
}
async function until(check: () => boolean, ms = 5000) {
  const deadline = Date.now() + ms;
  while (!check()) { assert.ok(Date.now() < deadline, "native fixture observation deadline"); await new Promise(resolve => setTimeout(resolve, 10)); }
}
const nativeOptions = {skip: process.platform === "win32", timeout: 15000};

test("Pi adapter delivers steering through original RPC process/turn and retains complete native history", nativeOptions, async () => {
  const f = nativeFixture(), events: any[] = [], adapter = f.adapter(), session = await adapter.createSession(f.params);
  const input = "exact\u2028steering\u2029text";
  let sending: Promise<void> | undefined;
  try {
    assert.equal(adapter.capabilities.injectMidTurn, true);
    sending = session.send("original", {turnId: "original-turn", verbosity: "tools", emit: event => events.push(event)});
    await until(() => events.some(event => event.type === "tool_call"));
    let delivered = false;
    const inserted = session.insertAtToolGap!(input, {turnId: "original-turn", signal: new AbortController().signal}).then(() => { delivered = true; });
    await until(() => f.calls().some(command => command.type === "steer"));
    await tick(); assert.equal(delivered, false);
    writeFileSync(join(f.home, "release"), "owned release");
    await inserted; await sending;
    assert.equal(events.at(-1).status, "completed"); assert.equal(events.at(-1).text, "STEERED " + input);
    assert.equal(events.filter(event => event.final).length, 1);
    assert.ok(events.some(event => event.type === "message" && event.text === "Working"));
    assert.deepEqual(f.calls().map(command => command.type), ["get_state", "prompt", "steer"]);
    const saved = session.recoveryCheckpoint!() as any; assert.ok(saved);
    const users = readFileSync(saved.native.path, "utf8").trim().split("\n").map(line => JSON.parse(line)).filter(row => row.message?.role === "user");
    assert.deepEqual(users.map(row => row.message.content[0].text), ["original", input]);
    await assert.rejects(session.insertAtToolGap!("late", {turnId: "original-turn", signal: new AbortController().signal}));
  } finally { await session.terminate(); await sending; f.close(); }
});

test("Pi RPC native identity/model/pending-state mismatch fails before releasing any model input", nativeOptions, async () => {
  for (const control of [{identity: "wrong"}, {model: "wrong"}, {pending: true}]) {
    const f = nativeFixture(control), events: any[] = [], session = await f.adapter().createSession(f.params);
    try {
      await session.send("must not run", {turnId: "turn", verbosity: "tools", emit: event => events.push(event)});
      assert.equal(events.at(-1).status, "failed");
      assert.deepEqual(f.calls().map(command => command.type), ["get_state"]);
      assert.equal(session.recoveryCheckpoint!(), undefined);
    } finally { await session.terminate(); f.close(); }
  }
});

test("Pi RPC interruption during startup preserves interruption and never releases the initial prompt", nativeOptions, async () => {
  const f = nativeFixture({holdState: true}), events: any[] = [], abort = new AbortController();
  const session = await f.adapter().createSession(f.params);
  let sending: Promise<void> | undefined;
  try {
    sending = session.send("must not run", {turnId: "startup", verbosity: "tools", signal: abort.signal, emit: event => events.push(event)});
    await until(() => { try { return f.calls().some(command => command.type === "get_state"); } catch { return false; } });
    abort.abort(); await sending;
    assert.equal(events.at(-1).type, "result"); assert.equal(events.at(-1).status, "interrupted");
    assert.deepEqual(f.calls().map(command => command.type), ["get_state"]);
  } finally { await session.terminate(); await sending; f.close(); }
});

test("Pi RPC interruption rejects a queued but unconsumed input instead of carrying it into another native turn", nativeOptions, async () => {
  const f = nativeFixture(), events: any[] = [], abort = new AbortController();
  const session = await f.adapter().createSession(f.params);
  let sending: Promise<void> | undefined;
  try {
    sending = session.send("original", {turnId: "active", verbosity: "tools", signal: abort.signal, emit: event => events.push(event)});
    await until(() => events.some(event => event.type === "tool_call"));
    const inserted = session.insertAtToolGap!("queued only", {turnId: "active", signal: abort.signal});
    const rejected = assert.rejects(inserted);
    await until(() => f.calls().some(command => command.type === "steer"));
    abort.abort(); await rejected; await sending;
    assert.equal(events.at(-1).status, "interrupted");
    const saved=session.recoveryCheckpoint!() as any;assert.ok(saved);
    assert.deepEqual(f.calls().map(command => command.type), ["get_state", "prompt", "steer"]);
    f.setControl({auto:true});
    await session.send("next original input",{turnId:"another",verbosity:"tools",emit:event=>events.push(event)});
    assert.equal(events.at(-1).status,"completed");
    assert.equal((session.recoveryCheckpoint!() as any).native.sessionId,saved.native.sessionId);
    assert.deepEqual(f.calls().filter(command=>command.type==="prompt").map(command=>command.message),["original","next original input"]);
    assert.equal(f.calls().filter(command=>command.type==="steer").length,1);
  } finally { await session.terminate(); await sending; f.close(); }
});

test("Pi RPC settled checkpoints recover the exact native path with the existing identity guard", nativeOptions, async () => {
  const f = nativeFixture({auto: true}); let session: AdapterSession | undefined;
  try {
    session = await f.adapter().createSession(f.params);
    const first: any[] = []; await session.send("first", {turnId: "one", verbosity: "tools", emit: event => first.push(event)});
    assert.equal(first.at(-1).status, "completed");
    const saved = session.recoveryCheckpoint!() as any; assert.ok(saved); await session.terminate();
    session = await f.adapter().recoverSession(f.params, saved);
    const second: any[] = []; await session.send("next", {turnId: "two", verbosity: "tools", emit: event => second.push(event)});
    assert.equal(second.at(-1).status, "completed"); assert.equal(second.at(-1).text, "ORIGINAL next");
    const retained = session.recoveryCheckpoint!() as any;
    assert.equal(retained.native.sessionId, saved.native.sessionId); assert.equal(retained.native.path, saved.native.path);
    assert.equal(f.calls().filter(command => command.type === "prompt").length, 2);
  } finally { await session?.terminate(); f.close(); }
});

test("Pi help alone does not advertise steering for the older unverified RPC lifecycle", nativeOptions, () => {
  const f = nativeFixture({version: "0.70.6"});
  try { assert.equal(f.adapter().capabilities.injectMidTurn, false); }
  finally { f.close(); }
});

for(const [version,supported] of [["0.84.2",true],["0.85.0\nNative update notice",true],["\u001b[32mv1.0.0\u001b[0m",true],["0.84.0",false],["0.85.0-preview",false]] as const)
  test(`Pi minimum version preserves steering eligibility for ${JSON.stringify(version)}`,nativeOptions,()=>{
    const f=nativeFixture({version});try{assert.equal(f.adapter().capabilities.injectMidTurn,supported);}finally{f.close();}
  });

test("Pi RPC canonicalizes a configured native-home alias without relaxing its retained file identity", nativeOptions, async () => {
  const f = nativeFixture({auto: true}); let session: AdapterSession | undefined;
  try {
    const alias = join(f.root, "pi-alias"); symlinkSync(f.home, alias, "dir");
    process.env.PI_CODING_AGENT_DIR = alias;
    session = await f.adapter().createSession(f.params);
    const events: any[] = []; await session.send("original", {turnId: "one", verbosity: "tools", emit: event => events.push(event)});
    assert.equal(events.at(-1).status, "completed");
    const saved = session.recoveryCheckpoint!() as any; assert.ok(saved);
    assert.equal(saved.native.home, f.home); assert.equal(saved.native.path, realpathSync(saved.native.path));
    await session.terminate(); session = await f.adapter().recoverSession(f.params, saved);
    const next: any[] = []; await session.send("next", {turnId: "two", verbosity: "tools", emit: event => next.push(event)});
    assert.equal(next.at(-1).status, "completed");
    assert.equal((session.recoveryCheckpoint!() as any).native.path, saved.native.path);
  } finally { await session?.terminate(); f.close(); }
});
