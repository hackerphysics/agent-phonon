# OpenClaw Native Schedule Discovery (Flow b9e56bec)

`openclaw.schedule.list` (`{}` -> `{schedules: [...]}`) and
`openclaw.schedule.get` (`{id}` -> `{schedule}`) are read-only device RPCs.
They inspect jobs already owned by the configured OpenClaw Gateway, not the
Phonon L4 `schedule.*` clock. No Agents HTTP surface or second clock is needed.

The Gateway adapter reads `cron.list` with `includeDisabled: true` using its
existing authenticated WS client. The CLI adapter reads only
`openclaw cron list --all --json` through the bounded discovery probe. Both
methods read fresh snapshots; get resolves an exact vendor id from that same
inventory, avoiding reliance on an unverified vendor `cron.get` RPC. There is
no transport-error fallback to another Gateway or to Phonon schedules.

The allowlisted projection exposes identity (`id`, name/displayName, enabled,
agentId/effectiveAgentId, declarationKey), trigger (`kind`, expr, tz, everyMs,
anchorMs, at/atMs, staggerMs), session (`sessionTarget`, sessionKey, wakeMode,
payloadKind), delivery (`mode`, channel, to, lastDeliveryStatus, lastDelivered,
lastFailureNotificationDeliveryStatus), and state (`nextRunAtMs`, lastRunAtMs,
lastRunStatus/lastStatus, consecutiveErrors, lastError). Unknown vendor fields
and raw payloads/prompts/configuration are omitted. Missing optional fields
stay absent. Clear credential assignments, bearer credentials and URL
passwords are redacted; opaque targets such as Feishu open_ids are preserved.

`device.info.capabilities` includes `openclaw_schedule_discover_v1` only after
a successful, validated native inventory read and when both methods are
permitted. Missing adapter/binary, unreachable Gateway, auth/method errors,
malformed responses and duplicate ids never yield a successful empty inventory.
Partial/paginated inventories (`hasMore`, `nextOffset` or a mismatched total)
are rejected as unsupported rather than returning an incomplete list/detail.
Transport failures use `errAgentUnavailable`, unsupported configuration/shape
uses `errCapabilityUnsupported`, and an absent or inaccessible detail id uses
`errInvalidParams`. Method allowlists apply; agent allowlists filter by the
effective native agent, falling back to agentId. Unknown bindings are hidden
when an agent allowlist exists. An empty native inventory is a valid success;
policy filtering can also hide all jobs without revealing foreign bindings.

TypeScript: `device.openclaw.schedule.list()` / `.get(id)`.
Python: `await device.openclaw_schedule_list()` / `openclaw_schedule_get(id)`.

Out of scope: vendor run history/status endpoints, all vendor writes/triggers,
Phonon L4 dispatch changes, Hermes discovery, Agents cron, live E2E, releases,
deployment and merge. No model invocation is needed for discovery or its tests.
