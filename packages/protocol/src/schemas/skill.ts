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

const skillName = z.string().min(1).max(128).regex(/^[A-Za-z0-9._-]+$/).refine(value => value !== "." && value !== "..");
export const SkillSelection = z.union([
  skillName,
  z.object({name:skillName,version:z.string().min(1).max(128).refine(value=>!/[\p{Cc}]/u.test(value)).optional(),scope:SkillScope.optional(),force:z.boolean().optional(),
    revision:z.string().regex(/^[a-f0-9]{64}$/).optional(),installationId:z.string().uuid().optional()}).strict(),
]);
export type SkillSelection = z.infer<typeof SkillSelection>;

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
  revision:z.string().regex(/^[a-f0-9]{64}$/).optional(),
  publication:z.object({kind:z.literal("immutable"),versionId:z.string().uuid(),treeHash:z.string().regex(/^[a-f0-9]{64}$/)}).strict().optional(),
});
export type SkillDescriptor = z.infer<typeof SkillDescriptor>;

// --- skill.install ---
export const SkillInstallParams = z
  .object({
    /** Exact parsed request identity; changed payloads cannot reuse a confirmed receipt. */
    clientRequestId: z.string().min(1).max(512).optional(),
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

export const SkillPublishParams=z.object({clientRequestId:z.string().min(1).max(512),agent:AgentId,name:skillName,scope:z.literal("project").default("project"),projectId:ProjectId,
  baseRevision:z.string().regex(/^[a-f0-9]{64}$/).nullable(),expectedReceiverID:z.string().uuid().optional(),source:z.union([SkillSource.options[0],SkillSource.options[1]])}).strict();
export type SkillPublishParams=z.infer<typeof SkillPublishParams>;
export const SkillUnpublishParams=z.object({clientRequestId:z.string().min(1).max(512),agent:AgentId,name:skillName,scope:z.literal("project").default("project"),projectId:ProjectId,
  baseRevision:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
export type SkillUnpublishParams=z.infer<typeof SkillUnpublishParams>;
export const SkillUnpublishResult=z.object({projectId:ProjectId,name:skillName,deactivated:z.literal(true),previousRevision:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
export type SkillUnpublishResult=z.infer<typeof SkillUnpublishResult>;

export const SkillInstallStatusParams = z.object({
  clientRequestId:z.string().min(1).max(512),agent:AgentId,name:z.string().min(1).max(255),scope:SkillScope,projectId:ProjectId.optional(),
  includeReceiverIdentity:z.literal(true).optional(),
  includeRecoveryContext:z.literal(true).optional(),
}).strict().refine(value=>value.scope==="project"?!!value.projectId:value.projectId===undefined,{message:"Project scope requires projectId; global scope excludes it"});
export type SkillInstallStatusParams = z.infer<typeof SkillInstallStatusParams>;
export const SkillInstallRecoveryContext=z.object({revision:z.string().regex(/^[a-f0-9]{64}$/),receiverID:z.string().uuid(),originalReceiverID:z.string().uuid().nullable(),
  fenced:z.boolean(),fenceID:z.string().uuid().optional()}).strict().refine(value=>value.fenced===!!value.fenceID);
export type SkillInstallRecoveryContext=z.infer<typeof SkillInstallRecoveryContext>;
const installStatusIdentity={clientRequestId:z.string().min(1).max(512),createdAt:Timestamp,updatedAt:Timestamp,receiverID:z.string().uuid().optional(),recovery:SkillInstallRecoveryContext.optional()};
export const SkillInstallStatusResult = z.discriminatedUnion("state",[
  z.object({clientRequestId:z.string().min(1).max(512),state:z.literal("not_found"),found:z.literal(false),outcomeKnown:z.literal(false)}).strict(),
  z.object({...installStatusIdentity,state:z.literal("prepared"),found:z.literal(true),outcomeKnown:z.literal(false),dispatchClaimed:z.literal(false)}).strict(),
  z.object({...installStatusIdentity,state:z.literal("dispatched"),found:z.literal(true),outcomeKnown:z.literal(false),dispatchClaimed:z.literal(true)}).strict(),
  z.object({...installStatusIdentity,state:z.literal("unknown"),found:z.literal(true),outcomeKnown:z.literal(false),dispatchClaimed:z.literal(true),reasonCode:z.enum(["write_outcome_unconfirmed","controller_not_observed"])}).strict(),
  z.object({...installStatusIdentity,state:z.literal("failed"),found:z.literal(true),outcomeKnown:z.literal(true),dispatchClaimed:z.literal(false),reasonCode:z.literal("preparation_failed")}).strict(),
  z.object({...installStatusIdentity,state:z.literal("confirmed"),found:z.literal(true),outcomeKnown:z.literal(true),dispatchClaimed:z.literal(true),result:SkillInstallResult}).strict(),
]);
export type SkillInstallStatusResult = z.infer<typeof SkillInstallStatusResult>;

export const SkillInstallFenceParams=z.object({clientRequestId:z.string().min(1).max(512),originalRequestId:z.string().min(1).max(512),agent:AgentId,
  name:z.string().min(1).max(255),scope:z.literal("project").default("project"),projectId:ProjectId,expectedReceiverID:z.string().uuid(),baseRecoveryRevision:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
export type SkillInstallFenceParams=z.infer<typeof SkillInstallFenceParams>;
export const SkillInstallFenceResult=z.object({clientRequestId:z.string().min(1).max(512),originalRequestId:z.string().min(1).max(512),agent:AgentId,
  name:z.string().min(1).max(255),scope:z.literal("project"),projectId:ProjectId,receiverID:z.string().uuid(),originalReceiverID:z.string().uuid().nullable(),fenceID:z.string().uuid(),
  disposition:z.literal("unconfirmed_metadata_fenced"),outcomeKnown:z.literal(false),targetLocked:z.literal(true),filesDeleted:z.literal(false),originalWritesMayContinue:z.literal(true),recordedAt:Timestamp}).strict();
export type SkillInstallFenceResult=z.infer<typeof SkillInstallFenceResult>;

// --- skill.uninstall ---
export const SkillUninstallParams = z
  .object({
    clientRequestId: z.string().optional(),
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

// --- skill.dirs ---
export const SkillDirsParams = z.object({
  /** 可选：global scope 的目标 agent。 */
  agent: AgentId.optional(),
  /** 可选：project scope 的目标项目。 */
  projectId: ProjectId.optional(),
  /** 可选：只查 global 或 project；不传时按 agent/projectId 返回可查范围。 */
  scope: SkillScope.optional(),
});
export type SkillDirsParams = z.infer<typeof SkillDirsParams>;

export const SkillDirectoryDescriptor = z.object({
  /** skill 目录名。 */
  name: z.string().min(1),
  scope: SkillScope,
  agent: AgentId.optional(),
  projectId: ProjectId.optional(),
  /** scope 根目录（global skill root 或 <project>/.agent/skills）。 */
  rootPath: z.string().min(1),
  /** skill 目录真实本机路径。 */
  path: z.string().min(1),
  exists: z.boolean(),
  active:z.boolean().optional(),
  publication:SkillDescriptor.shape.publication,
});
export type SkillDirectoryDescriptor = z.infer<typeof SkillDirectoryDescriptor>;

export const SkillDirsResult = z.object({
  directories: z.array(SkillDirectoryDescriptor),
});
export type SkillDirsResult = z.infer<typeof SkillDirsResult>;
