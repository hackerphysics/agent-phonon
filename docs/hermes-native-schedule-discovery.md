# Hermes Native Schedule Discovery

Flow `2c18ad8a`: device-local, read-only discovery of Hermes' own cron jobs.
No deployment, Agents service, Phonon L4 schedule mapping, execution, or clock is
introduced. Hermes remains the sole authority for its native timing and jobs.

## Local API

`HermesAdapter.discoverNativeSchedules({ agentId?, profile?, signal? })` returns
an inventory with runtime/source, profile/agent association, home, native store
update timestamp (if present), and job summaries. Disabled and completed jobs
are included, not just the next runnable jobs.

`HermesAdapter.getNativeSchedule(id, scope?)` returns the same summary plus:

- `trigger`: native kind, expression, display, explicit timezone if present,
  interval minutes, one-shot run time, and repeat counters. No timezone or next
  occurrence is inferred or calculated by Phonon.
- `context`: profile, agentId, home, origin, context-from references, workdir,
  model/provider pins and native attach-to-session preference when stored.
  The preference is not a claim of an actual execution Session ID.
- `delivery`: native deliver/failure-deliver targets and last delivery error.
  Last execution status and last delivery error remain separate observations.

The discoverer, types, and typed `HermesScheduleDiscoveryError` are exported
from core. This is a Hermes-specific adapter API, not a new RPC or SDK method.
There is intentionally no protocol, TypeScript/Python SDK, or `schedule.*`
change. A future shared vendor shape can preserve `{runtime, source, profile,
agentId, jobs}` and summary/detail `{trigger, context, delivery}` without
overloading L4 or requiring another runtime adapter to implement this feature.

## Native Sources And Scope

Verified against the installed Hermes v0.21.1 parser, `cron/jobs.py`,
`hermes_constants.py`, and `hermes_cli/profiles.py` on November 5, 2026:

- A bounded `discoveryProbe(binary, ["cron", "--help"])` confirms that the
  native cron/list surface exists. No table parsing or `--json` assumption.
- The store is read with read-only file flags from `<home>/cron/jobs.json`.
  Hermes' Python job loader is not called: its lock/normalization paths can
  write. No lock file, directory, missing store, or repair is created.
- `env.nativeScheduleHome` is a local discovery-only home override; otherwise
  use `HERMES_HOME`, then `~/.hermes`. A home already under `profiles/<name>`
  stays pinned when no explicit profile or non-default adapter profile is set.
- Explicit `profile` or `hermes:<profile>` selects root/default or
  `<root>/profiles/<profile>`, including managed `phn-*` profiles. Conflicting
  associations and path-like names are rejected. Named profile tombstones are
  honored. There is never a fallback to another profile's inventory.
- The probe receives the selected `HERMES_HOME` and supervised-child marker
  so Hermes' sticky `active_profile` does not redirect it.

Only allowlisted metadata is returned, not prompts, scripts, base URLs, tokens,
or raw job records. Results still contain owner-sensitive origin identifiers,
paths, names and native errors. Callers must enforce their existing device/owner
read authority and must not log full results. Discovery logs no diagnostics or
store contents. File contents are bounded at 8 MiB; non-regular, linked final
store files and symlinked selected home/cron directories are refused. This
local API is not a replacement for a caller's authorization boundary.

Execution-attempt history is deferred: `cron runs` is text, and this feature
does not introduce a speculative structured history parser. Missing native
fields remain absent/null; histories and sessions are never fabricated.

## Fail-Closed Matrix

| Observation | Outcome |
| --- | --- |
| Missing binary / null probe / ENOENT | `runtime_unavailable` error |
| Successful help without cron/list support | `cron_unsupported` error |
| Nonzero/failed/deadline probe | `probe_failed` error, including unsupported commands that exit nonzero |
| Missing/unreadable/unsafe/oversized store or deleted profile | `store_unreadable` error |
| Corrupt JSON, wrong structure/known field type, duplicate or missing ID | `store_invalid` error; no partial inventory |
| Valid structured `{ "jobs": [] }` | Successful empty inventory |
| Job ID absent in valid selected store | `job_not_found` error |
| Invalid/conflicting scope | `invalid_scope` error |
| Cancellation before/during discovery | Abort propagated, no observation returned |

Only `cron --help` can be executed by this discoverer. It never calls
create/add/edit/pause/resume/run/remove/rm/delete/tick, notepad or incident
mutations, `schedule.trigger`, or any model. It does not calculate due jobs,
start scheduling timers, subscribe to ticks, or modify the native clock.

## Verification

`pnpm --filter @agent-phonon/test-server... -r build` then
`node scripts/test-local.mjs focused packages/test-server/dist/fn-hermes-schedule-discover.test.js`.
The existing test-server package test command also runs these tests. Fixtures are
temporary, contain synthetic/redacted identifiers and never read personal jobs.
