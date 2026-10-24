import { z } from "zod";

export const ReasoningLevel = z.enum(["low", "standard", "high", "xhigh", "max"]);
export type ReasoningLevel = z.infer<typeof ReasoningLevel>;
// null explicitly removes Phonon's override; omission preserves legacy behavior.
export const TurnReasoning = z.object({ level: ReasoningLevel.nullable() }).strict();
export type TurnReasoning = z.infer<typeof TurnReasoning>;
export const ReasoningConfirmation = z.object({
  requestedLevel: ReasoningLevel.nullable(),
  nativeValue: z.enum(["off","none","minimal","low","medium","high","xhigh","max","ultra","auto","adaptive"]).nullable(),
  effectiveLevel: ReasoningLevel.optional(),
}).strict();
export type ReasoningConfirmation = z.infer<typeof ReasoningConfirmation>;
