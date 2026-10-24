import type { ReasoningLevel } from "@agent-phonon/protocol";

export function nativeReasoning(level: ReasoningLevel | null): string | null {
  return level === "standard" ? "medium" : level;
}
export function canonicalReasoning(value: unknown): ReasoningLevel | undefined {
  return value === "medium" ? "standard" : value === "low" || value === "standard" || value === "high" || value === "xhigh" || value === "max" ? value : undefined;
}
export function reportedReasoningLevels(values: unknown): ReasoningLevel[] | undefined {
  if (!Array.isArray(values)) return undefined;
  return [...new Set(values.map(value => canonicalReasoning(typeof value === "string" ? value : value?.value ?? value?.effort ?? value?.id)).filter((value): value is ReasoningLevel => value !== undefined))];
}
