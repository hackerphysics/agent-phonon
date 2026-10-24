import type { ModelInfo, ReasoningLevel } from "@agent-phonon/protocol";
import { DiscoveryRPC } from "../discovery-rpc.js";
import type { ProcessSupervisor } from "../process-supervisor.js";

/** Pi >= 0.84.1's native getSupportedThinkingLevels contract, not a provider-name guess. */
export function piModelReasoningLevels(model: Record<string, unknown>): ReasoningLevel[] | undefined {
  if (typeof model.reasoning !== "boolean") return undefined;
  if (!model.reasoning) return [];
  const raw = model.thinkingLevelMap;
  if (raw !== undefined && (!raw || typeof raw !== "object" || Array.isArray(raw))) return undefined;
  const map = (raw ?? {}) as Record<string, unknown>;
  if (Object.values(map).some(value => value !== null && typeof value !== "string")) return undefined;
  const levels: Array<[ReasoningLevel, string]> = [["low", "low"], ["standard", "medium"], ["high", "high"], ["xhigh", "xhigh"], ["max", "max"]];
  return levels.filter(([canonical, native]) => map[native] !== null
    && (!["xhigh", "max"].includes(canonical) || typeof map[native] === "string")).map(([canonical]) => canonical);
}

export function parsePiNativeModels(value: unknown): ModelInfo[] {
  const rows = (value as { models?: unknown } | null)?.models;
  if (!Array.isArray(rows) || rows.length > 2000) throw new Error("Invalid native Pi model catalog");
  const models: ModelInfo[] = [], seen = new Set<string>();
  for (const value of rows) {
    if (!value || typeof value !== "object") throw new Error("Invalid native Pi model");
    const row = value as Record<string, unknown>;
    if (typeof row.provider !== "string" || !row.provider || typeof row.id !== "string" || !row.id) throw new Error("Invalid native Pi model identity");
    const id = row.provider + "/" + row.id;
    if (id.length > 240 || seen.has(id)) throw new Error("Invalid native Pi model identity");
    seen.add(id);
    const levels = piModelReasoningLevels(row), window = row.contextWindow;
    models.push({ id, available: true,
      ...(levels ? { reasoningLevels: levels } : {}),
      ...(typeof row.name === "string" ? { displayName: row.name } : {}),
      ...(typeof window === "number" && Number.isSafeInteger(window) && window > 0 ? { contextWindow: window } : {}) });
  }
  return models;
}

/** Ephemeral metadata-only Pi process; disables project context and discovered extensions. */
export async function discoverPiNativeModels(input: {
  bin: string; env: NodeJS.ProcessEnv; signal?: AbortSignal; onRuntime?: (runtime: ProcessSupervisor) => void;
}): Promise<{ models: ModelInfo[]; selectedID?: string }> {
  const channel = new DiscoveryRPC(input.bin, ["--mode", "rpc", "--no-session", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-context-files"], {
    env: input.env, ...(input.signal ? { signal: input.signal } : {}), ...(input.onRuntime ? { onRuntime: input.onRuntime } : {}),
  });
  try {
    const models = parsePiNativeModels(await channel.request({ type: "get_available_models" }));
    const state = await channel.request({ type: "get_state" }) as { model?: { provider?: unknown; id?: unknown } } | null;
    const model = state?.model;
    const selectedID = typeof model?.provider === "string" && typeof model.id === "string" ? model.provider + "/" + model.id : undefined;
    return { models, ...(selectedID && models.some(model => model.id === selectedID) ? { selectedID } : {}) };
  } finally { await channel.close(); }
}
