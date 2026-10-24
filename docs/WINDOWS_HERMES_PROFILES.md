# Windows Hermes Employee Profiles

Status: implemented in the maintained source and verified in isolated Windows
x64 profile/controller and real-provider HITL/recovery workers. It is not
activated in global device installations and does not certify a phone-to-Windows
production connection.

## Runtime Assets And Authority

Windows profile files use the existing rooted native file broker. A daemon may
use its bundled `native-fs/` directory or the device-local absolute setting
`employeeProfileFileBrokerRoot`. An embedded Hermes adapter may supply
`profileFileBrokerRoot`. Neither setting is accepted from employee RPC input.
The selected target executable passes the existing manifest/type/size/SHA-256
check and a protocol/platform probe before use. Missing or invalid assets do not
advertise profile installation and fail before native profile creation.

Assets are prepared off-device for the actual OS/architecture. The Windows
acceptance uses only the 78,848-byte x64 executable, its manifest and required
notices; it does not copy Mac dependencies or install a compiler/package manager.
The existing broker protocol/C implementation is not changed by this feature.
Generic FileManager, skill publication and their separate unfinished work are not
claimed complete by profile acceptance. See `NATIVE_FS_BROKER.md` for that boundary.

Root identities are observations, not grants. Normal controller application still
requires local employee-profile consent, the allowed Agent/model and namespace
policy. Its private workspace comes from the configured root plus tenant and
employee identity, never a caller-selected path. The controller stores the
workspace/root identities before continuing. Existing logical ownership also
requires the stored nonce marker and matching namespace-owned private Project;
a fresh root query alone cannot authorize an unrelated historical directory.

## Native File Operations

The installed Hermes launcher's exact interpreter and native profile-path,
configuration and provider APIs remain authoritative. No default persona,
memories, sessions, channels or rotating authentication store is cloned. Native
declared inference environment keys may be copied inside the device only, as on
the POSIX path. Learned `memories/USER.md` remains separate from desired USER.md.

The Windows Python backend uses the fixed pinned broker for no-follow directory
creation, regular/singly-linked reads, private temporary-file writes and new
directory publication. Each directory observation is bound to its actual volume/
file ID. Guidance/configuration updates write and flush a private temporary file,
then use handle-relative native rename after checking the held directory and
temporary-file identities. It does not use a path-based overwrite fallback.

Before a new managed profile receives native tools, a read-only Win32 security
query checks the same file identity. Ownership must match the current token's
user/effective owner; ACLs must not permit foreign writes. SYSTEM and the trusted
OS administrator principal are not treated as an unprivileged foreign writer.
Unknown ACEs/null ACLs, reparse points, hardlinks, changed ownership/identity and
explicit Hermes tool/safe-mode denials fail closed. No personal ACL is repaired.
Positive fixtures must therefore create genuinely private directories, not rely
on Node's POSIX mode parameter to initialize Windows ACLs.

Ready still requires native document hashes. Private native-directory identity
is retained in the controller observation and checked on replay/status. A missing
previously installed profile is not recreated with empty memory. A replacement
with copied markers/guidance cannot borrow a distinct original directory ID.
These filesystem observations do not constitute admin-proof isolation or an
exhaustive same-user race/power-loss guarantee.

## Bounded Python Invocation

Windows sends the fixed bridge, native argv and profile input through a bounded
stdin envelope to the exact native interpreter. The outer command line stays
small. The script limit is 256 KiB, argv count 64 and complete frame 2 MiB.
The frame's script is compiled product code, not remote message text. CLI args,
Unicode/quoted prompts and JSON input retain their original values; no shell
interpolation or temporary Python source file is introduced. POSIX invocation
keeps its previous native shape. Both profile operations and session execution
use the same framing helper.

## Evidence And Remaining Work

The final prepared Windows gate has 16 passing native/profile/controller cases,
including two isolated profiles, scoped tools, memory-preserving revisions,
local-edit/hardlink/junction/foreign-write refusal, missing/copied native homes,
normal controller apply/status/resolve, tenant isolation, persistent workspace
replacement refusal and long stdin frames. Personal configuration fingerprints
and owned cleanup are independently checked. The model inventory in the manager
case is deterministic; native profile APIs/file IO use the installed Hermes.
That profile-only gate has zero real model calls, global service changes or
production writes.

The Mac lane uses installed Hermes/Python plus 0.16/0.21 compatibility fixtures:
127 pass, three opt-in native-tool cases skipped. This is not new Linux or
Windows provider/HITL/recovery evidence. Public method/SDK parity remains at
110 methods. See Phonon Work's Windows profile acceptance report for receipts.

A separate real-provider Windows gate now passes three actual native-chat
workflow turns bound to one DE profile and Session. It verifies native tool
requests, an explicitly rejected decision and durable applied receipt, exact
history-based follow-up replies, idle-daemon restart/recovery without inference,
post-restart continuation, and missing/replaced-store refusal. The synthetic
decision controller is an authenticated loopback SDK, not an iPhone. Windows
recovery requires the prepared native assets; matching no-delete-shared handles
pin the broker-observed volume/file IDs around installed read-only SessionDB
metadata APIs. See Phonon Work's
`mobile/WINDOWS_HERMES_INFERENCE_TEST_RUN_2026-10-22.md` for the scoped evidence.

Still required: forced active profile-process interruption, updated Ubuntu
acceptance, global target-matched runtime activation, account-bound Windows
connection, actual mobile production flow, and Windows OpenClaw Gateway/native-
tool owner handling. Neither isolated gate certifies those remaining items.
