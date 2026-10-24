import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync, realpathSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {AdapterRegistry, CodexAdapter} from "@agent-phonon/core";
import type {StreamEvent} from "@agent-phonon/protocol";
import {TestConn} from "./harness.js";

const fixtureOptions = {skip: process.platform === "win32", timeout: 15000};
function isTerminal(event: StreamEvent): event is Extract<StreamEvent, {type: "result" | "error"}> {
  return (event.type === "result" || event.type === "error") && event.final === true;
}
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "phonon-codex-final-")));
  const bin = join(root, "codex.cjs");
  writeFileSync(bin, `#!${process.execPath}
const input = require('node:fs').readFileSync(0, 'utf8');
const event = value => console.log(JSON.stringify(value));
const message = (id, text) => event({type:'item.completed',item:{id,type:'agent_message',text}});
event({type:'thread.started',thread_id:'11111111-1111-4111-8111-111111111111'});
if (input.includes('upstream node')) {
  message('review', input.includes('Planning detail') ? 'POLLUTED' : input.includes('FINAL') ? 'CLEAN_DOWNSTREAM' : 'MISSING');
} else if (input === 'next') {
  message('next', 'NEXT');
} else {
  message('progress', 'Planning detail');
  event({type:'item.started',item:{id:'final',type:'agent_message',text:'not a completed reply'}});
  event({type:'item.updated',item:{id:'final',type:'agent_message',text:'partial text'}});
  if (input === 'failed') {
    event({type:'turn.failed',error:{message:'deliberate failure'}});
    process.exit(0);
  }
  message('final', input === 'empty' ? '' : 'FINAL\\u2028line\\u2029last');
}
event({type:'turn.completed'});
if (input === 'nonzero') process.exitCode = 1;
`, {mode: 0o700});
  const adapter = new CodexAdapter({env: {binPath: bin, codexHome: root,
    defaultModel: "fixture", models: [{id: "fixture", available: true}]}});
  return {root, adapter, close: () => rmSync(root, {recursive: true, force: true})};
}

test("Codex final result is the last whole agent message, while all commentary remains observable", fixtureOptions, async () => {
  const f = fixture();
  const session = await f.adapter.createSession({sessionId: "final", agentId: "codex", model: "fixture", cwd: f.root});
  try {
    const first: StreamEvent[] = [];
    await session.send("first", {turnId: "first", verbosity: "tools", emit: event => first.push(event)});
    assert.deepEqual(first.filter(event => event.type === "message").map(event => event.text),
      ["Planning detail", "FINAL\u2028line\u2029last"]);
    const terminal = first.filter(isTerminal);
    assert.equal(terminal.length, 1);
    assert.ok(terminal[0]?.type === "result");
    assert.equal(terminal[0]!.status, "completed");
    assert.equal(terminal[0]!.text, "FINAL\u2028line\u2029last");
    const second: StreamEvent[] = [];
    await session.send("next", {turnId: "second", verbosity: "tools", emit: event => second.push(event)});
    assert.equal(second.find(event => event.type === "result")?.text, "NEXT", "a resumed turn cannot reuse prior reply text");
  } finally { await session.terminate(); f.close(); }
});

for (const input of ["empty", "failed", "nonzero"]) {
  test(`Codex does not promote commentary or an unsuccessful execution into a final reply (${input})`, fixtureOptions, async () => {
    const f = fixture();
    const session = await f.adapter.createSession({sessionId: "failure", agentId: "codex", model: "fixture", cwd: f.root});
    try {
      const events: StreamEvent[] = [];
      await session.send(input, {turnId: "turn", verbosity: "tools", emit: event => events.push(event)});
      const terminal = events.filter(isTerminal);
      assert.equal(terminal.length, 1);
      assert.equal(terminal[0]!.type, "error");
      assert.equal(terminal[0]!.status, "failed");
      assert.equal(events.some(event => event.type === "result"), false);
    } finally { await session.terminate(); f.close(); }
  });
}

test("workflow downstream input and retained result exclude Codex progress commentary", fixtureOptions, async () => {
  const f = fixture(), registry = new AdapterRegistry();
  registry.register(f.adapter);
  const tc = new TestConn({registry, tenantId: "final-owner", workspaceRoot: f.root});
  try {
    const project = await tc.call("project.create", {name: "final", git: false}) as any;
    const run = await tc.call("workflow.run", {project: project.project.projectId, plan: {mode: "dag", nodes: [
      {nodeId: "a", agent: "codex", model: "fixture", input: "first"},
      {nodeId: "b", agent: "codex", model: "fixture", input: "review", dependsOn: ["a"]},
    ], finalNodeId: "b"}}) as any;
    let status: any;
    const deadline = Date.now() + 10000;
    do {
      status = await tc.call("workflow.status", {workflowId: run.workflowId});
      if (["completed", "failed"].includes(status.status)) break;
      assert.ok(Date.now() < deadline, "workflow must settle");
      await new Promise(resolve => setTimeout(resolve, 20));
    } while (true);
    assert.equal(status.status, "completed");
    assert.equal(status.nodes.find((node: any) => node.nodeId === "a").result.text, "FINAL\u2028line\u2029last");
    assert.equal(status.finalText, "CLEAN_DOWNSTREAM");
    const result = await tc.call("workflow.result", {workflowId: run.workflowId}) as any;
    assert.equal(result.text, "CLEAN_DOWNSTREAM");
    assert.ok(tc.streamEvents.some(event => event.type === "message" && event.text === "Planning detail"));
  } finally { await tc.conn.dispose(); f.close(); }
});
