import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, symlinkSync, linkSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { readClaudeContext, type ClaudeContextIdentity } from "./claude-context.js";
import { withPeerFixture } from "../testing/peer-fixture.js";

async function fixture(work: (f: any) => Promise<void>) {
  return withPeerFixture("claude-context", async scope => {
    const home = join(scope.root, "home"), directory = join(home, "projects", "fixture"), sessionId = randomUUID(), userId = randomUUID();
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const file = join(directory, sessionId + ".jsonl"), model = "claude-sonnet-4-5-20250929", now = Date.now();
    const base = { isSidechain: false, userType: "external", cwd: scope.root, sessionId, version: "2.0.1", timestamp: new Date(now).toISOString() };
    const user = { ...base, type: "user", uuid: userId, parentUuid: null, message: { role: "user", content: "Original task" } };
    const assistant = { ...base, type: "assistant", uuid: randomUUID(), parentUuid: userId, message: { role: "assistant", model, stop_reason: "tool_use",
      usage: { input_tokens: 100, output_tokens: 20, cache_creation_input_tokens: 30, cache_read_input_tokens: 40 }, content: [{ type: "tool_use", id: "native-read", name: "Read", input: { file_path: "/fixture" } }] } };
    const result = { ...base, type: "user", uuid: randomUUID(), parentUuid: assistant.uuid, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "native-read", content: "Native bytes" }] } };
    const final = { ...base, type: "assistant", uuid: randomUUID(), parentUuid: result.uuid, message: { role: "assistant", model, stop_reason: "end_turn",
      usage: assistant.message.usage, content: [{ type: "text", text: "Native final" }] } };
    const identity: ClaudeContextIdentity = { home, cwd: scope.root, sessionId, model, prompt: "Original task", notBefore: now - 1, outputReserve: 32000 };
    const write = (rows: any[], tail = "\n") => writeFileSync(file, rows.map(row => JSON.stringify(row)).join("\n") + tail, { mode: 0o600 });
    await work({ scope, home, file, identity, base, user, assistant, result, final, write });
  });
}

test("Claude transcript source binds exact original user UUID, native model/usage and parent chain", () => fixture(async f => {
  f.write([f.user, f.assistant]);
  const value = await readClaudeContext(f.file, { ...f.identity, tool: { name: "Read", input: { file_path: "/fixture" }, phase: "after" } });
  assert.equal(value?.userMessageId, f.user.uuid); assert.equal(value?.toolCallId, "native-read");
  assert.equal(value?.budget.state, "known"); if (value?.budget.state === "known") assert.equal(value.budget.inputTokens, 194);
  f.write([f.user, f.assistant, f.result, f.final]);
  assert.equal((await readClaudeContext(f.file, { ...f.identity, userMessageId: f.user.uuid }))?.completedText, "Native final");
  assert.equal(await readClaudeContext(f.file, { ...f.identity, tool: { name: "Read", input: { file_path: "/fixture" }, phase: "after" } }), undefined);
}));

test("Claude source validation preserves native context across compatible upgrades", () => fixture(async f => {
  for(const version of ["2.0.2","2.1.0","3.0.0"]){
    f.write([f.user,f.assistant,f.result,f.final].map(row=>({...row,version})));
    assert.equal((await readClaudeContext(f.file,{...f.identity,userMessageId:f.user.uuid}))?.completedText,"Native final");
  }
  for(const version of ["2.0.0","2.1.0-preview","unknown"]){
    f.write([f.user,f.assistant,f.result,f.final].map(row=>({...row,version})));
    assert.equal(await readClaudeContext(f.file,{...f.identity,userMessageId:f.user.uuid}),undefined);
  }
}));

test("Claude transcript completion cannot use stale, foreign, incomplete or error results", () => fixture(async f => {
  for (const patch of [{ sessionId: randomUUID() }, { version: "other" }, { cwd: "/" }, { parentUuid: randomUUID() }, { uuid: f.user.uuid }, { timestamp: "invalid" },
    { message: { ...f.final.message, model: "foreign" } }, { isApiErrorMessage: true }]) {
    f.write([f.user, f.assistant, f.result, { ...f.final, ...patch }]); assert.equal(await readClaudeContext(f.file, f.identity), undefined);
  }
  f.write([f.user, f.assistant, f.result, f.final], ""); assert.equal(await readClaudeContext(f.file, f.identity), undefined);
  f.write([f.user, f.assistant, f.result, f.final]);
  for (const patch of [{ userMessageId: randomUUID() }, { prompt: "Other input" }, { notBefore: Date.now() + 10000 }, { sessionId: randomUUID() }]) assert.equal(await readClaudeContext(f.file, { ...f.identity, ...patch }), undefined);
  f.write([f.user, f.assistant, { ...f.result, message: { ...f.result.message, content: [{ ...f.result.message.content[0], is_error: true }] } }, f.final]);
  assert.equal((await readClaudeContext(f.file, f.identity))?.completedText, "Native final", "A handled tool failure does not invalidate a later native completed reply");
}));

test("Claude later original input, compaction and delegated transcript cannot inherit previous authority", () => fixture(async f => {
  f.write([f.user, f.assistant, f.result, f.final, { ...f.user, uuid: randomUUID(), parentUuid: f.final.uuid }]);
  assert.equal(await readClaudeContext(f.file, { ...f.identity, userMessageId: f.user.uuid }), undefined);
  f.write([f.user, f.assistant, { ...f.base, uuid: randomUUID(), parentUuid: f.assistant.uuid, type: "system", subtype: "compact_boundary" }]);
  assert.equal(await readClaudeContext(f.file, f.identity), undefined);
  f.write([f.user, { ...f.assistant, isSidechain: true }]); assert.equal((await readClaudeContext(f.file, f.identity))?.completedText, undefined);
  assert.equal(await readClaudeContext(f.file,{...f.identity,tool:{name:"Read",input:{file_path:"/fixture"},phase:"after"}}),undefined);
  f.write([f.user,f.assistant,{...f.final,uuid:randomUUID(),isSidechain:true,parentUuid:null},f.result,f.final]);assert.equal((await readClaudeContext(f.file,f.identity))?.completedText,"Native final");
}));

test("Claude tool proof requires one exact current native call and never a returned/failed/repeated call", () => fixture(async f => {
  const tool = { name: "Read", input: { file_path: "/fixture" }, phase: "before" as const };
  f.write([f.user, f.assistant]); assert.equal((await readClaudeContext(f.file, { ...f.identity, tool }))?.toolCallId, "native-read");
  for (const patch of [{ id: "foreign" }, { name: "Bash" }, { input: {} }]) assert.equal(await readClaudeContext(f.file, { ...f.identity, tool: { ...tool, ...patch } }), undefined);
  f.write([f.user, f.assistant, f.result]); assert.equal(await readClaudeContext(f.file, { ...f.identity, tool }), undefined);
  const other = { ...f.assistant, parentUuid: f.result.uuid, uuid: randomUUID(), message: { ...f.assistant.message, content: [{ ...f.assistant.message.content[0], id: "next-read" }] } };
  f.write([f.user, f.assistant, f.result, other]);
  assert.equal(await readClaudeContext(f.file, { ...f.identity, tool: { ...tool, phase: "after" } }), undefined, "Ambiguous repeated name/input needs exact native ID");
  assert.equal((await readClaudeContext(f.file, { ...f.identity, tool: { ...tool, phase: "after", id: "next-read" } }))?.toolCallId, "next-read");
}));

test("Claude unknown budgets and linked/oversized files are never promoted to runtime authority", () => fixture(async f => {
  f.write([f.user, { ...f.assistant, message: { ...f.assistant.message, usage: { input_tokens: 100 } } }]);
  assert.equal((await readClaudeContext(f.file, f.identity))?.budget.state, "unknown");
  f.write([f.user, f.assistant]); assert.equal((await readClaudeContext(f.file, { ...f.identity, outputReserve: undefined }))?.budget.state, "unknown");
  const alias = join(f.scope.root, "linked.jsonl"); symlinkSync(f.file, alias); assert.equal(await readClaudeContext(alias, f.identity), undefined);
  linkSync(f.file, join(f.scope.root, "hardlink")); assert.equal(await readClaudeContext(f.file, f.identity), undefined);
  f.write([f.user, { ...f.assistant, large: "x".repeat(1024 * 1024) }]); assert.equal(await readClaudeContext(f.file, f.identity), undefined);
}));

test("Claude command hooks cannot confuse child/root identical arguments while delegation remains pending",()=>fixture(async f=>{
  const task={...f.assistant,parentUuid:f.assistant.uuid,uuid:randomUUID(),message:{...f.assistant.message,content:[{type:"tool_use",id:"root-task",name:"Task",input:{prompt:"Child read"}}]}};
  f.write([f.user,f.assistant,task]);
  assert.equal(await readClaudeContext(f.file,{...f.identity,tool:{name:"Read",input:{file_path:"/fixture"},phase:"after"}}),undefined);
  assert.equal(await readClaudeContext(f.file,{...f.identity,tool:{name:"Task",input:{prompt:"Child read"},phase:"after"}}),undefined);
}));
