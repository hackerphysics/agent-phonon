import test from "node:test";
import assert from "node:assert/strict";
import { ManagedMcpConfigureParams, ManagedMcpStatusResult, METHODS } from "../index.js";

test("managed MCP RPC is typed, bounded, secret-free and rejects caller-selected commands or endpoints", () => {
  const input = { revision: 1, bindings: [{ id: "12345678-1234-4234-8234-123456789abc", agentId: "codex", enabled: true }] };
  assert.equal(ManagedMcpConfigureParams.safeParse(input).success, true);
  for (const extra of [{ url: "https://other.invalid" }, { command: "sh" }, { token: "secret" }, { owner: "other" }]) assert.equal(ManagedMcpConfigureParams.safeParse({ ...input, ...extra }).success, false);
  assert.equal(ManagedMcpConfigureParams.safeParse({ ...input, bindings: [...input.bindings, ...input.bindings] }).success, false);
  assert.equal(METHODS["mcp.configure"].direction, "s2p"); assert.equal(METHODS["mcp.status"].direction, "s2p");
  assert.equal(ManagedMcpStatusResult.safeParse({ revision: -1, allowed: false, bindings: [] }).success, true);
});
