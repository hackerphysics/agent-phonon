# Hermes Native Schedule RPC (Flow b75457e9)

Expose only `hermes.schedule.list({profile?})` and
`hermes.schedule.get({id, profile?})`, wrapping the existing adapter discovery
methods. Omitted profile selects the adapter's configured/default profile;
explicit profile selects that exact native profile, with no cross-profile fallback.
List returns `{runtime, source, profile, agentId, updatedAt?, jobs}`; get returns
`{schedule}` with summary, trigger, context and delivery. Local home paths and
unknown/raw fields never cross the wire. Display/context/delivery strings reuse
OpenClaw's credential redactor; opaque IDs remain exact. Metadata is owner-sensitive.

The connection applies method and native agent policy. Profile identities must
match; duplicate IDs and invalid results fail closed. Native missing-job/scope
errors map to `errInvalidParams`, unsupported cron/corrupt stores to
`errCapabilityUnsupported`, other discovery failures to `errAgentUnavailable`.
Unknown diagnostics are never relayed. No error becomes an empty list.

`hermes_schedule_discover_v1` is advertised only after both methods are allowed
and a successful authorized default/configured-profile inventory read. Failure
removes the optional capability on the next `device.info` observation. Capability
absence is not evidence that the device has no jobs. TypeScript exposes
`device.hermes.schedule.list/get`; Python exposes `hermes_schedule_list/get`.

Agents may aggregate these reads by owned DE (overriding the earlier deferral
of Agents HTTP aggregation, not moving discovery into Agents). No vendor writes,
triggers, scheduler, connectors, release, upgrade or deployment are added.
