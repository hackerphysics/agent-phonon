import test from "node:test";
import assert from "node:assert/strict";
import { mcpRequestByteLimit } from "./mcp-request-budget.generated.js";

test("managed MCP expands only typed Canvas HTML operations and their original receipt checks", () => {
  for (const name of ["canvas_create_frame", "canvas_update_frame"]) {
    assert.equal(mcpRequestByteLimit({ method: "tools/call", params: { name } }), 2 * 1024 * 1024);
    assert.equal(mcpRequestByteLimit({ method: "tools/call", params: { name: "canvas_check_submission", arguments: { tool_name: name } } }), 2 * 1024 * 1024);
  }
  for (const value of [null, [], { method: "initialize" }, { method: "ping", params: { name: "canvas_update_frame" } },
    { method: "tools/call", params: { name: "canvas_get_page" } }, { method: "tools/call", params: { name: "canvas_update_frame_extra" } },
    { method: "tools/call", params: { name: "canvas_check_submission", arguments: { tool_name: "canvas_delete_product" } } }]) assert.equal(mcpRequestByteLimit(value), 65536);
});

test("automation save and its exact receipt check have a separate bounded allowance", () => {
  assert.equal(mcpRequestByteLimit({ method: "tools/call", params: { name: "phonon_save_automation" } }), 512 * 1024);
  assert.equal(mcpRequestByteLimit({ method: "tools/call", params: { name: "phonon_check_automation_submission", arguments: { tool_name: "phonon_save_automation" } } }), 512 * 1024);
  for (const value of [
    { method: "tools/call", params: { name: "phonon_run_automation" } },
    { method: "tools/call", params: { name: "phonon_save_automation_extra" } },
    { method: "tools/call", params: { name: "phonon_check_automation_submission", arguments: { tool_name: "canvas_update_frame" } } },
    { method: "tools/call", params: { name: "canvas_check_submission", arguments: { tool_name: "phonon_save_automation" } } },
    { method: "ping", params: { name: "phonon_save_automation" } },
  ]) assert.equal(mcpRequestByteLimit(value), 65536);
});

test("Role save expands only its typed request and exact Agents receipt group", () => {
  assert.equal(mcpRequestByteLimit({ method: "tools/call", params: { name: "phonon_save_role" } }), 512 * 1024);
  assert.equal(mcpRequestByteLimit({ method: "tools/call", params: { name: "phonon_check_agents_submission", arguments: { tool_name: "phonon_save_role" } } }), 512 * 1024);
  for (const value of [
    { method: "tools/call", params: { name: "phonon_rename_device" } },
    { method: "tools/call", params: { name: "phonon_check_projects_submission", arguments: { tool_name: "phonon_save_role" } } },
    { method: "tools/call", params: { name: "phonon_check_agents_submission", arguments: { tool_name: "phonon_save_agent" } } },
    { method: "tools/call", params: { name: "canvas_check_submission", arguments: { tool_name: "phonon_save_role" } } },
  ]) assert.equal(mcpRequestByteLimit(value), 65536);
});
