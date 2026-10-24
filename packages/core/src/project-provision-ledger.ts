import {DatabaseSync} from "node:sqlite";
import {randomUUID} from "node:crypto";
import {PhononError} from "./rpc.js";
import {openSync,closeSync,lstatSync,constants,realpathSync} from "node:fs";
import {resolve} from "node:path";
import {workspacePathsOverlap} from "./workspace-paths.js";
import {z} from "zod";
const identity=z.string().regex(/^[pw]:[a-f0-9]+:[a-f0-9]+$/).max(80),nodeIdentity=z.string().regex(/^[a-f0-9]+:[a-f0-9]+$/).max(80);
function privateFile(path:string,auxiliary=false){
  const value=lstatSync(path);
  if(!value.isFile()||value.isSymbolicLink()||value.nlink!==1||realpathSync(path)!==resolve(path)
    ||process.platform!=="win32"&&(value.uid!==process.getuid?.()||(value.mode&0o077)!==0))
    throw new PhononError("errProjectProvisionChanged",auxiliary?"workspace ledger auxiliary file is not privately owned":"workspace ledger file is not privately owned");
  return value;
}
function privateAuxiliaries(path:string){
  for(const suffix of["-wal","-shm","-journal"]){
    try{privateFile(path+suffix,true);}
    catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
  }
}

export interface ProvisionRecord{
  tenant:string;request_id:string;request_hash:string;receiver_id:string;name:string;project_id:string;root:string;root_identity:string;root_node_identity:string;path:string;path_key:string;
  state:"prepared"|"dispatched"|"observed"|"confirmed"|"unknown"|"failed";claim:string|null;workspace_identity:string|null;node_identity:string|null;created_at:string;
}
export class ProjectProvisionLedger{
  private db:DatabaseSync;
  private original:{dev:number;ino:number};
  private compromised=false;
  constructor(private path:string){
    if(process.platform==="win32")throw new PhononError("errCapabilityUnsupported","workspace provisioning ledger ACL handling is not yet qualified on Windows");
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
      CREATE TABLE IF NOT EXISTS roots(tenant TEXT NOT NULL,root TEXT NOT NULL,identity TEXT NOT NULL,PRIMARY KEY(tenant,root));
      CREATE TABLE IF NOT EXISTS operations(tenant TEXT NOT NULL,request_id TEXT NOT NULL,request_hash TEXT NOT NULL,receiver_id TEXT NOT NULL,name TEXT NOT NULL,
        project_id TEXT NOT NULL UNIQUE,root TEXT NOT NULL,root_identity TEXT NOT NULL,root_node_identity TEXT NOT NULL,path TEXT NOT NULL UNIQUE,path_key TEXT NOT NULL UNIQUE,state TEXT NOT NULL CHECK(state IN('prepared','dispatched','observed','confirmed','unknown','failed')),
        claim TEXT,workspace_identity TEXT,node_identity TEXT,created_at TEXT NOT NULL,PRIMARY KEY(tenant,request_id),
        CHECK((state='prepared')=(claim IS NULL)),CHECK(state NOT IN('observed','confirmed') OR workspace_identity IS NOT NULL AND node_identity IS NOT NULL));
      CREATE TRIGGER IF NOT EXISTS provision_identity_immutable BEFORE UPDATE ON operations WHEN
        (NEW.tenant,NEW.request_id,NEW.request_hash,NEW.receiver_id,NEW.name,NEW.project_id,NEW.root,NEW.root_identity,NEW.root_node_identity,NEW.path,NEW.path_key,NEW.created_at)
        IS NOT (OLD.tenant,OLD.request_id,OLD.request_hash,OLD.receiver_id,OLD.name,OLD.project_id,OLD.root,OLD.root_identity,OLD.root_node_identity,OLD.path,OLD.path_key,OLD.created_at)
        OR OLD.claim IS NOT NULL AND NEW.claim IS NOT OLD.claim
        OR OLD.workspace_identity IS NOT NULL AND NEW.workspace_identity IS NOT OLD.workspace_identity
        OR OLD.node_identity IS NOT NULL AND NEW.node_identity IS NOT OLD.node_identity
        BEGIN SELECT RAISE(ABORT,'provision identity is immutable');END;
      CREATE TRIGGER IF NOT EXISTS provision_state_monotonic BEFORE UPDATE ON operations WHEN NEW.state<>OLD.state AND NOT(
        OLD.state='prepared' AND NEW.state='dispatched' OR OLD.state='dispatched' AND NEW.state IN('observed','unknown','failed') OR OLD.state='observed' AND NEW.state='confirmed')
        BEGIN SELECT RAISE(ABORT,'provision dispatch cannot replay');END;
      CREATE TRIGGER IF NOT EXISTS provision_no_delete BEFORE DELETE ON operations BEGIN SELECT RAISE(ABORT,'provision history is retained');END;
      CREATE TRIGGER IF NOT EXISTS provision_receiver_immutable BEFORE UPDATE ON receivers BEGIN SELECT RAISE(ABORT,'provision receiver is immutable');END;
      CREATE TRIGGER IF NOT EXISTS provision_receiver_retained BEFORE DELETE ON receivers BEGIN SELECT RAISE(ABORT,'provision receiver is retained');END;
      CREATE TRIGGER IF NOT EXISTS provision_root_immutable BEFORE UPDATE ON roots BEGIN SELECT RAISE(ABORT,'provision root is immutable');END;
      CREATE TRIGGER IF NOT EXISTS provision_root_retained BEFORE DELETE ON roots BEGIN SELECT RAISE(ABORT,'provision root is retained');END;`);
    this.guard();
    }catch(error){this.db.close();throw error;}
  }
  private guard(){
    if(this.compromised)throw new PhononError("errProjectProvisionChanged","provision ledger security changed");
    try{
      const current=lstatSync(this.path);
      if(current.dev!==this.original.dev||current.ino!==this.original.ino)throw new PhononError("errProjectProvisionChanged","provision ledger was replaced");
      privateFile(this.path);
      privateAuxiliaries(this.path);
    }catch(error){this.compromised=true;throw error;}
  }
  receiver(tenant:string){
    this.guard();
    this.db.prepare("INSERT INTO receivers VALUES(?,?) ON CONFLICT DO NOTHING").run(tenant,randomUUID());
    return (this.db.prepare("SELECT id FROM receivers WHERE tenant=?").get(tenant) as {id:string}).id;
  }
  get(tenant:string,id:string):ProvisionRecord|undefined{this.guard();return this.db.prepare("SELECT * FROM operations WHERE tenant=? AND request_id=?").get(tenant,id) as ProvisionRecord|undefined;}
  project(tenant:string,id:string):ProvisionRecord|undefined{this.guard();return this.db.prepare("SELECT * FROM operations WHERE tenant=? AND project_id=?").get(tenant,id) as ProvisionRecord|undefined;}
  overlapping(key:string):ProvisionRecord|undefined{this.guard();return(this.db.prepare("SELECT * FROM operations").all() as unknown as ProvisionRecord[]).find(row=>workspacePathsOverlap(row.path_key,key));}
  prepare(input:Omit<ProvisionRecord,"state"|"claim"|"workspace_identity"|"node_identity">){
    this.guard();identity.parse(input.root_identity);nodeIdentity.parse(input.root_node_identity);
    this.db.exec("BEGIN IMMEDIATE");try{
      const old=this.get(input.tenant,input.request_id);if(old){this.db.exec("COMMIT");return old;}
      const root=this.db.prepare("SELECT identity FROM roots WHERE tenant=? AND root=?").get(input.tenant,input.root) as {identity:string}|undefined;
      if(root&&root.identity!==input.root_identity)throw new PhononError("errProjectProvisionChanged","configured workspace root was replaced");
      const count=this.db.prepare("SELECT count(*) n FROM operations WHERE tenant=?").get(input.tenant) as {n:number};
      if(count.n>=1000)throw new PhononError("errTenantQuotaExceeded","workspace preparation history requires human maintenance");
      this.db.prepare("INSERT INTO roots VALUES(?,?,?) ON CONFLICT DO NOTHING").run(input.tenant,input.root,input.root_identity);
      this.db.prepare(`INSERT INTO operations(tenant,request_id,request_hash,receiver_id,name,project_id,root,root_identity,root_node_identity,path,path_key,state,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,'prepared',?)`).run(input.tenant,input.request_id,input.request_hash,input.receiver_id,input.name,input.project_id,input.root,input.root_identity,input.root_node_identity,input.path,input.path_key,input.created_at);
      const row=this.get(input.tenant,input.request_id)!;this.db.exec("COMMIT");return row;
    }catch(error){this.db.exec("ROLLBACK");throw error;}
  }
  claim(row:ProvisionRecord,claim:string){this.guard();return this.db.prepare("UPDATE operations SET state='dispatched',claim=? WHERE tenant=? AND request_id=? AND request_hash=? AND state='prepared'").run(claim,row.tenant,row.request_id,row.request_hash).changes===1;}
  observe(row:ProvisionRecord,claim:string,workspaceIdentity:string,workspaceNodeIdentity:string){
    this.guard();
    identity.parse(workspaceIdentity);nodeIdentity.parse(workspaceNodeIdentity);
    if(this.db.prepare("UPDATE operations SET state='observed',workspace_identity=?,node_identity=? WHERE tenant=? AND request_id=? AND claim=? AND state='dispatched'")
      .run(workspaceIdentity,workspaceNodeIdentity,row.tenant,row.request_id,claim).changes!==1)throw new PhononError("errProjectProvisionUnconfirmed");
  }
  settle(row:ProvisionRecord,state:"unknown"|"failed"){this.guard();this.db.prepare("UPDATE operations SET state=? WHERE tenant=? AND request_id=? AND claim=? AND state='dispatched'").run(state,row.tenant,row.request_id,row.claim);}
  confirm(row:ProvisionRecord){this.guard();this.db.prepare("UPDATE operations SET state='confirmed' WHERE tenant=? AND request_id=? AND state='observed'").run(row.tenant,row.request_id);}
  close(){this.db.close();}
}
