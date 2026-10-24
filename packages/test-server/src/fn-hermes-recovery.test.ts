import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID,createHash } from "node:crypto";
import { mkdtempSync,realpathSync,mkdirSync,writeFileSync,readFileSync,existsSync,rmSync,statSync,symlinkSync,renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join,dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { AdapterRegistry,HermesAdapter,PhononStore,type EmployeeProfileTarget,type CreateSessionParams } from "@agent-phonon/core";
import { TestConn } from "./harness.js";

const digest=(value:string|Buffer)=>createHash("sha256").update(value).digest("hex");
const documents=(target:EmployeeProfileTarget)=>({"SOUL.md":`# ${target.input.name}\n\n${target.input.responsibility}\n\n${target.input.documents.soul}`,"AGENTS.md":target.input.documents.agents,"USER.md":target.input.documents.user,"TOOLS.md":target.input.documents.tools});
async function until(check:()=>boolean|Promise<boolean>){for(let i=0;i<500;i++){if(await check())return;await new Promise(resolve=>setTimeout(resolve,10));}throw new Error("Hermes recovery condition not observed");}
async function fixture(version:"0.16"|"0.21"="0.21"){
  const root=realpathSync(mkdtempSync(join(tmpdir(),"phonon-hermes-recovery-"))),previous=process.env.HERMES_HOME;process.env.HERMES_HOME=root;
  const bin=join(root,"hermes"),calls=join(root,"calls.jsonl"),inferences=join(root,"inferences.jsonl");
  mkdirSync(join(root,"hermes_cli"));mkdirSync(join(root,"profiles"));
  writeFileSync(bin,"#!/usr/bin/python3\n");writeFileSync(join(root,"hermes_cli","__init__.py"),"");
  writeFileSync(join(root,"hermes_cli","config.py"),"def load_config(): return {}\n");
  writeFileSync(join(root,"hermes_constants.py"),"import os,sys\nfrom pathlib import Path\ndef get_hermes_home():\n return Path(os.environ['HERMES_HOME'])/'profiles'/sys.argv[sys.argv.index('--profile')+1]\n");
  writeFileSync(join(root,"hermes_cli","profiles.py"),"import os\nfrom pathlib import Path\ndef get_profile_dir(name): return Path(os.environ['HERMES_HOME'])/'profiles'/name\ndef profile_exists(name): return get_profile_dir(name).is_dir()\n");
  const metadata=join(root,`hermes_agent-${version}.0.dist-info`);mkdirSync(metadata);
  writeFileSync(join(metadata,"METADATA"),`Metadata-Version: 2.1\nName: hermes-agent\nVersion: ${version}.0\n`);
  writeFileSync(join(root,"hermes_state.py"),version==="0.16"?String.raw`import sqlite3
class SessionDB:
 def __init__(self,db_path=None,read_only=False):
  assert read_only is True, 'probe must never open a writer'
  self.read_only=read_only
  self._conn=sqlite3.connect(db_path.as_uri()+'?mode=ro',uri=True,isolation_level=None)
  self._conn.row_factory=sqlite3.Row
  def authorize(action,table,column,*unused):
   if action==sqlite3.SQLITE_READ and table=='messages' and column not in ('','id','session_id','active','role'): return sqlite3.SQLITE_DENY
   return sqlite3.SQLITE_OK
  self._conn.set_authorizer(authorize)
 def get_session(self,sid):
  row=self._conn.execute('SELECT * FROM sessions WHERE id=?',(sid,)).fetchone()
  return dict(row) if row else None
 def resolve_resume_session_id(self,sid):
  if self._conn.execute('SELECT 1 FROM messages WHERE session_id=? LIMIT 1',(sid,)).fetchone(): return sid
  row=self._conn.execute('SELECT id FROM sessions WHERE parent_session_id=? ORDER BY started_at DESC,id DESC LIMIT 1',(sid,)).fetchone()
  return row[0] if row else sid
 def get_messages(self,session_id,include_inactive=False): raise AssertionError('recovery must never materialize legacy message bodies')
 def close(self): self._conn.close()
`:String.raw`import sqlite3
class SessionDB:
 def __init__(self,db_path,read_only=False):
  assert read_only is True, 'probe must never open a writer'
  self.db=sqlite3.connect(db_path.as_uri()+'?mode=ro',uri=True);self.db.row_factory=sqlite3.Row
 def get_session(self,sid):
  row=self.db.execute('SELECT * FROM sessions WHERE id=?',(sid,)).fetchone()
  return dict(row) if row else None
 def resolve_resume_session_id(self,sid):
  row=self.db.execute('SELECT id FROM sessions WHERE parent_session_id=?',(sid,)).fetchone()
  return row[0] if row else sid
 def get_resume_message_count(self,sid,tip_only=False): return self.db.execute('SELECT COUNT(*) FROM messages WHERE session_id=?',(sid,)).fetchone()[0]
 def assert_resume_safe(self,sid,tip_only=False): assert self.get_resume_message_count(sid)<20000
 def _session_turn_lease_key(self,sid): return sid
 def _read_one(self,sql,params): return self.db.execute(sql,params).fetchone()
 def close(self): self.db.close()
`);
  writeFileSync(join(root,"hermes_cli","main.py"),String.raw`import os,sys,json,uuid,sqlite3,time
from pathlib import Path
def main():
 from run_agent import AIAgent
 args=sys.argv[1:]
 home=Path(os.environ['HERMES_HOME'])/'profiles'/args[args.index('--profile')+1]
 sid=args[args.index('--resume')+1] if '--resume' in args else 'native-'+uuid.uuid4().hex
 with open(Path(os.environ['HERMES_HOME'])/'calls.jsonl','a') as f: f.write(json.dumps({'args':args,'sid':sid})+'\n')
 history=[]
 if '--resume' in args:
  db=sqlite3.connect(home/'state.db')
  history=[{'role':row[0],'content':row[1]} for row in db.execute('SELECT role,content FROM messages WHERE session_id=? AND active=1 ORDER BY id',(sid,))]
  db.close()
  if args[args.index('-q')+1]=='lost-history': history=[]
  if args[args.index('-q')+1]=='metadata-history': history=[{'role':'session_meta','content':'not restored conversation'}]
 agent=AIAgent();agent.session_id='different-native' if args[args.index('-q')+1]=='redirect' else sid
 agent.run_conversation(args[args.index('-q')+1],home=home,conversation_history=history)
`);
  writeFileSync(join(root,"run_agent.py"),`legacy=${version==="0.16"?"True":"False"}\n`+String.raw`import os,json,sqlite3,time
from pathlib import Path
class AIAgent:
 def run_conversation(self,text,home=None,**kw):
  with open(Path(os.environ['HERMES_HOME'])/'inferences.jsonl','a') as f: f.write(json.dumps({'sid':self.session_id,'text':text})+'\n')
  db=sqlite3.connect(home/'state.db')
  db.execute('CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY,source TEXT,model TEXT,cwd TEXT,started_at REAL,ended_at REAL,archived INTEGER,end_reason TEXT,parent_session_id TEXT)')
  if legacy:
   db.execute('CREATE TABLE IF NOT EXISTS messages(id INTEGER PRIMARY KEY,session_id TEXT,role TEXT,content TEXT,active INTEGER DEFAULT 1,tool_call_id TEXT,tool_calls TEXT,tool_name TEXT,finish_reason TEXT,reasoning TEXT,reasoning_content TEXT,reasoning_details TEXT,codex_reasoning_items TEXT,codex_message_items TEXT,platform_message_id TEXT,observed INTEGER DEFAULT 0)')
   db.execute('CREATE TABLE IF NOT EXISTS compression_locks(session_id TEXT PRIMARY KEY,holder TEXT,acquired_at REAL,expires_at REAL)')
  else:
   db.execute('CREATE TABLE IF NOT EXISTS messages(id INTEGER PRIMARY KEY,session_id TEXT,role TEXT,content TEXT,active INTEGER DEFAULT 1)')
   db.execute('CREATE TABLE IF NOT EXISTS session_turn_leases(conversation_id TEXT PRIMARY KEY,holder TEXT,expires_at REAL)')
   db.execute('CREATE TABLE IF NOT EXISTS compression_locks(session_id TEXT PRIMARY KEY,holder TEXT,expires_at REAL)')
  db.execute('INSERT OR IGNORE INTO sessions VALUES(?,?,?,?,?,?,0,?,NULL)',(self.session_id,'cli','m1',os.getcwd(),time.time(),time.time(),'cli_close'))
  history=[r[0] for r in db.execute('SELECT content FROM messages WHERE session_id=? AND active=1 ORDER BY id',(self.session_id,))]
  db.execute('INSERT INTO messages(session_id,role,content) VALUES(?,?,?)',(self.session_id,'user',text));db.commit();db.close()
  return {'completed':True,'final_response':'native history: '+json.dumps(history),'messages':[]}
`);
  class NativeAdapter extends HermesAdapter{
    override async discoverAgents(){return [{agentId:"hermes:base",displayName:"Native fixture",adapter:"hermes",available:true,models:[{id:"m1",available:true}],capabilities:this.capabilities,scannedAt:new Date().toISOString()}] as any;}
    override async provisionEmployee(target:EmployeeProfileTarget){
      const home=join(root,"profiles",target.runtimeProfile);mkdirSync(home,{recursive:true});
      mkdirSync(join(home,"memories"),{recursive:true});
      for(const [name,body] of Object.entries(documents(target)))writeFileSync(join(home,name),body);
      return this.inspectEmployee(target);
    }
    override async inspectEmployee(target:EmployeeProfileTarget){const home=join(root,"profiles",target.runtimeProfile);return {home,documentHashes:Object.fromEntries(Object.keys(documents(target)).map(name=>[name,digest(readFileSync(join(home,name)))])),memoryBytes:0};}
  }
  const registry=new AdapterRegistry(),adapter=new NativeAdapter({env:{binPath:bin}});registry.register(adapter);
  let store=new PhononStore(join(root,"state.db")),conn=new TestConn({store,registry,workspaceRoot:root,tenantId:"owner",policy:{allowEmployeeProfiles:true}});
  const employeeId=randomUUID(),spec={employeeId,revision:1,agent:"hermes:base",model:"m1",profileId:randomUUID(),name:"Researcher",responsibility:"Verify retained context",documents:{soul:"Original employee identity",agents:"Preserve project boundaries",user:"Owner",tools:"Use existing tools"}};
  const employee=await conn.call("employee.profile.apply",spec) as any;
  assert.equal(employee.state,"ready");
  const project=(await conn.call("project.create",{name:"group-project",git:false}) as any).project.projectId;
  const identity=async(project:string)=>(await conn.call("session.create",{project,agent:"hermes:base",model:"m1",agentConfig:{employee:{id:employeeId,revision:1}}}) as any).sessionId as string;
  const privateId=await identity(employee.privateWorkspace.projectId),groupId=await identity(project);
  const nativeHome=join(root,"profiles",employee.runtimeProfile);
  const list=(file:string)=>existsSync(file)?readFileSync(file,"utf8").trim().split("\n").map(line=>JSON.parse(line)):[];
  return {root,bin,employee,spec,privateId,groupId,nativeHome,adapter,registry,get conn(){return conn;},get store(){return store;},calls:()=>list(calls),inferences:()=>list(inferences),
    expected(id:string){return {sessionId:id,project:id===privateId?employee.privateWorkspace.projectId:project,agent:"hermes:base",model:"m1"};},
    async turn(id:string,input:string){const result=await conn.call("session.send",{sessionId:id,input}) as any;const end=await conn.waitTurnEnd(result.turnId);await until(async()=>(await conn.call("session.status",{sessionId:id}) as any).status==="idle");return end;},
    async restart(){await conn.conn.dispose();store.close();store=new PhononStore(join(root,"state.db"));conn=new TestConn({store,registry,workspaceRoot:root,tenantId:"owner",policy:{allowEmployeeProfiles:true}});},
    async close(){await conn.conn.dispose();store.close();if(previous===undefined)delete process.env.HERMES_HOME;else process.env.HERMES_HOME=previous;rmSync(root,{recursive:true,force:true});}};
}

for(const version of ["0.16","0.21"] as const){
test(`Hermes ${version} DE recovery preserves distinct private/group native histories, memory and pending context without inference`,{skip:!existsSync("/usr/bin/python3")},async()=>{
  const f=await fixture(version);
  try{
    await f.turn(f.privateId,"private original");await f.turn(f.groupId,"group original");
    const native=f.calls().map(call=>call.sid);assert.notEqual(native[0],native[1]);
    const memory=join(f.nativeHome,"memories","MEMORY.md");writeFileSync(memory,"Persistent DE memory");
    await f.conn.call("session.inject",{sessionId:f.privateId,context:[{role:"system",content:"pending after reconnect"}]});
    const checkpoint=JSON.parse(String(f.store.loadSessions("owner").find(row=>row.session_id===f.privateId)!.recovery_json));assert.equal(checkpoint.settled,true);
    const updated=await f.conn.call("employee.profile.apply",{...f.spec,revision:2,documents:{...f.spec.documents,soul:"Updated personality without losing history"}}) as any;
    assert.equal(updated.state,"ready");
    const bytes=readFileSync(join(f.nativeHome,"state.db"));await f.restart();
    for(const id of [f.privateId,f.groupId]){
      assert.equal((await f.conn.call("session.status",{sessionId:id}) as any).recovery.canAttempt,true);
      const recovered=await f.conn.call("session.recover",f.expected(id)) as any;assert.equal(recovered.employeeRevision,2);
    }
    assert.equal(f.calls().length,2);assert.equal(f.inferences().length,2);assert.equal(f.conn.streamEvents.length,0);
    assert.deepEqual(readFileSync(join(f.nativeHome,"state.db")),bytes);assert.equal(readFileSync(memory,"utf8"),"Persistent DE memory");
    await f.turn(f.privateId,"private next");await f.turn(f.groupId,"group next");
    assert.deepEqual(f.calls().map(call=>call.sid),[native[0],native[1],native[0],native[1]]);
    assert.match(f.inferences()[2].text,/pending after reconnect/);
    for(const call of f.inferences().slice(2))assert.match(call.text,/Updated personality without losing history/);
    const finals=f.conn.streamEvents.filter(event=>event.final);assert.ok(JSON.stringify(finals).includes("private original"));assert.ok(JSON.stringify(finals).includes("group original"));
  }finally{await f.close();}
});
}

test("Hermes recovery rejects missing, replaced, empty, busy, archived and redirected native records without another attempt",{skip:!existsSync("/usr/bin/python3")},async()=>{
  for(const variant of ["missing","replaced","empty","busy","archived","redirected","cwd","model","symlink","turn-lease","expired-lease","compression-lease"]){
    const f=await fixture();
    try{
      await f.turn(f.privateId,"original");const sid=f.calls()[0].sid;await f.restart();const path=join(f.nativeHome,"state.db");
      if(variant==="missing")rmSync(path);
      else if(variant==="replaced"){const copy=path+".replacement";writeFileSync(copy,readFileSync(path));renameSync(copy,path);}
      else if(variant==="symlink"){const copy=join(f.root,"other.db");writeFileSync(copy,readFileSync(path));rmSync(path);symlinkSync(copy,path);}
      else{
        const db=new DatabaseSync(path);
        if(variant==="empty")db.prepare("DELETE FROM messages WHERE session_id=?").run(sid);
        if(variant==="busy")db.prepare("UPDATE sessions SET ended_at=NULL WHERE id=?").run(sid);
        if(variant==="archived")db.prepare("UPDATE sessions SET archived=1 WHERE id=?").run(sid);
        if(variant==="redirected")db.prepare("INSERT INTO sessions(id,parent_session_id) VALUES('new-tip',?)").run(sid);
        if(variant==="cwd")db.prepare("UPDATE sessions SET cwd=? WHERE id=?").run(f.root,sid);
        if(variant==="model")db.prepare("UPDATE sessions SET model='other' WHERE id=?").run(sid);
        if(variant==="turn-lease"||variant==="expired-lease")db.prepare("INSERT INTO session_turn_leases VALUES(?,'external-native-owner',?)").run(sid,variant==="expired-lease"?1:Date.now()/1000+300);
        if(variant==="compression-lease")db.prepare("INSERT INTO compression_locks VALUES(?,'external-native-compactor',1)").run(sid);
        db.close();
      }
      await assert.rejects(f.conn.call("session.recover",f.expected(f.privateId)),variant);
      assert.equal((await f.conn.call("session.status",{sessionId:f.privateId}) as any).status,"paused");assert.equal(f.calls().length,1);assert.equal(f.inferences().length,1);
      if(variant==="missing")assert.equal(existsSync(path),false);
    }finally{await f.close();}
  }
});

test("Hermes 0.16 recovery refuses unsafe/unsupported legacy histories without inference or writes",{skip:!existsSync("/usr/bin/python3")},async()=>{
  for(const variant of ["missing","replaced","empty","inactive-only","metadata-only","busy","archived","child","parent","compressed-root","cwd","model","started-at","source","symlink","compression-lease","expired-compression-lease","oversized","partial-api","unknown-version","unexpected-turn-table","missing-active","missing-history-column","missing-lock-table","wrong-reader","read-only-false"]){
    const f=await fixture("0.16");
    try{
      await f.turn(f.privateId,"legacy original");const sid=f.calls()[0].sid;await f.restart();const path=join(f.nativeHome,"state.db");
      if(variant==="missing")rmSync(path);
      else if(variant==="replaced"){writeFileSync(path+".replacement",readFileSync(path));renameSync(path+".replacement",path);}
      else if(variant==="symlink"){const external=join(f.root,"other.db");writeFileSync(external,readFileSync(path));rmSync(path);symlinkSync(external,path);}
      else if(variant==="partial-api")writeFileSync(join(f.root,"hermes_state.py"),readFileSync(join(f.root,"hermes_state.py"),"utf8")+"\nSessionDB.get_resume_message_count=lambda *a,**kw:1\n");
      else if(variant==="unknown-version")writeFileSync(join(f.root,"hermes_agent-0.16.0.dist-info/METADATA"),"Metadata-Version: 2.1\nName: hermes-agent\nVersion: 0.21.0\n");
      else if(variant==="wrong-reader"){
        writeFileSync(join(f.nativeHome,"other.db"),readFileSync(path));
        writeFileSync(join(f.root,"hermes_state.py"),readFileSync(join(f.root,"hermes_state.py"),"utf8").replace("db_path.as_uri()","(db_path.parent/'other.db').as_uri()"));
      }else if(variant==="read-only-false")writeFileSync(join(f.root,"hermes_state.py"),readFileSync(join(f.root,"hermes_state.py"),"utf8").replace("self.read_only=read_only","self.read_only=False"));
      else{
        const db=new DatabaseSync(path);
        if(variant==="empty")db.prepare("DELETE FROM messages WHERE session_id=?").run(sid);
        if(variant==="inactive-only")db.prepare("UPDATE messages SET active=0 WHERE session_id=?").run(sid);
        if(variant==="metadata-only")db.prepare("UPDATE messages SET role='session_meta' WHERE session_id=?").run(sid);
        if(variant==="busy")db.prepare("UPDATE sessions SET ended_at=NULL WHERE id=?").run(sid);
        if(variant==="archived")db.prepare("UPDATE sessions SET archived=1 WHERE id=?").run(sid);
        if(variant==="child")db.prepare("INSERT INTO sessions(id,parent_session_id) VALUES('unverified-child',?)").run(sid);
        if(variant==="parent")db.prepare("UPDATE sessions SET parent_session_id='unverified-parent' WHERE id=?").run(sid);
        if(variant==="compressed-root")db.prepare("UPDATE sessions SET end_reason='compression' WHERE id=?").run(sid);
        if(variant==="cwd")db.prepare("UPDATE sessions SET cwd=? WHERE id=?").run(f.root,sid);
        if(variant==="model")db.prepare("UPDATE sessions SET model='other-model' WHERE id=?").run(sid);
        if(variant==="started-at")db.prepare("UPDATE sessions SET started_at=started_at+1 WHERE id=?").run(sid);
        if(variant==="source")db.prepare("UPDATE sessions SET source='tool' WHERE id=?").run(sid);
        if(variant==="compression-lease"||variant==="expired-compression-lease")db.prepare("INSERT INTO compression_locks VALUES(?,'other-owner',1,?)").run(sid,variant==="expired-compression-lease"?1:Date.now()/1000+300);
        if(variant==="oversized")db.prepare("WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<20000) INSERT INTO messages(session_id,role,content) SELECT ?,'user','bounded-fixture' FROM n").run(sid);
        if(variant==="unexpected-turn-table")db.exec("CREATE TABLE session_turn_leases(conversation_id TEXT,holder TEXT,expires_at REAL)");
        if(variant==="missing-active")db.exec("ALTER TABLE messages RENAME COLUMN active TO hidden_active");
        if(variant==="missing-history-column")db.exec("ALTER TABLE messages RENAME COLUMN reasoning_content TO unknown_reasoning");
        if(variant==="missing-lock-table")db.exec("DROP TABLE compression_locks");
        db.close();
      }
      const before=existsSync(path)?readFileSync(path):undefined;
      await assert.rejects(f.conn.call("session.recover",f.expected(f.privateId)),variant);
      assert.equal((await f.conn.call("session.status",{sessionId:f.privateId}) as any).status,"paused");
      assert.equal(f.calls().length,1);assert.equal(f.inferences().length,1);
      if(before)assert.deepEqual(readFileSync(path),before,variant);else assert.equal(existsSync(path),false);
    }finally{await f.close();}
  }
});

test("Hermes 0.16 recovery counts only active rows with a 20000-row ceiling without materializing bodies",{skip:!existsSync("/usr/bin/python3")},async()=>{
  for(const active of [false,true]){
    const f=await fixture("0.16");
    try{
      await f.turn(f.privateId,"legacy original");const sid=f.calls()[0].sid;await f.restart();const path=join(f.nativeHome,"state.db"),db=new DatabaseSync(path);
      db.prepare("WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<?) INSERT INTO messages(session_id,role,content,active) SELECT ?,'user','must-not-read-body',? FROM n").run(active?19999:20001,sid,active?1:0);db.close();
      const before=readFileSync(path);await f.conn.call("session.recover",f.expected(f.privateId));
      assert.deepEqual(readFileSync(path),before);assert.equal(f.calls().length,1);assert.equal(f.inferences().length,1);
      assert.equal((await f.conn.call("session.status",{sessionId:f.privateId}) as any).status,"idle");
    }finally{await f.close();}
  }
});

for(const version of ["0.16","0.21"] as const){
test(`Hermes ${version} bridge rejects a resumed native-id switch before the inference method runs`,{skip:!existsSync("/usr/bin/python3")},async()=>{
  const f=await fixture(version);
  try{
    await f.turn(f.privateId,"original");await f.restart();await f.conn.call("session.recover",f.expected(f.privateId));
    await f.turn(f.privateId,"redirect");assert.equal(f.calls().length,2);assert.equal(f.inferences().length,1);
    assert.equal((f.conn.streamEvents.at(-1) as any).status,"failed");
    const checkpoint=JSON.parse(String(f.store.loadSessions("owner").find(row=>row.session_id===f.privateId)!.recovery_json??"null"));assert.equal(checkpoint,null);
  }finally{await f.close();}
});

test(`Hermes ${version} bridge rejects empty or metadata-only resume history under the unchanged native id`,{skip:!existsSync("/usr/bin/python3")},async()=>{
  for(const input of ["lost-history","metadata-history"]){
    const f=await fixture(version);
    try{
      await f.turn(f.privateId,"original");await f.restart();await f.conn.call("session.recover",f.expected(f.privateId));
      await f.turn(f.privateId,input);
      assert.equal(f.calls().length,2);assert.equal(f.calls()[0].sid,f.calls()[1].sid);
      assert.equal(f.inferences().length,1);assert.equal((f.conn.streamEvents.at(-1) as any).status,"failed");
      assert.equal(JSON.parse(String(f.store.loadSessions("owner").find(row=>row.session_id===f.privateId)!.recovery_json??"null")),null);
    }finally{await f.close();}
  }
});
}

test("installed Hermes readonly APIs verify an isolated DE native record without reopening it or calling main",async t=>{
  const bin=process.env.PHONON_TEST_HERMES_BIN;if(!bin){t.skip("Set PHONON_TEST_HERMES_BIN for isolated installed-native readonly verification");return;}
  const root=realpathSync(mkdtempSync(join(tmpdir(),"phonon-hermes-installed-recovery-"))),previous=process.env.HERMES_HOME;process.env.HERMES_HOME=root;
  const profile="phn-readonly",home=join(root,"profiles",profile),cwd=join(root,"work");mkdirSync(join(home,"memories"),{recursive:true});mkdirSync(cwd);writeFileSync(join(home,"config.yaml"),"{}\n");writeFileSync(join(home,"memories","MEMORY.md"),"Keep native long-term memory");
  try{
    const real=realpathSync(bin),python=readFileSync(real,"utf8").split("\n")[0]!.startsWith("#!/bin/sh")?join(dirname(real),"python3"):readFileSync(real,"utf8").split("\n")[0]!.slice(2);
    const sid="20261018_120000_abcdef",employeeId=randomUUID();
    const seed=String.raw`import sys,json,os
from pathlib import Path
sys.path[0]=os.path.dirname(os.path.realpath(sys.argv[1]))
from hermes_state import SessionDB
home=Path(sys.argv[2]);db=SessionDB(db_path=home/'state.db')
db.create_session(sys.argv[3],source='cli',model='m1',cwd=sys.argv[4])
db.append_message(sys.argv[3],'user','Original native context')
db.append_message(sys.argv[3],'assistant','Original native reply')
db.end_session(sys.argv[3],'cli_close')
row=db.get_session(sys.argv[3]);db.close();print(json.dumps({'startedAt':row['started_at']}))
`;
    const seeded=JSON.parse(execFileSync(python,["-c",seed,real,home,sid,cwd],{encoding:"utf8",env:{...process.env,HERMES_HOME:home,PYTHONDONTWRITEBYTECODE:"1"},timeout:20000}));
    const path=join(home,"state.db"),before=readFileSync(path),info=statSync(path,{bigint:true}),adapter=new HermesAdapter({env:{binPath:bin}});
    const params:CreateSessionParams={sessionId:"retained",agentId:"hermes:base",model:"m1",cwd,employee:{employeeId,revision:1,runtimeProfile:profile,provider:"hermes",home,context:[]}};
    const checkpoint={phononSessionId:params.sessionId,model:"m1",employeeId,native:{profile,nativeHome:home,sessionId:sid,cwd,model:"m1",startedAt:seeded.startedAt,databaseDevice:String(info.dev),databaseInode:String(info.ino),messageCount:2},pendingInject:["pending context"]};
    const session=await adapter.recoverSession(params,checkpoint);assert.deepEqual(session.recoveryCheckpoint!(),checkpoint);await session.terminate();
    assert.deepEqual(readFileSync(path),before);assert.equal(readFileSync(join(home,"memories","MEMORY.md"),"utf8"),"Keep native long-term memory");
    await assert.rejects(adapter.recoverSession({...params,sessionId:"other-group"},checkpoint));
    const lease=String.raw`import sys,os,time
from pathlib import Path
sys.path[0]=os.path.dirname(os.path.realpath(sys.argv[1]))
from hermes_state import SessionDB
db=SessionDB(db_path=Path(sys.argv[2])/'state.db')
if callable(getattr(db,'try_acquire_session_turn_lease',None)):
 assert db.try_acquire_session_turn_lease(sys.argv[3],'external-native-turn',ttl_seconds=300)
else:
 from importlib.metadata import version
 assert version('hermes-agent').split('.')[:2]==['0','16']
 db._conn.execute('INSERT INTO compression_locks(session_id,holder,acquired_at,expires_at) VALUES(?,?,?,?)',(sys.argv[3],'external-native-compression',time.time(),time.time()+300))
db.close()
`;
    execFileSync(python,["-c",lease,real,home,sid],{env:{...process.env,HERMES_HOME:home,PYTHONDONTWRITEBYTECODE:"1"},timeout:20000});
    await assert.rejects(adapter.recoverSession(params,checkpoint));
    rmSync(path);await assert.rejects(adapter.recoverSession(params,checkpoint));assert.equal(existsSync(path),false);
  }finally{if(previous===undefined)delete process.env.HERMES_HOME;else process.env.HERMES_HOME=previous;rmSync(root,{recursive:true,force:true});}
});
