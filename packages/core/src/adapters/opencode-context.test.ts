import test from "node:test";
import assert from "node:assert/strict";
import {chmodSync,readFileSync,symlinkSync,linkSync} from "node:fs";
import {join} from "node:path";
import {DatabaseSync} from "node:sqlite";
import {withPeerFixture} from "../testing/peer-fixture.js";
import {readOpenCodeCompletion} from "./opencode-context.js";

async function fixture(work:(f:any)=>Promise<void>){return withPeerFixture("opencode-completion",async scope=>{
  const file=join(scope.root,"opencode.db"),now=Date.now()-100,sessionId="ses_original",db=new DatabaseSync(file);scope.defer(()=>db.close());
  db.exec("CREATE TABLE session(id TEXT PRIMARY KEY,directory TEXT,parent_id TEXT); CREATE TABLE message(id TEXT PRIMARY KEY,session_id TEXT,time_created INTEGER,data TEXT); CREATE TABLE part(id TEXT PRIMARY KEY,session_id TEXT,message_id TEXT,time_created INTEGER,data TEXT)");
  db.prepare("INSERT INTO session VALUES(?,?,NULL)").run(sessionId,scope.root);
  const user={role:"user",time:{created:now},model:{providerID:"fixture",modelID:"m1"}};
  const assistant={role:"assistant",parentID:"msg_original",path:{cwd:scope.root},providerID:"fixture",modelID:"m1",time:{created:now+1,completed:now+4},finish:"stop"};
  const text={type:"text",text:"Actual native final",time:{start:now+2,end:now+3}};
  const message=(id:string,data:unknown,time=now)=>db.prepare("INSERT OR REPLACE INTO message VALUES(?,?,?,?)").run(id,sessionId,time,JSON.stringify(data));
  const part=(id:string,mid:string,data:unknown,time=now)=>db.prepare("INSERT OR REPLACE INTO part VALUES(?,?,?,?,?)").run(id,sessionId,mid,time,JSON.stringify(data));
  message("msg_original",user);message("msg_final",assistant,now+1);
  part("prt_prompt","msg_original",{type:"text",text:'"Original task"'});
  part("prt_text","msg_final",text,now+2);part("prt_stop","msg_final",{type:"step-finish",reason:"stop"},now+4);
  chmodSync(file,0o600);
  const identity={sessionId,cwd:scope.root,model:"fixture/m1",prompt:'"Original task"',notBefore:now-1};
  await work({scope,file,db,now,user,assistant,text,identity,message,part,read:()=>readOpenCodeCompletion(file,identity)});
});}

test("OpenCode missing stdout completion requires the original completed native leaf and reads without changing DB bytes",()=>fixture(async f=>{
  const before=readFileSync(f.file);assert.deepEqual(f.read(),{messageId:"msg_final",text:"Actual native final"});assert.deepEqual(readFileSync(f.file),before);
  assert.equal(readOpenCodeCompletion(f.file,{...f.identity,model:""})?.text,"Actual native final","native default selection stays bound to its original user and assistant model");
  f.part("prt_prompt","msg_original",{type:"text",text:'"Original task"\n'});assert.equal(f.read()?.text,"Actual native final");
  f.part("prt_prompt","msg_original",{type:"text",text:'"Original task"\n\n'});assert.equal(f.read(),undefined);
}));

for(const variant of ["session","cwd","model","prompt","stale","child","later-user","parent","native-error","unfinished","tool-stop","summary","missing-stop","wrong-stop","pending-tool","unfinished-text","oversized"] as const)
  test(`OpenCode refuses unconfirmed native completion: ${variant}`,()=>fixture(async f=>{
    if(variant==="session")f.identity.sessionId="ses_foreign";
    if(variant==="cwd")f.identity.cwd="/";
    if(variant==="model")f.identity.model="fixture/other";
    if(variant==="prompt")f.identity.prompt="Other task";
    if(variant==="stale")f.identity.notBefore=f.now+1;
    if(variant==="child")f.db.prepare("UPDATE session SET parent_id='ses_parent'").run();
    if(variant==="later-user")f.message("msg_followup",f.user,f.now+5);
    if(variant==="parent")f.message("msg_final",{...f.assistant,parentID:"msg_other"},f.now+1);
    if(variant==="native-error")f.message("msg_final",{...f.assistant,error:{message:"native failure"}},f.now+1);
    if(variant==="unfinished")f.message("msg_final",{...f.assistant,time:{created:f.now+1}},f.now+1);
    if(variant==="tool-stop")f.message("msg_final",{...f.assistant,finish:"tool-calls"},f.now+1);
    if(variant==="summary")f.message("msg_final",{...f.assistant,summary:true},f.now+1);
    if(variant==="missing-stop")f.db.prepare("DELETE FROM part WHERE id='prt_stop'").run();
    if(variant==="wrong-stop")f.part("prt_stop","msg_final",{type:"step-finish",reason:"length"});
    if(variant==="pending-tool")f.part("prt_tool","msg_final",{type:"tool",state:{status:"running"}});
    if(variant==="unfinished-text")f.part("prt_text","msg_final",{...f.text,time:{start:f.now+2}});
    if(variant==="oversized")f.part("prt_text","msg_final",{...f.text,text:"x".repeat(262145)});
    assert.equal(f.read(),undefined);
  }));

test("OpenCode native completion refuses linked, writable or malformed stores",()=>fixture(async f=>{
  const symlink=join(f.scope.root,"alias.db"),hardlink=join(f.scope.root,"copy.db");symlinkSync(f.file,symlink);
  assert.equal(readOpenCodeCompletion(symlink,f.identity),undefined);
  linkSync(f.file,hardlink);assert.equal(f.read(),undefined);
}));

test("OpenCode native completion never accepts mutable or malformed rows",()=>fixture(async f=>{
  chmodSync(f.file,0o666);assert.equal(f.read(),undefined);chmodSync(f.file,0o600);
  f.db.prepare("UPDATE message SET data='not json' WHERE id='msg_final'").run();assert.equal(f.read(),undefined);
}));
