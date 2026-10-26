import {DatabaseSync} from "node:sqlite";
import {randomUUID} from "node:crypto";
import {PhononError} from "./rpc.js";
import {openSync,closeSync,lstatSync,constants,realpathSync} from "node:fs";
import {isAbsolute,resolve} from "node:path";
import {workspacePathsOverlap} from "./workspace-paths.js";
import {z} from "zod";

const identity=z.string().regex(/^dir:[a-f0-9]+:[a-f0-9]+$/).max(80);
const commit=z.string().regex(/^[a-f0-9]{40,64}$/);
const label=z.string().min(1).max(512);
const pathKey=z.string().min(1).max(4096);
const absolute=z.string().min(1).max(4096).refine(isAbsolute,"path must be absolute");
const TENANT_LIMIT=1000;

function checked<S extends z.ZodTypeAny>(schema:S,value:unknown):z.output<S>{
  const result=schema.safeParse(value);
  if(result.success)return result.data as z.output<S>;
  throw new PhononError("errInvalidParams",result.error.issues[0]?.message??"invalid worktree ledger payload");
}
function privateFile(path:string,auxiliary=false){
  const value=lstatSync(path);
  if(!value.isFile()||value.isSymbolicLink()||value.nlink!==1||realpathSync(path)!==resolve(path)
    ||process.platform!=="win32"&&(value.uid!==process.getuid?.()||(value.mode&0o077)!==0))
    throw new PhononError("errProjectProvisionChanged",auxiliary?"worktree ledger auxiliary file is not privately owned":"worktree ledger file is not privately owned");
  return value;
}
function privateAuxiliaries(path:string){
  for(const suffix of["-wal","-shm","-journal"]){
    try{privateFile(path+suffix,true);}
    catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
  }
}

export interface WorktreeProvisionRecord{
  tenant:string;request_id:string;request_hash:string;receiver_id:string;project_id:string;
  source_path:string;source_identity:string;source_common_dir:string;source_common_identity:string;
  base_commit:string;base_branch:string;new_branch:string;name:string;workspace_id:string;path:string;path_key:string;
  state:"prepared"|"dispatched"|"confirmed"|"unknown"|"failed";claim:string|null;
  directory_identity:string|null;git_directory:string|null;git_identity:string|null;created_at:string;
}
export type WorktreeProvisionInput=Omit<WorktreeProvisionRecord,"state"|"claim"|"directory_identity"|"git_directory"|"git_identity">;

/** Bounded sidecar ledger for worktree provisioning: one row per request, one forward-only state machine. */
export class WorktreeProvisionLedger{
  private db:DatabaseSync;
  private original:{dev:number;ino:number};
  private compromised=false;
  constructor(private path:string){
    if(process.platform==="win32")throw new PhononError("errCapabilityUnsupported","worktree provision ledger ACL handling is not yet qualified on Windows");
    try{const fd=openSync(path,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);closeSync(fd);}
    catch(error){if((error as NodeJS.ErrnoException).code!=="EEXIST")throw error;}
    const before=privateFile(path);
    this.original={dev:before.dev,ino:before.ino};
    privateAuxiliaries(path);
    this.db=new DatabaseSync(path);
    try{
      this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;");
      this.guard();
      this.db.exec(`CREATE TABLE IF NOT EXISTS receivers(tenant TEXT PRIMARY KEY,id TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS sources(tenant TEXT NOT NULL,source_path TEXT NOT NULL,source_identity TEXT NOT NULL,source_common_dir TEXT NOT NULL,source_common_identity TEXT NOT NULL,PRIMARY KEY(tenant,source_path));
        CREATE TABLE IF NOT EXISTS worktrees(tenant TEXT NOT NULL,request_id TEXT NOT NULL,request_hash TEXT NOT NULL,receiver_id TEXT NOT NULL,project_id TEXT NOT NULL,
          source_path TEXT NOT NULL,source_identity TEXT NOT NULL,source_common_dir TEXT NOT NULL,source_common_identity TEXT NOT NULL,base_commit TEXT NOT NULL,base_branch TEXT NOT NULL,new_branch TEXT NOT NULL,name TEXT NOT NULL,
          workspace_id TEXT NOT NULL,path TEXT NOT NULL UNIQUE,path_key TEXT NOT NULL UNIQUE,state TEXT NOT NULL CHECK(state IN('prepared','dispatched','confirmed','unknown','failed')),
          claim TEXT,directory_identity TEXT,git_directory TEXT,git_identity TEXT,created_at TEXT NOT NULL,PRIMARY KEY(tenant,request_id),UNIQUE(tenant,workspace_id),UNIQUE(tenant,project_id,new_branch),
          CHECK((state='prepared')=(claim IS NULL)),CHECK(state<>'confirmed' OR directory_identity IS NOT NULL AND git_directory IS NOT NULL AND git_identity IS NOT NULL));
        CREATE UNIQUE INDEX IF NOT EXISTS worktree_claim_unique ON worktrees(tenant,claim);
        CREATE TRIGGER IF NOT EXISTS worktree_identity_immutable BEFORE UPDATE ON worktrees WHEN
          (NEW.tenant,NEW.request_id,NEW.request_hash,NEW.receiver_id,NEW.project_id,NEW.source_path,NEW.source_identity,NEW.source_common_dir,NEW.source_common_identity,NEW.base_commit,NEW.base_branch,NEW.new_branch,NEW.name,NEW.workspace_id,NEW.path,NEW.path_key,NEW.created_at)
          IS NOT (OLD.tenant,OLD.request_id,OLD.request_hash,OLD.receiver_id,OLD.project_id,OLD.source_path,OLD.source_identity,OLD.source_common_dir,OLD.source_common_identity,OLD.base_commit,OLD.base_branch,OLD.new_branch,OLD.name,OLD.workspace_id,OLD.path,OLD.path_key,OLD.created_at)
          OR OLD.claim IS NOT NULL AND NEW.claim IS NOT OLD.claim
          OR OLD.directory_identity IS NOT NULL AND NEW.directory_identity IS NOT OLD.directory_identity
          OR OLD.git_directory IS NOT NULL AND NEW.git_directory IS NOT OLD.git_directory
          OR OLD.git_identity IS NOT NULL AND NEW.git_identity IS NOT OLD.git_identity
          BEGIN SELECT RAISE(ABORT,'worktree identity is immutable');END;
        CREATE TRIGGER IF NOT EXISTS worktree_state_monotonic BEFORE UPDATE ON worktrees WHEN NEW.state<>OLD.state AND NOT(
          OLD.state='prepared' AND NEW.state='dispatched' OR OLD.state='dispatched' AND NEW.state IN('confirmed','unknown','failed'))
          BEGIN SELECT RAISE(ABORT,'worktree dispatch cannot replay');END;
        CREATE TRIGGER IF NOT EXISTS worktree_no_delete BEFORE DELETE ON worktrees BEGIN SELECT RAISE(ABORT,'worktree history is retained');END;
        CREATE TRIGGER IF NOT EXISTS worktree_receiver_immutable BEFORE UPDATE ON receivers BEGIN SELECT RAISE(ABORT,'worktree receiver is immutable');END;
        CREATE TRIGGER IF NOT EXISTS worktree_receiver_retained BEFORE DELETE ON receivers BEGIN SELECT RAISE(ABORT,'worktree receiver is retained');END;
        CREATE TRIGGER IF NOT EXISTS worktree_source_immutable BEFORE UPDATE ON sources BEGIN SELECT RAISE(ABORT,'worktree source identity is immutable');END;
        CREATE TRIGGER IF NOT EXISTS worktree_source_retained BEFORE DELETE ON sources BEGIN SELECT RAISE(ABORT,'worktree source identity is retained');END;`);
      this.guard();
    }catch(error){this.db.close();throw error;}
  }
  private guard(){
    if(this.compromised)throw new PhononError("errProjectProvisionChanged","worktree ledger security changed");
    try{
      const current=lstatSync(this.path);
      if(current.dev!==this.original.dev||current.ino!==this.original.ino)throw new PhononError("errProjectProvisionChanged","worktree ledger was replaced");
      privateFile(this.path);
      privateAuxiliaries(this.path);
    }catch(error){this.compromised=true;throw error;}
  }
  receiver(tenant:string,create=true):string|undefined{
    this.guard();checked(label,tenant);
    if(create)this.db.prepare("INSERT INTO receivers VALUES(?,?) ON CONFLICT DO NOTHING").run(tenant,randomUUID());
    const row=this.db.prepare("SELECT id FROM receivers WHERE tenant=?").get(tenant) as {id:string}|undefined;
    return row?.id;
  }
  get(tenant:string,id:string):WorktreeProvisionRecord|undefined{
    this.guard();
    return this.db.prepare("SELECT * FROM worktrees WHERE tenant=? AND request_id=?").get(tenant,id) as unknown as WorktreeProvisionRecord|undefined;
  }
  workspace(tenant:string,workspaceID:string):WorktreeProvisionRecord|undefined{
    this.guard();
    return this.db.prepare("SELECT * FROM worktrees WHERE tenant=? AND workspace_id=?").get(tenant,workspaceID) as unknown as WorktreeProvisionRecord|undefined;
  }
  overlapping(pathKey:string):WorktreeProvisionRecord|undefined{
    this.guard();
    return(this.db.prepare("SELECT * FROM worktrees").all() as unknown as WorktreeProvisionRecord[]).find(row=>workspacePathsOverlap(row.path_key,pathKey));
  }
  prepare(input:WorktreeProvisionInput):WorktreeProvisionRecord{
    this.guard();
    checked(label,input.tenant);checked(label,input.request_id);checked(label,input.request_hash);checked(label,input.receiver_id);checked(label,input.project_id);
    checked(absolute,input.source_path);checked(identity,input.source_identity);checked(absolute,input.source_common_dir);checked(identity,input.source_common_identity);
    checked(commit,input.base_commit);checked(label,input.base_branch);checked(label,input.new_branch);checked(label,input.name);checked(label,input.workspace_id);
    checked(absolute,input.path);checked(pathKey,input.path_key);checked(label,input.created_at);
    this.db.exec("BEGIN IMMEDIATE");
    try{
      const old=this.get(input.tenant,input.request_id);
      if(old){
        if(old.request_hash!==input.request_hash)throw new PhononError("errInvalidParams","worktree request payload changed");
        if(old.receiver_id!==input.receiver_id||old.project_id!==input.project_id||old.workspace_id!==input.workspace_id
          ||old.source_path!==input.source_path||old.path!==input.path||old.path_key!==input.path_key)
          throw new PhononError("errProjectProvisionChanged","worktree preparation identity changed");
        this.db.exec("COMMIT");return old;
      }
      const receiver=this.db.prepare("SELECT id FROM receivers WHERE tenant=?").get(input.tenant) as {id:string}|undefined;
      if(receiver&&receiver.id!==input.receiver_id)throw new PhononError("errProjectProvisionChanged","worktree receiver is not this tenant receiver");
      const count=this.db.prepare("SELECT count(*) n FROM worktrees WHERE tenant=?").get(input.tenant) as {n:number};
      if(count.n>=TENANT_LIMIT)throw new PhononError("errTenantQuotaExceeded","worktree preparation history requires human maintenance");
      const source=this.db.prepare("SELECT source_identity,source_common_dir,source_common_identity FROM sources WHERE tenant=? AND source_path=?").get(input.tenant,input.source_path) as {source_identity:string;source_common_dir:string;source_common_identity:string}|undefined;
      if(source&&(source.source_identity!==input.source_identity||source.source_common_dir!==input.source_common_dir||source.source_common_identity!==input.source_common_identity))
        throw new PhononError("errProjectProvisionChanged","worktree source repository was replaced");
      this.db.prepare("INSERT INTO sources VALUES(?,?,?,?,?) ON CONFLICT DO NOTHING").run(input.tenant,input.source_path,input.source_identity,input.source_common_dir,input.source_common_identity);
      this.db.prepare("INSERT INTO receivers VALUES(?,?) ON CONFLICT DO NOTHING").run(input.tenant,input.receiver_id);
      try{
        this.db.prepare(`INSERT INTO worktrees(tenant,request_id,request_hash,receiver_id,project_id,source_path,source_identity,source_common_dir,source_common_identity,base_commit,base_branch,new_branch,name,workspace_id,path,path_key,state,claim,directory_identity,git_directory,git_identity,created_at)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'prepared',NULL,NULL,NULL,NULL,?)`).run(input.tenant,input.request_id,input.request_hash,input.receiver_id,input.project_id,input.source_path,input.source_identity,input.source_common_dir,input.source_common_identity,input.base_commit,input.base_branch,input.new_branch,input.name,input.workspace_id,input.path,input.path_key,input.created_at);
      }catch(error){throw new PhononError("errProjectProvisionChanged","worktree path, workspace or branch is already provisioned");}
      const row=this.get(input.tenant,input.request_id)!;
      this.db.exec("COMMIT");return row;
    }catch(error){try{this.db.exec("ROLLBACK");}catch{/* transaction already closed */}throw error;}
  }
  claim(row:WorktreeProvisionRecord,claim:string):boolean{
    this.guard();checked(label,claim);
    return this.db.prepare("UPDATE worktrees SET state='dispatched',claim=? WHERE tenant=? AND request_id=? AND request_hash=? AND state='prepared'")
      .run(claim,row.tenant,row.request_id,row.request_hash).changes===1;
  }
  confirm(row:WorktreeProvisionRecord,claim:string,directoryIdentity:string,gitDirectory:string,gitIdentity:string){
    this.guard();checked(identity,directoryIdentity);checked(identity,gitIdentity);checked(absolute,gitDirectory);
    if(this.db.prepare("UPDATE worktrees SET state='confirmed',directory_identity=?,git_directory=?,git_identity=? WHERE tenant=? AND request_id=? AND claim=? AND state='dispatched'")
      .run(directoryIdentity,gitDirectory,gitIdentity,row.tenant,row.request_id,claim).changes!==1)
      throw new PhononError("errProjectProvisionUnconfirmed","worktree confirmation did not match a dispatched claim");
  }
  settle(row:WorktreeProvisionRecord,state:"unknown"|"failed"):boolean{
    this.guard();
    return this.db.prepare("UPDATE worktrees SET state=? WHERE tenant=? AND request_id=? AND claim=? AND state='dispatched'")
      .run(state,row.tenant,row.request_id,row.claim).changes===1;
  }
  close(){this.db.close();}
}
