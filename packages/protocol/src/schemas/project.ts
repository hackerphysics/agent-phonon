import { z } from "zod";
import { ProjectId, Timestamp } from "./common.js";

/**
 * 项目管理协议（design D23）。
 *
 * 一个项目 = 一个目录 + Git。所有 session 必须绑定一个项目（projectId）。
 * 项目是磁盘上的客观目录，**设备级共享、不受 tenant 隔离**——不同 tenant 都能看到/用
 * 同一项目，在其下各干各的；冲突风险用户自担。（隔离发生在会话/任务层，不在文件层。）
 */

/** 项目描述。 */
export const ProjectDescriptor = z.object({
  projectId: ProjectId,
  /** 展示名。 */
  name: z.string().min(1),
  /** 项目目录的绝对路径（设备本地）。 */
  path: z.string().min(1),
  /** 是否已 git init。 */
  git: z.boolean().default(true),
  /** 当前分支（若有）。 */
  branch: z.string().optional(),
  /** 可选：远端 URL。 */
  remote: z.string().optional(),
  createdAt: Timestamp,
});
export type ProjectDescriptor = z.infer<typeof ProjectDescriptor>;

// --- project.create ---
export const ProjectCreateParams = z.object({
  /** 可选：幂等键（P0-3）。 */
  clientRequestId: z.string().optional(),
  name: z.string().min(1),
  /**
   * 可选：指定目录路径。缺省由 phonon 在受控工作区下按 name 生成
   * （避免服务端越权指定任意本地路径）。
   */
  path: z.string().optional(),
  /** 是否 git init（默认 true，项目 = 目录 + Git）。 */
  git: z.boolean().default(true),
  /** 可选：初始化时设置的远端。 */
  remote: z.string().optional(),
});
export type ProjectCreateParams = z.infer<typeof ProjectCreateParams>;

export const ProjectCreateResult = z.object({
  project: ProjectDescriptor,
});
export type ProjectCreateResult = z.infer<typeof ProjectCreateResult>;

// --- project.list ---
export const ProjectListParams = z.object({}).default({});
export type ProjectListParams = z.infer<typeof ProjectListParams>;

export const ProjectListResult = z.object({
  projects: z.array(ProjectDescriptor),
});
export type ProjectListResult = z.infer<typeof ProjectListResult>;

// --- project.get ---
export const ProjectGetParams = z.object({ projectId: ProjectId });
export type ProjectGetParams = z.infer<typeof ProjectGetParams>;

export const ProjectGetResult = z.object({ project: ProjectDescriptor });
export type ProjectGetResult = z.infer<typeof ProjectGetResult>;

// --- project.remove ---
export const ProjectRemoveParams = z.object({
  projectId: ProjectId,
  /**
   * 是否删除物理目录。默认 false（仅从 phonon 解绑/注销，保留磁盘文件，防误删）。
   * true 才真正删目录——危险操作，需 policy allowDeleteFiles。
   */
  deleteFiles: z.boolean().default(false),
  /**
   * 有 active session 绑定本项目时的处理（P1-7 / Minimax#5）：
   * - reject（默认）：还有 active session → errProjectHasActiveSessions
   * - cascade      ：级联 terminate 所有 active session 再移除
   */
  whenActiveSessions: z.enum(["reject", "cascade"]).default("reject"),
});
export type ProjectRemoveParams = z.infer<typeof ProjectRemoveParams>;

export const ProjectRemoveResult = z.object({
  projectId: ProjectId,
  removed: z.literal(true),
  filesDeleted: z.boolean(),
  /** cascade 时被级联 terminate 的 session。 */
  terminatedSessions: z.array(z.string()).optional(),
});
export type ProjectRemoveResult = z.infer<typeof ProjectRemoveResult>;

// ===========================================================================
// Git / worktree 子能力（D25）
// worktree = 同一仓库的多个工作目录，天然适配「多 tenant/session 在同一项目各干各的」。
// ===========================================================================

/** worktree 描述。 */
export const WorktreeDescriptor = z.object({
  /** worktree 标识（phonon 生成）。 */
  worktreeId: z.string().min(1),
  projectId: ProjectId,
  /** worktree 的工作目录路径。 */
  path: z.string().min(1),
  /** 该 worktree 检出的分支。 */
  branch: z.string().min(1),
  /** 是否是主工作区（项目本体目录）。 */
  isPrimary: z.boolean().default(false),
  createdAt: Timestamp.optional(),
});
export type WorktreeDescriptor = z.infer<typeof WorktreeDescriptor>;

// --- project.worktree.create：基于某 branch 创建 worktree ---
export const WorktreeCreateParams = z.object({
  /** 可选：幂等键（P0-3）。 */
  clientRequestId: z.string().optional(),
  projectId: ProjectId,
  /** 基于哪个已有 branch 创建（检出点）。 */
  baseBranch: z.string().min(1),
  /**
   * 可选：新建并检出的分支名。缺省则直接检出 baseBranch
   * （注：同一 branch 不能被两个 worktree 同时检出，所以多开并发时通常传 newBranch）。
   */
  newBranch: z.string().optional(),
  /** 可选：指定 worktree 路径；缺省由 phonon 在受控区生成。 */
  path: z.string().optional(),
});
export type WorktreeCreateParams = z.infer<typeof WorktreeCreateParams>;

export const WorktreeCreateResult = z.object({
  worktree: WorktreeDescriptor,
});
export type WorktreeCreateResult = z.infer<typeof WorktreeCreateResult>;

// --- project.worktree.list ---
export const WorktreeListParams = z.object({ projectId: ProjectId });
export type WorktreeListParams = z.infer<typeof WorktreeListParams>;

export const WorktreeListResult = z.object({
  worktrees: z.array(WorktreeDescriptor),
});
export type WorktreeListResult = z.infer<typeof WorktreeListResult>;

// --- project.worktree.remove：清理 worktree ---
export const WorktreeRemoveParams = z.object({
  projectId: ProjectId,
  worktreeId: z.string().min(1),
  /**
   * 是否强制清理（P1-7）。默认 false：
   * 有未提交变更 → errWorktreeHasChanges；还有 active/running session 绑定 → errWorktreeInUse。
   * force=true 才允许硬删，但会连带影响返回 affectedSessions。
   */
  force: z.boolean().default(false),
});
export type WorktreeRemoveParams = z.infer<typeof WorktreeRemoveParams>;

export const WorktreeRemoveResult = z.object({
  worktreeId: z.string(),
  removed: z.literal(true),
  /** 被连带影响（被迫 terminate）的 session（force 硬删时）。 */
  affectedSessions: z.array(z.string()).optional(),
});
export type WorktreeRemoveResult = z.infer<typeof WorktreeRemoveResult>;

// --- project.git.deleteBranch：删除（已合并的）branch ---
export const GitDeleteBranchParams = z.object({
  projectId: ProjectId,
  branch: z.string().min(1),
  /**
   * 是否强制删除（P1-7）。默认 false：
   * 未合并 → errBranchNotMerged；仍被某 worktree 检出 → errBranchInUse。
   * force=true 强删未合并（git branch -D），返回 affectedWorktrees。
   */
  force: z.boolean().default(false),
});
export type GitDeleteBranchParams = z.infer<typeof GitDeleteBranchParams>;

export const GitDeleteBranchResult = z.object({
  branch: z.string(),
  deleted: z.literal(true),
  wasMerged: z.boolean().optional(),
  /** 被连带影响的 worktree（force 硬删时）。 */
  affectedWorktrees: z.array(z.string()).optional(),
});
export type GitDeleteBranchResult = z.infer<typeof GitDeleteBranchResult>;

// ===========================================================================
// project.git.*  v0.7：底层 Git 操作（commit/merge/diff/log/push/status）
// 设计原则：phonon 只暴露通用 git 能力；PR 创建等平台特定逻辑由上层 server 实现。
// ===========================================================================

// --- project.git.commit ---
export const GitCommitParams = z.object({
  projectId: ProjectId,
  /** 在哪个 worktree 提交；不传 = 项目主目录 */
  worktreeId: z.string().optional(),
  message: z.string().min(1),
  /** 显式列出要 add 的路径（相对 cwd）；不传 = git add -A */
  files: z.array(z.string()).optional(),
  /** 允许空 commit（git commit --allow-empty）；默认 false */
  allowEmpty: z.boolean().default(false),
  /** 提交者信息（可选；不传走 git 全局配置） */
  author: z.object({ name: z.string(), email: z.string() }).optional(),
});
export type GitCommitParams = z.infer<typeof GitCommitParams>;

export const GitCommitResult = z.object({
  commitSha: z.string(),
  /** 该 commit 改了几个文件 */
  filesChanged: z.number().int().nonnegative(),
  insertions: z.number().int().nonnegative().optional(),
  deletions: z.number().int().nonnegative().optional(),
});
export type GitCommitResult = z.infer<typeof GitCommitResult>;

// --- project.git.merge ---
export const GitMergeParams = z.object({
  projectId: ProjectId,
  /** 把这个分支合并进 targetBranch；可以是 commit sha */
  sourceBranch: z.string().min(1),
  /** 合并到哪个分支；不传 = 当前 branch */
  targetBranch: z.string().optional(),
  /** 合并策略 */
  strategy: z.enum(["merge", "squash", "rebase", "ff-only"]).default("merge"),
  /** merge commit 消息（squash/merge 时用） */
  message: z.string().optional(),
  /** 冲突时是否 abort（默认 true，避免 worktree 留在冲突状态） */
  abortOnConflict: z.boolean().default(true),
});
export type GitMergeParams = z.infer<typeof GitMergeParams>;

export const GitMergeResult = z.object({
  /** 合并后的最新 commit sha */
  commitSha: z.string().optional(),
  /** 是否产生 merge commit（squash/ff 可能没有） */
  mergeCommitCreated: z.boolean(),
  /** 是否有冲突 */
  hasConflict: z.boolean(),
  /** 冲突文件列表（hasConflict=true 时） */
  conflictFiles: z.array(z.string()).optional(),
  /** 当 abortOnConflict=true 且发生冲突时为 true */
  aborted: z.boolean().optional(),
});
export type GitMergeResult = z.infer<typeof GitMergeResult>;

// --- project.git.diff ---
export const GitDiffParams = z.object({
  projectId: ProjectId,
  worktreeId: z.string().optional(),
  /** diff 起点；不传 = HEAD（与工作区比较） */
  ref1: z.string().optional(),
  /** diff 终点；不传 = 工作区当前状态 */
  ref2: z.string().optional(),
  /** 只 diff 这些路径 */
  paths: z.array(z.string()).optional(),
  /** 上下文行数，默认 3 */
  contextLines: z.number().int().nonnegative().default(3),
  /** stat 而不是 patch */
  statOnly: z.boolean().default(false),
  /** 最大返回字节数，超出截断 */
  maxBytes: z.number().int().positive().default(1048576),
});
export type GitDiffParams = z.infer<typeof GitDiffParams>;

export const GitDiffResult = z.object({
  /** unified diff 文本（statOnly=false 时） */
  patch: z.string().optional(),
  /** stat 摘要（filesChanged/insertions/deletions） */
  filesChanged: z.number().int().nonnegative(),
  insertions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  /** patch 是否被截断 */
  truncated: z.boolean(),
});
export type GitDiffResult = z.infer<typeof GitDiffResult>;

// --- project.git.log ---
export const GitLogParams = z.object({
  projectId: ProjectId,
  worktreeId: z.string().optional(),
  branch: z.string().optional(),
  limit: z.number().int().positive().max(500).default(50),
  /** 起始时间 ISO */
  since: z.string().optional(),
  /** 结束时间 ISO */
  until: z.string().optional(),
  /** 只看这些路径相关的提交 */
  paths: z.array(z.string()).optional(),
});
export type GitLogParams = z.infer<typeof GitLogParams>;

export const GitCommitInfo = z.object({
  sha: z.string(),
  shortSha: z.string(),
  author: z.string(),
  email: z.string(),
  timestamp: z.string(),
  subject: z.string(),
  body: z.string().optional(),
});
export type GitCommitInfo = z.infer<typeof GitCommitInfo>;

export const GitLogResult = z.object({
  commits: z.array(GitCommitInfo),
});
export type GitLogResult = z.infer<typeof GitLogResult>;

// --- project.git.push ---
export const GitPushParams = z.object({
  projectId: ProjectId,
  worktreeId: z.string().optional(),
  branch: z.string().min(1),
  remote: z.string().default("origin"),
  force: z.boolean().default(false),
  /** 如果远端不存在该 branch 是否 set-upstream */
  setUpstream: z.boolean().default(true),
});
export type GitPushParams = z.infer<typeof GitPushParams>;

export const GitPushResult = z.object({
  pushed: z.boolean(),
  remote: z.string(),
  branch: z.string(),
  /** 推送了多少个 commit */
  commitsPushed: z.number().int().nonnegative().optional(),
  /** push 后远端 HEAD sha */
  remoteHead: z.string().optional(),
});
export type GitPushResult = z.infer<typeof GitPushResult>;

// --- project.git.status ---
export const GitStatusParams = z.object({
  projectId: ProjectId,
  worktreeId: z.string().optional(),
});
export type GitStatusParams = z.infer<typeof GitStatusParams>;

export const GitFileStatus = z.object({
  /** 文件路径（相对 cwd） */
  path: z.string(),
  /** 索引区状态（git status --porcelain 第 1 位） */
  index: z.enum(["unmodified", "modified", "added", "deleted", "renamed", "copied", "untracked"]),
  /** 工作区状态（第 2 位） */
  worktree: z.enum(["unmodified", "modified", "added", "deleted", "renamed", "copied", "untracked"]),
});
export type GitFileStatus = z.infer<typeof GitFileStatus>;

export const GitStatusResult = z.object({
  branch: z.string(),
  /** 是否 dirty（有任何未提交改动） */
  isClean: z.boolean(),
  /** ahead/behind 上游 */
  ahead: z.number().int().nonnegative().optional(),
  behind: z.number().int().nonnegative().optional(),
  upstream: z.string().optional(),
  files: z.array(GitFileStatus),
});
export type GitStatusResult = z.infer<typeof GitStatusResult>;
