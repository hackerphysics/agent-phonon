import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {AdapterRegistry,PiAdapter} from "@agent-phonon/core";
import {PhononDaemon} from "./daemon.js";
import {defaultConfig} from "./config.js";

test("configured Pi is registered by the normal daemon and receives its explicit settings",async()=>{
  const root=mkdtempSync(join(tmpdir(),"phonon-daemon-pi-")),bin=join(root,"pi"),log=join(root,"invocation.json");
  writeFileSync(bin,`#!${process.execPath}
import {writeFileSync} from 'node:fs';
if(process.argv.includes('--help'))console.log('--session-id <id>');
else if(process.argv.includes('--version'))console.log('pi registration fixture');
else{let input='';process.stdin.on('data',chunk=>input+=chunk);process.stdin.on('end',()=>{
writeFileSync(${JSON.stringify(log)},JSON.stringify({args:process.argv.slice(2),input}));
console.log(JSON.stringify({type:'message_update',assistantMessageEvent:{type:'text_delta',delta:'registered'}}));
console.log(JSON.stringify({type:'agent_settled',aborted:false}));});}
`,{mode:0o700});
  const cfg=defaultConfig(),missing=join(root,"not-installed");
  cfg.dbPath=join(root,"state.db");cfg.workspaceRoot=root;cfg.servers=[];cfg.rescueAgent={enabled:false};cfg.obs={enabled:false};
  // Suppress unrelated auto-discovery; none of these runtimes is started.
  cfg.adapters=[{type:"pi",piBinPath:bin,piModel:"pi-model",piModels:[{id:"pi-model",available:true}],piAppendSystemPrompt:"Only the test workspace"},
    {type:"hermes",hermesBinPath:missing,hermesModel:"unused"},{type:"opencode",opencodeBinPath:missing},
    {type:"copilot",copilotBinPath:missing},
    {type:"claude-code",claudeBinPath:missing,claudeDefaultModel:"unused"},{type:"codex",codexBinPath:missing,codexDefaultModel:"unused"}];
  const daemon=new PhononDaemon(cfg);
  try{
    const registry=(daemon as unknown as {registry:AdapterRegistry}).registry,adapter=registry.resolve("pi");
    assert.ok(adapter instanceof PiAdapter);
    assert.equal((await adapter.discoverAgents())[0]?.models[0]?.id,"pi-model");
    const session=await adapter.createSession({sessionId:"s-pi-config",agentId:"pi",model:"pi-model",cwd:root});
    const events:any[]=[];await session.send("Registration task",{turnId:"t-pi-config",emit:event=>events.push(event),verbosity:"tools"});
    assert.ok(events.some(event=>event.type==="result"&&event.status==="completed"&&event.text==="registered"));
    const captured=JSON.parse(readFileSync(log,"utf8"));
    assert.equal(captured.args[captured.args.indexOf("--append-system-prompt")+1],"Only the test workspace");
    assert.equal(captured.args[captured.args.indexOf("--model")+1],"pi-model");
    assert.equal(captured.input,"Registration task\n");await session.terminate();
  }finally{await daemon.stop();rmSync(root,{recursive:true,force:true});}
});
