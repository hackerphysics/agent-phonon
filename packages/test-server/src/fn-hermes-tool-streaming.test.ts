import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,mkdir,writeFile,readFile,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {HermesAdapter} from "@agent-phonon/core";
import type {StreamEvent} from "@agent-phonon/protocol";

async function fixture(body:string,after="",callbacks=true){
  const root=await mkdtemp(path.join(tmpdir(),"phonon-hermes-tool-stream-"));
  for(const name of ["hermes_cli","agent"])await mkdir(path.join(root,name));
  for(const name of ["hermes_cli/__init__.py","agent/__init__.py"])await writeFile(path.join(root,name),"");
  await writeFile(path.join(root,"hermes"),"#!/usr/bin/python3\n");
  await writeFile(path.join(root,"hermes_cli/config.py"),"def load_config(): return {}\n");
  await writeFile(path.join(root,"agent/delegation_context.py"),"owned=True\ndef is_dispatcher_owned_worker_context(): return owned\n");
  await writeFile(path.join(root,"hermes_cli/main.py"),`def main():\n from run_agent import AIAgent\n agent=AIAgent()\n agent.run_conversation(conversation_history=[{'role':'assistant','tool_calls':[{'id':'old','function':{'name':'old_tool'}}]}])\n${after.split("\n").filter(Boolean).map(line=>" "+line).join("\n")}\n`);
  const init=callbacks?"self.tool_start_callback=self.before; self.tool_complete_callback=self.after":"pass";
  await writeFile(path.join(root,"run_agent.py"),`import os,json,time,threading\nclass AIAgent:\n def __init__(self): ${init}\n def before(self,*args):\n  with open('original-start.jsonl','a') as f: f.write(json.dumps(args)+'\\n')\n def after(self,*args):\n  with open('original-complete.jsonl','a') as f: f.write(json.dumps(args)+'\\n')\n def run_conversation(self,*args,**kwargs):\n${body.split("\n").map(line=>"  "+line).join("\n")}\n`);
  const session=await new HermesAdapter({env:{binPath:path.join(root,"hermes")}}).createSession({sessionId:"observed",agentId:"hermes:default",model:"default",cwd:root});
  return {root,session,async close(){await session.terminate();await rm(root,{recursive:true,force:true});}};
}

const returned=(id:string,name:string,content:string)=>`{'completed':True,'final_response':'actual final','messages':[{'role':'assistant','tool_calls':[{'id':'${id}','function':{'name':'${name}','arguments':'{}'}}]},{'role':'tool','tool_call_id':'${id}','content':${JSON.stringify(content)}}]}`;
function signal(){let resolve!:()=>void;const promise=new Promise<void>(ready=>{resolve=ready;});return {promise,resolve};}

test("Hermes tool start and completion arrive before native return, preserve callbacks and deduplicate transcript wrappers",{timeout:20000},async()=>{
  const f=await fixture([
    "self.tool_start_callback('native-id','read_file',{'path':'input.txt'})",
    "until=time.time()+12",
    "while not os.path.exists('finish-tool') and time.time()<until: time.sleep(0.01)",
    "assert os.path.exists('finish-tool')",
    "kwargs['stream_callback']('native text')",
    "self.tool_complete_callback('native-id','read_file',{'path':'input.txt'},'actual file bytes')",
    "while not os.path.exists('finish-turn') and time.time()<until: time.sleep(0.01)",
    "assert os.path.exists('finish-turn')",
    "return "+returned("native-id","tool_call","actual file bytes"),
  ].join("\n"),"assert agent.tool_start_callback == agent.before\nassert agent.tool_complete_callback == agent.after");
  const events:StreamEvent[]=[],started=signal(),completed=signal();
  let pending:Promise<void>|undefined,settled=false;
  try{
    pending=f.session.send("observe",{turnId:"live",verbosity:"tools",emit:event=>{events.push(event);if(event.type==="tool_call")started.resolve();if(event.type==="tool_result")completed.resolve();}}).finally(()=>{settled=true;});
    await Promise.race([started.promise,pending.then(()=>{throw new Error("Native ended before start observation");})]);
    assert.equal(settled,false);assert.equal(events.filter(e=>e.type==="tool_result").length,0);
    await writeFile(path.join(f.root,"finish-tool"),"");
    await Promise.race([completed.promise,pending.then(()=>{throw new Error("Native ended before result observation");})]);
    assert.equal(settled,false);assert.equal(events.some(e=>"final"in e),false);
    await writeFile(path.join(f.root,"finish-turn"),"");await pending;
    const tools=events.filter(e=>e.type==="tool_call"||e.type==="tool_result");
    assert.deepEqual(tools.map(e=>[e.type,e.toolCallId,e.toolName]),[["tool_call","native-id","read_file"],["tool_result","native-id","read_file"]]);
    assert.equal(tools[1]!.type==="tool_result"&&tools[1]!.output,"actual file bytes");
    assert.equal(events.at(-1)?.type,"result");
    assert.equal((await readFile(path.join(f.root,"original-start.jsonl"),"utf8")).trim().split("\n").length,1);
    assert.equal((await readFile(path.join(f.root,"original-complete.jsonl"),"utf8")).trim().split("\n").length,1);
  }finally{await f.close();await pending?.catch(()=>{});}
});

test("Hermes keeps concurrent same-name IDs distinct, ignores child/old/late callbacks and leaves thinking callbacks untouched",async()=>{
  const f=await fixture([
    "import agent.delegation_context as context",
    "self.saved_start,self.saved_complete=self.tool_start_callback,self.tool_complete_callback",
    "context.owned=False",
    "self.tool_start_callback('child','read_file',{})",
    "self.tool_complete_callback('child','read_file',{},'child output')",
    "context.owned=True",
    "self.tool_start_callback('old','old_tool',{})",
    "self.tool_complete_callback('old','old_tool',{},'old output')",
    "def worker(i):",
    " self.tool_start_callback('call-'+str(i),'read_file',{'index':i})",
    " self.tool_complete_callback('call-'+str(i),'read_file',{'index':i},'output-'+str(i))",
    " self.tool_complete_callback('call-'+str(i),'read_file',{'index':i},'duplicate')",
    "threads=[threading.Thread(target=worker,args=(i,)) for i in range(20)]",
    "for thread in threads: thread.start()",
    "for thread in threads: thread.join()",
    "return {'completed':True,'final_response':'threaded final'}",
  ].join("\n"),"agent.saved_start('late','read_file',{})\nagent.saved_complete('late','read_file',{},'late output')\nassert not hasattr(agent,'thinking_callback')");
  try{
    const events:StreamEvent[]=[];await f.session.send("observe",{turnId:"parallel",verbosity:"tools",emit:e=>events.push(e)});
    const calls=events.filter(e=>e.type==="tool_call"),results=events.filter(e=>e.type==="tool_result");
    assert.equal(calls.length,20);assert.equal(results.length,20);assert.equal(new Set(calls.map(e=>e.toolCallId)).size,20);
    for(let i=0;i<20;i++)assert.equal(results.find(e=>e.toolCallId==="call-"+i)?.output,"output-"+i);
    assert.equal(events.at(-1)?.type,"result");assert.equal(events.filter(e=>"final"in e).length,1);
  }finally{await f.close();}
});

test("Hermes callback-free fallback retains native errors and a thrown turn never fabricates a tool completion",async()=>{
  for(const throws of [false,true]){
    const f=await fixture(throws?"self.tool_start_callback('unfinished','terminal',{})\nraise RuntimeError('native failure')":"return "+returned("fallback","terminal",'{"exit_code":7,"stdout":"actual failure"}'),"",throws);
    try{
      const events:StreamEvent[]=[];await f.session.send("observe",{turnId:"fallback",verbosity:"tools",emit:e=>events.push(e)});
      const results=events.filter(e=>e.type==="tool_result");
      assert.equal(results.length,throws?0:1);if(!throws)assert.equal(results[0]!.ok,false);
      assert.equal(events.at(-1)?.type,throws?"error":"result");
    }finally{await f.close();}
  }
});

test("Hermes tool projections bound oversized native display output with an explicit excerpt marker",async()=>{
  const f=await fixture("self.tool_complete_callback('large','read_file',{},'x'*200000)\nreturn {'completed':True,'final_response':'bounded final'}");
  try{
    const events:StreamEvent[]=[];await f.session.send("observe",{turnId:"bounded",verbosity:"tools",emit:e=>events.push(e)});
    const result=events.find(e=>e.type==="tool_result");assert.ok(result?.type==="tool_result");
    assert.ok(String(result.output).length<132000);assert.ok(String(result.output).includes("tool output excerpt"));
  }finally{await f.close();}
});
