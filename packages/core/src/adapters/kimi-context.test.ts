import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, linkSync, mkdirSync, readFileSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readKimiWireProof, type KimiWireIdentity } from "./kimi-context.js";
import { withPeerFixture } from "../testing/peer-fixture.js";

type Row = { timestamp: number; message: { type: string; payload: Record<string, unknown> } };
const posix = { skip: process.platform === "win32" };
async function fixture(work: (f: {
  root: string; directory: string; file: string; identity: KimiWireIdentity;
  row: (type: string, payload?: Record<string, unknown>) => Row;
  write: (rows: Row[], options?: { version?: string; tail?: string }) => void;
  begin: Row; step: Row; call: Row; result: Row; tool: NonNullable<KimiWireIdentity["tool"]>;
}) => Promise<void>) {
  return withPeerFixture("kimi-context", async scope => {
    const root = scope.root, shareDir = join(root, "share"), sessionId = randomUUID();
    const directory = join(shareDir, "sessions", createHash("md5").update(root).digest("hex"), sessionId);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const file = join(directory, "wire.jsonl"), timestamp = (Date.now() - 1000) / 1000;
    const identity: KimiWireIdentity = { nativeVersion: "1.40.0", shareDir, cwd: root, sessionId,
      prompt: "Original task", notBefore: timestamp * 1000 - 1 };
    const row = (type: string, payload: Record<string, unknown> = {}): Row => ({ timestamp, message: { type, payload } });
    const tool = { id: "original-root-call", name: "phonon_project_coordination", arguments: '{"operation":"peers"}' };
    const begin = row("TurnBegin", { user_input: identity.prompt }), step = row("StepBegin", { n: 1 });
    const call = row("ToolCall", { type: "function", id: tool.id, function: { name: tool.name, arguments: tool.arguments }, extras: null });
    const result = row("ToolResult", { tool_call_id: tool.id, return_value: { is_error: false, output: "result", message: "", display: [], extras: null } });
    const write = (rows: Row[], options: { version?: string; tail?: string } = {}) => writeFileSync(file,
      [JSON.stringify({ type: "metadata", protocol_version: options.version ?? "1.9" }), ...rows.map(value => JSON.stringify(value))].join("\n")
      + (options.tail ?? "\n"), { mode: 0o600 });
    await work({ root, directory, file, identity, row, write, begin, step, call, result, tool });
  });
}

test("Kimi root proof binds Wire 1.9, original input and a stable turn prefix, not model/permission/budget claims", posix, () => fixture(async f => {
  f.write([f.begin, f.step, f.row("ContentPart", { type: "text", text: "Native text" }), f.call]);
  const value = await readKimiWireProof(f.file, { ...f.identity, tool: f.tool });
  assert.ok(value); assert.equal(value.toolCallId, f.tool.id); assert.equal(value.step, 1);
  assert.match(value.turnId, /^[a-f0-9]{64}$/); assert.match(value.snapshotHash, /^[a-f0-9]{64}$/);
  assert.equal("budget" in value, false); assert.equal("completedText" in value, false); assert.equal("approved" in value, false);
  f.write([f.begin, f.step, f.call, f.result, f.row("StepBegin", { n: 2 })]);
  const next = await readKimiWireProof(f.file, { ...f.identity, turnId: value.turnId });
  assert.equal(next?.turnId, value.turnId); assert.equal(next?.step, 2); assert.notEqual(next?.snapshotHash, value.snapshotHash);
  assert.equal(await readKimiWireProof(f.file, { ...f.identity, tool: f.tool }), undefined);
}));

test("Kimi root tool proof requires the exact original ID, name and raw arguments without normalization", posix, () => fixture(async f => {
  f.write([f.begin, f.step, f.call]);
  for (const patch of [{ id: "other" }, { name: "other" }, { arguments: '{ "operation": "peers" }' }, { arguments: '{}' }]) {
    assert.equal(await readKimiWireProof(f.file, { ...f.identity, tool: { ...f.tool, ...patch } }), undefined);
  }
  for (const rows of [[f.begin, f.step, f.call, f.call], [f.begin, f.step, f.result], [f.begin, f.call],
    [f.begin, f.step, f.call, f.result, f.result], [f.begin, f.step, f.call, f.row("StepBegin", { n: 2 })]]) {
    f.write(rows); assert.equal(await readKimiWireProof(f.file, { ...f.identity, tool: f.tool }), undefined);
  }
  f.write([f.begin, f.step, f.call, { ...f.result, message: { ...f.result.message,
    payload: { tool_call_id: f.tool.id, return_value: { is_error: true } } } }]);
  assert.equal(await readKimiWireProof(f.file, { ...f.identity, tool: f.tool }), undefined);
  assert.ok(await readKimiWireProof(f.file, f.identity), "a handled native tool error does not manufacture a new user/authority");
}));

test("Kimi turn identity hashes the exact UTF-8 prefix and does not treat status estimates as request headroom", posix, () => fixture(async f => {
  const prompt="\u539f\u59cb\u4efb\u52a1",begin=f.row("TurnBegin",{user_input:prompt});
  f.write([begin,f.step,f.row("StatusUpdate",{context_tokens:1,max_context_tokens:1000000,context_usage:0.000001})]);
  const value=await readKimiWireProof(f.file,{...f.identity,prompt});assert.ok(value);
  const prefix=readFileSync(f.file,"utf8").split("\n").slice(0,2).join("\n")+"\n";
  assert.equal(value.turnId,createHash("sha256").update(prefix).digest("hex"));
  assert.equal("budget" in value,false);
}));

test("Kimi original prompt and turn fingerprint cannot be inherited by a repeated, foreign or rewritten turn", posix, () => fixture(async f => {
  f.write([f.begin, f.step]); const original = await readKimiWireProof(f.file, f.identity); assert.ok(original);
  for (const patch of [{ nativeVersion: "1.41.0" }, { sessionId: randomUUID() }, { cwd: f.identity.shareDir },
    { prompt: "Other task" }, { notBefore: Date.now() + 1000 }, { notBefore: NaN }, { turnId: "0".repeat(64) }]) {
    assert.equal(await readKimiWireProof(f.file, { ...f.identity, ...patch }), undefined);
  }
  f.write([{ ...f.begin, timestamp: f.begin.timestamp + 0.001 }, { ...f.step, timestamp: f.step.timestamp + 0.001 }]);
  assert.equal(await readKimiWireProof(f.file, { ...f.identity, turnId: original.turnId }), undefined);
  f.write([f.begin, f.step, f.row("TurnEnd"), f.begin, f.step]);
  assert.equal(await readKimiWireProof(f.file, f.identity), undefined, "two matching inputs after assignment are not one authority");
  const old = (value: Row) => ({ ...value, timestamp: value.timestamp - 10 });
  f.write([old(f.begin), old(f.step), old(f.row("TurnEnd")), f.begin, f.step]);
  assert.ok(await readKimiWireProof(f.file, f.identity));
}));

test("Kimi child events never supply root calls, status, completion or a parent lifetime", posix, () => fixture(async f => {
  const parent = f.row("ToolCall", { type: "function", id: "parent-task", function: { name: "Agent", arguments: '{"prompt":"child"}' } });
  const child = (event: Row, parentId = "parent-task") => f.row("SubagentEvent", {
    parent_tool_call_id: parentId, agent_id: "a12345678", subagent_type: "coder", event: event.message,
  });
  const returned = f.row("ToolResult", { tool_call_id: "parent-task", return_value: { is_error: false } });
  f.write([f.begin, f.step, parent, child(f.call), child(f.row("TurnEnd"))]);
  assert.equal(await readKimiWireProof(f.file, { ...f.identity, tool: f.tool }), undefined);
  assert.equal(await readKimiWireProof(f.file, f.identity), undefined, "child TurnEnd cannot close the parent Agent call");
  f.write([f.begin, f.step, parent, child(f.call), returned, f.call]);
  assert.equal((await readKimiWireProof(f.file, { ...f.identity, tool: f.tool }))?.toolCallId, f.tool.id);
  for (const rows of [[f.begin, f.step, child(f.call)], [f.begin, f.step, parent, child(f.call, "foreign-parent")],
    [f.begin, f.step, parent, returned, child(f.call)]]) {
    f.write(rows); assert.equal(await readKimiWireProof(f.file, f.identity), undefined);
  }
  const childApproval=f.row("ApprovalRequest",{id:"child-consent",tool_call_id:f.tool.id,
    source_kind:"foreground_turn",source_id:"child-source",agent_id:"a12345678",subagent_type:"coder"});
  f.write([f.begin,f.step,parent,child(f.call),childApproval,returned,f.call]);
  assert.equal(await readKimiWireProof(f.file,{...f.identity,tool:f.tool}),undefined,"unqualified child-forwarded requests cannot be promoted to root consent");
}));

test("Kimi pending native approvals/questions/hooks and denied calls cannot supply usable root proof", posix, () => fixture(async f => {
  const approval = f.row("ApprovalRequest", { id: "consent-1", tool_call_id: f.tool.id,
    source_kind: "foreground_turn", source_id: "original-turn", agent_id: null, subagent_type: null });
  const response = f.row("ApprovalResponse", { request_id: "consent-1", response: "approve", feedback: "" });
  const question = f.row("QuestionRequest", { id: "question-1", tool_call_id: f.tool.id, questions: [] });
  const triggered = f.row("HookTriggered", { event: "PreToolUse", target: f.tool.name, hook_count: 1 });
  const resolved = f.row("HookResolved", { event: "PreToolUse", target: f.tool.name, action: "allow", reason: "", duration_ms: 1 });
  for (const wait of [approval, question, triggered]) {
    f.write([f.begin, f.step, f.call, wait]); assert.equal(await readKimiWireProof(f.file, f.identity), undefined);
  }
  f.write([f.begin, f.step, f.call, approval, response]);
  assert.ok(await readKimiWireProof(f.file, { ...f.identity, tool: f.tool }));
  f.write([f.begin, f.step, f.call, triggered, resolved]); assert.ok(await readKimiWireProof(f.file, f.identity));
  for (const rows of [[f.begin, f.step, f.call, response], [f.begin, f.step, f.call, approval, approval],
    [f.begin, f.step, f.call, approval, { ...response, message: { ...response.message, payload: { request_id: "consent-1", response: "reject" } } }],
    [f.begin, f.step, f.call, triggered, { ...resolved, message: { ...resolved.message, payload: { ...resolved.message.payload, action: "block" } } }],
    [f.begin, f.step, f.call, question, question]]) {
    f.write(rows); assert.equal(await readKimiWireProof(f.file, f.identity), undefined);
  }
  f.write([f.begin, f.step, f.call, question, f.result, f.row("StepBegin", { n: 2 })]);
  assert.ok(await readKimiWireProof(f.file, f.identity));
}));

for (const type of ["TurnEnd", "SteerInput", "StepInterrupted", "CompactionBegin", "CompactionEnd", "BtwBegin", "BtwEnd", "HookRequest", "ToolCallRequest", "UnknownEvent"]) {
  test(`Kimi ${type} invalidates the old current-turn proof rather than granting completion/authority`, posix, () => fixture(async f => {
    f.write([f.begin, f.step, f.call, f.row(type)]);
    assert.equal(await readKimiWireProof(f.file, f.identity), undefined);
    assert.equal(await readKimiWireProof(f.file, { ...f.identity, tool: f.tool }), undefined);
  }));
}

test("Kimi metadata, partial JSONL, timestamp/order and payload corruption fail closed", posix, () => fixture(async f => {
  for (const version of ["1.1", "1.8", "2.0"]) {
    f.write([f.begin, f.step], { version }); assert.equal(await readKimiWireProof(f.file, f.identity), undefined);
  }
  f.write([f.begin, f.step], { tail: "" }); assert.equal(await readKimiWireProof(f.file, f.identity), undefined);
  f.write([f.begin, f.step]); const original = readFileSync(f.file);
  for (const bytes of [Buffer.concat([original, Buffer.from('{"timestamp":')]), Buffer.concat([original, Buffer.from([0xff, 10])])]) {
    writeFileSync(f.file, bytes); assert.equal(await readKimiWireProof(f.file, f.identity), undefined);
  }
  for (const rows of [[f.begin, { ...f.step, timestamp: f.begin.timestamp - 1 }],
    [f.begin, { ...f.step, timestamp: Date.now() / 1000 + 10 }], [f.begin, f.row("StepBegin", { n: 2 })],
    [f.begin, f.row("StepBegin", { n: 0 })], [f.begin, f.row("StepBegin", { n: 1.5 })],
    [f.begin, f.step, f.row("ToolCall", { ...f.call.message.payload, function: { name: f.tool.name, arguments: "null" } })]]) {
    f.write(rows); assert.equal(await readKimiWireProof(f.file, f.identity), undefined);
  }
}));

test("Kimi local original-root file proof refuses aliases, child paths, links, writable ownership and oversized logs", posix, () => fixture(async f => {
  f.write([f.begin, f.step]);
  const alias = join(f.root, "alias.jsonl"); symlinkSync(f.file, alias);
  assert.equal(await readKimiWireProof(alias, f.identity), undefined);
  const hardlink = join(f.root, "hardlink"); linkSync(f.file, hardlink);
  assert.equal(await readKimiWireProof(f.file, f.identity), undefined); unlinkSync(hardlink);
  const child = join(f.directory, "subagents", "child"); mkdirSync(child, { recursive: true, mode: 0o700 });
  const childFile = join(child, "wire.jsonl"); writeFileSync(childFile, readFileSync(f.file), { mode: 0o600 });
  assert.equal(await readKimiWireProof(childFile, f.identity), undefined);
  chmodSync(f.file, 0o666); assert.equal(await readKimiWireProof(f.file, f.identity), undefined); chmodSync(f.file, 0o600);
  chmodSync(f.directory, 0o777); assert.equal(await readKimiWireProof(f.file, f.identity), undefined); chmodSync(f.directory, 0o700);
  const saved = join(f.root, "saved.jsonl"); renameSync(f.file, saved); symlinkSync(saved, f.file);
  assert.equal(await readKimiWireProof(f.file, f.identity), undefined); unlinkSync(f.file); renameSync(saved, f.file);
  const directoryAlias=join(f.root,"saved-session");renameSync(f.directory,directoryAlias);symlinkSync(directoryAlias,f.directory);
  assert.equal(await readKimiWireProof(f.file,f.identity),undefined);unlinkSync(f.directory);renameSync(directoryAlias,f.directory);
  f.write([f.begin, f.step, f.row("Notification", { body: "x".repeat(4 * 1024 * 1024) })]);
  assert.equal(await readKimiWireProof(f.file, f.identity), undefined);
  f.write([f.begin, f.step, ...Array.from({ length: 8192 }, () => f.row("StatusUpdate"))]);
  assert.equal(await readKimiWireProof(f.file, f.identity), undefined);
}));
