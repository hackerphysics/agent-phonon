import { z } from "zod";

const id = z.string().uuid().transform(value => value.toLowerCase());
const position = z.string().regex(/^(0|[1-9][0-9]{0,17})$/);
export const CoordinationActivity = z.object({
  summary: z.string().trim().max(500), phase: z.enum(["planning", "working", "validating", "blocked", "idle", "completed"]),
  impact: z.array(z.string().trim().min(1).max(240)).max(16), dependencies: z.string().max(1000).default(""),
}).strict().refine(value=>new TextEncoder().encode(JSON.stringify(value)).length<=16000,"Activity exceeds the encoded byte limit");
export const AgentCoordinationInput = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("presence") }).strict(),
  z.object({ operation: z.literal("peers"), after: position.default("0") }).strict(),
  z.object({ operation: z.literal("activity"), requestId: id, baseRevision: z.number().int().nonnegative(), activity: CoordinationActivity }).strict(),
  z.object({ operation: z.literal("send"), requestId: id, recipientId: id, kind: z.enum(["intent", "question", "notice", "request", "result"]),
    text: z.string().trim().min(1).max(4000), references: z.array(z.string().trim().min(1).max(512)).max(8).default([]), inReplyTo: id.optional() }).strict(),
  z.object({ operation: z.literal("inbox"), after: position.default("0") }).strict(),
  z.object({ operation: z.literal("acknowledge"), messageIds: z.array(id).min(1).max(32).refine(values => new Set(values).size === values.length) }).strict(),
  z.object({ operation: z.literal("receipt"), requestId: id }).strict(),
  z.object({ operation: z.literal("leave") }).strict(),
]).refine(value=>new TextEncoder().encode(JSON.stringify(value)).length<=24000,"Coordination action exceeds the encoded byte limit");
export type AgentCoordinationInput = z.infer<typeof AgentCoordinationInput>;
// Device-owned metadata, deliberately outside the model-facing action union.
const receiveBoundary = z.enum(["before_model", "after_tools"]);
const receiveEvidence = z.enum(["context_hook", "provider_payload"]);
export const CoordinationReceiveReport = z.discriminatedUnion("mode", [
  z.object({ version: z.literal(1), mode: z.literal("tool_polling") }).strict(),
  z.object({ version: z.literal(1), mode: z.literal("runtime_pending"), boundary: receiveBoundary,
    evidence: receiveEvidence, visibility: z.enum(["hidden", "collapsed"]) }).strict(),
  z.object({ version: z.literal(1), mode: z.literal("runtime_checkpoint"), boundary: receiveBoundary,
    evidence: receiveEvidence, visibility: z.enum(["hidden", "collapsed"]) }).strict(),
]);
export type CoordinationReceiveReport = z.infer<typeof CoordinationReceiveReport>;
export const CoordinationReceiveState = z.object({ report: CoordinationReceiveReport,
  reportedAt: z.string().datetime(), current: z.boolean(),
}).strict();
export const ProjectCoordinationParams = z.object({ sourceKind: z.enum(["native", "dev"]), runId: id,
  workflowId: z.string().min(1).max(512), sessionId: z.string().min(1).max(512), turnId: z.string().min(1).max(512), action: AgentCoordinationInput,
  receive: CoordinationReceiveReport.optional(),
  evidenceVersion: z.literal(1).optional(),
  workspaceVersion: z.literal(1).optional(),
}).strict();
export type ProjectCoordinationParams = z.infer<typeof ProjectCoordinationParams>;
const workspaceText = (limit: number) => z.string().min(1).max(limit).refine(value =>
  new TextEncoder().encode(value).length <= limit && !/[\x00-\x1f\x7f-\x9f]/.test(value));
export const CoordinationWorkspace = z.discriminatedUnion("state", [
  z.object({ state: z.literal("current"), deviceId: id, runtimeWorkspaceId: workspaceText(4096),
    path: workspaceText(4096), repositoryRoot: workspaceText(4096), branch: workspaceText(1024),
    isWorktree: z.boolean(), worktreeId: workspaceText(512).optional(), detached: z.boolean(),
    head: z.string().regex(/^[a-f0-9]{40,64}$/).optional(), observedAt: z.string().datetime(), checkedAt: z.string().datetime(),
  }).strict(),
  z.object({ state: z.enum(["unavailable", "unsupported", "notGit"]), deviceId: id.nullable(), checkedAt: z.string().datetime(),
    reasonCode: z.string().regex(/^[a-z0-9_]{1,64}$/).optional(),
  }).strict(),
]);
export type CoordinationWorkspace = z.infer<typeof CoordinationWorkspace>;
const Participant = z.object({ id, position, projectId: id, ownerId: z.string(), deviceId: id.nullable(), agentId: z.string(),
  agentKind: z.enum(["agent", "de"]), sourceKind: z.enum(["native", "dev", "mcp"]), sessionId: z.string(), label: z.string(),
  activity: CoordinationActivity, activityRevision: z.number().int().nonnegative(), lastSeenAt: z.string().nullable(),
  deviceName: z.string().nullable().optional(), runtimeState: z.string().nullable().optional(),
  receive: CoordinationReceiveState.optional(),
  workspace: CoordinationWorkspace.optional(),
  presence: z.enum(["active", "stale", "offline", "ended"]),
}).strict();
const Message = z.object({ id, position, senderId: id, recipientId: id, kind: z.enum(["intent", "question", "notice", "request", "result"]),
  text: z.string().max(4000), references: z.array(z.string()).max(8), inReplyTo: id.nullable(), depth: z.number().int().min(0).max(6),
  createdAt: z.string().nullable(), expiresAt: z.string().nullable(), state: z.enum(["stored", "received", "withdrawn", "expired"]), receivedAt: z.string().nullable(),
  contentAvailable: z.boolean().optional(),
}).strict();
export const ProjectCoordinationResult = z.object({ self: Participant.optional(), participants: z.array(Participant).max(32).optional(),
  receiveReporting: z.literal(1).optional(),
  evidenceVersion: z.literal(1).optional(),
  workspaceVersion: z.literal(1).optional(),
  deliveryOffers: z.array(z.object({messageId:id,deliveryId:id}).strict()).max(32).optional(),
  messages: z.array(Message).max(32).optional(), message: Message.optional(), next: position.nullable().optional(),
  status: z.enum(["recorded", "not_found", "left"]).optional(), requestId: id.optional(), participantId: id.optional(), replayed: z.boolean().optional(),
}).strict();
export type ProjectCoordinationResult = z.infer<typeof ProjectCoordinationResult>;

export const CoordinationRuntimeEvidence = z.object({deliveryId:id,boundaryId:id,
  contentHash:z.string().regex(/^[0-9a-f]{64}$/),state:z.enum(["offered","context_hook","provider_payload"])}).strict();
export const ProjectCoordinationEvidenceParams = z.object({version:z.literal(1),
  reports:z.array(CoordinationRuntimeEvidence).min(1).max(8).refine(rows=>new Set(rows.map(row=>row.deliveryId)).size===rows.length),
}).strict();
export type ProjectCoordinationEvidenceParams = z.infer<typeof ProjectCoordinationEvidenceParams>;
export const ProjectCoordinationEvidenceResult = z.object({version:z.literal(1),
  receipts:z.array(z.discriminatedUnion("status",[
    z.object({deliveryId:id,status:z.literal("recorded"),state:z.enum(["offered","context_hook","provider_payload"])}).strict(),
    z.object({deliveryId:id,status:z.literal("rejected"),reason:z.enum(["unavailable","mismatch"])}).strict(),
  ])).max(8),
}).strict();
export type ProjectCoordinationEvidenceResult = z.infer<typeof ProjectCoordinationEvidenceResult>;
