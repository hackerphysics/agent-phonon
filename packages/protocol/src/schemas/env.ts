import { z } from "zod";
import { ProjectId, AgentId } from "./common.js";

/** Skill / agent 执行环境变量配置。明文存储在设备本地，list 默认脱敏。 */
export const EnvScope = z.enum(["global", "project", "skill"]);
export type EnvScope = z.infer<typeof EnvScope>;

const EnvTargetBase = z.object({
  scope: EnvScope,
  projectId: ProjectId.optional(),
  agent: AgentId.optional(),
  skillName: z.string().min(1).optional(),
});

function withEnvTargetRefine<T extends z.ZodTypeAny>(schema: T): T {
  return schema
    .refine((v: unknown) => (v as { scope?: string; projectId?: string }).scope !== "project" || !!(v as { projectId?: string }).projectId, { message: "project scope requires projectId", path: ["projectId"] })
    .refine((v: unknown) => {
      const x = v as { scope?: string; projectId?: string; agent?: string; skillName?: string };
      return x.scope !== "skill" || (!!x.projectId && !!x.agent && !!x.skillName);
    }, { message: "skill scope requires projectId+agent+skillName", path: ["skillName"] }) as unknown as T;
}

export const EnvTarget = withEnvTargetRefine(EnvTargetBase);
export type EnvTarget = z.infer<typeof EnvTargetBase>;

export const EnvVarDescriptor = withEnvTargetRefine(EnvTargetBase.extend({
  name: z.string().min(1),
  value: z.string().optional(),
  redacted: z.boolean().default(true),
  updatedAt: z.string().datetime({ offset: true }).optional(),
}));
export type EnvVarDescriptor = z.infer<typeof EnvVarDescriptor>;

export const EnvSetParams = withEnvTargetRefine(EnvTargetBase.extend({
  clientRequestId: z.string().optional(),
  name: z.string().min(1),
  value: z.string(),
  /** 可选：如果是 secret，list 默认永远脱敏。默认 true。 */
  secret: z.boolean().default(true),
}));
export type EnvSetParams = z.infer<typeof EnvSetParams>;
export const EnvSetResult = z.object({ variable: EnvVarDescriptor });
export type EnvSetResult = z.infer<typeof EnvSetResult>;

export const EnvListParams = EnvTargetBase.partial().extend({
  /** 默认 false；true 需要本地 policy allowEnvReveal。 */
  reveal: z.boolean().default(false),
});
export type EnvListParams = z.infer<typeof EnvListParams>;
export const EnvListResult = z.object({ variables: z.array(EnvVarDescriptor) });
export type EnvListResult = z.infer<typeof EnvListResult>;

export const EnvDeleteParams = withEnvTargetRefine(EnvTargetBase.extend({
  clientRequestId: z.string().optional(),
  name: z.string().min(1),
}));
export type EnvDeleteParams = z.infer<typeof EnvDeleteParams>;
export const EnvDeleteResult = z.object({ deleted: z.literal(true), name: z.string() });
export type EnvDeleteResult = z.infer<typeof EnvDeleteResult>;
