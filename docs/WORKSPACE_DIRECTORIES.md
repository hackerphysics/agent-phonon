# Existing Workspace Directories

Status: implemented and locally tested on macOS. Not yet released. Windows
drive/UNC parsing has unit coverage, not live Windows filesystem acceptance.

## Discovery

Require `workspace_directory_picker_v1` in current `device.info.capabilities`.
Call the existing `device.fs.list` with `projectCandidates: true`,
`directoryInput` and an optional `limit` (wire maximum 1000; the phone controller
requests 100). This mode cannot be
combined with legacy root/absolute-path selectors. TypeScript exposes `fsList`;
Python exposes `fs_list` with the same wire options. Both SDKs refuse the new
mode when the current native capability is absent; they never fall back to an
older implementation which ignores its fields.

Input is interpreted on the device using its POSIX or Windows path rules, not
the phone's rules or a shell. Absolute paths and `~` are supported. A trailing
separator lists that directory; otherwise the last component is a prefix.
Results are sorted one-level directory suggestions, filtered before the result
limit, with `input`, `pathStyle`, optional `directoryMatch`, and entry
`directoryIdentity` / `selectable` fields. `truncated` means more candidates may
exist, not that the returned window is a complete directory listing. At most
1000 matching candidates are identity-checked, although the parent directory's
names are read before sorting. No file content or recursive tree is returned.

Local filesystem-browse policy, method/root allowlists and namespace boundaries
remain mandatory. Ancestors of allowed roots may be navigable but not selectable.
Foreign namespace paths, namespace storage containers and private employee
directories cannot become ordinary Project working directories. Reads are
serialized per connection; a newer input supersedes stale queued reads without
starting overlapping scans after an observation timeout.

## Registration

Capture the exact current selectable path and its `dir:<device>:<inode>`
identity. Call `project.create` with `name`, that absolute `path`, `git: false`,
`existingDirectoryIdentity` and the original `clientRequestId`. No remote or
employee field is allowed. TypeScript `project.create` and Python
`project_create` verify the native capability and returned identity.

This mode registers an existing directory only. It does not create directories,
initialize/clone Git, copy files, start an Agent or change a retained Session's
working directory. Identities are observations, not authority grants. The native
controller revalidates current policy, ownership and identity before registration.
Strict references use reserved `dir-` IDs and persist the identity in SQLite.
Later reads and execution resolve that pinned identity; replaced/missing roots
are not silently adopted. Existing legacy references and directory bytes remain
unchanged. Same-process concurrent/repeated registration reuses one strict
reference; the unique namespace/path index also prevents cross-process duplicate
records, but a concurrent loser can receive a constraint error and must reconcile
with the original request rather than create another directory.

The Phonon business controller separately verifies current account/Project
editing authority, Project revision and native connection before registration
and Registry binding. The local path/identity observation does not grant those
permissions. An uncertain transport outcome is reconciled under the original
operation identity, not converted into confirmed success or absence of effects.

## Evidence

Four Core/schema tests, two TypeScript SDK tests and two Python directory tests
pass locally. Coverage includes POSIX/drive/UNC syntax, strict no-Git fields,
prefix filtering, foreign/private paths, original file preservation, concurrent
reuse, persistence, root replacement and old-controller refusal. The controlled
Phonon HTTP/PostgreSQL/current-source-daemon case exercises selection,
registration, original CWD execution, exact retry and authority withdrawal.
These are not production-account or paid-model acceptance.
