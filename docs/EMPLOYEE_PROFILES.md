# Isolated Employee Profiles

`employee.profile.apply/status` provide durable tenant-scoped DE installation.
`employee_profiles_v1` marks controller support; the adapter must also declare
`employeeProfiles`. Creation/editing requires explicit local
`allowEmployeeProfiles: true`, never merely `trustLocal` or `allowedMethods`.
Agent allowlists and model discovery still apply.

The controller derives native names from tenant/employee identity, not a remote
directory. Base agent/profile IDs are immutable. Desired revision/content hashes
are durable before application; stale revisions and changed same-revision input
fail. Ready requires readback hashes matching the SOUL/AGENTS/USER/TOOLS guidance.
On OpenClaw versions whose native file API explicitly rejects `TOOLS.md`, empty
tool guidance may remain absent and is represented by the empty-content hash.
Nonempty guidance is never silently dropped, and permission/transport/other-file
errors still fail. The adapter never bypasses that native API with direct writes.

OpenClaw creation can be acknowledged before its runtime config snapshot sees
the new identity. After a successful create, the adapter waits at most five
seconds for the same ID and workspace in the native runtime catalog before
updating it. It does not repeat creation, restart the Gateway or guess a path.
Unobserved visibility fails with `employee_profile_native_pending`; closure,
changed workspace and read errors still prevent writes. Ready still requires
the complete native document readback, not the creation acknowledgement.

Discovery preserves native OpenClaw display names and stable sub-agent IDs.
The employee status `runtimeProfile` is the actual installed identity; a mobile
application must not confuse it with the base harness or logical `profileId`.
Hermes inventory reads the installed Python package version without invoking
the cold-home CLI's synchronous remote update check.
Replaying an applied revision never silently overwrites local file changes.

## Native Runtimes

- OpenClaw Gateway uses native `agents.create/update` and `agents.files.get/set`,
  with a dedicated workspace/ownership marker. Native auth inheritance remains
  in charge; source auth stores and personality are not cloned or overwritten.
- Hermes uses its installed console script's interpreter and native path/config
  APIs. A fresh named profile is staged with descriptor-relative no-follow file
  operations on POSIX and a pinned rooted native broker/handle-bound Windows
  backend when its local runtime assets are available. No base memories, sessions, channels, skills or OAuth/auth.json
  stores are copied. Only native-declared inference-provider environment keys
  may be copied locally; they never enter protocol/app/server responses.
  Native root credential-pool fallback still owns rotating login grants.
  Windows asset setup, ACL checks, pipe framing and acceptance boundaries are in
  `WINDOWS_HERMES_PROFILES.md`. Previously installed missing/copy-replaced native
  homes are not silently recreated or adopted; private directory identities are
  retained alongside document observations.
- Active external Hermes memory providers require isolated setup rather than
  silently sharing another profile's external memory.
- The local `hermesManagedProfileNativeTools` opt-in applies only to newly
  managed Hermes profiles. Native 0.16/0.21 one-shot execution selects
  `platform_toolsets.cli`, not root `toolsets`. Provisioning adds only the
  `mcp-phonon_current_turn` alias to that effective selection, preserves other
  platforms and explicit denials, and verifies rather than repairs an existing
  profile on a provisioning retry. Safe mode, `no_mcp`, empty/malformed explicit
  selections and an existing current-turn MCP alias prevent enablement.
- CLI-only OpenClaw does not advertise installation. A provider name alone is
  not capability proof. Native API refusals must not trigger global-file edits
  or a generic file-broker bypass.

Persona updates preserve learned memory. Hermes desired USER.md is separate
from mutable memories/USER.md, which is seeded once and then preserved.
OpenClaw MEMORY.md is never rewritten. Memory bytes describe known native files,
not an invented complete accounting of every backend/database.

## Session Identity

Use `agentConfig: {employee: {id: employeeId, revision: installedRevision}}` on
Session/Workflow creation. The controller resolves it in the current tenant and
passes an internal binding to the adapter. Session metadata carries employee
ID/revision; different conversations use distinct Sessions with one DE memory.
Verified revisions can be injected into idle Sessions. Running/unrecovered
Sessions block profile writes; leases cover creation and turn finalization too.

Each employee has an actual namespace-scoped device home, tagged `employeeId` in
project metadata. It is not a Registry/Default project. Normal workspace pickers
exclude it. Projectless private chats execute there; project groups retain
canonical project/workspace writer checks. Detached Hermes history must be
verified before reattachment, never silently replaced by a fresh conversation.

## SDKs And Tests

TypeScript: `device.employeeProfiles.apply(params)` / `.status(employeeId)`.
Python: `await device.employee_profile_apply(**params)` /
`await device.employee_profile_status(employee_id)`.

Tests cover actual controller/SQLite, policy/owner isolation, separate Sessions,
versions, memory and bad-readback refusal. OpenClaw's native API boundary is
stubbed, not a live-provider claim. With `PHONON_TEST_HERMES_BIN`, an installed
Hermes smoke test uses temporary HERMES_HOME, native profile listing and symlink
refusal; it starts no model or personal gateway/profile.
