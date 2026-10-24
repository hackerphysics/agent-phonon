import { z } from "zod";
import { SessionId, Timestamp } from "./common.js";

export const CompressionState = z.enum(["running", "succeeded", "noop", "failed", "unknown"]);
export const CompressionReceipt = z.object({
  operationId: z.string().min(1).max(512), sessionId: SessionId,
  requestHash: z.string().regex(/^[a-f0-9]{64}$/), state: CompressionState,
  mode: z.enum(["native", "custom"]), agent: z.string(), model: z.string(), project: z.string(),
  summary: z.string().max(4000).optional(), errorCode: z.string().max(128).optional(),
  tokensBefore: z.number().int().nonnegative().optional(), tokensAfter: z.number().int().nonnegative().optional(),
  filesChanged: z.number().int().nonnegative().optional(), recordsChanged: z.number().int().nonnegative().optional(),
  blocksRemoved: z.number().int().nonnegative().optional(), bytesBefore: z.number().int().nonnegative().optional(), bytesAfter: z.number().int().nonnegative().optional(),
  createdAt: Timestamp, updatedAt: Timestamp,
});
export type CompressionReceipt = z.infer<typeof CompressionReceipt>;
export const CompressionStatusParams = z.object({ sessionId: SessionId, operationId: z.string().min(1).max(512) });
export const SessionCompressionControls = z.object({
  native: z.boolean(), custom: z.boolean(), blocked: z.boolean(), operation: CompressionReceipt.optional(),
});
