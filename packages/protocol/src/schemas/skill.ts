import { z } from "zod";
import { AgentId, ProjectId, Timestamp } from "./common.js";

/**
 * Skill 管理协议（design D24）。
 *
 * 给指定 agent 安装/卸载 skill，支持两级 scope：
 *   - global  : agent 全局，对该 agent 所有项目可见
 *   - project : 项目级，仅对某 projectId 可见（需 projectId）
 *
 * 每个 agent 靠 capability `skillManagement` 声明是否支持；不支持 → errCapabilityUnsupported。
 */

export const SkillScope = z.enum(["global", "project"]);
export type SkillScope = z.infer<typeof SkillScope>;

/** skill 来源：内联内容、本地路径、或远端引用。 */
export const SkillSource = z.union([
  z.object({ kind: z.literal("inline"), files: z.record(z.string()) }), // path → content
  z.object({
    kind: z.literal("archive"),
    /** v0 先支持 tar.gz；zip/archiveUrl 后续再加，避免安全边界没收稳。 */
    format: z.literal("tar.gz"),
    contentBase64: z.string().min(1),
    /** 强烈建议传；phonon 会校验内容 hash，防传输/供应链篡改。 */
    sha256: z.string().optional(),
    /** 可选大小提示，便于 policy/日志；实际大小以 decode 后为准。 */
    sizeBytes: z.number().int().positive().optional(),
  }),
  z.object({ kind: z.literal("localPath"), path: z.string().min(1) }),
  z.object({
    kind: z.literal("url"),
    url: z.string().min(1),
    /** 可选：内容校验和（P2-12 / 供应链可信度）。url 装需 policy allowUrlSkillInstall。 */
    sha256: z.string().optional(),
  }),
]);
export type SkillSource = z.infer<typeof SkillSource>;

/** 已安装 skill 的描述。 */
export const SkillDescriptor = z.object({
  /** skill 名/key。 */
  name: z.string().min(1),
  /** 归属哪个 agent。 */
  agent: AgentId,
  scope: SkillScope,
  /** scope=project 时所属项目。 */
  projectId: ProjectId.optional(),
  /** 版本（P2-12，同名冲突可辨）。 */
  version: z.string().optional(),
  /** 内容 hash（P2-12，可复现/防篡改）。 */
  hash: z.string().optional(),
  /** 适配的 agent（某些 skill 只适 OpenClaw 不适 Codex）。 */
  compatibleAgents: z.array(AgentId).optional(),
  /** 来源是否可信（本地/内联=可信，url=需校验）。 */
  sourceTrusted: z.boolean().optional(),
  /** 安装落地路径（设备本地）。 */
  installedPath: z.string().optional(),
  installedAt: Timestamp.optional(),
});
export type SkillDescriptor = z.infer<typeof SkillDescriptor>;

// --- skill.install ---
export const SkillInstallParams = z
  .object({
    /** 目标 agent。 */
    agent: AgentId,
    name: z.string().min(1),
    scope: SkillScope,
    /** scope=project 时必填。 */
    projectId: ProjectId.optional(),
    source: SkillSource,
  })
  .refine((v) => v.scope !== "project" || !!v.projectId, {
    message: "scope=project requires projectId",
    path: ["projectId"],
  });
export type SkillInstallParams = z.infer<typeof SkillInstallParams>;

export const SkillInstallResult = z.object({
  skill: SkillDescriptor,
});
export type SkillInstallResult = z.infer<typeof SkillInstallResult>;

// --- skill.uninstall ---
export const SkillUninstallParams = z
  .object({
    agent: AgentId,
    name: z.string().min(1),
    scope: SkillScope,
    projectId: ProjectId.optional(),
  })
  .refine((v) => v.scope !== "project" || !!v.projectId, {
    message: "scope=project requires projectId",
    path: ["projectId"],
  });
export type SkillUninstallParams = z.infer<typeof SkillUninstallParams>;

export const SkillUninstallResult = z.object({
  agent: AgentId,
  name: z.string(),
  scope: SkillScope,
  uninstalled: z.literal(true),
});
export type SkillUninstallResult = z.infer<typeof SkillUninstallResult>;

// --- skill.list ---
export const SkillListParams = z.object({
  /** 可选：按 agent 过滤。 */
  agent: AgentId.optional(),
  /** 可选：按 scope 过滤。 */
  scope: SkillScope.optional(),
  /** 可选：按项目过滤（看某项目可见的 skill）。 */
  projectId: ProjectId.optional(),
});
export type SkillListParams = z.infer<typeof SkillListParams>;

export const SkillListResult = z.object({
  skills: z.array(SkillDescriptor),
});
export type SkillListResult = z.infer<typeof SkillListResult>;
