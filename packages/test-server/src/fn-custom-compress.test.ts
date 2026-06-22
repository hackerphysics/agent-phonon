import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dropToolIOFromJsonlFiles } from "@agent-phonon/core";

test("custom compress dropToolIO removes structured tool blocks but preserves text", async () => {
  const dir = mkdtempSync(join(tmpdir(), "phonon-compress-"));
  const file = join(dir, "s.jsonl");
  const rows = [
    { type: "message", message: { role: "assistant", content: [{ type: "text", text: "keep text" }, { type: "tool_use", id: "t1", name: "read", input: { path: "x" } }] } },
    { type: "message", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "huge output" }, { type: "text", text: "also keep" }] } },
  ];
  writeFileSync(file, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  const r = await dropToolIOFromJsonlFiles([file], { keepRecentToolCalls: 0 });
  assert.equal(r.filesChanged, 1);
  assert.equal(r.blocksRemoved, 2);
  assert.equal(r.recordsChanged, 2);
  assert.equal(r.backups.length, 1);
  const text = readFileSync(file, "utf8");
  assert.ok(text.includes("keep text"));
  assert.ok(text.includes("also keep"));
  assert.equal(text.includes("tool_use"), false);
  assert.equal(text.includes("tool_result"), false);
  assert.equal(text.includes("huge output"), false);
});

test("custom compress dropToolIO keeps recent tool calls/results while preserving mixed text", async () => {
  const dir = mkdtempSync(join(tmpdir(), "phonon-compress-"));
  const file = join(dir, "s.jsonl");
  const rows = [
    { type: "message", message: { role: "assistant", content: [{ type: "text", text: "before old" }, { type: "tool_use", id: "old", name: "read", input: { path: "old" } }, { type: "text", text: "after old" }] } },
    { type: "message", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "old", content: "old output" }] } },
    { type: "message", message: { role: "assistant", content: [{ type: "text", text: "before new" }, { type: "tool_use", id: "new", name: "read", input: { path: "new" } }, { type: "text", text: "after new" }] } },
    { type: "message", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "new", content: "new output" }] } },
  ];
  writeFileSync(file, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  const r = await dropToolIOFromJsonlFiles([file], { keepRecentToolCalls: 1 });
  assert.equal(r.blocksRemoved, 2);
  const text = readFileSync(file, "utf8");
  assert.ok(text.includes("before old"));
  assert.ok(text.includes("after old"));
  assert.ok(text.includes("before new"));
  assert.ok(text.includes("after new"));
  assert.equal(text.includes("old output"), false);
  assert.equal(text.includes('"id":"old"'), false);
  assert.ok(text.includes('"id":"new"'));
  assert.ok(text.includes("new output"));
});

test("custom compress dropToolIO keeps recent tool blocks even when they have no id (item 3)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "phonon-compress-"));
  const file = join(dir, "s.jsonl");
  // Trajectory-style: tool blocks WITHOUT ids. Old must drop, most-recent must stay.
  const rows = [
    { type: "tool_call", toolName: "read", args: { path: "OLD_CALL" } },
    { type: "tool_result", output: "OLD_RESULT" },
    { type: "text", text: "keep narration" },
    { type: "tool_call", toolName: "read", args: { path: "NEW_CALL" } },
    { type: "tool_result", output: "NEW_RESULT" },
  ];
  writeFileSync(file, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  const r = await dropToolIOFromJsonlFiles([file], { keepRecentToolCalls: 1 });
  const text = readFileSync(file, "utf8");
  // narration preserved
  assert.ok(text.includes("keep narration"));
  // old call + old result dropped
  assert.equal(text.includes("OLD_CALL"), false);
  assert.equal(text.includes("OLD_RESULT"), false);
  // most-recent call + its result kept despite having no id (position-based keep)
  assert.ok(text.includes("NEW_CALL"));
  assert.ok(text.includes("NEW_RESULT"));
  assert.equal(r.blocksRemoved, 2);
});

test("custom compress dropToolIO drops Codex function_call/function_call_output records", async () => {
  const dir = mkdtempSync(join(tmpdir(), "phonon-compress-"));
  const file = join(dir, "rollout.jsonl");
  // Codex rollout shape: response_item wrapping function_call payloads.
  const rows = [
    { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "reasoning kept" }] } },
    { type: "response_item", payload: { type: "function_call", name: "shell", arguments: "{}", call_id: "c1" } },
    { type: "response_item", payload: { type: "function_call_output", call_id: "c1", output: "BIG_TOOL_OUTPUT" } },
  ];
  writeFileSync(file, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  const r = await dropToolIOFromJsonlFiles([file], { keepRecentToolCalls: 0 });
  const text = readFileSync(file, "utf8");
  assert.ok(text.includes("reasoning kept"));
  assert.equal(text.includes("function_call"), false);
  assert.equal(text.includes("BIG_TOOL_OUTPUT"), false);
  assert.equal(r.blocksRemoved, 2);
});
