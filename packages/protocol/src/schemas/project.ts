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
