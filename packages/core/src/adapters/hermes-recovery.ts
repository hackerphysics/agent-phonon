import { execFile } from "node:child_process";
import { dirname } from "node:path";
import { z } from "zod";
import { hermesCommand,hermesBridgeInvocation } from "./hermes-command.js";
import { PhononError } from "../rpc.js";
import {NativeFileBroker} from "../native-file-broker.js";
import {HERMES_PROFILE_FILES} from "./hermes-profile-files.js";

export const HermesNativeObservation=z.object({
  profile:z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/),nativeHome:z.string().min(1),sessionId:z.string().min(1).max(512),cwd:z.string().min(1),
  model:z.string().max(512),startedAt:z.number().finite(),databaseDevice:z.string(),databaseInode:z.string(),messageCount:z.number().int().positive(),
}).strict();
export type HermesNativeObservation=z.infer<typeof HermesNativeObservation>;
export const HermesCheckpoint=z.object({phononSessionId:z.string().min(1),model:z.string(),native:HermesNativeObservation,pendingInject:z.array(z.string()).max(256),
  employeeId:z.string().optional(),
}).strict();
export type HermesCheckpoint=z.infer<typeof HermesCheckpoint>;

// Native read APIs and verified 0.16 metadata-only SELECTs. Never reopen or infer.
const HERMES_RECOVERY_PROBE=String.raw`
import sys, os, json, stat, math, sqlite3
from pathlib import Path
wire=sys.stdout
sys.stdout=sys.stderr
sys.path[0]=os.path.dirname(os.path.realpath(sys.argv[1]))

def fail(code): raise RuntimeError(code)

# PHONON_HERMES_PROFILE_FILES

def legacy_count(db, path, sid, row):
    from importlib.metadata import version
    # A missing modern API is not permission to downgrade arbitrary runtimes.
    if version('hermes-agent').split('.')[:2]!=['0','16']: raise RuntimeError('unsupported native read API')
    conn=getattr(db,'_conn',None)
    if getattr(db,'read_only',False) is not True or not isinstance(conn,sqlite3.Connection): raise RuntimeError('unverified legacy reader')
    main=[item for item in conn.execute('PRAGMA database_list') if item[1]=='main']
    if len(main)!=1 or Path(main[0][2]).resolve(strict=True)!=path: raise RuntimeError('reader store changed')
    tables={item[0] for item in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    if 'session_turn_leases' in tables or not {'sessions','messages','compression_locks'}<=tables: raise RuntimeError('unsupported legacy schema')
    required={
        'sessions':{'id','source','model','cwd','started_at','ended_at','archived','parent_session_id','end_reason'},
        'messages':{'id','session_id','active','role','content','tool_call_id','tool_calls','tool_name','finish_reason',
                    'reasoning','reasoning_content','reasoning_details','codex_reasoning_items','codex_message_items','platform_message_id','observed'},
        'compression_locks':{'session_id','holder','acquired_at','expires_at'},
    }
    for table,columns in required.items():
        if not columns<={item[1] for item in conn.execute('PRAGMA table_info('+table+')')}: raise RuntimeError('incomplete legacy schema')
    # 0.16's resolver can return a parent with messages even when a child has
    # newer history. Without conversation leases, only an unambiguous root is safe.
    if row.get('parent_session_id') is not None or row.get('end_reason')=='compression': raise RuntimeError('legacy lineage cannot be verified')
    if conn.execute('SELECT 1 FROM sessions WHERE parent_session_id=? LIMIT 1',(sid,)).fetchone() is not None: raise RuntimeError('legacy descendant exists')
    if conn.execute('SELECT holder FROM compression_locks WHERE session_id=?',(sid,)).fetchone() is not None: raise RuntimeError('native compression lease remains')
    # Match native get_messages()'s active-row scope, without loading any bodies.
    # Legacy has no resume guard; enforce the newer runtime's conservative default.
    count=conn.execute('SELECT COUNT(*) FROM (SELECT 1 FROM messages WHERE session_id=? AND active=1 LIMIT 20001)',(sid,)).fetchone()[0]
    if count<=0 or count>20000: raise RuntimeError('legacy history missing or too large')
    # Native CLI removes session_meta rows before restoration. Metadata alone
    # must not pass a probe and then become a fresh conversation under the same id.
    if conn.execute("SELECT 1 FROM messages WHERE session_id=? AND active=1 AND role IN ('user','assistant','system','tool') LIMIT 1",(sid,)).fetchone() is None: raise RuntimeError('legacy conversation history missing')
    return count

def safe_count(db, path, sid, row):
    methods=['_session_turn_lease_key','_read_one','get_resume_message_count','assert_resume_safe']
    present=[callable(getattr(db,name,None)) for name in methods]
    if not any(present): return legacy_count(db,path,sid,row)
    if not all(present): raise RuntimeError('incomplete native read API')
    # Compression parents share one turn authority. Expired lease rows remain
    # uncertainty, never permission to take another native owner's turn.
    lease_key=db._session_turn_lease_key(sid)
    if db._read_one('SELECT holder FROM session_turn_leases WHERE conversation_id=?',(lease_key,)) is not None: raise RuntimeError('native turn lease remains')
    if db._read_one('SELECT holder FROM compression_locks WHERE session_id=?',(sid,)) is not None: raise RuntimeError('native compression lease remains')
    count=db.get_resume_message_count(sid,tip_only=True)
    if count<=0: raise RuntimeError('native history missing')
    db.assert_resume_safe(sid,tip_only=True)
    return count

try:
    request=json.load(sys.stdin)
    from hermes_cli.profiles import get_profile_dir, profile_exists
    if not profile_exists(request['profile']): raise RuntimeError('profile missing')
    raw_home=get_profile_dir(request['profile'])
    home=raw_home.resolve(strict=True)
    os.environ['HERMES_HOME']=str(home)
    path=home/'state.db'
    if os.name=='nt':
        profile_fs_ready();parent=profile_root(str(raw_home));guard=profile_windows_read_guard(parent,'state.db')
        _,database_device,database_inode=guard['identity'].split(':')
        fd=None
    else:
        fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW)
    try:
        if fd is not None:
            before=os.fstat(fd)
            if not stat.S_ISREG(before.st_mode) or before.st_nlink!=1: raise RuntimeError('unsafe state store')
            database_device=str(before.st_dev);database_inode=str(before.st_ino)
        from hermes_state import SessionDB
        db=SessionDB(db_path=path,read_only=True)
        try:
            sid=request['sessionId']
            row=db.get_session(sid)
            if not row or row.get('id')!=sid or row.get('source')!='cli' or row.get('archived')!=0: raise RuntimeError('session missing')
            if db.resolve_resume_session_id(sid)!=sid: raise RuntimeError('native identity changed')
            if row.get('ended_at') is None or not math.isfinite(float(row['ended_at'])): raise RuntimeError('native session not settled')
            cwd=str(Path(row['cwd']).resolve(strict=True))
            if cwd!=str(Path(request['cwd']).resolve(strict=True)): raise RuntimeError('workspace changed')
            count=safe_count(db,path,sid,row)
            if fd is not None:
                after=os.stat(path,follow_symlinks=False)
                if not stat.S_ISREG(after.st_mode) or (before.st_dev,before.st_ino)!=(after.st_dev,after.st_ino): raise RuntimeError('store changed')
            else:
                profile_root(str(raw_home),parent.identity)
                if _profile_broker('read',parent,'state.db',read_limit=1)['identity']!=guard['identity']: raise RuntimeError('store changed')
            result={'profile':request['profile'],'nativeHome':str(home),'sessionId':sid,'cwd':cwd,
                'model':row.get('model') or '', 'startedAt':row['started_at'],'databaseDevice':database_device,
                'databaseInode':database_inode,'messageCount':count}
        finally: db.close()
    finally:
        if fd is not None: os.close(fd)
        else: profile_windows_close_guard(guard);profile_close(parent)
    wire.write(json.dumps({'ok':True,'native':result})+'\n')
except Exception:
    wire.write(json.dumps({'ok':False})+'\n')
wire.flush()
`.replace("# PHONON_HERMES_PROFILE_FILES",HERMES_PROFILE_FILES);

export async function observeHermesSession(bin:string,profile:string,sessionId:string,cwd:string,profileFileBrokerRoot?:string):Promise<HermesNativeObservation>{
  const command=hermesCommand(bin);
  let broker:string|undefined;
  if(process.platform==="win32"){
    if(!profileFileBrokerRoot)throw new PhononError("errSessionBusy","Windows Hermes native identity requires prepared file runtime assets");
    broker=await new NativeFileBroker(profileFileBrokerRoot).verifiedExecutable();
  }
  return new Promise((resolve,reject)=>{
    const failure=()=>new PhononError("errSessionBusy","Hermes native Session identity could not be verified");
    const invocation=hermesBridgeInvocation(HERMES_RECOVERY_PROBE,[command.entry,...(broker?[broker]:[])],JSON.stringify({profile,sessionId,cwd}));
    const child=execFile(command.python,invocation.args,{cwd:dirname(command.entry),timeout:8000,maxBuffer:65536,env:{...process.env,PYTHONDONTWRITEBYTECODE:"1"}},(error,stdout)=>{
      if(error){reject(failure());return;}
      try{const result=JSON.parse(stdout);if(result.ok!==true)throw failure();resolve(HermesNativeObservation.parse(result.native));}catch{reject(failure());}
    });
    child.stdin?.on("error",()=>{});
    child.stdin?.end(invocation.stdin);
  });
}

export function sameHermesSession(saved:HermesNativeObservation,current:HermesNativeObservation):boolean{
  const {messageCount:before,...identity}=saved,{messageCount:after,...observed}=current;
  return after>=before&&Object.entries(identity).every(([key,value])=>observed[key as keyof typeof observed]===value);
}
