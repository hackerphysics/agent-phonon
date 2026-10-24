import { z } from "zod";

export const SessionCheckpoint = z.object({
  version: z.literal(1), adapter: z.string().min(1), agent: z.string().min(1),
  model: z.string().min(1), project: z.string().min(1), cwd: z.string().min(1),
  settled: z.boolean(), state: z.record(z.unknown()),
}).strict();
export type SessionCheckpoint = z.infer<typeof SessionCheckpoint>;

export function readSessionCheckpoint(value: unknown): SessionCheckpoint | undefined {
  if (typeof value !== "string" || Buffer.byteLength(value) > 65536) return;
  try { return SessionCheckpoint.parse(JSON.parse(value)); } catch { return; }
}
