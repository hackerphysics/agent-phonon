import { z } from "zod";
import { SessionId, Timestamp } from "./common.js";

const graphemes = new Intl.Segmenter("und", { granularity: "grapheme" });
const length = (value: string) => Array.from(graphemes.segment(value)).length;
const bounded = (count: number) => z.string().max(count * 16).refine(value => length(value) <= count);
const id = z.string().uuid().transform(value => value.toLowerCase());
export const ConversationBoardItem = z.object({
  id, kind: z.enum(["todo", "note"]), text: bounded(60).refine(value => value.trim().length > 0),
  completed: z.boolean(), sourceMessageID: id.optional(),
}).strict();
const content = { goal: bounded(70), items: z.array(ConversationBoardItem).max(8) };
const concise = (value: { goal: string; items: Array<{ id: string; text: string }> }) =>
  length(value.goal) + value.items.reduce((sum, item) => sum + length(item.text), 0) <= 400
  && new Set(value.items.map(item => item.id)).size === value.items.length;
const read = z.object({ operation: z.literal("read") }).strict();
const write = z.object({ operation: z.literal("write"), requestId: id,
  baseRevision: z.number().int().nonnegative().max(2147483646), ...content }).strict();
/** Model-owned content only. Routing and author identity are never accepted here. */
export const AgentBoardInput = z.discriminatedUnion("operation", [read, write])
  .refine(value => value.operation === "read" || concise(value));
export type AgentBoardInput = z.infer<typeof AgentBoardInput>;
const lineage = { nativeRunId: id, workflowId: z.string().min(1).max(512),
  sessionId: SessionId, turnId: z.string().min(1).max(512) };
/** Controller-stamped current-turn lineage, authenticated by the device transport. */
export const ConversationBoardParams = z.discriminatedUnion("operation", [
  read.extend(lineage).strict(), write.extend(lineage).strict(),
]).refine(value => value.operation === "read" || concise(value));
export type ConversationBoardParams = z.infer<typeof ConversationBoardParams>;
export const ConversationBoard = z.object({ conversationID: id, ...content,
  revision: z.number().int().nonnegative().max(2147483647), authorID: z.string().min(1).max(128), updatedAt: Timestamp,
}).strict().refine(concise);
export const ConversationBoardResult = z.object({
  status: z.enum(["ok", "conflict"]), board: ConversationBoard, replayed: z.boolean().optional(),
}).strict();
export type ConversationBoardResult = z.infer<typeof ConversationBoardResult>;
