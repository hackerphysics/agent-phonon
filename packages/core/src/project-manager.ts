import { spawn } from "node:child_process";
import { spawnSupervised } from "./process-supervisor.js";
import { mkdir, rm, readdir, stat, realpath } from "node:fs/promises";
import { existsSync, realpathSync } from "node:fs";
import { join, resolve, basename, dirname, sep, relative, isAbsolute } from "node:path";
import { homedir } from "node:os";
import { PhononError } from "./rpc.js";
import { buildChildProcessEnvironment } from "./child-env.js";
import { randomUUID,createHash } from "node:crypto";
import {canonicalWorkspacePath,workspacePathKey,workspacePathsOverlap,assertNamespacePathAvailable,assertProcessPathAvailable,assertNamespaceBrowsePath,assertProcessBrowsePath,rememberProcessPath,type NamespacePath} from "./workspace-paths.js";
import {assertDirectoryIdentity,directoryIdentity} from "./directory-identity.js";
import {observeWorkspaceGit} from "./workspace-git-observation.js";

/**
 * 项目管理（design §8c / D23 + D25）。
 *
 * 一个项目 = 一个目录 + Git。core 直接跑 git 命令实现 worktree/分支操作。
 * 注册标识与目录归属受 namespace 隔离；本机管理员检查不等于远端账号权限。
 * 持久化 v0 用内存表 + 磁盘探测；后续接 sqlite。
 */

export interface ProjectRecord {
  directoryIdentity?:string;
  employeeId?:string;
  projectId: string;
  namespace?: string;
  name: string;
  path: string;
  git: boolean;
  createdAt: string;
}

export interface WorktreeRecord {
  worktreeId: string;
  projectId: string;
  path: string;
  branch: string;
  isPrimary: boolean;
  createdAt: string;
}

/** 受控工作区根：项目缺省建在这里下面（避免 server 越权指定任意路径，P0-1）。 */
function defaultWorkspaceRoot(): string {
  return process.env.PHONON_PROJECTS_ROOT ?? join(homedir(), "phonon-projects");
}

function runGit(cwd: string, args: string[], timeoutMs = 30000): Promise<string> {
  return new Promise((resolveP, reject) => {
    const child = spawn("git", args, { cwd });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new PhononError("errInternal", `git ${args[0]} timeout`));
    }, timeoutMs);
    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (err += d.toString()));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(new PhononError("errInternal", `git spawn failed: ${e.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolveP(out.trim());
      else reject(new PhononError("errInternal", `git ${args.join(" ")} exited ${code}: ${err.slice(0, 300)}`));
    });
  });
}

/**
 * Git argument-injection 防护（安全修复 A1）。
 *
 * runGit 走 spawn(shell:false) 已排除 shell 注入，但用户可控的
 * branch/ref/remote/since/until 作为位置参数拼进 git。git 会把 `-` 开头的
 * 值解析成选项（如 `--output=` `--upload-pack=`）→ 可任意写盘/执行。
 * 这里在拼参前统一拒绝以 `-` 开头，并对 ref/branch 做保守白名单。
 */
/** 拒绝以 `-` 开头（避免被当选项）。用于任何用户可控的位置值。 */
function assertNotOption(value: string, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new PhononError("errInvalidParams", `${label} must be a non-empty string`);
  }
  if (value.startsWith("-")) {
    throw new PhononError("errInvalidParams", `${label} must not start with '-' (option injection): ${value}`);
  }
  if (value.includes("\n") || value.includes("\r") || value.includes("\0")) {
    throw new PhononError("errInvalidParams", `${label} contains control characters`);
  }
  return value;
}

/**
 * 校验 git ref / branch 名。拒 `-` 开头 + 保守字符集（git check-ref-format 的子集）。
 * 允许：字母数字 . _ / - + ~ ^ : @ { } （覆盖 refspec / HEAD@{u} / a..b 等常见形式）。
 * 拒：空格、`..` 开头、控制符、`-` 开头、`--`。
 */
export function assertRefName(value: string, label: string): string {
  assertNotOption(value, label);
  if (value.length > 255) throw new PhononError("errInvalidParams", `${label} too long`);
  if (value.includes("--")) throw new PhononError("errInvalidParams", `${label} must not contain '--'`);
  if (/\s/.test(value)) throw new PhononError("errInvalidParams", `${label} must not contain whitespace`);
  // 保守白名单：ref/refspec/range 常见字符
  if (!/^[A-Za-z0-9._/~^:@{}-]+$/.test(value)) {
    throw new PhononError("errInvalidParams", `${label} contains disallowed characters: ${value}`);
  }
  return value;
}

/** 校验 remote（名字或 URL）。主要拒 `-` 开头 + 控制符；url 本身形式由 git 处理。 */
function assertRemote(value: string, label = "remote"): string {
  return assertNotOption(value, label);
}

export class ProjectManager {
  private projects = new Map<string, ProjectRecord>();
  private worktrees = new Map<string, WorktreeRecord>();
  /** 查询某 project 是否有 active session（由 engine 注入）。 */
  private hasActiveSessions: (projectId: string) => string[];
  /** 查询某 worktree 是否有 active session（bug-bash#2 B8）。 */
  private hasActiveSessionsForWorktree: (worktreeId: string) => string[];
  /** 可选 policy 校验回调（bug-bash P0-1）。 */
  private assertProjectPath?: (path: string) => void;
  private assertDeleteFiles?: () => void;
  private namespace?: string;
  private assertPreparedIdentity?: (id:string,path:string)=>void;

  constructor(
    hasActiveSessions: (projectId: string) => string[] = () => [],
    hooks?: { namespace?: string; assertProjectPath?: (path: string) => void; assertDeleteFiles?: () => void; store?: import("./store.js").PhononStore; workspaceRoot?: string; hasActiveSessionsForWorktree?: (worktreeId: string) => string[] },
  ) {
    this.hasActiveSessions = hasActiveSessions;
    this.namespace = hooks?.namespace;
    if(this.namespace!==undefined&&!this.namespace)throw new PhononError("errInvalidParams","project namespace must not be empty");
    this.hasActiveSessionsForWorktree = hooks?.hasActiveSessionsForWorktree ?? (() => []);
    this.assertProjectPath = hooks?.assertProjectPath;
    this.assertDeleteFiles = hooks?.assertDeleteFiles;
    this.store = hooks?.store;
    this.workspaceRoot = hooks?.workspaceRoot;
    // 重启恢复：从 sqlite 加载已有 project/worktree
    if (this.store) {
      for (const p of this.store.loadProjects()) this.projects.set(p.projectId, p);
      for (const w of this.store.loadWorktrees()) this.worktrees.set(w.worktreeId, w);
    }
  }

  private store?: import("./store.js").PhononStore;
  /** 受控项目根（与 PolicyEnforcer.workspaceRoot 一致，避免路径校验不一致）。 */
  private workspaceRoot?: string;

  /**
   * Refresh metadata shared by connections, then apply the current namespace
   * and physical ownership boundary before returning or using any reference.
   */
  private refreshFromStore(): void {
    if (!this.store) return;
    this.projects = new Map(this.store.loadProjects().map((p) => [p.projectId, p]));
    this.worktrees = new Map(this.store.loadWorktrees().map((w) => [w.worktreeId, w]));
  }
  private inMemoryPaths():NamespacePath[]{
    return [...this.projects.values()].map(row=>({path:row.path,namespace:row.namespace})).concat(
      [...this.worktrees.values()].map(row=>({path:row.path,namespace:this.projects.get(row.projectId)?.namespace})));
  }
  private assertOwnership(path:string):string{
    const canonical=canonicalWorkspacePath(path);
    if(this.namespace!==undefined){
      assertProcessPathAvailable(canonical,this.namespace);
      if(this.store)this.store.assertWorkspacePath(canonical,this.namespace);
      else assertNamespacePathAvailable(canonical,this.namespace,this.inMemoryPaths());
    }
    return canonical;
  }
  private reserveOwnership(path:string):string{
    const canonical=this.assertOwnership(path);
    if(this.namespace!==undefined){this.store?.reserveWorkspacePath(canonical,this.namespace);rememberProcessPath(canonical,this.namespace);}
    return canonical;
  }
  directoryAccess(path:string):{path:string;selectable:boolean}{
    this.refreshFromStore();const canonical=canonicalWorkspacePath(path),key=workspacePathKey(canonical);
    if(this.namespace!==undefined){
      assertProcessBrowsePath(canonical,this.namespace);
      if(this.store)this.store.assertWorkspaceBrowsePath(canonical,this.namespace);else assertNamespaceBrowsePath(canonical,this.namespace,this.inMemoryPaths());
      const storage=workspacePathKey(canonicalWorkspacePath(join(this.workspaceRoot??defaultWorkspaceRoot(),".namespaces")));
      const own=workspacePathKey(canonicalWorkspacePath(this.namespaceRoot(this.workspaceRoot??defaultWorkspaceRoot())));
      if(key.startsWith(storage+sep)&&key!==own&&!key.startsWith(own+sep))throw new PhononError("errPolicyDenied","foreign namespace storage is not browsable");
    }
    const homes=[...this.projects.values()].filter(row=>!!row.employeeId);
    if(homes.some(row=>{const home=workspacePathKey(row.path);return key===home||key.startsWith(home+sep);}))throw new PhononError("errPolicyDenied","private employee directories are not project directories");
    let selectable=true;
    try{
      this.assertProjectPath?.(canonical);this.assertStorageContainer(canonical,this.workspaceRoot??defaultWorkspaceRoot());this.assertOwnership(canonical);
      if(homes.some(row=>workspacePathsOverlap(key,workspacePathKey(row.path))))selectable=false;
    }catch(error){if(error instanceof PhononError&&error.appCode==="errPolicyDenied")selectable=false;else throw error;}
    return {path:canonical,selectable};
  }
  private namespaceRoot(root:string):string{
    return join(root,".namespaces",createHash("sha256").update(this.namespace!).digest("hex"));
  }
  setPreparedIdentityGuard(guard:(id:string,path:string)=>void){this.assertPreparedIdentity=guard;}
  assertPreparedPathAvailable(path:string){
    this.refreshFromStore();this.assertProjectPath?.(path);this.assertOwnership(path);
    if(this.inMemoryPaths().some(record=>workspacePathsOverlap(workspacePathKey(record.path),workspacePathKey(path))))throw new PhononError("errProjectExists","managed workspace cannot nest an existing Project or worktree");
  }
  reservePreparedPath(path:string){this.assertPreparedPathAvailable(path);this.reserveOwnership(path);}
  registerPrepared(record:ProjectRecord):ProjectRecord{
    if(record.namespace!==this.namespace||record.git||record.employeeId)throw new PhononError("errPolicyDenied");
    this.refreshFromStore();this.assertProjectPath?.(record.path);const canonical=this.reserveOwnership(record.path);
    if(canonical!==record.path)throw new PhononError("errProjectProvisionChanged");
    const existing=this.projects.get(record.projectId);
    if(existing){if(existing.namespace!==record.namespace||existing.path!==record.path||existing.name!==record.name||existing.git)throw new PhononError("errProjectProvisionChanged");return this.get(record.projectId);}
    if([...this.projects.values()].some(project=>project.path===record.path))throw new PhononError("errProjectExists");
    this.assertPreparedIdentity?.(record.projectId,record.path);this.store?.upsertProject(record);this.projects.set(record.projectId,record);return record;
  }
  private assertStorageContainer(path:string,root:string):void{
    if(this.namespace===undefined)return;
    const container=workspacePathKey(canonicalWorkspacePath(join(root,".namespaces"))),candidate=workspacePathKey(path),own=workspacePathKey(canonicalWorkspacePath(this.namespaceRoot(root)));
    if(workspacePathsOverlap(candidate,container)&&(candidate===own||!candidate.startsWith(own+sep)))
      throw new PhononError("errPolicyDenied","namespace storage containers are not selectable Projects");
  }

  /** 解析 projectId → 工作目录（session.create / file.* 用）。 */
  resolveCwd(projectId: string, worktreeId?: string): string {
    const project = this.get(projectId);
    if (worktreeId) {
      const wt = this.worktrees.get(worktreeId);
      if (!wt || wt.projectId !== projectId) throw new PhononError("errWorktreeNotFound", `worktree ${worktreeId} not found`);
      this.assertProjectPath?.(wt.path);return this.assertOwnership(wt.path);
    }
    return project.path;
  }

  async create(params: { name: string; path?: string; git?: boolean; remote?: string; employeeId?:string;existingDirectoryIdentity?:string },assertCurrent?:()=>void): Promise<ProjectRecord> {
    if(params.existingDirectoryIdentity){
      if(!params.path||!isAbsolute(params.path)||params.git!==false||params.remote!==undefined||params.employeeId||params.name.length>120||/[\x00-\x1f\x7f]/.test(params.name))throw new PhononError("errInvalidParams","existing directory registration cannot initialize a repository");
      this.assertProjectPath?.(params.path);
      assertCurrent?.();assertDirectoryIdentity(params.path,params.existingDirectoryIdentity);
      const access=this.directoryAccess(params.path);if(!access.selectable)throw new PhononError("errPolicyDenied","directory is not selectable");
      const existing=[...this.projects.values()].find(row=>row.projectId.startsWith("dir-")&&row.path===access.path&&(this.namespace===undefined||row.namespace===this.namespace));
      if(existing){
        const current=this.get(existing.projectId);assertCurrent?.();assertDirectoryIdentity(current.path,params.existingDirectoryIdentity);
        const pinned={...current,directoryIdentity:params.existingDirectoryIdentity};this.store?.upsertProject(pinned);this.projects.set(pinned.projectId,pinned);return pinned;
      }
    }
    const projectId = params.existingDirectoryIdentity?`dir-${randomUUID()}`:`proj-${Date.now()}-${randomUUID()}`;
    const root = this.workspaceRoot ?? defaultWorkspaceRoot();
    let path = params.path ? resolve(params.path) : this.namespace===undefined?join(root,params.name):join(this.namespaceRoot(root),projectId);
    // 路径校验（P0-1）：policy 执行越界拒绝（不再「记风险但放行」）
    if (this.assertProjectPath) this.assertProjectPath(path);
    path=canonicalWorkspacePath(path);this.assertStorageContainer(path,root);this.assertPreparedIdentity?.(projectId,path);path=this.reserveOwnership(path);
    if(params.existingDirectoryIdentity){assertDirectoryIdentity(path,params.existingDirectoryIdentity);}
    else if (existsSync(path) && (await readdir(path)).length > 0) {
      // 目录已存在且非空：当作既有项目接管，不报错
    } else {
      await mkdir(path, { recursive: true,mode:0o700 });
    }
    // realpath 归一化：让对外 path 与文件系统真实路径一致（macOS /var → /private/var
    // 是 symlink；不归一会导致 project.exec 子进程 cwd、skill 安装路径报 /private/var
    // 而 project.path 是 /var，上层做前缀匹配/围栏判断时跨平台错配）。
    path = await realpath(path);
    this.assertProjectPath?.(path);this.assertOwnership(path);
    if(params.existingDirectoryIdentity){assertCurrent?.();assertDirectoryIdentity(path,params.existingDirectoryIdentity);}
    if(params.existingDirectoryIdentity){
      this.refreshFromStore();const existing=[...this.projects.values()].find(row=>row.projectId.startsWith("dir-")&&row.path===path&&row.namespace===this.namespace);
      if(existing){assertDirectoryIdentity(existing.path,params.existingDirectoryIdentity);return this.get(existing.projectId);}
    }
    const git = params.git !== false;
    if (git && !existsSync(join(path, ".git"))) {
      await runGit(path, ["init"]);
      if (params.remote) { assertRemote(params.remote); await runGit(path, ["remote", "add", "origin", "--", params.remote]).catch(() => {}); }
    }
    const rec: ProjectRecord = { projectId, namespace: this.namespace, name: params.name, path, git, createdAt: new Date().toISOString(),...(params.employeeId?{employeeId:params.employeeId}:{}),...(params.existingDirectoryIdentity?{directoryIdentity:params.existingDirectoryIdentity}:{}) };
    this.projects.set(projectId, rec);
    this.store?.upsertProject(rec);
    return rec;
  }

  list(): ProjectRecord[] {
    this.refreshFromStore();
    return [...this.projects.values()].filter(p => this.namespace===undefined||p.namespace===this.namespace)
      .filter(p=>{try{this.assertProjectPath?.(p.path);if(p.directoryIdentity)assertDirectoryIdentity(p.path,p.directoryIdentity);return true;}catch(error){if(error instanceof PhononError&&error.appCode==="errPolicyDenied"||p.directoryIdentity)return false;throw error;}})
      .map(p=>{this.assertOwnership(p.path);this.assertPreparedIdentity?.(p.projectId,p.path);return p;});
  }

  get(projectId: string,options?: {readonly?:boolean}): ProjectRecord {
    this.refreshFromStore();
    const rec = this.projects.get(projectId);
    if (!rec || (this.namespace!==undefined&&rec.namespace!==this.namespace)) throw new PhononError("errProjectNotFound", `project ${projectId} not found`);
    const canonical=realpathSync(rec.path);
    if (rec.namespace && canonical!==rec.path) throw new PhononError("errPolicyDenied","registered project root identity changed");
    this.assertProjectPath?.(canonical);
    this.assertOwnership(canonical);
    this.assertPreparedIdentity?.(rec.projectId,canonical);
    if(rec.directoryIdentity)assertDirectoryIdentity(rec.path,rec.directoryIdentity);
    return rec;
  }

  async remove(projectId: string, opts: { deleteFiles?: boolean; whenActiveSessions?: "reject" | "cascade" }): Promise<{ filesDeleted: boolean; terminatedSessions?: string[] }> {
    const rec = this.get(projectId);
    const active = this.hasActiveSessions(projectId);
    let terminatedSessions: string[] | undefined;
    if (active.length > 0) {
      if ((opts.whenActiveSessions ?? "reject") === "reject")
        throw new PhononError("errProjectHasActiveSessions", `project has ${active.length} active sessions`);
      terminatedSessions = active; // cascade：调用方负责 terminate（engine 注入回调）
    }
    let filesDeleted = false;
    if(opts.deleteFiles)this.assertDeleteFiles?.();
    this.reserveOwnership(rec.path);
    for(const wt of this.worktrees.values())if(wt.projectId===projectId)this.reserveOwnership(wt.path);
    if (opts.deleteFiles) {
      if (this.assertDeleteFiles) this.assertDeleteFiles(); // policy：allowDeleteFiles
      await rm(rec.path, { recursive: true, force: true });
      filesDeleted = true;
    }
    this.projects.delete(projectId);
    this.store?.deleteProject(projectId);
    // 清理该 project 的 worktree 记录
    for (const [id, wt] of this.worktrees) if (wt.projectId === projectId) this.worktrees.delete(id);
    return { filesDeleted, terminatedSessions };
  }

  // ---- worktree (D25) ----
  async worktreeCreate(params: { projectId: string; baseBranch: string; newBranch?: string; path?: string }): Promise<WorktreeRecord> {
    const proj = this.get(params.projectId);
    // A1: 校验用户可控的 branch 名，拒选项注入
    assertRefName(params.baseBranch, "baseBranch");
    if (params.newBranch) assertRefName(params.newBranch, "newBranch");
    const worktreeId = `wt-${Date.now()}-${randomUUID()}`;
    let wtPath = params.path ? resolve(params.path) : this.namespace===undefined?join(proj.path,"..",`${proj.name}-${params.newBranch??params.baseBranch}`.replace(/\//g,"-")):join(dirname(proj.path),worktreeId);
    // 自定义 worktree path 同样走 policy 路径校验（bug-bash#2 B8）
    this.assertProjectPath?.(wtPath);wtPath=canonicalWorkspacePath(wtPath);
    this.assertStorageContainer(wtPath,this.workspaceRoot??defaultWorkspaceRoot());wtPath=this.reserveOwnership(wtPath);
    const branch = params.newBranch ?? params.baseBranch;
    const args = ["worktree", "add"];
    if (params.newBranch) args.push("-b", params.newBranch);
    args.push(wtPath, params.baseBranch);
    await runGit(proj.path, args);
    wtPath=await realpath(wtPath);this.assertProjectPath?.(wtPath);this.assertOwnership(wtPath);
    const rec: WorktreeRecord = { worktreeId, projectId: params.projectId, path: wtPath, branch, isPrimary: false, createdAt: new Date().toISOString() };
    this.worktrees.set(worktreeId, rec);
    this.store?.upsertWorktree(rec);
    return rec;
  }

  worktreeList(projectId: string): WorktreeRecord[] {
    this.get(projectId);
    return [...this.worktrees.values()].filter((w) => w.projectId === projectId).map(w=>{this.assertProjectPath?.(w.path);this.assertOwnership(w.path);return w;});
  }

  async worktreeRemove(params: { projectId: string; worktreeId: string; force?: boolean }): Promise<{ affectedSessions?: string[] }> {
    const proj = this.get(params.projectId);
    const wt = this.worktrees.get(params.worktreeId);
    if (!wt||wt.projectId!==params.projectId) throw new PhononError("errWorktreeNotFound", `worktree ${params.worktreeId} not found`);
    // 精确到该 worktree 的 active session（不是整个 project，bug-bash#2 B8）
    const active = this.hasActiveSessionsForWorktree(params.worktreeId).filter(Boolean);
    if (active.length > 0 && !params.force)
      throw new PhononError("errWorktreeInUse", "worktree has active sessions");
    this.assertProjectPath?.(wt.path);this.reserveOwnership(wt.path);
    const args = ["worktree", "remove", wt.path];
    if (params.force) args.push("--force");
    await runGit(proj.path, args).catch((e) => {
      if (String(e?.message).includes("contains modified") || String(e?.message).includes("not empty"))
        throw new PhononError("errWorktreeHasChanges", "worktree has uncommitted changes (use force)");
      throw e;
    });
    this.worktrees.delete(params.worktreeId);
    this.store?.deleteWorktree(params.worktreeId);
    return { affectedSessions: params.force ? active : undefined };
  }

  async deleteBranch(params: { projectId: string; branch: string; force?: boolean }): Promise<{ wasMerged: boolean; affectedWorktrees?: string[] }> {
    const proj = this.get(params.projectId);
    assertRefName(params.branch, "branch"); // A1
    const inUse = this.worktreeList(params.projectId).filter((w) => w.branch === params.branch);
    if (inUse.length > 0 && !params.force)
      throw new PhononError("errBranchInUse", "branch is checked out by a worktree");
    const flag = params.force ? "-D" : "-d";
    try {
      await runGit(proj.path, ["branch", flag, "--", params.branch]);
    } catch (e) {
      if (String((e as Error)?.message).includes("not fully merged"))
        throw new PhononError("errBranchNotMerged", "branch not merged (use force)");
      throw e;
    }
    return { wasMerged: !params.force, affectedWorktrees: inUse.length ? inUse.map((w) => w.worktreeId) : undefined };
  }

  // ===========================================================================
  // v0.7: project.git.* — commit / merge / diff / log / push / status
  // 所有方法都基于 worktree cwd（不传 worktreeId 用主目录）。
  // ===========================================================================

  /** 内部：解析 worktree cwd（不传走主目录）。 */
  private cwdFor(projectId: string, worktreeId?: string): string {
    return this.resolveCwd(projectId,worktreeId);
  }

  async gitCommit(params: { projectId: string; worktreeId?: string; message: string; files?: string[]; allowEmpty?: boolean; author?: { name: string; email: string } }): Promise<{ commitSha: string; filesChanged: number; insertions?: number; deletions?: number }> {
    const cwd = this.cwdFor(params.projectId, params.worktreeId);
    // 1. add
    if (params.files && params.files.length > 0) {
      await runGit(cwd, ["add", "--", ...params.files]);
    } else {
      await runGit(cwd, ["add", "-A"]);
    }
    // 2. commit
    const args = ["commit", "-m", params.message];
    if (params.allowEmpty) args.push("--allow-empty");
    if (params.author) args.push("--author", `${params.author.name} <${params.author.email}>`);
    try {
      await runGit(cwd, args);
    } catch (e) {
      const msg = String((e as Error)?.message);
      if (/nothing to commit|nothing added/.test(msg) && !params.allowEmpty) {
        throw new PhononError("errInvalidParams", "nothing to commit (set allowEmpty=true to force)");
      }
      throw e;
    }
    // 3. 拿新 commit sha + 改动统计
    const sha = (await runGit(cwd, ["rev-parse", "HEAD"]))!;
    const stat = await runGit(cwd, ["show", "--stat", "--format=", sha]);
    const m = stat.match(/(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(\-\))?/);
    return {
      commitSha: sha,
      filesChanged: m ? Number(m[1]) : 0,
      insertions: m && m[2] ? Number(m[2]) : undefined,
      deletions: m && m[3] ? Number(m[3]) : undefined,
    };
  }

  async gitMerge(params: { projectId: string; sourceBranch: string; targetBranch?: string; strategy?: "merge" | "squash" | "rebase" | "ff-only"; message?: string; abortOnConflict?: boolean }): Promise<{ commitSha?: string; mergeCommitCreated: boolean; hasConflict: boolean; conflictFiles?: string[]; aborted?: boolean }> {
    const proj = this.get(params.projectId);
    // A1: 校验用户可控的 branch
    assertRefName(params.sourceBranch, "sourceBranch");
    if (params.targetBranch) assertRefName(params.targetBranch, "targetBranch");
    const strategy = params.strategy ?? "merge";
    const abortOnConflict = params.abortOnConflict ?? true;
    // 切到 targetBranch（不传 = 当前 branch）。assertRefName 已防选项注入；
    // checkout 切分支不能加 `--`（那会变成 checkout pathspec 语义）。
    if (params.targetBranch) {
      await runGit(proj.path, ["checkout", params.targetBranch]);
    }
    // 跑 merge
    let mergeCommitCreated = false;
    // 跑 merge；exit 非 0 时不一定是错误（可能是冲突），统一用 status 检查冲突
    let mergeFailed = false;
    let mergeErr: Error | undefined;
    try {
      if (strategy === "rebase") {
        await runGit(proj.path, ["rebase", params.sourceBranch]);
      } else if (strategy === "squash") {
        await runGit(proj.path, ["merge", "--squash", params.sourceBranch]);
        const msg = params.message ?? `squash merge ${params.sourceBranch}`;
        await runGit(proj.path, ["commit", "-m", msg]);
        mergeCommitCreated = true;
      } else if (strategy === "ff-only") {
        await runGit(proj.path, ["merge", "--ff-only", params.sourceBranch]);
      } else {
        const args = ["merge", "--no-ff", params.sourceBranch];
        if (params.message) { args.push("-m", params.message); }
        await runGit(proj.path, args);
        mergeCommitCreated = true;
      }
    } catch (e) {
      mergeFailed = true;
      mergeErr = e as Error;
    }
    if (mergeFailed) {
      // 检查是否真是冲突（不是其他错误）
      let conflictFiles: string[] = [];
      try {
        const out = await runGit(proj.path, ["diff", "--name-only", "--diff-filter=U"]);
        conflictFiles = out.split("\n").map((l) => l.trim()).filter(Boolean);
      } catch { /* ignore */ }
      if (conflictFiles.length > 0) {
        if (abortOnConflict) {
          try {
            if (strategy === "rebase") await runGit(proj.path, ["rebase", "--abort"]);
            else await runGit(proj.path, ["merge", "--abort"]);
          } catch { /* ignore */ }
          return { mergeCommitCreated: false, hasConflict: true, conflictFiles, aborted: true };
        }
        return { mergeCommitCreated: false, hasConflict: true, conflictFiles };
      }
      // 不是冲突，是其他错误
      throw mergeErr ?? new PhononError("errInternal", "git merge failed");
    }
    const sha = (await runGit(proj.path, ["rev-parse", "HEAD"])).trim();
    return { commitSha: sha, mergeCommitCreated, hasConflict: false };
  }

  async gitDiff(params: { projectId: string; worktreeId?: string; ref1?: string; ref2?: string; paths?: string[]; contextLines?: number; statOnly?: boolean; maxBytes?: number }): Promise<{ patch?: string; filesChanged: number; insertions: number; deletions: number; truncated: boolean }> {
    const cwd = this.cwdFor(params.projectId, params.worktreeId);
    // A1: 校验用户可控的 ref
    if (params.ref1) assertRefName(params.ref1, "ref1");
    if (params.ref2) assertRefName(params.ref2, "ref2");
    const context = params.contextLines ?? 3;
    const maxBytes = params.maxBytes ?? 1048576;
    const baseArgs: string[] = ["diff", `-U${context}`];
    if (params.ref1 && params.ref2) baseArgs.push(`${params.ref1}..${params.ref2}`);
    else if (params.ref1) baseArgs.push(params.ref1);
    if (params.paths && params.paths.length > 0) { baseArgs.push("--"); baseArgs.push(...params.paths); }
    // shortstat 拿 filesChanged/insertions/deletions
    const statOut = await runGit(cwd, [...baseArgs.slice(0, params.paths && params.paths.length > 0 ? -params.paths.length - 1 : baseArgs.length), "--shortstat"]).catch(() => "");
    const m = statOut.match(/(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(\-\))?/);
    const filesChanged = m ? Number(m[1]) : 0;
    const insertions = m && m[2] ? Number(m[2]) : 0;
    const deletions = m && m[3] ? Number(m[3]) : 0;
    if (params.statOnly) return { filesChanged, insertions, deletions, truncated: false };
    const patch = await runGit(cwd, baseArgs).catch(() => "");
    const buf = Buffer.from(patch, "utf8");
    if (buf.length > maxBytes) {
      return { patch: buf.subarray(0, maxBytes).toString("utf8") + "\n... (truncated)", filesChanged, insertions, deletions, truncated: true };
    }
    return { patch, filesChanged, insertions, deletions, truncated: false };
  }

  async gitLog(params: { projectId: string; worktreeId?: string; branch?: string; limit?: number; since?: string; until?: string; paths?: string[] }): Promise<{ commits: Array<{ sha: string; shortSha: string; author: string; email: string; timestamp: string; subject: string; body?: string }> }> {
    const cwd = this.cwdFor(params.projectId, params.worktreeId);
    const limit = params.limit ?? 50;
    // 用 NUL 分隔字段，换行分隔提交
    const FMT = "%H%x1f%h%x1f%an%x1f%ae%x1f%aI%x1f%s%x1f%b%x1e";
    const args = ["log", `--format=${FMT}`, `-n`, String(limit)];
    if (params.since) args.push(`--since=${params.since}`);
    if (params.until) args.push(`--until=${params.until}`);
    // A1: branch 是用户可控位置参数（在 -- 之前），必须防选项注入
    if (params.branch) { assertRefName(params.branch, "branch"); args.push(params.branch); }
    if (params.paths && params.paths.length > 0) { args.push("--"); args.push(...params.paths); }
    const out = await runGit(cwd, args);
    const commits = out.split("\x1e").map((rec) => rec.trim()).filter(Boolean).map((rec) => {
      const parts = rec.split("\x1f");
      return {
        sha: parts[0] ?? "",
        shortSha: parts[1] ?? "",
        author: parts[2] ?? "",
        email: parts[3] ?? "",
        timestamp: parts[4] ?? "",
        subject: parts[5] ?? "",
        body: parts[6] || undefined,
      };
    });
    return { commits };
  }

  async gitPush(params: { projectId: string; worktreeId?: string; branch: string; remote?: string; force?: boolean; setUpstream?: boolean }): Promise<{ pushed: boolean; remote: string; branch: string; commitsPushed?: number; remoteHead?: string }> {
    const cwd = this.cwdFor(params.projectId, params.worktreeId);
    const remote = params.remote ?? "origin";
    // A1: remote 与 branch 都是用户可控位置参数，防选项注入（--receive-pack= 等）
    assertRemote(remote, "remote");
    assertRefName(params.branch, "branch");
    const setUpstream = params.setUpstream ?? true;
    const args = ["push"];
    if (params.force) args.push("--force");
    if (setUpstream) args.push("--set-upstream");
    args.push("--", remote, params.branch);
    await runGit(cwd, args);
    // 拿远端 head
    let remoteHead: string | undefined;
    try { remoteHead = (await runGit(cwd, ["rev-parse", `${remote}/${params.branch}`])).trim(); } catch { /* ignore */ }
    return { pushed: true, remote, branch: params.branch, remoteHead };
  }

  async gitStatus(params: { projectId: string; worktreeId?: string }) {
    const cwd = this.cwdFor(params.projectId, params.worktreeId);
    const identity=directoryIdentity(cwd);
    return observeWorkspaceGit(cwd,params,()=>{
      if(this.cwdFor(params.projectId,params.worktreeId)!==cwd)throw new PhononError('errPolicyDenied','Workspace identity changed');
      assertDirectoryIdentity(cwd,identity);
    });
  }

  async exec(params: { projectId: string; worktreeId?: string; command: string; args?: string[]; cwd?: string; env?: Record<string, string>; timeoutMs?: number; maxOutputBytes?: number }): Promise<{ exitCode: number; stdout: string; stderr: string; durationMs: number; truncated: boolean }> {
    const root = this.cwdFor(params.projectId, params.worktreeId);
    let rootReal: string;
    let cwd: string;
    try {
      rootReal = await realpath(root);
      cwd = await realpath(params.cwd ? resolve(rootReal, params.cwd) : rootReal);
    } catch {
      throw new PhononError("errInvalidParams", "project.exec root/cwd must exist");
    }
    const rel = relative(rootReal, cwd);
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      throw new PhononError("errPolicyDenied", "project.exec cwd escapes project/worktree root");
    }
    if (params.command.includes("\n") || params.command.includes("\r") || params.command.includes("\0")) throw new PhononError("errInvalidParams", "invalid command");
    const started = Date.now();
    const max = params.maxOutputBytes ?? 1024 * 1024;
    const timeoutMs = params.timeoutMs ?? 120_000;
    return new Promise((resolveP, reject) => {
      const supervisor = spawnSupervised(params.command, params.args ?? [], { cwd, shell: false, env: buildChildProcessEnvironment(params.env) });
      const child = supervisor.child;
      let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0); let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0); let truncated = false;
      const append = (cur: Buffer<ArrayBufferLike>, d: Buffer): Buffer<ArrayBufferLike> => {
        const next = Buffer.concat([cur, d]);
        if (next.length > max) { truncated = true; return next.subarray(0, max); }
        return next;
      };
      const timer = setTimeout(() => { void supervisor.terminate(); }, timeoutMs);
      child.stdout.on("data", (d: Buffer) => { stdout = append(stdout, d); });
      child.stderr.on("data", (d: Buffer) => { stderr = append(stderr, d); });
      child.on("error", (e) => { clearTimeout(timer); reject(new PhononError("errInternal", `exec spawn failed: ${e.message}`)); });
      child.on("close", (code, signal) => {
        clearTimeout(timer);
        const exitCode = code ?? (signal ? 128 : 1);
        resolveP({ exitCode, stdout: stdout.toString("utf8"), stderr: stderr.toString("utf8"), durationMs: Date.now() - started, truncated });
      });
    });
  }
}

export { runGit };
