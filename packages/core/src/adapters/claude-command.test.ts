import assert from "node:assert/strict";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { claudeNodeCommand, qualifyClaudePeerContext } from "./claude-command.js";
import { withPeerFixture } from "../testing/peer-fixture.js";

test("Claude qualification uses the Node and SDK paired with the selected CLI without rewriting either",{skip:process.platform==="win32"},()=>withPeerFixture("claude-command",async scope=>{
  const bin=join(scope.root,"bin"),installed=join(scope.root,"owner-cli");mkdirSync(bin);mkdirSync(installed);
  const entry=join(installed,"cli.js"),sdk=join(installed,"sdk.mjs"),cli=join(bin,"claude"),node=join(bin,"node");
  writeFileSync(entry,'console.log("2.0.1 (Claude Code)")\n');writeFileSync(sdk,'export function query(){};export function createSdkMcpServer(){}\n');
  symlinkSync(entry,cli);symlinkSync(process.execPath,node);
  const before=readFileSync(sdk,"utf8");
  assert.deepEqual(claudeNodeCommand(cli),{entry,node});
  assert.deepEqual(await qualifyClaudePeerContext(cli),{entry,sdk,node});
  assert.equal(readFileSync(sdk,"utf8"),before);
  writeFileSync(entry,'console.log("2.0.2 (Claude Code)")\n');assert.equal(await qualifyClaudePeerContext(cli),undefined);
}));

test("Claude native/unknown launchers cannot acquire a fabricated bundled SDK binding",()=>withPeerFixture("claude-command",async scope=>{
  const bin=join(scope.root,"native");writeFileSync(bin,"not a qualified JavaScript CLI\n");
  assert.equal(claudeNodeCommand(bin),undefined);assert.equal(await qualifyClaudePeerContext(bin),undefined);
  assert.equal(await qualifyClaudePeerContext(join(scope.root,"missing")),undefined);
}));
