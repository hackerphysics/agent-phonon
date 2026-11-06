import { z } from "zod";
import { AgentId, ProjectId, SessionId, Timestamp } from "./common.js";

// Transport receipt only. This never starts, resumes or replays model execution.
export const MessageReceiveParams = z.object({
  messageId: z.string().uuid(),
  recipientId: z.string().uuid(),
  conversationId: z.string().uuid(),
  position: z.string().regex(/^[0-9]{1,20}$/),
  project: ProjectId,
  agent: AgentId,
  model: z.string().min(1).max(255),
  sessionId: SessionId.optional(),
  document: z.record(z.unknown()),
}).strict();
export type MessageReceiveParams = z.infer<typeof MessageReceiveParams>;
export const MessageReceiveResult = z.object({
  messageId: z.string().uuid(),
  recipientId: z.string().uuid(),
  conversationId: z.string().uuid(),
  requestHash: z.string().regex(/^[a-f0-9]{64}$/),
  receivedAt: Timestamp,
  state: z.literal("received"),
}).strict();
export type MessageReceiveResult = z.infer<typeof MessageReceiveResult>;
