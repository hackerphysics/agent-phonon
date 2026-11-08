import { z } from "zod";

// Native catalogs own the vocabulary; bound identifiers, not a frozen effort menu.
export const ReasoningLevel = z.string().regex(/^[a-z][a-z0-9_-]{0,63}(?![\s\S])/);
export type ReasoningLevel = z.infer<typeof ReasoningLevel>;
// null explicitly removes Phonon's override; omission preserves legacy behavior.
export const TurnReasoning = z.object({ level: ReasoningLevel.nullable() }).strict();
export type TurnReasoning = z.infer<typeof TurnReasoning>;
export const ReasoningConfirmation = z.object({
  requestedLevel: ReasoningLevel.nullable(),
  nativeValue: ReasoningLevel.nullable(),
  effectiveLevel: ReasoningLevel.optional(),
}).strict();
export type ReasoningConfirmation = z.infer<typeof ReasoningConfirmation>;
