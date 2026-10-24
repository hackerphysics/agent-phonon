import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {CodexAdapter} from '@agent-phonon/core';
import type {StreamEvent} from '@agent-phonon/protocol';

const options={skip:process.platform==='win32',timeout:15000};
const nativeID='11111111-1111-4111-8111-111111111111';
type Frame={id?:unknown;type:string;command?:unknown;status?:unknown;exit_code?:unknown;aggregated_output?:unknown};
function fixture(completed:Frame,started=true,held=false){
 const root=realpathSync(mkdtempSync(join(tmpdir(),'phonon-codex-command-'))),home=join(root,'home'),cwd=join(root,'work'),bin=join(root,'codex.cjs'),release=join(root,'release');mkdirSync(home);mkdirSync(cwd);
 writeFileSync(bin,`#!${process.execPath}
const fs=require('node:fs');fs.readFileSync(0,'utf8');
const emit=value=>console.log(JSON.stringify(value)),item=${JSON.stringify(completed)};
emit({type:'thread.started',thread_id:${JSON.stringify(nativeID)}});
${started?"emit({type:'item.started',item:{...item,status:'in_progress',exit_code:null,aggregated_output:''}});emit({type:'item.started',item:{...item,status:'in_progress'}});":''}
async function finish(){
 ${held?`while(!fs.existsSync(${JSON.stringify(release)}))await new Promise(resolve=>setTimeout(resolve,10));`:''}
 emit({type:'item.completed',item});emit({type:'item.completed',item});
 emit({type:'item.completed',item:{id:'final',type:'agent_message',text:'FINAL_ONLY'}});emit({type:'turn.completed'});
}finish().catch(error=>{console.error(error);process.exitCode=1;});
`,{mode:0o700});
 const adapter=new CodexAdapter({env:{binPath:bin,codexHome:home,defaultModel:'fixture'}});
 return {root,cwd,adapter,release:()=>writeFileSync(release,'release'),close:()=>rmSync(root,{recursive:true,force:true})};
}
async function wait(check:()=>boolean){const deadline=Date.now()+5000;while(!check()){assert(Date.now()<deadline,'Original command observation deadline');await new Promise(resolve=>setTimeout(resolve,10));}}
const command=(patch:Partial<Frame>={}):Frame=>({id:'command-1',type:'command_execution',command:'owned-command',status:'completed',exit_code:0,aggregated_output:'ACTUAL_OUTPUT\u2028next\u2029last',...patch});

test('Codex commands appear before return, then publish one paired native output and exit receipt',options,async()=>{
 const f=fixture(command(),true,true),session=await f.adapter.createSession({sessionId:'command-observation',agentId:'codex',model:'fixture',cwd:f.cwd}),events:StreamEvent[]=[];let settled=false;
 try{
  const original=session.send('observe',{turnId:'first',verbosity:'tools',emit:event=>events.push(event)}).finally(()=>{settled=true;});
  await wait(()=>events.some(event=>event.type==='tool_call'));
  assert.equal(settled,false);assert.equal(events.filter(event=>event.type==='tool_call').length,1);assert.equal(events.filter(event=>event.type==='tool_result').length,0);
  const call=events.find(event=>event.type==='tool_call')!;assert.equal(call.toolCallId,'command-1');assert.deepEqual(call.args,{command:'owned-command'});
  f.release();await original;
  const results=events.filter(event=>event.type==='tool_result');assert.equal(results.length,1);assert.equal(results[0]!.toolCallId,call.toolCallId);assert.equal(results[0]!.ok,true);
  assert.deepEqual(results[0]!.output,{command:'owned-command',output:'ACTUAL_OUTPUT\u2028next\u2029last',exitCode:0,status:'completed'});
  const last=events.at(-1)!;assert.equal(last.type,'result');assert.equal(last.status,'completed');assert.equal(last.text,'FINAL_ONLY');
 }finally{await session.terminate();f.close();}
});
test('Codex completed-only frames retain the original call/result identity without duplicate observations',options,async()=>{
 const f=fixture(command(),false),session=await f.adapter.createSession({sessionId:'completed-only',agentId:'codex',model:'fixture',cwd:f.cwd});
 try{const events:StreamEvent[]=[];await session.send('observe',{turnId:'only',verbosity:'tools',emit:event=>events.push(event)});assert.deepEqual(events.filter(event=>event.type==='tool_call'||event.type==='tool_result').map(event=>[event.type,event.toolCallId]),[['tool_call','command-1'],['tool_result','command-1']]);}
 finally{await session.terminate();f.close();}
});
for(const [label,patch]of [['nonzero exit',{exit_code:7}],['explicit native failure',{status:'failed',exit_code:0}],['failure without an exit code',{status:'failed',exit_code:null}]] as const){
 test('Codex reports '+label+' without overriding an independently successful agent reply',options,async()=>{
  const f=fixture(command(patch)),session=await f.adapter.createSession({sessionId:'failed-command',agentId:'codex',model:'fixture',cwd:f.cwd});
  try{const events:StreamEvent[]=[];await session.send('observe',{turnId:'failure',verbosity:'tools',emit:event=>events.push(event)});const results=events.filter(event=>event.type==='tool_result');assert.equal(results.length,1);assert.equal(results[0]!.ok,false);const final=events.at(-1);assert.ok(final?.type==='result');assert.equal(final.status,'completed');if(patch.exit_code===null)assert.equal(Object.hasOwn(results[0]!.output as object,'exitCode'),false);}
  finally{await session.terminate();f.close();}
 });
}
for(const patch of [{exit_code:null},{exit_code:'0'},{status:'in_progress'},{status:'unrecognized'}]){
 test('Codex leaves an unverified command result unconfirmed: '+JSON.stringify(patch),options,async()=>{
  const f=fixture(command(patch)),session=await f.adapter.createSession({sessionId:'unknown-command',agentId:'codex',model:'fixture',cwd:f.cwd});
  try{const events:StreamEvent[]=[];await session.send('observe',{turnId:'unknown',verbosity:'tools',emit:event=>events.push(event)});assert.equal(events.filter(event=>event.type==='tool_call').length,1);assert.equal(events.filter(event=>event.type==='tool_result').length,0);}
  finally{await session.terminate();f.close();}
 });
}
test('Codex legacy frames without native IDs do not fabricate a matched successful return',options,async()=>{
 const f=fixture(command({id:undefined})),session=await f.adapter.createSession({sessionId:'legacy-command',agentId:'codex',model:'fixture',cwd:f.cwd});
 try{const events:StreamEvent[]=[];await session.send('observe',{turnId:'legacy',verbosity:'tools',emit:event=>events.push(event)});assert.equal(events.filter(event=>event.type==='tool_result').length,0);assert(events.filter(event=>event.type==='tool_call').every(event=>event.toolCallId===undefined));}
 finally{await session.terminate();f.close();}
});
test('Codex re-used item IDs remain distinct across original and resumed turns',options,async()=>{
 const f=fixture(command()),session=await f.adapter.createSession({sessionId:'continued-command',agentId:'codex',model:'fixture',cwd:f.cwd});
 try{const events:StreamEvent[]=[];for(const turnId of ['first','second'])await session.send('observe',{turnId,verbosity:'tools',emit:event=>events.push(event)});assert.deepEqual(events.filter(event=>event.type==='tool_result').map(event=>[event.turnId,event.toolCallId]),[['first','command-1'],['second','command-1']]);}
 finally{await session.terminate();f.close();}
});
