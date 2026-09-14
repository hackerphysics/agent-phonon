import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenCodeAdapter, HermesAdapter } from "@agent-phonon/core";
import { parseHermesConfig } from "../../core/dist/adapters/hermes.js";
import { claudeSettingsEnvironment } from "../../core/dist/adapters/claude-code.js";

// Protocol parser fixtures only; the separate acceptance suite uses real native agents.
test("OpenCode 1.14 ToolPart: completed-only, phases, ids, exact output, errors and cancel", async () => {
  const adapter = new OpenCodeAdapter();
  const session = await adapter.createSession({ sessionId: "s", agentId: "opencode", model: "default", cwd: tmpdir() });
  const tools = new Map(); const events: any[] = [];
  const feed = (status: string, id = "native-call", output: unknown = "完整\noutput") => (session as any).handleEvent({ type: "tool_use", part: { id: "NOT-CALL-ID", callID: id, tool: "read", state: { status, input: { filePath: "/tmp/fixture" }, output, error: "native tool error" } } }, "t", (e: any) => events.push(e), () => {}, tools);
  feed("pending"); assert.equal(events.length, 0);
  feed("running"); feed("running"); feed("completed"); feed("completed");
  assert.deepEqual(events.map(e => e.type), ["tool_call", "tool_result"]);
  assert.equal(events[0].toolCallId, "native-call"); assert.deepEqual(events[0].args, { filePath: "/tmp/fixture" });
  assert.equal(events[1].toolCallId, events[0].toolCallId); assert.equal(events[1].output, "完整\noutput");
  feed("completed", "final-only", ""); assert.equal(events.at(-1).output, "");
  feed("error", "failed"); assert.equal(events.at(-1).ok, false); assert.equal(events.at(-1).output, "native tool error");
  feed("cancelled", "cancel"); assert.equal(events.at(-1).ok, false);
});

test("Hermes discovery parses real YAML shapes, quoted values and inline maps", () => {
  const root = mkdtempSync(join(tmpdir(), "phonon-hermes-yaml-"));
  try {
    const p = join(root, "config.yaml");
    writeFileSync(p, 'model: {default: "qwen:local", provider: localQwen}\nproviders:\n  localQwen: {api: "http://127.0.0.1:4000/v1", key_env: EXAMPLE_REF}\n');
    assert.deepEqual(parseHermesConfig(p), { defaultModel: "qwen:local", provider: "localQwen", catalogUrl: undefined });
    writeFileSync(p, 'model: plain-model\n'); assert.equal(parseHermesConfig(p).defaultModel, "plain-model");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Claude selected settings replace old endpoint/auth/model environment without mutating files", () => {
  const root = mkdtempSync(join(tmpdir(), "phonon-claude-settings-"));
  try {
    const p = join(root, "standalone.json"); const body = JSON.stringify({ env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:4000", ANTHROPIC_API_KEY: "unit-placeholder", ANTHROPIC_MODEL: "local" } });
    writeFileSync(p, body);
    const env = claudeSettingsEnvironment({ settingsPath: p, defaultModel: "old-model", baseUrl: "https://old.invalid", authToken: "old-fixture-token" }, { HOME: root, ANTHROPIC_AUTH_TOKEN: "old-fixture-token", ANTHROPIC_MODEL: "old", CLAUDE_CODE_OAUTH_TOKEN: "old-fixture-oauth", CLAUDE_CODE_USE_BEDROCK: "1" });
    assert.equal(env.ANTHROPIC_BASE_URL, "http://127.0.0.1:4000"); assert.equal(env.ANTHROPIC_API_KEY, "unit-placeholder");
    assert.equal(env.ANTHROPIC_AUTH_TOKEN, undefined); assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, undefined); assert.equal(env.CLAUDE_CODE_USE_BEDROCK, undefined); assert.equal(env.ANTHROPIC_MODEL, "local");
    writeFileSync(p, JSON.stringify({ env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:4000" } }));
    assert.throws(() => claudeSettingsEnvironment({ settingsPath: p, defaultModel: "default" }, {}), /own auth/);
    assert.throws(() => claudeSettingsEnvironment({ settingsPath: "relative.json", defaultModel: "default" }, {}), /absolute/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Hermes native structured exit0 failure is not success; normal 404 prose is success; no output fails", { skip: !existsSync("/usr/bin/python3") }, async () => {
  const root = mkdtempSync(join(tmpdir(), "phonon-hermes-native-contract-"));
  try {
    mkdirSync(join(root, "hermes_cli"));
    writeFileSync(join(root, "hermes"), "#!/usr/bin/python3\n");
    writeFileSync(join(root, "hermes_cli", "__init__.py"), "");
    writeFileSync(join(root, "hermes_cli", "config.py"), "def load_config(): return {}\n");
    writeFileSync(join(root, "hermes_cli", "main.py"), "def main():\n from run_agent import AIAgent\n AIAgent().run_conversation()\n");
    const adapter = new HermesAdapter({ env: { binPath: join(root, "hermes") } });
    for (const [name, result, expected] of [
      ["error", { completed: false, failed: true, error: "HTTP 404 missing model", final_response: "native error text" }, "failed"],
      ["normal", { completed: true, final_response: "HTTP 404 is documentation" }, "completed"],
      ["empty", { completed: true, final_response: "" }, "failed"],
      ["partial", { completed: false, partial: true, final_response: "partial" }, "failed"],
      ["cancel", { completed: false, interrupted: true, final_response: "partial" }, "interrupted"],
      ["tools", { completed: true, final_response: "marker", messages: [{ role: "assistant", tool_calls: [{ id: "real-id", function: { name: "read_file", arguments: '{"path":"/fixture"}' } }] }, { role: "tool", tool_call_id: "real-id", content: '{"content":"marker"}' }] }, "completed"],
    ] as const) {
      writeFileSync(join(root, "run_agent.py"), `import json\nclass AIAgent:\n def run_conversation(self,*a,**kw): return json.loads(${JSON.stringify(JSON.stringify(result))})\n`);
      const session = await adapter.createSession({ sessionId: `s-${name}`, agentId: "hermes:default", model: "default", cwd: tmpdir() });
      const events: any[] = [];
      await session.send("fixture", { turnId: "t", verbosity: "tools", emit: e => events.push(e) });
      assert.equal(events.at(-1)?.status, expected, JSON.stringify(events)); assert.equal(events.filter(e => e.final).length, 1);
      if (name === "tools") { assert.equal(events[0].toolCallId, "real-id"); assert.equal(events[1].toolCallId, "real-id"); assert.equal(events[1].output, '{"content":"marker"}'); }
      await session.terminate();
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("OpenCode JSONL chunking preserves UTF-8, flushes EOF and abort has one terminal", async () => {
  const root = mkdtempSync(join(tmpdir(), "phonon-opencode-stream-"));
  try {
    const bin = join(root, "opencode-fixture");
    const native = [
      { type: "tool_use", part: { tool: "read", callID: "native-utf8", state: { status: "completed", input: { filePath: "fixture" }, output: "中😀\nactual" } } },
      { type: "text", part: { text: "最终😀" } }, { type: "step_finish" },
    ];
    writeFileSync(bin, `#!${process.execPath}\nconst b=Buffer.from(${JSON.stringify(native.map(x => JSON.stringify(x)).join("\n"))});for(let i=0;i<b.length;i++)process.stdout.write(b.subarray(i,i+1));\n`, { mode: 0o700 });
    const adapter = new OpenCodeAdapter({ env: { binPath: bin } });
    const session = await adapter.createSession({ sessionId: "s-utf8", agentId: "opencode", model: "default", cwd: root });
    const events: any[] = [];
    await session.send("fixture", { turnId: "t", verbosity: "tools", emit: e => events.push(e) });
    assert.equal(events.find(e => e.type === "tool_result").output, "中😀\nactual"); assert.equal(events.at(-1).text, "最终😀"); assert.equal(events.at(-1).status, "completed");
    writeFileSync(bin, `#!${process.execPath}\nsetInterval(()=>{},1000);\n`, { mode: 0o700 });
    const abort = new AbortController(); const cancelled: any[] = [];
    const pending = session.send("fixture", { turnId: "cancel", verbosity: "tools", signal: abort.signal, emit: e => cancelled.push(e) });
    abort.abort(); await pending; await session.terminate();
    assert.equal(cancelled.length, 1); assert.equal(cancelled[0].status, "interrupted");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
