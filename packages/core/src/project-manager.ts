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

  // ===========================================================================
  // v0.7: project.git.* — commit / merge / diff / log / push / status
  // 所有方法都基于 worktree cwd（不传 worktreeId 用主目录）。
  // ===========================================================================

  /** 内部：解析 worktree cwd（不传走主目录）。 */
  private cwdFor(projectId: string, worktreeId?: string): string {
    if (!worktreeId) return this.get(projectId).path;
    const wt = this.worktrees.get(worktreeId);
    if (!wt) throw new PhononError("errWorktreeNotFound", `worktree ${worktreeId} not found`);
    return wt.path;
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
    const strategy = params.strategy ?? "merge";
    const abortOnConflict = params.abortOnConflict ?? true;
    // 切到 targetBranch（不传 = 当前 branch）
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
    if (params.branch) args.push(params.branch);
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
    const setUpstream = params.setUpstream ?? true;
    const args = ["push"];
    if (params.force) args.push("--force");
    if (setUpstream) args.push("--set-upstream");
    args.push(remote, params.branch);
    await runGit(cwd, args);
    // 拿远端 head
    let remoteHead: string | undefined;
    try { remoteHead = (await runGit(cwd, ["rev-parse", `${remote}/${params.branch}`])).trim(); } catch { /* ignore */ }
    return { pushed: true, remote, branch: params.branch, remoteHead };
  }

  async gitStatus(params: { projectId: string; worktreeId?: string }): Promise<{ branch: string; isClean: boolean; ahead?: number; behind?: number; upstream?: string; files: Array<{ path: string; index: string; worktree: string }> }> {
    const cwd = this.cwdFor(params.projectId, params.worktreeId);
    const branch = (await runGit(cwd, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
    let upstream: string | undefined; let ahead: number | undefined; let behind: number | undefined;
    try {
      upstream = (await runGit(cwd, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"])).trim();
      const ab = await runGit(cwd, ["rev-list", "--left-right", "--count", `${upstream}...HEAD`]);
      const [b, a] = ab.trim().split(/\s+/).map(Number);
      behind = b; ahead = a;
    } catch { /* 无上游 */ }
    const porcelain = await runGit(cwd, ["status", "--porcelain"]);
    const codeMap: Record<string, string> = {
      " ": "unmodified", "M": "modified", "A": "added", "D": "deleted",
      "R": "renamed", "C": "copied", "?": "untracked",
    };
    const files = porcelain.split("\n").filter(Boolean).map((l) => {
      const c0 = l[0] ?? " ";
      const c1 = l[1] ?? " ";
      const idx = c0 === "?" ? "untracked" : (codeMap[c0] ?? "unmodified");
      const wt = c0 === "?" ? "untracked" : (codeMap[c1] ?? "unmodified");
      const path = l.slice(3);
      return { path, index: idx, worktree: wt };
    });
    return { branch, isClean: files.length === 0, ahead, behind, upstream, files };
  }

  async exec(params: { projectId: string; worktreeId?: string; command: string; args?: string[]; cwd?: string; env?: Record<string, string>; timeoutMs?: number; maxOutputBytes?: number }): Promise<{ exitCode: number; stdout: string; stderr: string; durationMs: number; truncated: boolean }> {
    const root = this.cwdFor(params.projectId, params.worktreeId);
    const cwd = params.cwd ? resolve(root, params.cwd) : root;
    const normRoot = resolve(root);
    if (!(cwd === normRoot || cwd.startsWith(normRoot + "/"))) throw new PhononError("errPolicyDenied", "project.exec cwd escapes project/worktree root");
    if (params.command.includes("\n") || params.command.includes("\r") || params.command.includes("\0")) throw new PhononError("errInvalidParams", "invalid command");
    const started = Date.now();
    const max = params.maxOutputBytes ?? 1024 * 1024;
    const timeoutMs = params.timeoutMs ?? 120_000;
    return new Promise((resolveP, reject) => {
      const child = spawn(params.command, params.args ?? [], { cwd, shell: false, env: { ...process.env, ...(params.env ?? {}) } });
      let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0); let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0); let truncated = false;
      const append = (cur: Buffer<ArrayBufferLike>, d: Buffer): Buffer<ArrayBufferLike> => {
        const next = Buffer.concat([cur, d]);
        if (next.length > max) { truncated = true; return next.subarray(0, max); }
        return next;
      };
      const timer = setTimeout(() => { child.kill("SIGTERM"); }, timeoutMs);
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
