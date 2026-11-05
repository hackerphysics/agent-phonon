import { z } from "zod";
import { OpenClawSchedule } from "@agent-phonon/protocol";
import { PhononError } from "../rpc.js";

const omitNullFields = (value: unknown) => value && typeof value === "object" && !Array.isArray(value)
  ? Object.fromEntries(Object.entries(value).filter(([, field]) => field !== null)) : value;
const vendorJob = z.preprocess(omitNullFields, OpenClawSchedule.omit({ trigger: true, session: true, delivery: true, state: true }).extend({
  displayName: OpenClawSchedule.shape.name,
  schedule: z.preprocess(omitNullFields, OpenClawSchedule.shape.trigger),
  sessionTarget: OpenClawSchedule.shape.session.shape.sessionTarget,
  sessionKey: OpenClawSchedule.shape.session.shape.sessionKey,
  wakeMode: OpenClawSchedule.shape.session.shape.wakeMode,
  payload: z.preprocess(omitNullFields, z.object({ kind: OpenClawSchedule.shape.session.shape.payloadKind })).nullish(),
  delivery: z.preprocess(omitNullFields, OpenClawSchedule.shape.delivery).nullish(),
  state: z.preprocess(omitNullFields, OpenClawSchedule.shape.state.merge(OpenClawSchedule.shape.delivery.pick({
    lastDeliveryStatus: true, lastDelivered: true, lastFailureNotificationDeliveryStatus: true,
  }))).nullish(),
}));
const vendorList = z.union([z.array(vendorJob), z.object({
  jobs: z.array(vendorJob), error: z.null().optional(), ok: z.literal(true).optional(),
  hasMore: z.literal(false).optional(), nextOffset: z.null().optional(),
  total: z.number().int().nonnegative().optional(),
  offset: z.literal(0).optional(), limit: z.number().int().nonnegative().optional(),
}).refine(value => value.total === undefined || value.total === value.jobs.length)
  .refine(value => value.limit === undefined || value.jobs.length <= value.limit)
  .refine(value => (value.offset === undefined && value.limit === undefined)
    || value.hasMore === false || value.total === value.jobs.length)]);

// Only clear credential forms are redacted; opaque native delivery IDs stay intact.
function publicText(value: string): string {
  return value
    // Escapes are indivisible; an unterminated quoted value is redacted through EOF.
    // Commas, semicolons and closing braces can be part of an unquoted credential value.
    .replace(/((?:token|password|secret|api[_-]?key)["']?\s*[=:]\s*)("(?:\\[\s\S]|[^"\\])*(?:"|\\?$)|'(?:\\[\s\S]|[^'\\])*(?:'|\\?$)|[^\s&"']+)/gi,
      (_match, prefix: string, scalar: string) => {
        const quote = scalar[0] === '"' || scalar[0] === "'" ? scalar[0] : "";
        return `${prefix}${quote}[redacted]${quote}`;
      })
    .replace(/\b((?:Bearer|Basic)\s+)[^\s,;]+/gi, "$1[redacted]")
    // Greedy userinfo reaches the last authority @, never the path, query or fragment.
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/?#]*:[^\s/?#]*@/gi, "$1[redacted]@");
}

/** The supplied transport performs exactly one read. Errors never become []. */
export async function readOpenClawSchedules(read: () => Promise<unknown>): Promise<OpenClawSchedule[]> {
  let raw: unknown;
  try { raw = await read(); }
  catch { throw new PhononError("errAgentUnavailable", "OpenClaw schedule read unavailable (transport, authentication or method failure)"); }
  const parsed = vendorList.safeParse(raw);
  if (!parsed.success) throw new PhononError("errCapabilityUnsupported", "OpenClaw schedule response is unsupported");
  const jobs = Array.isArray(parsed.data) ? parsed.data : parsed.data.jobs;
  const ids = new Set<string>();
  return jobs.map(job => {
    if (ids.has(job.id)) throw new PhononError("errCapabilityUnsupported", "OpenClaw schedule identity is ambiguous");
    ids.add(job.id);
    const state = job.state ?? {};
    const normalized = OpenClawSchedule.parse({
      id: job.id, name: job.name ?? job.displayName, declarationKey: job.declarationKey,
      enabled: job.enabled, agentId: job.agentId, effectiveAgentId: job.effectiveAgentId,
      trigger: job.schedule,
      session: { sessionTarget: job.sessionTarget, sessionKey: job.sessionKey, wakeMode: job.wakeMode, payloadKind: job.payload?.kind },
      delivery: { ...job.delivery, lastDeliveryStatus: state.lastDeliveryStatus ?? job.delivery?.lastDeliveryStatus,
        lastDelivered: state.lastDelivered ?? job.delivery?.lastDelivered,
        lastFailureNotificationDeliveryStatus: state.lastFailureNotificationDeliveryStatus ?? job.delivery?.lastFailureNotificationDeliveryStatus },
      state,
    });
    // Keep opaque identities exact; redact only display text and delivery targets.
    if (normalized.name !== undefined) normalized.name = publicText(normalized.name);
    if (normalized.delivery.to !== undefined) normalized.delivery.to = publicText(normalized.delivery.to);
    if (normalized.state.lastError !== undefined) normalized.state.lastError = publicText(normalized.state.lastError);
    return normalized;
  });
}
