import { HermesSchedule, HermesScheduleListResult } from "@agent-phonon/protocol";
import type { AgentAdapter } from "./adapter.js";
import { HermesScheduleDiscoveryError } from "./adapters/hermes-schedule-discover.js";
import { publicText } from "./adapters/openclaw-schedule.js";
import { PhononError } from "./rpc.js";
import type { PolicyEnforcer } from "./policy.js";

function sanitize(value: unknown, key = ""): unknown {
  if (typeof value === "string") return ["id", "profile", "agentId"].includes(key) ? value : publicText(value);
  if (Array.isArray(value)) return value.map(item => sanitize(item));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([field, item]) => [field, sanitize(item, field)]));
  return value;
}

/** No caller paths, vendor mutations, diagnostics or local home paths cross this boundary. */
export async function readHermesSchedules(adapter: AgentAdapter | undefined, policy: PolicyEnforcer, profile?: string, id?: string) {
  if (!adapter?.discoverNativeSchedules || !adapter.getNativeSchedule) throw new PhononError("errCapabilityUnsupported", "Hermes schedule discovery is not configured");
  if (profile !== undefined) policy.assertAgentAllowed(`hermes:${profile}`);
  try {
    const scope = profile === undefined ? {} : { profile };
    if (id !== undefined) {
      const schedule = HermesSchedule.parse(await adapter.getNativeSchedule(id, scope));
      policy.assertAgentAllowed(schedule.context.agentId);
      if (schedule.id !== id || schedule.context.agentId !== `hermes:${schedule.context.profile}` || profile !== undefined && schedule.context.profile !== profile) throw new Error("identity mismatch");
      return { schedule: HermesSchedule.parse(sanitize(schedule)) };
    }
    const inventory = HermesScheduleListResult.parse(await adapter.discoverNativeSchedules(scope));
    policy.assertAgentAllowed(inventory.agentId);
    if (inventory.agentId !== `hermes:${inventory.profile}` || profile !== undefined && inventory.profile !== profile
      || new Set(inventory.jobs.map(job => job.id)).size !== inventory.jobs.length) throw new Error("identity mismatch");
    return HermesScheduleListResult.parse(sanitize(inventory));
  } catch (error) {
    if (error instanceof PhononError) throw error;
    if (error instanceof HermesScheduleDiscoveryError) {
      const code = ["invalid_scope", "job_not_found"].includes(error.code) ? "errInvalidParams"
        : ["cron_unsupported", "store_invalid"].includes(error.code) ? "errCapabilityUnsupported" : "errAgentUnavailable";
      throw new PhononError(code, `Hermes schedule discovery: ${error.code}`);
    }
    throw new PhononError("errAgentUnavailable", "Hermes schedule discovery unavailable");
  }
}
