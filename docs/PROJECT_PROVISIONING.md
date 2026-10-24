# Controlled Project Provisioning

Status: native prerequisite implemented and locally verified on macOS only.
Phonon's default-off source-bound business controller is implemented and tested
with controlled and actual isolated native receivers. The packaged native/server path is not
released, enabled by default or accepted on the three real target devices.

## Contract

`project.provision` takes only `{clientRequestId, name, expectedReceiverID}`. Both
identities are UUIDs; the receiver is observed from current `device.info` as
`projectProvisionReceiverID` with capability `project_provision_v1`. No caller
path, Git initialization, remote, shell command, credentials or approval field
is accepted. The host must explicitly enable local `allowProjectProvision` and
both methods in any method allowlist. `trustLocal` does not enable this policy.
An existing configured workspace root and persistent native database are required.

`project.provision.status` takes `{clientRequestId, expectedReceiverID}`. The
TypeScript SDK exposes `device.project.provision` / `provisionStatus`; Python
uses `project_provision` / `project_provision_status`. Creation helpers check
the current capability/receiver before mutation and preserve the exact captured
packet. Legacy `project.create` remains unchanged and adds no probe. Controllers
with their own durable commit-to-send fence must prepare these reads before
claiming dispatch, then use the captured fixed RPC, not insert an SDK preflight
after that fence.

No raw provisioning RPC or human decision operation is exposed as an MCP tool.
Phonon's new closed prepare/status/reconcile business tools bind the original
owner, source authorization, device, canonical Project and Registry association;
see its `docs/mcp-workspace-preparation.md`. Native receiver/file IDs
are observations, never those grants. This creates an existing native Project
record, not a second session, development product or workflow execution store.

## Persistence And Uncertainty

An independent `<native-db>.projects.sqlite` journal preserves namespace-scoped
receiver, request fingerprint, original root identity, generated random target,
exclusive dispatch claim, actual directory identity and state. SQLite identities
and dispatch states are immutable/monotonic. A bounded per-tenant history refuses
new operations at its limit rather than deleting uncertain history. Files and
retained targets are never automatically deleted or released by this service.
The core store adds only a read-only journal-path accessor, not unrelated schema
or session/adapter changes.

The operation records `prepared`, atomically claims `dispatched`, and invokes
the private anchored `mkdir_new` once. A known native refusal records `failed`.
A lost response, unobserved controller or uncertain mutation stays `unknown`;
reconnect, duplicate calls and `status` do not dispatch again or adopt an existing
directory. Root or target replacement is refused. Ordinary `project.create`
cannot adopt the generated directory, its child/ancestor or unknown reservation;
the managed basename is reserved even if its journal is missing.

An identical request that is durably still `prepared` may claim its original
unwritten target after restart. Only the mutating `project.provision` may do so;
status reports it without dispatch. The saved target, not a new random directory,
is used. A request with a dispatch claim never returns to prepared.

Only after actual exclusive-create and directory readback receipts are durably
`observed` may the original native Project metadata be registered and the
operation marked `confirmed`. `status` performs no directory creation. It may
repair that exact missing metadata registration from the persisted observation,
after current policy and filesystem checks. It is therefore filesystem-read-only,
not a promise of zero metadata writes. A confirmed Project subsequently removed
by the owner is not silently re-registered by old request/status calls.

Every later managed Project lookup verifies the recorded root/directory file
identity. Existing Projects/worktrees cannot become implicit parents/children of
a newly managed workspace. The project journal and SQLite auxiliary files reject
links and non-private POSIX files, and runtime file replacement is refused.
Each ledger operation rechecks the canonical file, original inode/link count,
current owner/private mode and any current WAL/SHM/rollback-journal files.
An observed security failure permanently closes that controller to further
ledger access, even if permissions are subsequently restored; a separately
verified reopen is required. Unsafe files are not repaired and uncertain claims
are never reset by this check.
This is not a defense against an OS administrator or arbitrary same-user writes
to the native databases. Windows journal ACL handling is not qualified, so the
Windows capability is explicitly absent and provisioning fails closed rather
than relying on POSIX mode bits as Windows security. Direct ledger construction
also refuses Windows before creating a file, without an alternate unguarded
SQLite entry that bypasses the capability gate.

## Evidence And Remaining Gates

The local directory-only C helper exercises the changed native filesystem code,
but its tree/crypto symbols abort if used. It is not a production runtime asset.
Eighteen actual Core/RPC/SQLite provisioning cases, ten exclusive directory
cases, nineteen old-broker compatibility cases, fifty-eight old-asset skill
regressions, sixty-eight combined TypeScript SDK/Project-ownership/protocol cases
(including eight SDK cases), and three Python SDK cases pass with no
failures/skips. Cases include same-request races, account/receiver isolation,
unchanged retries, lost acknowledgements, controller disposal, metadata-only
recovery, directory/journal replacement, ordinary-path takeover refusal, removed
Project preservation and SQLite trigger protection. Whole-source typing and
protocol/SDK parity pass separately. Initial fixture/typing errors are not
counted as accepted execution.

All temporary helpers, synthetic databases, directories and processes are removed.
No model or daily service is started, no personal profile is edited, and no
dependencies or toolchains are installed. Concise evidence belongs to Phonon's
`mcp-native-project-provisioning-latest` acceptance directory. These counts
overlap prior directory/skill gates and are not added to their totals.

A separate 53-case Phonon local gate now connects actual native
`PhononConnection`/SQLite/directory-helper behavior to Auth/MCP/Agents/Registry.
It checks actual directory identity/content, canonical MCP/Web/iOS binding,
cross-account denial, original receipt recovery after reopen and retained
unknown filesystem effects without re-creation/adoption. The directory helper
still has abort-on-use tree/crypto stubs and test-only resolver injection; no
normal manifest is altered. This is not a production packaged daemon or model
acceptance. Its child, SQLite/workspace roots, helper, PostgreSQL database and
service fixtures are removed; see Phonon's `mcp-workspace-preparation.md`.

After the continuous journal-security checks, the local native preparation gate
has 26 passes (including eight added permission/link/sidecar cases), with zero
failures/skips on macOS. The 53-case real local native HTTP selection and existing
10 directory, 19 old-broker, 58 skill, 68 TypeScript SDK/ownership/protocol and
3 Python cases pass again. Source typing passes. The Windows-only direct-ledger
refusal case is registered only on Windows and is not certified by this Mac run.
Earlier error-classification and source-drift runs were rejected, not accepted
as final evidence. Concise current records are retained in Phonon's
`mcp-workspace-ledger-security-latest` acceptance directory.

Still required: approved local/CI pinned Zig 0.13.0 toolchain, matching production
helpers for all targets, Windows journal ACL support, installed integrated native
and source-bound business/Registry provisioning, safe recovery/release/cleanup decisions, current
integrated release gates, and real independent Mac/Ubuntu/Windows MCP/client/
model/HITL/multi-account acceptance. Existing helper manifests do not match the
new C source; normal packaging must reject them. Do not edit manifest hashes,
ship the directory-only test binary, compile on a deployment server, or infer
three-device readiness from this local prerequisite.
