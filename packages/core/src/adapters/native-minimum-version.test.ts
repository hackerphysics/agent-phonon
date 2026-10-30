import test from "node:test";
import assert from "node:assert/strict";
import {writeFileSync} from "node:fs";
import {join} from "node:path";
import {CodexAdapter} from "./codex.js";
import {withPeerFixture} from "../testing/peer-fixture.js";

test("Codex discovery uses a prerelease minimum without pinning a single CLI build",()=>withPeerFixture("codex-minimum",async scope=>{
  for(const [version,supported] of [
    ["0.165.0-alpha.1.2",true],["0.165.0-alpha.1.10",true],["0.165.0",true],["0.166.0",true],["1.0.0",true],
    ["0.165.0-alpha.1.1",false],["0.164.9",false],["unknown",false],
  ] as const){
    const bin=join(scope.root,"codex.mjs");
    writeFileSync(bin,`#!${process.execPath}\nif(process.argv.includes('--version'))console.log(${JSON.stringify("codex-cli "+version)});else process.exit(17);\n`,{mode:0o700});
    const adapter=new CodexAdapter({env:{binPath:bin,codexHome:scope.root,defaultModel:"fixture",models:[{id:"fixture",available:true,reasoningLevels:["low"]}]}});
    const inventory=await adapter.discoverAgents();
    assert.equal(inventory[0]?.capabilities.injectMidTurn,supported,version);
  }
}));
