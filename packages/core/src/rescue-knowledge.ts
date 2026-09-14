import { z } from "zod";
import { RESCUE_KNOWLEDGE_DATA } from "./rescue-knowledge-data.js";

/** Internal Rescue tool, not a wire RPC or a runtime skill installer. */
export const rescueKnowledgeQuerySchema = z.object({
  action: z.enum(["list", "search", "get"]),
  id: z.string().max(100).optional(),
  agent: z.string().max(80).optional().describe("Discovered native agent (opencode, claude-code, hermes, codex, copilot, phonon-rescue), not a targetId"),
  version: z.string().max(120).optional().describe("Exact discovered agent version; never assume a known version"),
  platform: z.string().max(30).optional().describe("Observed platform; linux is the only native-verified platform"),
  protocol: z.enum(["chat", "responses", "anthropic", "gemini"]).optional(),
  text: z.string().max(500).optional().describe("Short symptom keywords; never include secrets or full config contents"),
  limit: z.number().int().min(1).max(10).optional(),
}).strict();
export type RescueKnowledgeQuery = z.infer<typeof rescueKnowledgeQuerySchema>;
type Entry = (typeof RESCUE_KNOWLEDGE_DATA.entries)[number];
const agents = new Set<string>(RESCUE_KNOWLEDGE_DATA.entries.flatMap(e => [...e.agents]));
function agentName(value?: string): string | undefined {
  const name = value?.trim().toLowerCase();
  return name === "claude" || name === "claude code" ? "claude-code" : name;
}
function applicability(entry: Entry, q: RescueKnowledgeQuery): string[] {
  const reasons: string[] = [];
  const agent = agentName(q.agent);
  if (!agent) reasons.push("agent-not-observed");
  else if (!(entry.agents as readonly string[]).includes(agent)) reasons.push("agent-mismatch");
  if (!q.platform) reasons.push("platform-not-observed");
  else if (q.platform.toLowerCase() !== "linux") reasons.push("platform-unverified");
  const rawVersion = q.version?.trim();
  // Exact display aliases were observed from native --version. Never strip an
  // unknown build/prerelease suffix or search arbitrary text for a semver.
  const aliases: Readonly<Record<string, string>> = entry.versionAliases;
  const version = rawVersion && Object.hasOwn(aliases, rawVersion)
    ? aliases[rawVersion] : rawVersion?.replace(/^v(?=\d)/, "");
  if (entry.versions.length && !version) reasons.push("version-not-observed");
  else if (entry.versions.length && !(entry.versions as readonly string[]).includes(version!)) reasons.push("version-unverified");
  if (!(entry.protocols as readonly string[]).includes("any")) {
    if (!q.protocol) reasons.push("protocol-not-observed");
    else if (!(entry.protocols as readonly string[]).includes(q.protocol)) reasons.push("protocol-mismatch");
  }
  return reasons;
}

/** Pure bounded query: static bundled data, no filesystem, network or mutation. */
export function queryRescueKnowledge(input: RescueKnowledgeQuery) {
  const q = rescueKnowledgeQuerySchema.parse(input);
  const agent = agentName(q.agent);
  const base = { packVersion: RESCUE_KNOWLEDGE_DATA.packVersion, sourceRevision: RESCUE_KNOWLEDGE_DATA.authoring.sourceSha256 };
  if (agent && !agents.has(agent)) return { ...base, status: "no-match", reason: "unknown-agent; do not apply another agent's repair", entries: [] };
  if (q.action === "get" && !q.id) return { ...base, status: "no-match", reason: "get requires a stable knowledge id", entries: [] };
  const words = (q.text ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  const matched = RESCUE_KNOWLEDGE_DATA.entries.filter(entry => {
    if (q.id && entry.id !== q.id) return false;
    if (agent && !(entry.agents as readonly string[]).includes(agent)) return false;
    if (q.action !== "search" || !words.length) return true;
    const haystack = `${entry.id} ${entry.title} ${entry.symptoms.join(" ")} ${entry.body}`.toLowerCase();
    return words.some(word => haystack.includes(word));
  });
  const entries = matched.slice(0, q.limit ?? 10).map(entry => {
    const reasons = applicability(entry, q);
    const applicable = reasons.length === 0;
    const { body: _body, steps: _steps, ...metadata } = entry;
    return { ...metadata, applicable, applicabilityReasons: reasons,
      ...(q.action === "get" && applicable ? { body: entry.body, steps: [...entry.steps] } : {}),
      ...(entry.kind === "boundary-only" ? { repairAuthorizedByEvidence: false } : {}),
    };
  });
  // Copy nested metadata as well: callers can never mutate trusted module state.
  return structuredClone({ ...base, status: entries.length ? "found" : "no-match", total: matched.length, entries,
    guidance: "Get applicable entries before repair; cite id/revision. Missing context or mismatch requires discovery/version-specific validation, not a guessed patch. Boundary-only entries do not validate provider writes. Knowledge never expands maintenance policy." });
}
