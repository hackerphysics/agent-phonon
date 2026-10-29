import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { CodexAppServer } from "./codex-app-server.js";
import { withPeerFixture } from "../testing/peer-fixture.js";

const fakeSource = String.raw`
import {createInterface}from"node:readline";
const send=value=>process.stdout.write(JSON.stringify(value)+"\n");
let starts=0,steers=0,replies=[];
for await(const line of createInterface({input:process.stdin})){
 const f=JSON.parse(line),reply=result=>send({id:f.id,result}),event=(method,params)=>send({method,params});
 if(!f.method){replies.push(f);continue;}
 if(f.method==="initialize")reply({});
 else if(f.method==="initialized"){}
 else if(f.method==="thread/start")reply({thread:{id:"native-thread",cwd:process.cwd()}});
 else if(f.method==="turn/start"){
  starts++;reply({turn:{id:"native-turn",status:"inProgress"}});
  event("turn/started",{threadId:"native-thread",turn:{id:"native-turn",status:"inProgress"}});
  event("item/completed",{threadId:"native-thread",turnId:"native-turn",item:{type:"userMessage",id:"original",clientId:f.params.clientUserMessageId,content:f.params.input}});
 }else if(f.method==="turn/steer"){
  steers++;const mode=process.env.FAKE_MODE;
  const observed=()=>event("item/completed",{threadId:mode==="wrong-thread"?"foreign":"native-thread",turnId:"native-turn",item:{type:"userMessage",id:"steered-"+steers,
   clientId:mode==="wrong-client"?"foreign":f.params.clientUserMessageId,content:mode==="wrong-text"?[{type:"text",text:"different"}]:f.params.input}});
  if(mode==="rejected"){send({id:f.id,error:{code:-32600,message:"native rejected input"}});continue;}
  if(mode==="hold")continue;
  if(mode==="event-first")observed();
  reply({turnId:mode==="wrong-turn"?"foreign":"native-turn"});
  if(!["ack-only","wrong-turn","event-first"].includes(mode))observed();
 }else if(f.method==="test/push"){
  for(const item of f.params.frames)send(item);reply({});
 }else if(f.method==="test/stats")reply({starts,steers,replies});
 else if(f.method==="test/spoof"){
  send({id:f.id,method:"native/foreign",params:{threadId:"foreign",turnId:"native-turn"}});reply({actual:true});
 }else if(f.method==="test/malformed")process.stdout.write("not JSON\n");
}
`;

async function fixture(mode: string, work: (f: { channel: CodexAppServer; events: any[]; failures: Error[]; requests: any[] }) => Promise<void>) {
  await withPeerFixture("codex-native-rpc", async scope => {
    const bin = join(scope.root, "native.mjs"), events: any[] = [], failures: Error[] = [], requests: any[] = [];
    writeFileSync(bin, "#!" + process.execPath + "\n" + fakeSource, { mode: 0o700 });
    const channel = new CodexAppServer({ bin, args: [], cwd: scope.root, env: { PATH: process.env.PATH, FAKE_MODE: mode },
      onRuntime: runtime => scope.watch(runtime.child, true), notify: value => events.push(value), failed: error => failures.push(error),
      request: async frame => { requests.push(frame); return { answered: true }; } });
    scope.defer(() => channel.close());
    await channel.initialize();
    const thread = await channel.rpc("thread/start", {}); channel.bindThread(thread.thread);
    const clientUserMessageId = channel.arm("phonon-turn", "original prompt");
    channel.acceptStart(await channel.rpc("turn/start", { threadId: "native-thread", clientUserMessageId, input: [{ type: "text", text: "original prompt" }] }));
    await channel.rpc("test/stats", {});
    await work({ channel, events, failures, requests });
  });
}

for (const mode of ["normal", "event-first"]) test(`Codex native steering correlates exact current-turn input (${mode})`, () => fixture(mode, async f => {
  await Promise.all([f.channel.insert("same input", { turnId: "phonon-turn", signal: new AbortController().signal }),
    f.channel.insert("same input", { turnId: "phonon-turn", signal: new AbortController().signal })]);
  const stats = await f.channel.rpc("test/stats", {});
  assert.equal(stats.starts, 1); assert.equal(stats.steers, 2);
  assert.deepEqual(f.failures, []);
}));

for (const mode of ["ack-only", "wrong-thread", "wrong-client", "wrong-text", "hold"]) test(`Codex native ${mode} cannot claim applied input`, () => fixture(mode, async f => {
  const abort = new AbortController(); let settled = false;
  const inserted = f.channel.insert("required input", { turnId: "phonon-turn", signal: abort.signal });
  void inserted.then(() => { settled = true; }, () => { settled = true; });
  await f.channel.rpc("test/stats", {}); await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false); abort.abort(); await assert.rejects(inserted);
  assert.equal((await f.channel.rpc("test/stats", {})).starts, 1);
}));

for (const mode of ["wrong-turn", "rejected"]) test(`Codex native ${mode} refuses insertion without replacement work`, () => fixture(mode, async f => {
  await assert.rejects(f.channel.insert("input", { turnId: "phonon-turn", signal: new AbortController().signal }));
  assert.equal((await f.channel.rpc("test/stats", {})).starts, 1);
}));

test("Codex native authority is rechecked before releasing an insertion", () => fixture("normal", async f => {
  await assert.rejects(f.channel.insert("not authorized", { turnId: "phonon-turn", signal: new AbortController().signal,
    beforeApply() { throw new Error("revoked"); } }), /revoked/);
  const stats = await f.channel.rpc("test/stats", {}); assert.equal(stats.steers, 0);
  await assert.rejects(f.channel.insert("wrong turn", { turnId: "other", signal: new AbortController().signal }));
}));

test("Codex native terminal closes pending input and never turns it into another prompt", () => fixture("ack-only", async f => {
  const inserted = f.channel.insert("late input", { turnId: "phonon-turn", signal: new AbortController().signal });
  const rejected = assert.rejects(inserted);
  await f.channel.rpc("test/push", { frames: [{ method: "turn/completed", params: { threadId: "native-thread", turn: { id: "native-turn", status: "completed", items: [] } } }] });
  await rejected;
  await assert.rejects(f.channel.insert("future", { turnId: "phonon-turn", signal: new AbortController().signal }));
  assert.equal((await f.channel.rpc("test/stats", {})).starts, 1);
}));

test("Codex native foreign requests and response-ID spoofing cannot borrow the root turn", () => fixture("normal", async f => {
  assert.deepEqual(await f.channel.rpc("test/spoof", {}), { actual: true });
  await f.channel.rpc("test/push", { frames: [{ id: 7, method: "native/request", params: { threadId: "native-thread", turnId: "native-turn" } },
    { id: 8, method: "native/request", params: { threadId: "native-thread", turnId: "other" } }] });
  await new Promise(resolve => setImmediate(resolve));
  const stats = await f.channel.rpc("test/stats", {});
  assert.equal(f.requests.length, 1);
  assert.ok(stats.replies.some((reply: any) => reply.id === 8 && reply.error));
}));
