import type { ModelInfo } from "@agent-phonon/protocol";
import { DiscoveryRPC } from "../discovery-rpc.js";
import { reportedReasoningLevels } from "../reasoning.js";
import type { ProcessSupervisor } from "../process-supervisor.js";

export function parseCodexNativeModels(value: unknown): { models: ModelInfo[]; nextCursor: string | null } {
  const page = value as { data?: unknown; nextCursor?: unknown } | null;
  if (!page || !Array.isArray(page.data) || page.data.length > 1000
    || page.nextCursor !== null && page.nextCursor !== undefined && (typeof page.nextCursor !== "string" || page.nextCursor.length > 4096)) {
    throw new Error("Invalid native Codex model page");
  }
  const models: ModelInfo[] = [], seen = new Set<string>();
  for (const value of page.data) {
    if (!value || typeof value !== "object") throw new Error("Invalid native Codex model");
    const row = value as Record<string, unknown>;
    const id = typeof row.model === "string" && row.model ? row.model : row.id;
    if (typeof id !== "string" || !id || id.length > 240 || seen.has(id)) throw new Error("Invalid native Codex model identity");
    seen.add(id);
    const raw = row.supportedReasoningEfforts ?? row.supported_reasoning_levels;
    const levels = reportedReasoningLevels(Array.isArray(raw) ? raw.map(value =>
      value && typeof value === "object" ? (value as Record<string, unknown>).reasoningEffort ?? (value as Record<string, unknown>).effort : value) : raw);
    models.push({ id, available: true,
      ...(typeof row.displayName === "string" ? { displayName: row.displayName } : {}),
      ...(levels ? { reasoningLevels: levels } : {}) });
  }
  return { models, nextCursor: typeof page.nextCursor === "string" ? page.nextCursor : null };
}

/** model/list only: no threads, turns, prompts, tools or configuration writes. */
export async function discoverCodexNativeModels(input: {
  bin: string; args: string[]; env: NodeJS.ProcessEnv; signal?: AbortSignal;
  onRuntime?: (runtime: ProcessSupervisor) => void;
}): Promise<ModelInfo[]> {
  const channel = new DiscoveryRPC(input.bin, ["app-server", ...input.args], {
    env: input.env, ...(input.signal ? { signal: input.signal } : {}), ...(input.onRuntime ? { onRuntime: input.onRuntime } : {}),
  });
  try {
    await channel.request({ method: "initialize", params: { clientInfo: { name: "agent_phonon_model_discovery", version: "1" }, capabilities: {} } });
    channel.initialized();
    const models: ModelInfo[] = [], cursors = new Set<string>(), identities = new Set<string>();
    let cursor: string | null = null;
    for (let page = 0; page < 16; page++) {
      const reply = parseCodexNativeModels(await channel.request({ method: "model/list", params: { limit: 100, ...(cursor ? { cursor } : {}) } }));
      for (const model of reply.models) {
        if (identities.has(model.id)) throw new Error("Native Codex model pages overlap");
        identities.add(model.id); models.push(model);
      }
      if (reply.nextCursor === null) return models;
      if (cursors.has(reply.nextCursor)) throw new Error("Native Codex model cursor did not advance");
      cursors.add(reply.nextCursor); cursor = reply.nextCursor;
    }
    throw new Error("Native Codex model page limit exceeded");
  } finally { await channel.close(); }
}
