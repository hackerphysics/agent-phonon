import { ReasoningLevel } from "@agent-phonon/protocol";

export function nativeReasoning(level: ReasoningLevel | null): string | null {
  return level === "standard" ? "medium" : level;
}
export function canonicalReasoning(value: unknown): ReasoningLevel | undefined {
  const parsed = ReasoningLevel.safeParse(value);
  return parsed.success ? parsed.data === "medium" ? "standard" : parsed.data : undefined;
}
export function reportedReasoningLevels(values: unknown): ReasoningLevel[] | undefined {
  if (!Array.isArray(values) || values.length > 64) return undefined;
  return [...new Set(values.map(value => canonicalReasoning(typeof value === "string" ? value : value?.value ?? value?.effort ?? value?.reasoningEffort ?? value?.id)).filter((value): value is ReasoningLevel => value !== undefined))];
}
