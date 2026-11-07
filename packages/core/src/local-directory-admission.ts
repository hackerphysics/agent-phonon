import {DatabaseSync} from "node:sqlite";
import {createHash,randomUUID} from "node:crypto";
import {closeSync,constants,existsSync,fstatSync,lstatSync,mkdirSync,openSync,realpathSync} from "node:fs";
import {dirname,join,parse,resolve,sep} from "node:path";
import {homedir} from "node:os";
import {PhononError} from "./rpc.js";
import {directoryIdentity,assertDirectoryIdentity} from "./directory-identity.js";
import {canonicalWorkspacePath,workspacePathKey,workspacePathsOverlap,assertProcessPathAvailable} from "./workspace-paths.js";
import type {PhononStore} from "./store.js";

export interface LocalDirectorySource {url:string;deviceKey?:string;expectedTenantId?:string}
const denied=(message:string):never=>{throw new PhononError("errPolicyDenied",message);};
const overlap=(a:string,b:string)=>workspacePathsOverlap(workspacePathKey(a),workspacePathKey(b));

/** Local configured identity, not a remote account assertion or an MCP grant. */
export function localDirectorySourceFingerprint(source:LocalDirectorySource):string|undefined{
  if(!source.deviceKey||!source.expectedTenantId||source.expectedTenantId.trim()!==source.expectedTenantId||/[\x00-\x1f\x7f]/.test(source.expectedTenantId))return undefined;
  let url:URL;try{url=new URL(source.url);}catch{return undefined;}
  if(url.username||url.password||url.search||url.hash)return undefined;
  if(!["https:","wss:"].includes(url.protocol)&&!(["http:","ws:"].includes(url.protocol)&&["localhost","127.0.0.1","[::1]"].includes(url.hostname)))return undefined;
  return createHash("sha256").update(JSON.stringify(["phonon-local-directory-v1",source.url,source.deviceKey,source.expectedTenantId])).digest("hex");
}

/** No chmod/repair of existing provenance. Unsupported OS ownership fails closed. */
export function assertLocalOwnerPath(path:string,directory=false):void{
  if(process.platform==="win32"||process.getuid===undefined)denied("local directory consent requires verified OS ownership");
  const uid=process.getuid!(),info=lstatSync(path);
  if(realpathSync(path)!==resolve(path)||info.isSymbolicLink()||info.uid!==uid
    ||(directory?!info.isDirectory():!info.isFile()||info.nlink!==1)||(info.mode&0o077)!==0)denied("local provenance must be private, owned and nonlinked");
  for(let parent=dirname(path);;parent=dirname(parent)){
    const stat=lstatSync(parent);
    if(stat.isSymbolicLink()||!stat.isDirectory()||(stat.uid!==uid&&stat.uid!==0)
      ||(stat.mode&0o022)!==0&&!(stat.uid===0&&(stat.mode&0o1000)!==0))denied("local provenance ancestor is not protected");
    if(dirname(parent)===parent)break;
  }
}

interface Admission {path:string;identity:string;source:string;tenant:string;createdAt:string;revokedAt:string|null;generation:string}

/** Only local code can write here. Remote project records are never consent. */
export class LocalDirectoryAdmissions {
  readonly path:string;
  constructor(private readonly mainDb:string){this.path=mainDb+".local-directories/consent.sqlite";}
  private access<T>(write:boolean,fn:(db:DatabaseSync)=>T):T|undefined{
    if(this.mainDb===":memory:"){if(write)denied("local consent requires durable storage");return undefined;}
    const dir=dirname(this.path);
    if(!existsSync(dir)){
      if(!write)return undefined;
      assertLocalOwnerPath(dirname(this.mainDb),true);
      mkdirSync(dir,{mode:0o700});
    }
    assertLocalOwnerPath(dir,true);
    assertLocalOwnerPath(dirname(this.mainDb),true);
    if(!existsSync(this.path)){
      if(!write)return undefined;
      const fd=openSync(this.path,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);closeSync(fd);
    }
    assertLocalOwnerPath(this.path);
    for(const suffix of ["-journal","-wal","-shm"])if(existsSync(this.path+suffix))assertLocalOwnerPath(this.path+suffix);
    const identity=lstatSync(this.path,{bigint:true}),fd=openSync(this.path,constants.O_RDONLY|constants.O_NOFOLLOW);
    let db:DatabaseSync|undefined;
    try{
      const held=fstatSync(fd,{bigint:true});if(held.dev!==identity.dev||held.ino!==identity.ino)denied("local provenance changed");
      db=new DatabaseSync(this.path,{readOnly:!write});
      const opened=lstatSync(this.path,{bigint:true});if(opened.dev!==held.dev||opened.ino!==held.ino)denied("local provenance changed");
      if(write)db.exec(`PRAGMA busy_timeout=1000;PRAGMA journal_mode=DELETE;
        CREATE TABLE IF NOT EXISTS observations(source TEXT PRIMARY KEY,tenant TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS admissions(path TEXT PRIMARY KEY,identity TEXT NOT NULL,source TEXT NOT NULL,tenant TEXT NOT NULL,createdAt TEXT NOT NULL,revokedAt TEXT,generation TEXT NOT NULL);`);
      if(write)db.exec("BEGIN IMMEDIATE");
      try{
        if(write){
          if(!db.prepare("PRAGMA table_info(admissions)").all().some(row=>row.name==="generation"))db.exec("ALTER TABLE admissions ADD COLUMN generation TEXT");
          db.exec("UPDATE admissions SET generation=lower(hex(randomblob(16))) WHERE generation IS NULL");
        }
        const result=fn(db);if(write)db.exec("COMMIT");return result;
      }
      catch(error){if(write)db.exec("ROLLBACK");throw error;}
    }finally{db?.close();closeSync(fd);}
  }
  observe(source:LocalDirectorySource,tenant:string):void{
    const fingerprint=localDirectorySourceFingerprint(source);
    if(!fingerprint||source.expectedTenantId!==tenant)return;
    this.access(true,db=>{db.prepare("INSERT INTO observations(source,tenant) VALUES(?,?) ON CONFLICT(source) DO UPDATE SET tenant=excluded.tenant").run(fingerprint,tenant);});
  }
  private pinned(db:DatabaseSync,source:LocalDirectorySource):string{
    const fingerprint=localDirectorySourceFingerprint(source);
    if(!fingerprint)denied("a configured authenticated source and pinned tenant are required");
    const row=db.prepare("SELECT tenant FROM observations WHERE source=?").get(fingerprint!) as {tenant:string}|undefined;
    if(row?.tenant!==source.expectedTenantId)denied("source has no matching persisted tenant observation");
    return fingerprint!;
  }
  admit(source:LocalDirectorySource,path:string,workspaceRoot:string,store:PhononStore):Admission{
    assertDirectoryIdentity(path,directoryIdentity(path));
    const info=lstatSync(path);
    if(process.getuid===undefined||info.uid!==process.getuid()||(info.mode&0o022)!==0)denied("selected directory must be owned and not group/world writable");
    if(path===parse(path).root||workspacePathKey(path)===workspacePathKey(canonicalWorkspacePath(homedir()))
      ||overlap(path,join(canonicalWorkspacePath(homedir()),".agent-phonon"))
      ||overlap(path,canonicalWorkspacePath(dirname(this.mainDb)))||overlap(path,join(canonicalWorkspacePath(workspaceRoot),".namespaces")))denied("internal state, home and namespace containers cannot be admitted");
    const tenant=source.expectedTenantId;if(!tenant)denied("tenant pin required");
    store.assertWorkspacePath(path,tenant!);assertProcessPathAvailable(path,tenant!);
    if(store.loadProjects().some(row=>row.employeeId&&overlap(path,row.path)))denied("employee homes cannot be admitted");
    return this.access(true,db=>{
      const fingerprint=this.pinned(db,source);
      const rows=db.prepare("SELECT * FROM admissions").all() as unknown as Admission[];
      for(const row of rows)if(overlap(path,row.path)&&(row.path!==path||row.source!==fingerprint||row.tenant!==tenant))denied("directory has another local consent owner");
      const identity=directoryIdentity(path),prior=rows.find(row=>row.path===path);
      if(prior&&prior.identity!==identity)denied("admitted directory identity changed; no automatic migration");
      const generation=prior&&!prior.revokedAt?prior.generation:randomUUID();
      const record:Admission={path,identity,source:fingerprint,tenant:tenant!,createdAt:prior?.createdAt??new Date().toISOString(),revokedAt:null,generation};
      db.prepare("INSERT INTO admissions(path,identity,source,tenant,createdAt,revokedAt,generation) VALUES(?,?,?,?,?,NULL,?) ON CONFLICT(path) DO UPDATE SET revokedAt=NULL,generation=excluded.generation")
        .run(path,identity,fingerprint,tenant!,record.createdAt,generation);
      return record;
    })!;
  }
  revoke(source:LocalDirectorySource,path:string):void{
    this.access(true,db=>{const fingerprint=this.pinned(db,source);db.prepare("UPDATE admissions SET revokedAt=? WHERE path=? AND source=? AND tenant=?").run(new Date().toISOString(),resolve(path),fingerprint,source.expectedTenantId!);});
  }
  list(source:LocalDirectorySource):Admission[]{
    return this.access(false,db=>{const fingerprint=this.pinned(db,source);return db.prepare("SELECT * FROM admissions WHERE source=? AND tenant=? ORDER BY path").all(fingerprint,source.expectedTenantId!) as unknown as Admission[];})??[];
  }
  /** false means ordinary configured-root policy still applies; overlap never falls back. */
  allows(path:string,source:LocalDirectorySource|undefined,tenant:string):boolean{
    return this.generation(path,source,tenant)!==undefined;
  }
  /** Operation authority, not a session lifetime pin. Re-admission cannot revive old work. */
  generation(path:string,source:LocalDirectorySource|undefined,tenant:string):string|undefined{
    return this.access(false,db=>{
      const rows=db.prepare("SELECT * FROM admissions").all() as unknown as Admission[];
      const matches=rows.filter(row=>overlap(path,row.path));if(!matches.length)return undefined;
      const fingerprint=source&&this.pinned(db,source);
      const row=matches.find(row=>row.source===fingerprint&&row.tenant===tenant&&source?.expectedTenantId===tenant
        &&(path===row.path||path.startsWith(row.path+sep)));
      if(!row||row.revokedAt||!row.generation)denied("directory has no current local admission for this source and tenant");
      assertDirectoryIdentity(row!.path,row!.identity);
      const owner=lstatSync(row!.path);if(owner.uid!==process.getuid?.()||(owner.mode&0o022)!==0)denied("directory owner changed");
      if(canonicalWorkspacePath(path)!==resolve(path))denied("admitted directory path is linked");
      return row!.generation;
    });
  }
}
