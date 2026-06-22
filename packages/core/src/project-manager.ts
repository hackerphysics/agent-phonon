import { spawn } from "node:child_process";
import { mkdir, rm, readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve, basename } from "node:path";
import { homedir } from "node:os";
import { PhononError } from "./rpc.js";

/**
 * 项目管理（design §8c / D23 + D25）。
 *
 * 一个项目 = 一个目录 + Git。core 直接跑 git 命令实现 worktree/分支操作。
 * 项目设备级共享、不受 tenant 隔离（D23 修正）。
 * 持久化 v0 用内存表 + 磁盘探测；后续接 sqlite。
 */

export interface ProjectRecord {
  projectId: string;
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

export class ProjectManager {
  private projects = new Map<string, ProjectRecord>();
  private worktrees = new Map<string, WorktreeRecord>();
  private idSeq = 1;
  /** 查询某 project 是否有 active session（由 engine 注入）。 */
  private hasActiveSessions: (projectId: string) => string[];
  /** 查询某 worktree 是否有 active session（bug-bash#2 B8）。 */
  private hasActiveSessionsForWorktree: (worktreeId: string) => string[];
  /** 可选 policy 校验回调（bug-bash P0-1）。 */
  private assertProjectPath?: (path: string) => void;
  private assertDeleteFiles?: () => void;

  constructor(
    hasActiveSessions: (projectId: string) => string[] = () => [],
    hooks?: { assertProjectPath?: (path: string) => void; assertDeleteFiles?: () => void; store?: import("./store.js").PhononStore; workspaceRoot?: string; hasActiveSessionsForWorktree?: (worktreeId: string) => string[] },
  ) {
    this.hasActiveSessions = hasActiveSessions;
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

  /** 解析 projectId → 工作目录（session.create / file.* 用）。 */
  resolveCwd(projectId: string, worktreeId?: string): string {
    if (worktreeId) {
      const wt = this.worktrees.get(worktreeId);
      if (!wt || wt.projectId !== projectId) throw new PhononError("errWorktreeNotFound", `worktree ${worktreeId} not found`);
      return wt.path;
    }
    const rec = this.projects.get(projectId);
    return rec?.path ?? projectId; // 兼容：未注册时把 projectId 当路径
  }

  async create(params: { name: string; path?: string; git?: boolean; remote?: string }): Promise<ProjectRecord> {
    const projectId = `proj-${Date.now()}-${this.idSeq++}`;
    const root = this.workspaceRoot ?? defaultWorkspaceRoot();
    const path = params.path ? resolve(params.path) : join(root, params.name);
    // 路径校验（P0-1）：policy 执行越界拒绝（不再「记风险但放行」）
    if (this.assertProjectPath) this.assertProjectPath(path);
    if (existsSync(path) && (await readdir(path)).length > 0) {
      // 目录已存在且非空：当作既有项目接管，不报错
    } else {
      await mkdir(path, { recursive: true });
    }
    const git = params.git !== false;
    if (git && !existsSync(join(path, ".git"))) {
      await runGit(path, ["init"]);
      if (params.remote) await runGit(path, ["remote", "add", "origin", params.remote]).catch(() => {});
    }
    const rec: ProjectRecord = { projectId, name: params.name, path, git, createdAt: new Date().toISOString() };
    this.projects.set(projectId, rec);
    this.store?.upsertProject(rec);
    return rec;
  }

  list(): ProjectRecord[] {
    return [...this.projects.values()];
  }

  get(projectId: string): ProjectRecord {
    const rec = this.projects.get(projectId);
    if (!rec) throw new PhononError("errProjectNotFound", `project ${projectId} not found`);
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
    const worktreeId = `wt-${Date.now()}-${this.idSeq++}`;
    const wtPath = params.path ? resolve(params.path) : join(proj.path, "..", `${proj.name}-${params.newBranch ?? params.baseBranch}`.replace(/\//g, "-"));
    // 自定义 worktree path 同样走 policy 路径校验（bug-bash#2 B8）
    if (params.path && this.assertProjectPath) this.assertProjectPath(wtPath);
    const branch = params.newBranch ?? params.baseBranch;
    const args = ["worktree", "add"];
    if (params.newBranch) args.push("-b", params.newBranch);
    args.push(wtPath, params.baseBranch);
    await runGit(proj.path, args);
    const rec: WorktreeRecord = { worktreeId, projectId: params.projectId, path: wtPath, branch, isPrimary: false, createdAt: new Date().toISOString() };
    this.worktrees.set(worktreeId, rec);
    this.store?.upsertWorktree(rec);
    return rec;
  }

  worktreeList(projectId: string): WorktreeRecord[] {
    return [...this.worktrees.values()].filter((w) => w.projectId === projectId);
  }

  async worktreeRemove(params: { projectId: string; worktreeId: string; force?: boolean }): Promise<{ affectedSessions?: string[] }> {
    const proj = this.get(params.projectId);
    const wt = this.worktrees.get(params.worktreeId);
    if (!wt) throw new PhononError("errWorktreeNotFound", `worktree ${params.worktreeId} not found`);
    // 精确到该 worktree 的 active session（不是整个 project，bug-bash#2 B8）
    const active = this.hasActiveSessionsForWorktree(params.worktreeId).filter(Boolean);
    if (active.length > 0 && !params.force)
      throw new PhononError("errWorktreeInUse", "worktree has active sessions");
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
    const inUse = this.worktreeList(params.projectId).filter((w) => w.branch === params.branch);
    if (inUse.length > 0 && !params.force)
      throw new PhononError("errBranchInUse", "branch is checked out by a worktree");
    const flag = params.force ? "-D" : "-d";
    try {
      await runGit(proj.path, ["branch", flag, params.branch]);
    } catch (e) {
      if (String((e as Error)?.message).includes("not fully merged"))
        throw new PhononError("errBranchNotMerged", "branch not merged (use force)");
      throw e;
    }
    return { wasMerged: !params.force, affectedWorktrees: inUse.length ? inUse.map((w) => w.worktreeId) : undefined };
  }
}

export { runGit };
