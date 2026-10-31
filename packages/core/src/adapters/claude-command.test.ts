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
  for(const version of ["2.0.2","2.1.0","3.0.0"]){
    writeFileSync(entry,`console.log(${JSON.stringify(version+" (Claude Code)")})\n`);
    assert.deepEqual(await qualifyClaudePeerContext(cli),{entry,sdk,node});
  }
  for(const version of ["2.0.0","2.1.0-preview","unknown"]){
    writeFileSync(entry,`console.log(${JSON.stringify(version+" (Claude Code)")})\n`);
    assert.equal(await qualifyClaudePeerContext(cli),undefined);
  }
  writeFileSync(entry,'console.log("2.1.0 (Claude Code)")\n');writeFileSync(sdk,'export function query(){}\n');
  assert.equal(await qualifyClaudePeerContext(cli),undefined,"newer version alone cannot replace a missing SDK API");
}));

test("Claude native/unknown launchers cannot acquire a fabricated bundled SDK binding",()=>withPeerFixture("claude-command",async scope=>{
  const bin=join(scope.root,"native");writeFileSync(bin,"not a qualified JavaScript CLI\n");
  assert.equal(claudeNodeCommand(bin),undefined);assert.equal(await qualifyClaudePeerContext(bin),undefined);
  assert.equal(await qualifyClaudePeerContext(join(scope.root,"missing")),undefined);
}));

test("Claude native CLI requires an explicit compatible Agent SDK and admits later releases",{skip:process.platform==="win32"},()=>withPeerFixture("claude-external-sdk",async scope=>{
  const entry=join(scope.root,"claude-native"),directory=join(scope.root,"owner-sdk"),sdk=join(directory,"sdk.mjs");mkdirSync(directory);
  writeFileSync(entry,'#!'+process.execPath+'\nconsole.log("2.1.123 (Claude Code)")\n',{mode:0o700});
  writeFileSync(sdk,'export function query(){};export function createSdkMcpServer(){}\n');
  assert.equal(await qualifyClaudePeerContext(entry),undefined);
  for(const version of ["0.2.123","0.2.124","0.3.0","1.0.0"]){
    writeFileSync(join(directory,"package.json"),JSON.stringify({name:"@anthropic-ai/claude-agent-sdk",version}));
    assert.deepEqual(await qualifyClaudePeerContext(entry,sdk),{entry,sdk,node:process.execPath,kind:"external"});
  }
  writeFileSync(join(directory,"package.json"),JSON.stringify({name:"@anthropic-ai/claude-agent-sdk",version:"0.2.122"}));
  assert.equal(await qualifyClaudePeerContext(entry,sdk),undefined);
  writeFileSync(join(directory,"package.json"),JSON.stringify({name:"@anthropic-ai/claude-agent-sdk",version:"0.2.123"}));
  for(const version of ["2.1.124","2.2.0","3.0.0"]){
    writeFileSync(entry,'#!'+process.execPath+'\nconsole.log('+JSON.stringify(version+' (Claude Code)')+')\n',{mode:0o700});
    assert.deepEqual(await qualifyClaudePeerContext(entry,sdk),{entry,sdk,node:process.execPath,kind:"external"});
  }
  writeFileSync(entry,'#!'+process.execPath+'\nconsole.log("2.1.122 (Claude Code)")\n',{mode:0o700});
  assert.equal(await qualifyClaudePeerContext(entry,sdk),undefined);
  writeFileSync(entry,'#!'+process.execPath+'\nconsole.log("2.1.124 (Claude Code)")\n',{mode:0o700});
  writeFileSync(sdk,'export function query(){}\n');assert.equal(await qualifyClaudePeerContext(entry,sdk),undefined);
  assert.equal(await qualifyClaudePeerContext(entry,"sdk.mjs"),undefined);
}));
