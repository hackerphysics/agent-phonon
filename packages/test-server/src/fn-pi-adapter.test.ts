import { test } from "node:test";
import assert from "node:assert/strict";
import { PiAdapter, parsePiEvent, parsePiModels, parsePiVersion, toPiSessionId, probePiSessionFlags } from "@agent-phonon/core";

/**
 * Fixtures below are copied verbatim from Pi's official docs
 * (packages/coding-agent/docs/json.md "JSON Event Stream"). Using the documented
 * shapes keeps the adapter honest instead of testing against invented fixtures.
 */

test("pi adapter parses the session header and records the native session id", () => {
  assert.deepEqual(parsePiEvent({ type: "session", version: 3, id: "abc-uuid", timestamp: "2024-12-03T14:00:00.000Z", cwd: "/path" }), {
    kind: "session",
    nativeSessionId: "abc-uuid",
    cwd: "/path",
  });
});

test("pi adapter streams assistant text deltas", () => {
  assert.deepEqual(
    parsePiEvent({
      type: "message_update",
      usage: { input: 100, output: 1, totalTokens: 101 },
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Hello " },
    }),
    { kind: "text_delta", text: "Hello " },
  );
});

test("pi adapter maps thinking deltas to their own channel (not assistant text)", () => {
  assert.deepEqual(
    parsePiEvent({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "considering" } }),
    { kind: "thinking_delta", text: "considering" },
  );
});

test("pi adapter maps the tool execution lifecycle", () => {
  assert.deepEqual(
    parsePiEvent({ type: "tool_execution_start", toolCallId: "call_abc123", toolName: "bash", args: { command: "ls -la" } }),
    { kind: "tool_call", toolCallId: "call_abc123", toolName: "bash", args: { command: "ls -la" } },
  );

  assert.deepEqual(
    parsePiEvent({
      type: "tool_execution_end",
      toolCallId: "call_abc123",
      toolName: "bash",
      result: { content: [{ type: "text", text: "complete output" }], details: {} },
      isError: false,
    }),
    {
      kind: "tool_result",
      toolCallId: "call_abc123",
      toolName: "bash",
      ok: true,
      output: { content: [{ type: "text", text: "complete output" }], details: {} },
    },
  );
});

test("pi adapter marks failed tools as not ok", () => {
  const parsed = parsePiEvent({ type: "tool_execution_end", toolCallId: "c1", toolName: "bash", result: {}, isError: true });
  assert.equal((parsed as { ok: boolean }).ok, false);
});

test("pi adapter treats agent_settled as the terminal signal and honours aborted", () => {
  assert.deepEqual(parsePiEvent({ type: "agent_settled", aborted: false }), { kind: "settled", aborted: false });
  assert.deepEqual(parsePiEvent({ type: "agent_settled", aborted: true }), { kind: "settled", aborted: true });
});

test("pi adapter surfaces provider stream errors", () => {
  assert.deepEqual(
    parsePiEvent({ type: "message_update", assistantMessageEvent: { type: "error", reason: "aborted", error: "stream broke" } }),
    { kind: "stream_error", message: "stream broke" },
  );
});

test("pi adapter ignores lifecycle events it does not need", () => {
  // agent_end / turn_start / compaction_* / retry events carry no phonon stream semantics here.
  for (const rec of [{ type: "agent_start" }, { type: "turn_start" }, { type: "compaction_start", reason: "threshold" }, { type: "queue_update" }]) {
    assert.deepEqual(parsePiEvent(rec), { kind: "ignore" }, `expected ignore for ${rec.type}`);
  }
});

test("pi adapter ignores malformed records instead of throwing", () => {
  assert.deepEqual(parsePiEvent(undefined), { kind: "ignore" });
  assert.deepEqual(parsePiEvent("nonsense"), { kind: "ignore" });
  // tool_execution_start without a toolCallId cannot be correlated -> must not be emitted.
  assert.deepEqual(parsePiEvent({ type: "tool_execution_start", toolName: "bash" }), { kind: "ignore" });
});

test("toPiSessionId satisfies Pi's rule: starts/ends alphanumeric", () => {
  // Pi: "Session IDs must start and end with a letter or number", chars A-Za-z0-9._-
  assert.equal(toPiSessionId("ses_abc123"), "ses_abc123");
  assert.equal(toPiSessionId("has/slash and space"), "has-slash-and-space");
  assert.equal(toPiSessionId("__leading_and_trailing__"), "leading_and_trailing");
  for (const raw of ["ses_abc123", "has/slash and space", "__lead_trail__", "!!!", "---"]) {
    const id = toPiSessionId(raw);
    assert.match(id, /^[A-Za-z0-9].*[A-Za-z0-9]$|^[A-Za-z0-9]$/, `not alphanumeric-bounded: ${id}`);
  }
});

test("parsePiVersion strips ANSI and skips banner blank lines", () => {
  assert.equal(parsePiVersion("\n\npi 0.73.1\nmore\n"), "pi 0.73.1");
  assert.equal(parsePiVersion("\u001b[32mpi 0.73.1\u001b[0m"), "pi 0.73.1");
  assert.equal(parsePiVersion("   \n  "), undefined);
});

test("parsePiModels parses Pi's real table output into provider/model ids", () => {
  // Verbatim shape observed from `pi --list-models` on a real install (it writes to
  // stderr, and the columns are provider-then-model — NOT one model id per line).
  const listing = [
    "provider  model        context  max-out  thinking  images",
    "zai       glm-4.5-air  131.1K   98.3K    yes       no",
    "zai       glm-4.7      204.8K   131.1K    yes       no",
    "zai       glm-5-turbo  200K     131.1K    yes       no",
  ].join("\n");
  const ids = parsePiModels(listing).map((m) => m.id);
  assert.deepEqual(ids, ["zai/glm-4.5-air", "zai/glm-4.7", "zai/glm-5-turbo"]);
  // The provider column must never leak out as if it were a model id.
  assert.ok(!ids.includes("provider"));
  assert.ok(!ids.includes("zai"));
});

test("parsePiModels drops separator lines and tolerates blank padding", () => {
  const listing = "\nprovider  model  context\n──────────────\nopenai  gpt-5.4  400K\n\n";
  assert.deepEqual(parsePiModels(listing).map((m) => m.id), ["openai/gpt-5.4"]);
});

test("pi adapter declares capabilities honestly", () => {
  const a = new PiAdapter();
  assert.equal(a.name, "pi");
  assert.equal(a.capabilities.streaming, true, "pi --mode json is real streaming");
  // nativeSession is derived from what the installed Pi actually accepts, not from
  // the docs: --session-id/--name only exist in newer Pi, and Pi 0.70.6 aborts on
  // an unknown option. Asserting a hard-coded true here is what let the doc/CLI
  // mismatch ship unnoticed.
  const flags = probePiSessionFlags("pi");
  assert.equal(a.capabilities.nativeSession, flags.sessionId || flags.name,
    "nativeSession must mirror the probed create-if-absent selector, not optimism");
  // No blocking pre-tool hook is wired, so orchestrators must not assume HITL can stop a command.
  assert.deepEqual(a.capabilities.hooks, []);
  // Pi compacts on its own thresholds but exposes no on-demand flag; do not claim nativeCompression.
  assert.equal(a.capabilities.nativeCompression, false);
});

test("pi adapter is discoverable but reports unavailable without the CLI", async () => {
  const adapter = new PiAdapter({ env: { binPath: "/nonexistent/pi" } });
  const [agent] = await adapter.discoverAgents();
  assert.equal(agent?.agentId, "pi");
  assert.equal(agent?.available, false);
  assert.match(agent?.unavailableReason ?? "", /pi CLI not found/);
});