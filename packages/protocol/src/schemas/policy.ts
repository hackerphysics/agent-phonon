import { z } from "zod";
import { AgentId, ProjectId } from "./common.js";

/**
 * 本地安全策略（design D27 / review P0-1）。
 *
 * phonon 不做终端用户鉴权（那是服务端的事），但**必须有设备主人配置的本地授权边界**——
 * 否则任意接入的 server 都能让本地 agent 读任意文件、装任意 skill、删 worktree。
 *
 * 这是「设备 policy」，不是「用户鉴权」。每个 tenant 一份，phonon 在执行前据此拦截。
 * 这些是本地配置，不进 device→server 的线协议；放协议包是为了类型共享与校验。
 */

/** 单个 tenant 的本地授权边界。 */
export const TenantPolicy = z.object({
  /** 允许操作的项目根目录白名单（绝对路径）。document/project 路径必须落在其下。 */
  allowedProjectRoots: z.array(z.string()).default([]),
  /** 允许使用的 agent 白名单；空 = 不限制。 */
  allowedAgents: z.array(AgentId).default([]),
  /** 允许的方法白名单；空 = 全允许。用它可表达「只读租户」（只放查询类方法）。 */
  allowedMethods: z.array(z.string()).default([]),
  /** 是否允许全局 skill 安装（影响该 agent 所有项目，危险）。默认 false。 */
  allowGlobalSkillInstall: z.boolean().default(false),
  /** 是否允许从 url 安装 skill（供应链入口，危险）。默认 false。 */
  allowUrlSkillInstall: z.boolean().default(false),
  /** 是否允许物理删盘（project.remove deleteFiles / worktree force 等）。默认 false。 */
  allowDeleteFiles: z.boolean().default(false),
  /** document.send 是否允许发送项目/worktree 目录之外的文件。默认 false（project-scoped）。 */
  allowExternalDocuments: z.boolean().default(false),
  /** env.list reveal=true 是否允许返回环境变量明文。默认 false（只能脱敏查看）。 */
  allowEnvReveal: z.boolean().default(false),
  /** 单文件上传上限（字节）；超出走 prepare_upload 或拒绝。 */
  maxUploadBytes: z.number().int().positive().optional(),
  /** 敏感路径黑名单（即使在 allowedProjectRoots 内也拒绝，如 .ssh/.aws/.env）。 */
  denyPathPatterns: z.array(z.string()).default([
    "**/.ssh/**",
    "**/.aws/**",
    "**/.env",
    "**/.git/config",
    "**/id_rsa*",
    "**/*.pem",
    "**/openclaw.json",
  ]),
});
export type TenantPolicy = z.infer<typeof TenantPolicy>;

/** policy 默认值（最严格：白名单空、写操作全关）。 */
export const DEFAULT_TENANT_POLICY: TenantPolicy = TenantPolicy.parse({});

/**
 * 校验一个绝对路径是否落在某项目根白名单内（不含 deny 匹配）。
 * 真实 glob/deny 匹配由 core 实现；这里给协议层一个轻量前缀检查骨架。
 */
export function isPathUnderRoots(absPath: string, roots: readonly string[]): boolean {
  if (roots.length === 0) return false;
  const norm = absPath.replace(/\\/g, "/");
  return roots.some((r) => {
    const root = r.replace(/\\/g, "/").replace(/\/+$/, "");
    return norm === root || norm.startsWith(root + "/");
  });
}

/** policy 拒绝时的归一化结果（core 用，便于回 errPolicyDenied）。 */
export const PolicyDecision = z.object({
  allowed: z.boolean(),
  /** 拒绝原因（如 "path_outside_project" / "url_skill_disabled" / "delete_not_allowed"）。 */
  reason: z.string().optional(),
  /** 关联 projectId（若适用）。 */
  projectId: ProjectId.optional(),
});
export type PolicyDecision = z.infer<typeof PolicyDecision>;
