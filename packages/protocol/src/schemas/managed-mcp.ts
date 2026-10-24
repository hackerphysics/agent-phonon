import { z } from "zod";

export const ManagedMcpBinding = z.object({
  id: z.string().uuid(),
  agentId: z.string().min(1).max(255),
  enabled: z.boolean(),
}).strict();
export const ManagedMcpConfigureParams = z.object({
  revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  bindings: z.array(ManagedMcpBinding).max(50),
}).strict().refine(value => new Set(value.bindings.map(item => item.id)).size === value.bindings.length
  && new Set(value.bindings.map(item => item.agentId)).size === value.bindings.length, "duplicate MCP binding");
export const ManagedMcpStatusParams = z.object({}).strict();
export const ManagedMcpBindingStatus = z.object({
  id: z.string().uuid(), agentId: z.string().min(1).max(255),
  state: z.enum(["configured", "removed", "conflict", "unsupported", "local_consent_required", "error"]),
  code: z.string().regex(/^[a-z0-9_]{1,100}$/).optional(),
}).strict();
export const ManagedMcpStatusResult = z.object({
  revision: z.number().int().min(-1),
  allowed: z.boolean(),
  bindings: z.array(ManagedMcpBindingStatus).max(50),
}).strict();
export type ManagedMcpConfigureParams = z.infer<typeof ManagedMcpConfigureParams>;
export type ManagedMcpStatusResult = z.infer<typeof ManagedMcpStatusResult>;
