import { z } from "zod";
import { SessionId } from "./common.js";

const id = z.string().uuid().transform(value => value.toLowerCase());
const members = z.object({ operation: z.literal("members") }).strict();
const order=z.string().regex(/^(0|[1-9][0-9]{0,18})$/).refine(value=>/^(0|[1-9][0-9]{0,18})$/.test(value)&&BigInt(value)<=9223372036854775807n);
const history=z.object({operation:z.literal("history"),beforeOrder:order.optional(),throughOrder:order.optional(),limit:z.number().int().min(1).max(40).optional()}).strict();
const read=z.object({operation:z.literal("read"),messageID:id,offset:z.number().int().min(0).max(2147483646).optional()}).strict();
const send = z.object({ operation: z.literal("send"), requestId: id,
  text: z.string().max(4000),
  mentionIDs: z.array(id).min(1).max(8), mode: z.enum(["insert", "wait", "queue"]),
  attachmentIDs:z.array(z.string().regex(/^native-file:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)).max(5).optional()
    .describe("Explicit immutable files already published in this conversation/project. At most five files and 25 MiB. Use serverRef, never device paths or URLs. Recorded does not prove recipient file delivery."),
}).strict();
const status = z.object({ operation: z.literal("status"), requestId: id }).strict();
const distinct = (value: { operation: string; text?:string;mentionIDs?: string[];attachmentIDs?:string[] }) =>
  value.operation !== "send" || new Set(value.mentionIDs).size === value.mentionIDs?.length
    &&new Set(value.attachmentIDs).size===(value.attachmentIDs?.length??0)
    &&(!!value.text?.trim()||!!value.attachmentIDs?.length);
/** Agent-authored content only; current conversation and sender are controller-owned. */
export const AgentMessageInput = z.discriminatedUnion("operation", [members, history, read, send, status]).refine(distinct);
export type AgentMessageInput = z.infer<typeof AgentMessageInput>;
const lineage = { nativeRunId: id, workflowId: z.string().min(1).max(512), sessionId: SessionId, turnId: z.string().min(1).max(512) };
export const ConversationMessageParams = z.discriminatedUnion("operation", [
  members.extend(lineage).strict(), history.extend(lineage).strict(),read.extend(lineage).strict(),send.extend(lineage).strict(), status.extend(lineage).strict(),
]).refine(distinct);
export type ConversationMessageParams = z.infer<typeof ConversationMessageParams>;
const receipt = z.object({ personID: id, state: z.enum(["recorded", "sending", "pendingInsert", "waiting", "queued", "accepted", "running", "succeeded", "removed", "unsupported", "notAccepted", "offline", "failed", "unknown", "cancelled"]), errorCode: z.string().max(128).optional() }).strict();
const historyMessage=z.object({id,historyOrder:order,author:z.enum(["human","assistant","system"]),senderID:z.string().max(512),senderName:z.string().max(240),
  createdAt:z.string().datetime({offset:true}),text:z.string().max(12000),textLength:z.number().int().nonnegative(),isExcerpt:z.boolean(),mentionIDs:z.array(id).max(32),
  originKind:z.string().max(128).optional(),attachmentIDs:z.array(z.string().regex(/^native-(file|result):[0-9a-f-]{36}$/)).max(5),
  runID:id.optional(),workflowID:id.optional(),requestID:id.optional()}).strict();
export const ConversationMessageResult = z.discriminatedUnion("status", [
  z.object({status:z.literal("history"),conversationID:id,projectID:id,throughOrder:order,messages:z.array(historyMessage).max(40),nextBeforeOrder:order.optional()}).strict(),
  z.object({status:z.literal("message"),conversationID:id,projectID:id,message:historyMessage,offset:z.number().int().nonnegative(),nextOffset:z.number().int().positive().optional()}).strict(),
  z.object({ status: z.literal("members"), conversationID: id, projectID: id, senderID: id, enabled: z.boolean(),
    members: z.array(z.object({ id, name: z.string().max(120) }).strict()).max(32),
    limits: z.object({ maxHops: z.number().int().positive(), maxDeliveries: z.number().int().positive(), maxRecipients: z.number().int().positive(), maxRoots: z.number().int().positive() }).strict(),
  }).strict(),
  z.object({ status: z.literal("recorded"), requestId: id, messageID: id, chainID: id, rootMessageID: id,
    depth: z.number().int().positive().max(12), receipts: z.array(receipt).max(8), replayed: z.boolean().optional(),
  }).strict(),
  z.object({ status: z.literal("not_found"), requestId: id }).strict(),
  z.object({ status: z.literal("not_accepted"), requestId: id, errorCode: z.string().min(1).max(128) }).strict(),
]);
export type ConversationMessageResult = z.infer<typeof ConversationMessageResult>;
