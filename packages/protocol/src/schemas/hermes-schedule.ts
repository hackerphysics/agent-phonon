import { z } from "zod";

const text = z.string().max(4096);
const optionalText = text.nullish();
const profile = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/);
export const HermesScheduleSummary = z.object({
  id: text.min(1), name: optionalText, enabled: z.boolean().nullish(), state: optionalText,
  nextRunAt: optionalText, lastRunAt: optionalText, lastStatus: optionalText, lastError: optionalText,
});
export const HermesSchedule = HermesScheduleSummary.extend({
  trigger: z.object({
    kind: text.min(1), expr: optionalText, display: optionalText, timezone: optionalText,
    minutes: z.number().finite().nullish(), runAt: optionalText,
    repeat: z.object({ times: z.number().finite().nullish(), completed: z.number().finite().nullish() }).nullish(),
  }),
  context: z.object({
    profile, agentId: text.min(1),
    origin: z.object({ platform: optionalText, chat_id: z.union([text, z.number().finite()]).nullish(),
      chat_name: optionalText, thread_id: z.union([text, z.number().finite()]).nullish() }).nullish(),
    contextFrom: z.array(text).nullish(), workdir: optionalText, model: optionalText, provider: optionalText,
    attachToSession: z.boolean().nullish(),
  }),
  delivery: z.object({ mode: optionalText, failureMode: optionalText, lastDeliveryError: optionalText }),
});
export const HermesScheduleListParams = z.object({ profile: profile.optional() }).strict();
export const HermesScheduleListResult = z.object({
  runtime: z.literal("hermes"), source: z.literal("cron/jobs.json"), profile, agentId: text.min(1),
  updatedAt: optionalText, jobs: z.array(HermesScheduleSummary),
});
export const HermesScheduleGetParams = HermesScheduleListParams.extend({ id: text.min(1) }).strict();
export const HermesScheduleGetResult = z.object({ schedule: HermesSchedule });
export type HermesScheduleListResult = z.infer<typeof HermesScheduleListResult>;
export type HermesScheduleGetResult = z.infer<typeof HermesScheduleGetResult>;
