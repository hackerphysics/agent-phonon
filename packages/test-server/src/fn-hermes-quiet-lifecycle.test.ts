import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HERMES_BRIDGE } from "../../core/dist/adapters/hermes-bridge.js";

function quietLifecycle(mode:string){
  const root=realpathSync(mkdtempSync(join(tmpdir(),"phonon-hermes-quiet-close-")));
  const source=String.raw`
import os,sys,json,sqlite3,types,time,importlib.metadata
from pathlib import Path
from types import SimpleNamespace
root=Path.cwd();home=root/'profile';home.mkdir()
original_out=sys.stdout
os.environ.pop('PHONON_HERMES_NATIVE_MCP_CONTEXT',None)
os.environ.pop('PHONON_HERMES_EXPECTED_PROFILE_HOME',None)
os.environ.pop('PHONON_HERMES_EXPECTED_SESSION',None)
os.environ.pop('PHONON_REASONING_REQUEST',None)
mode=__MODE__
path=home/('other.db' if mode=='wrong-db' else 'state.db')
conn=sqlite3.connect(path);conn.row_factory=sqlite3.Row
conn.execute('CREATE TABLE sessions(id TEXT PRIMARY KEY,source TEXT,archived INTEGER,parent_session_id TEXT,cwd TEXT,ended_at REAL,end_reason TEXT)')
conn.execute('CREATE TABLE compression_locks(session_id TEXT PRIMARY KEY,holder TEXT)')
conn.execute('INSERT INTO sessions VALUES(?,?,?,?,?,?,?)',('owned','gateway' if mode=='wrong-source' else 'cli',1 if mode=='archived' else 0,'parent' if mode=='child' else None,str(home if mode=='wrong-cwd' else root),123 if mode=='already-ended' else None,'compression' if mode=='already-ended' else None))
conn.execute("INSERT INTO sessions VALUES('unrelated','cli',0,NULL,?,456,'retain')",(str(root),))
if mode=='descendant': conn.execute("INSERT INTO sessions VALUES('child','cli',0,'owned',?,NULL,NULL)",(str(root),))
if mode=='compression-lock': conn.execute("INSERT INTO compression_locks VALUES('owned','other-owner')")
conn.commit()
if mode=='wrong-db': (home/'state.db').touch()
calls=[]
class SessionDB:
    read_only=mode=='read-only'
    _conn=conn
    def get_session(self,sid):
        row=self._conn.execute('SELECT * FROM sessions WHERE id=?',(sid,)).fetchone()
        return dict(row) if row else None
    def end_session(self,sid,reason):
        calls.append((sid,reason))
        self._conn.execute('UPDATE sessions SET ended_at=?,end_reason=? WHERE id=? AND ended_at IS NULL',(time.time(),reason,sid));self._conn.commit()
db=SessionDB()
def module(name,**attrs):
    value=types.ModuleType(name);value.__path__=[];value.__dict__.update(attrs);sys.modules[name]=value
module('hermes_state',SessionDB=SessionDB)
importlib.metadata.version=lambda name:'0.21.0' if mode=='unknown-version' else '0.16.0'
class AIAgent:
    _session_db=db
    session_id='owned'
    def run_conversation(self,*args,**kwargs):
        result={'completed':True,'final_response':'Actual successful turn','messages':[]}
        if mode=='failure-result': result.update(completed=False,failed=True,error='failure')
        if mode=='partial': result['partial']=True
        if mode=='interrupted': result['interrupted']=True
        if mode=='empty-response': result['final_response']=''
        return result
def main():
    agent=AIAgent();agent.run_conversation()
    if mode=='multiple-root-turns': agent.run_conversation()
    if mode=='success-exit0': raise SystemExit(0)
    if mode=='nonzero': raise SystemExit(1)
module('run_agent',AIAgent=AIAgent)
module('hermes_cli');module('hermes_cli.main',main=main);module('hermes_cli.config',load_config=lambda:{})
module('hermes_constants',get_hermes_home=lambda:home)
sys.argv=['bridge','/native/hermes','chat','-Q','-q','owned input']
if mode=='not-quiet': sys.argv.remove('-Q')
try: exec(__BRIDGE__)
except SystemExit: pass
original_out.write(json.dumps({'calls':calls,'owned':db.get_session('owned'),'unrelated':db.get_session('unrelated')})+'\n')
conn.close()
`.replace("__MODE__",JSON.stringify(mode)).replace("__BRIDGE__",JSON.stringify(HERMES_BRIDGE));
  try{
    const output=execFileSync("python3",["-B","-c",source],{cwd:root,encoding:"utf8",timeout:10000});
    return JSON.parse(output.trim().split("\n").at(-1)!);
  }finally{rmSync(root,{recursive:true,force:true});}
}

for(const mode of ["success-return","success-exit0"]){
  test("Hermes 0.16 quiet lifecycle closes only its successful root using the native API: "+mode,()=>{
    const result=quietLifecycle(mode);
    assert.deepEqual(result.calls,[["owned","cli_close"]]);
    assert.ok(Number.isFinite(result.owned.ended_at));assert.equal(result.owned.end_reason,"cli_close");
    assert.equal(result.unrelated.ended_at,456);assert.equal(result.unrelated.end_reason,"retain");
  });
}
for(const mode of ["failure-result","partial","interrupted","empty-response","nonzero","wrong-cwd","read-only","child","descendant","compression-lock","wrong-source","archived","unknown-version","wrong-db","multiple-root-turns","not-quiet"]){
  test("Hermes quiet lifecycle does not manufacture settlement for "+mode,()=>{
    const result=quietLifecycle(mode);
    assert.deepEqual(result.calls,[]);assert.equal(result.owned.ended_at,null);
    assert.equal(result.unrelated.ended_at,456);assert.equal(result.unrelated.end_reason,"retain");
  });
}
test("Hermes quiet lifecycle preserves a native session's first close reason",()=>{
  const result=quietLifecycle("already-ended");
  assert.deepEqual(result.calls,[]);assert.equal(result.owned.ended_at,123);assert.equal(result.owned.end_reason,"compression");
});
