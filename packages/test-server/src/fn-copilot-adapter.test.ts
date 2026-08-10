import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCopilotEvent, parseCopilotModelsHelp } from "@agent-phonon/core";

test("Copilot adapter parses streamed assistant deltas", () => {
  assert.deepEqual(parseCopilotEvent({
    type: "assistant.message_delta",
    data: { messageId: "m-1", deltaContent: "hello" },
  }), { kind: "message_delta", text: "hello" });
});

test("Copilot adapter maps tool lifecycle events", () => {
  assert.deepEqual(parseCopilotEvent({
    type: "tool.execution_start",
    data: { toolCallId: "call-1", toolName: "bash", arguments: { command: "pwd" } },
  }), {
    kind: "tool_call",
    toolName: "bash",
    toolCallId: "call-1",
    args: { command: "pwd" },
  });

  assert.deepEqual(parseCopilotEvent({
    type: "tool.execution_complete",
    data: {
      toolCallId: "call-1",
      success: true,
      result: { content: "/tmp/project\n<exited with exit code 0>" },
    },
  }), {
    kind: "tool_result",
    toolCallId: "call-1",
    ok: true,
    output: "/tmp/project\n<exited with exit code 0>",
  });
});

test("Copilot adapter captures native session id from terminal result", () => {
  assert.deepEqual(parseCopilotEvent({
    type: "result",
    sessionId: "ac410364-0b08-4bd9-8648-d6864d3f5d45",
    exitCode: 0,
  }), {
    kind: "result",
    nativeSessionId: "ac410364-0b08-4bd9-8648-d6864d3f5d45",
  });
});

test("Copilot adapter parses and deduplicates models from help config", () => {
  const help = `
  \`model\`: AI model to use for Copilot CLI.
    - "claude-opus-4.6"
    - "gpt-5.4"
    - "gpt-5.4"

  \`mouse\`: whether to enable mouse support.
    - "not-a-model"
  `;
  assert.deepEqual(parseCopilotModelsHelp(help), [
    { id: "claude-opus-4.6", available: true },
    { id: "gpt-5.4", available: true },
  ]);
});
