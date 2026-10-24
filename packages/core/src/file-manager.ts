import {constants} from "node:fs";
import type {FileHandle} from "node:fs/promises";
import { mkdir, open, readdir, lstat, realpath } from "node:fs/promises";
import { basename, dirname, join, resolve, sep,relative } from "node:path";
import { PhononError } from "./rpc.js";
import { darwinFileRead, darwinFileWrite } from "./darwin-file-broker.js";

export interface FileScopeResolver {
  resolveCwd(projectId: string, worktreeId?: string): string;
  assertPath?: (absolutePath: string, projectRoot: string) => void;
}

type StatEntry = { path: string; type: "file" | "directory" | "symlink" | "other"; sizeBytes: number; modifiedAt: string };

export class FileManager {
  constructor(private resolver: FileScopeResolver) {}

  /**
   * Realpath of the deepest existing ancestor, with any non-existent suffix re-appended.
   * Lets us containment-check write/mkdir targets that don't exist yet, while still
   * resolving symlinks in the existing portion of the path.
   */
  private async realpathBoundary(abs: string): Promise<string> {
    const suffix: string[] = [];
    let cur = abs;
    for (;;) {
      try {
        const real = await realpath(cur);
        return suffix.length ? resolve(real, ...suffix) : real;
      } catch (e) {
        if ((e as NodeJS.ErrnoException)?.code !== "ENOENT") throw e;
        const parent = dirname(cur);
        if (parent === cur) return abs; // hit fs root, nothing left to resolve
        suffix.unshift(basename(cur));
        cur = parent;
      }
    }
  }

  /**
   * Resolve a project-relative path to an absolute path, enforcing that it stays
   * inside the project/worktree root — including via symlinks (defeats `evil -> /etc`).
   *
   * followFinal=true  (read/write/mkdir/list-base): the final component is resolved too,
   *   so a final symlink pointing outside is rejected (readFile/writeFile would follow it).
   * followFinal=false (stat): the final component is NOT resolved, so an in-project symlink
   *   can be lstat'd and reported as "symlink" without being followed. Middle-of-path
   *   symlinks are still resolved and rejected.
   */
  private async resolvePath(projectId: string, worktreeId: string | undefined, rel: string, followFinal = true): Promise<string> {
    if (rel.includes("\0") || rel.startsWith("/") || rel === "") {
      throw new PhononError("errInvalidParams", "file path must be a non-empty relative path");
    }
    // Normalize the root through realpath too, so both sides are comparable on
    // platforms where the workspace itself sits under a symlink (e.g. macOS /tmp).
    const root = await this.realpathBoundary(resolve(this.resolver.resolveCwd(projectId, worktreeId)));
    const abs = resolve(root, rel);
    // 1) lexical containment — fast reject of ../ escapes.
    if (abs !== root && !abs.startsWith(root + sep)) {
      throw new PhononError("errPolicyDenied", `file path escapes project/worktree: ${rel}`);
    }
    // 2) realpath containment — defeats symlink escape (string prefix check alone is insufficient).
    //    For stat we probe the parent dir so an in-project symlink entry can still be reported.
    const probe = !followFinal && abs !== root ? dirname(abs) : abs;
    const real = await this.realpathBoundary(probe);
    if (real !== root && !real.startsWith(root + sep)) {
      throw new PhononError("errPolicyDenied", `file path escapes project/worktree via symlink: ${rel}`);
    }
    this.resolver.assertPath?.(abs,root);
    this.resolver.assertPath?.(real,root);
    return followFinal ? real : abs;
  }

  /** Standard Node APIs with Linux /proc fd anchors. Each component is opened
   * no-follow relative to an already-open directory, not re-resolved by name.
   * Other platforms fail explicitly until an equally strong OS adapter exists.
   */
  private async anchored(projectId:string,worktreeId:string|undefined,rel:string,flags:number,createDirs=false):Promise<FileHandle>{
    if(process.platform!=="linux")throw new PhononError("errPolicyDenied","secure file broker unsupported on this platform");
    const abs=await this.resolvePath(projectId,worktreeId,rel);
    const root=await this.realpathBoundary(resolve(this.resolver.resolveCwd(projectId,worktreeId)));
    const parts=relative(root,abs).split(sep).filter(Boolean);
    if(parts.some(p=>p==='..')||parts.length>256)throw new PhononError("errPolicyDenied","invalid anchored path");
    const handles:FileHandle[]=[];let result:FileHandle|undefined;
    try{
      let current=await open(root,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);handles.push(current);
      if(await realpath(`/proc/self/fd/${current.fd}`)!==root)throw new PhononError("errPolicyDenied","opened root identity changed");
      for(let i=0;i<parts.length;i++){
        const path=`/proc/self/fd/${current.fd}/${parts[i]}`;const final=i===parts.length-1;
        if(createDirs&&(!final||!!(flags&constants.O_DIRECTORY))){try{await mkdir(path);}catch(e){if((e as NodeJS.ErrnoException).code!=="EEXIST")throw e;}}
        current=await open(path,(final?flags:constants.O_RDONLY|constants.O_DIRECTORY)|constants.O_NOFOLLOW);handles.push(current);
      }
      result=current;return current;
    }catch(error){if((error as NodeJS.ErrnoException).code==="ELOOP"||(error as NodeJS.ErrnoException).code==="ENOTDIR")throw new PhononError("errPolicyDenied","symlink or directory identity changed during file operation");throw error;}
    finally{for(const h of handles)if(h!==result)await h.close();}
  }

  async read(params: { projectId: string; worktreeId?: string; path: string; encoding?: "utf8" | "base64"; maxBytes?: number }) {
    if(process.platform==="darwin"){
      const abs=await this.resolvePath(params.projectId,params.worktreeId,params.path),root=await realpath(this.resolver.resolveCwd(params.projectId,params.worktreeId));
      const result=await darwinFileRead(root,relative(root,abs),params.maxBytes),encoding=params.encoding??"utf8";
      return {path:params.path,encoding,data:encoding==="base64"?String(result.data):Buffer.from(String(result.data),"base64").toString("utf8"),sizeBytes:Number(result.sizeBytes),truncated:result.truncated===true};
    }
    const file=await this.anchored(params.projectId,params.worktreeId,params.path,constants.O_RDONLY|constants.O_NONBLOCK);
    let out: Buffer,sizeBytes: number;
    try {
      const stat=await file.stat();if(!stat.isFile())throw new PhononError("errInvalidParams","file.read requires a regular file");sizeBytes=stat.size;
      const limit=Math.min(sizeBytes,params.maxBytes??sizeBytes);
      out=Buffer.alloc(limit);const read=await file.read(out,0,limit,0);out=out.subarray(0,read.bytesRead);
    } finally {await file.close();}
    const max=params.maxBytes;
    const encoding = params.encoding ?? "utf8";
    return {
      path: params.path,
      encoding,
      data: encoding === "base64" ? out.toString("base64") : out.toString("utf8"),
      sizeBytes,
      truncated: !!max && sizeBytes > max,
    };
  }

  async write(params: { projectId: string; worktreeId?: string; path: string; encoding?: "utf8" | "base64"; data: string; overwrite?: boolean; createDirs?: boolean }) {
    const content = params.encoding === "base64" ? Buffer.from(params.data, "base64") : Buffer.from(params.data, "utf8");
    if(process.platform==="darwin"){
      const abs=await this.resolvePath(params.projectId,params.worktreeId,params.path),root=await realpath(this.resolver.resolveCwd(params.projectId,params.worktreeId));
      await darwinFileWrite(root,relative(root,abs),content,params.overwrite??true,params.createDirs??true);
      return {path:params.path,sizeBytes:content.length,written:true as const};
    }
    const flags=constants.O_WRONLY|constants.O_CREAT|constants.O_NONBLOCK|(params.overwrite===false?constants.O_EXCL:0);
    const file=await this.anchored(params.projectId,params.worktreeId,params.path,flags,params.createDirs??true);
    try{
      if(!(await file.stat()).isFile())throw new PhononError("errInvalidParams","file.write requires a regular file");
      if(params.overwrite!==false)await file.truncate(0);
      await file.writeFile(content);
    }finally{await file.close();}
    return { path: params.path, sizeBytes: content.length, written: true as const };
  }

  async mkdir(params: { projectId: string; worktreeId?: string; path: string; recursive?: boolean }) {
    await this.resolvePath(params.projectId,params.worktreeId,params.path);
    const parent=await this.anchored(params.projectId,params.worktreeId,dirname(params.path),constants.O_RDONLY|constants.O_DIRECTORY,params.recursive??true);
    try{try{await mkdir(`/proc/self/fd/${parent.fd}/${basename(params.path)}`);}catch(e){if((e as NodeJS.ErrnoException).code!=="EEXIST"||params.recursive===false)throw e;}}finally{await parent.close();}
    return { path: params.path, created: true as const };
  }

  async stat(params: { projectId: string; worktreeId?: string; path: string }) {
    await this.resolvePath(params.projectId,params.worktreeId,params.path,false);
    const parent=await this.anchored(params.projectId,params.worktreeId,dirname(params.path),constants.O_RDONLY|constants.O_DIRECTORY);
    try{return {stat:await this.lstatOne(`/proc/self/fd/${parent.fd}/${basename(params.path)}`,params.path)};}finally{await parent.close();}
  }

  async list(params: { projectId: string; worktreeId?: string; path?: string; recursive?: boolean; limit?: number }) {
    const baseRel = params.path ?? ".";
    const limit = params.limit ?? 500;
    const base=await this.anchored(params.projectId,params.worktreeId,baseRel,constants.O_RDONLY|constants.O_DIRECTORY);
    const entries:StatEntry[]=[];
    const root=this.resolver.resolveCwd(params.projectId,params.worktreeId);
    const walk=async(handle:FileHandle,relDir:string):Promise<void>=>{
      if(entries.length>=limit)return;
      for(const name of await readdir(`/proc/self/fd/${handle.fd}`)){
        if(entries.length>=limit)break;const childRel=relDir==='.'?name:`${relDir}/${name}`;
        try{this.resolver.assertPath?.(resolve(root,childRel),root);}catch{continue;}
        const path=`/proc/self/fd/${handle.fd}/${name}`;const stat=await this.lstatOne(path,childRel);entries.push(stat);
        if(params.recursive&&stat.type==='directory'){
          let next:FileHandle|undefined;try{next=await open(path,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);await walk(next,childRel);}catch(e){if((e as NodeJS.ErrnoException).code!=='ELOOP'&&(e as NodeJS.ErrnoException).code!=='ENOTDIR')throw e;}finally{await next?.close();}
        }
      }
    };
    try{await walk(base,baseRel);}finally{await base.close();}
    return { path: baseRel, entries, truncated: entries.length >= limit };
  }

  private async lstatOne(abs: string, rel: string): Promise<StatEntry> {
    const s = await lstat(abs);
    const type = s.isSymbolicLink() ? "symlink" : s.isFile() ? "file" : s.isDirectory() ? "directory" : "other";
    return { path: rel, type, sizeBytes: s.size, modifiedAt: s.mtime.toISOString() };
  }
}
