import { z } from "zod";

const text = z.string().max(4096);
const timestamp = z.number().finite().nonnegative();

/** Read-only projection of a vendor job, never a Phonon L4 Schedule. */
export const OpenClawSchedule = z.object({
  id: text.min(1),
  name: text.optional(),
  declarationKey: text.optional(),
  enabled: z.boolean(),
  agentId: text.optional(),
  effectiveAgentId: text.optional(),
  trigger: z.object({
    kind: text.min(1), expr: text.optional(), tz: text.optional(),
    everyMs: timestamp.optional(), anchorMs: timestamp.optional(),
    at: text.optional(), atMs: timestamp.optional(), staggerMs: timestamp.optional(),
  }),
  session: z.object({
    sessionTarget: text.optional(), sessionKey: text.optional(),
    wakeMode: text.optional(), payloadKind: text.optional(),
  }),
  delivery: z.object({
    mode: text.optional(), channel: text.optional(), to: text.optional(),
    lastDeliveryStatus: text.optional(), lastDelivered: z.boolean().optional(),
    lastFailureNotificationDeliveryStatus: text.optional(),
  }),
  state: z.object({
    nextRunAtMs: timestamp.optional(), lastRunAtMs: timestamp.optional(),
    lastRunStatus: text.optional(), lastStatus: text.optional(),
    consecutiveErrors: z.number().int().nonnegative().optional(), lastError: text.optional(),
  }),
});
export type OpenClawSchedule = z.infer<typeof OpenClawSchedule>;

export const OpenClawScheduleListParams = z.object({}).strict();
export const OpenClawScheduleListResult = z.object({ schedules: z.array(OpenClawSchedule) });
export type OpenClawScheduleListResult = z.infer<typeof OpenClawScheduleListResult>;
export const OpenClawScheduleGetParams = z.object({ id: text.min(1) }).strict();
export const OpenClawScheduleGetResult = z.object({ schedule: OpenClawSchedule });
export type OpenClawScheduleGetResult = z.infer<typeof OpenClawScheduleGetResult>;
