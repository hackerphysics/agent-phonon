# Managed Unified Phonon MCP

The daemon supports `mcp.configure` / `mcp.status` for owner-approved automatic
registration of the Unified Phonon MCP in local native tools. This is separate
from the turn-scoped `phonon_current_turn` MCP endpoint.

Local permission is required per exact registered source:

```sh
agent-phonon mcp allow --server wss://agents.phonon.work/phonon --agents codex,pi
agent-phonon mcp deny --server wss://agents.phonon.work/phonon
```

`agent-phonon server list` prints a non-secret `source` selector. If more than
one account is configured at the same URL, pass its exact selector using
`--source <source>` to `mcp allow` or `mcp deny`; URL-only selection is rejected
as ambiguous. A source is derived from the exact registered URL, device key and
expected tenant. This selector is not a credential or an owner assertion.
Local consent is bound to that source, including the selected runtime allowlist.
Changing the key or tenant requires new human local consent; an old `allow:true`
or another account's copied consent does not authorize the replacement account.

The web/iOS device switch then selects runtimes and product grants. A server
cannot supply executable commands, config paths, remote URLs or secrets through
the RPC; it sends a versioned full snapshot:

```json
{"revision":1,"bindings":[{"id":"11111111-1111-4111-8111-111111111111","agentId":"codex","enabled":true}]}
```

Native configurations contain only a stdio proxy command and non-secret local
references. The proxy loads the existing device credential from the registered
daemon config and authenticates only to that server's HTTPS device broker.
The server holds the short-lived MCP credential. Neither MCP access tokens nor
phone/browser/service credentials are copied into native MCP settings.

Configuration writes preserve unrelated entries, comments where supported,
native permission filters and personal approvals. Changed/deleted owned entries,
unsafe ownership, symlinks and unsupported syntax return a conflict. They are
never adopted, overwritten or retried with broader permissions. User-level
registration may require a new session/client reload; no native app is restarted.

Default supported formats on macOS/Linux: Codex TOML, Claude Code user JSON,
Copilot MCP JSON, OpenCode JSON(C), Pi 0.99.0+ MCP JSON, Hermes default YAML and
OpenClaw main MCP config. Custom Hermes profile paths must be selected locally;
other OpenClaw sub-agent scopes and non-JSON-compatible JSON5 remain unsupported.
Windows ACL-safe configuration is implemented but still under acceptance, as
described below. Profiles are not silently converted to global scope.

The daemon keeps a private version-2 per-source ownership/revision ledger
alongside its database. Native aliases include both source and binding identity,
so equal binding UUIDs at the same server URL cannot share revision or ownership
state. Managers and workers retain the source selected at connection creation.
Every proxy request rechecks that exact source, its local consent and runtime
allowlist. A running proxy cannot switch to another account after config changes.
URL-only legacy ledgers and aliases have unknown ownership: they are not adopted,
overwritten or deleted. Legacy proxy commands without `--source` fail closed;
human review is required to retire those old registrations.

Turning off local permission rejects every future proxy request,
including existing processes. Turning off the server switch rejects calls even
while the daemon is offline; owned file removal occurs on reconnect or sync.
Uncertain writes are not replayed and prior effects are not undone by revocation.

Protocol capability: `managed_mcp_v1`. TS SDK helpers are `device.mcp.configure`
and `device.mcp.status`; Python helpers are `device.mcp_configure` and
`device.mcp_status`. Configuration states and actual tool-call observation are
separate; unit/parser/SDK tests do not establish real native-model acceptance.

The two closed Canvas HTML operations (`canvas_create_frame` and
`canvas_update_frame`), plus `canvas_check_submission` naming one of those exact
operations, allow 2 MiB requests. Other RPCs retain 64 KiB. The budget module is
generated from the Unified Canvas contract and grants no new authority. Responses
remain bounded at 2 MiB; source documents use authorized, hash-pinned chunks.

## Windows Acceptance In Progress

Windows uses the installed Windows PowerShell/.NET ACL APIs, not POSIX chmod,
runtime compilation or a permissive shell. Private files are created with a
protected DACL for the current user, SYSTEM and Administrators. Existing unsafe
files, foreign owners, untrusted writers, reparse points and replaceable parents
are refused; existing directories are never globally tightened. Paths and file
content travel over stdin. Configuration replacement still uses Node's atomic
rename and verifies the exact original source and the resulting registration.

ACL reads pin a file handle, deny writers/deletion and enforce a one-MiB byte
limit. Replacement preparation groups the before/after source checks and private
temporary-file creation into one helper call. Windows daemon configuration and
status RPCs use a packaged worker so synchronous ACL processes do not block the
daemon event loop. Writes remain serial and uncertain outcomes are not retried.

On October 21, 2026, isolated operations on Windows 11 / Node 24.19.0 confirmed
private directory/file creation, exact reads, missing/oversized read behavior,
foreign-reader/foreign-writer rejection and junction-parent rejection. The
pre-optimization writer added and removed Codex TOML, Claude JSON and Hermes
YAML entries in a disposable directory after verifying the prepared artifact's
checksum. These were runtime smoke observations, not remote test suites or real
installed-client/model acceptance. No personal config or daemon was changed.

The optimized replacement operation also refused changed source content without
creating a temporary file, and successfully prepared/replaced/read back unchanged
content on Windows. The Windows worker and multi-runtime RPC timing still require
acceptance. Follow-up uploads failed and left a partial locked artifact, which
was never executed. All five temporary runtime modules were later ownership/ACL
checked and removed, with no known scratch directories remaining.

Local source/test typechecking and the daemon build pass. Of 68 selected daemon
cases, 66 pass and two Windows-only ACL cases are explicitly skipped on macOS;
they must run locally on Windows or in CI, not on a deployment server. Real local
worker coverage includes consent, revision and ownership checks. The packaged
worker imports, returns status and exits in a local smoke check. This is not
release approval or final Mac/Ubuntu/Windows MCP acceptance.

## October 22 Runtime Checkpoint

A locally prepared, dependency-bundled runtime has now added, reported and
removed all seven supported configuration formats in isolated directories on
Mac arm64, Ubuntu x86_64 and Windows x64 with existing Node 24.19.0 runtimes.
This uses synthetic inventory and no live broker, native client or model.

The Windows Manager's real worker path took 14650 ms to configure seven entries,
832 ms for status and 14716 ms to remove them. Caller timers advanced 477 times,
with maximum measured delay 283 ms. Both snapshots fit the source gateway's
30-second timeout in this observation; no network-RPC latency guarantee follows.

The first Windows observation correctly rejected TEMP permissions that granted
foreign SIDs modification/replacement rights. No permissions were weakened.
The follow-up used a newly private profile child, matching the daemon's normal
configuration location, and confirmed scratch cleanup. No installed personal
configuration, daemon/service or credential was changed. All builds, dependency
bundling and preflight ran locally; remote devices only verified/unpacked the
prepared runtime and performed the three bounded functional operations.

This closes the worker-only/multi-format runtime smoke gap, not actual device
WebSocket RPC, enrolled-account authorization, native-client/tool discovery,
installed-model execution or final three-device acceptance. Those gates remain.

## Source-Bound Replacement Checkpoint

The later October 22 runtime adds exact source identity to local consent,
state/revisions, aliases, workers and every running proxy call. Thirteen local
source-isolation cases include equal binding IDs at one URL, ambiguous selection,
copied/legacy consent, account replacement, worker pinning, async revision and
revocation races, per-source allowlists and malformed ownership state.

The full selected native run passes 58 cases with two Windows-only real ACL
cases skipped on Mac. Downstream Phonon verification adds 11 packaged artifact/
stdio cases, eight real managed Auth/Agents/MCP cases (including two owners in
one native profile), ten Auth managed-grant cases and 96 real business HTTP
cases. These certify the named frozen runtime and controlled adapters, not
installed vendor clients/models or a full repository release gate. Three fresh
target-specific archives were prepared entirely locally; none was activated.
Current-version actual Mac/Ubuntu/Windows acceptance still requires an approved
serialized cutover without overlapping daily daemons.
