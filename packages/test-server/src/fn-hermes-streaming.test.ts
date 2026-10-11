import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { HermesAdapter, HERMES_BRIDGE } from "@agent-phonon/core";

/**
 * Hermes streaming (2026-10-11).
 *
 * Hermes' own `run_conversation` has always accepted `stream_callback` (fired
 * with each text delta). The bridge now chains onto whatever callback the CLI
 * already installed, so phonon sees deltas without breaking Hermes' own TTS queue.
 */

test("hermes bridge is valid Python (a syntax error would break hermes outright)", () => {
  const dir = mkdtempSync(join(tmpdir(), "phonon-hermes-bridge-"));
  try {
    const file = join(dir, "bridge.py");
    writeFileSync(file, HERMES_BRIDGE, "utf8");
    // py_compile raises SystemExit(1) on SyntaxError; it does not import hermes.
    execFileSync("python3", ["-m", "py_compile", file], { stdio: "pipe" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("hermes bridge emits a text delta event and chains the caller's callback", () => {
  // The CLI passes its own stream_callback (TTS text_queue), so phonon must chain
  // rather than replace, or Hermes' own behaviour regresses.
  assert.match(HERMES_BRIDGE, /hermes_text_delta/, "bridge must emit text deltas");
  assert.match(HERMES_BRIDGE, /existing = kwargs\.get\("stream_callback"\)/);
  assert.match(HERMES_BRIDGE, /if callable\(existing\):\s*\n\s*existing\(delta\)/, "must still invoke the caller's callback");
});

test("hermes bridge handles both positional and keyword stream_callback forms", () => {
  // run_conversation signature: (user_message, system_message, conversation_history,
  // task_id, stream_callback, persist_user_message) — so args[4] is the callback.
  assert.match(HERMES_BRIDGE, /len\(args\) >= 5/, "must locate the positional slot");
  assert.match(HERMES_BRIDGE, /args\[4\] = chained/, "must rewrite the positional slot");
  assert.match(HERMES_BRIDGE, /kwargs\["stream_callback"\] = chained/, "must inject when absent");
});

test("hermes bridge still buffers tool messages until the run completes", () => {
  // Tool events come from the post-run result scan, not the delta callback.
  // This is the nuance the rescue knowledge records.
  const deltaAt = HERMES_BRIDGE.indexOf("hermes_text_delta");
  const toolAt = HERMES_BRIDGE.indexOf("hermes_tool_call");
  const runAt = HERMES_BRIDGE.indexOf("result = native_run");
  assert.ok(deltaAt > 0 && toolAt > 0 && runAt > 0);
  assert.ok(deltaAt < runAt, "text delta is emitted during the run");
  assert.ok(toolAt > runAt, "tool call is only emitted after the run returns");
});

test("hermes adapter now advertises streaming", () => {
  const caps = new HermesAdapter().capabilities;
  assert.equal(caps.streaming, true, "hermes streams text deltas via the native callback");
});