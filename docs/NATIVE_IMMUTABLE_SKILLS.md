# Native Immutable Skill Versions

## Separate, Non-Downgrading Methods

`skill.publish` is a new Project-only native method, not an optional legacy
`skill.install` flag. An old receiver cannot strip that flag and silently perform
an in-place overwrite. Both SDKs expose `skill.publish` / `skill_publish` and
`skill.unpublish` / `skill_unpublish`. The Protocol registry contains 114 methods.

Publication requires the exact namespace/Agent/Project/name, a bounded original
`clientRequestId`, inline or prepared archive source, and explicit `baseRevision`.
Use null only when no selection exists; otherwise use the opaque `revision`
returned by the current `skill.list` or original publication receipt. That digest
is a comparison value, never an authorization grant. Source paths, URLs, global
scope, root identities, permissions and owner overrides are not accepted.

The receiver requires persistent SQLite and already-prepared tree runtime assets.
`immutable_skill_publication_v1` identifies implementation availability, not
current caller permission, target filesystem acceptance or release approval.

With `skill_install_receiver_identity_v1`, publication may additionally require
the exact observed `device.info.skillReceiverID` using `expectedReceiverID`.
That persistent account-namespace identity is checked before cached results as
well as mutation/commit. Opted-in `skill.install.status` returns receiver proof
only for an originally tagged receipt; old rows are never retagged. See
`NATIVE_SKILL_INSTALL_RECEIPTS.md`. This does not replace current source consent
or Project/policy checks and does not authorize a new write after uncertainty.

## Filesystem Publication

A new version is created under
`<Project>/.agent/skill-versions/<name>/<publication UUID>`, never merged into the
human/legacy `<Project>/.agent/skills/<name>` directory. The latter remains intact.
Each publication UUID is separate from the persistent namespace receiver ID.
An explicit local-policy metadata fence can prevent an uncertain publication's
late activation while preserving the selected version and unselected tree. It
does not release the target or delete either tree; see `NATIVE_SKILL_FENCES.md`.
The existing nonce/target ledger claims dispatch before any target mutation.

The private native broker preserves PFS2 base operations and adds the explicit
`publish_tree_v1` / `verify_tree_v1` probe extensions. A publication is one bounded
process: validate the complete framed plan, create an exclusive private staging
tree, write/sync files, compare SHA-256 for every file, check exact directory
membership and retained identities, then rename to a new name without replacement.
Existing destinations win a race unchanged. Failed stages remain unselected.
No arbitrary archive extraction utility, shell command or network access is used.

Limits are 4096 entries, 64 levels, 16 MiB per file and 64 MiB aggregate data.
The helper retains bounded handles and adjusts only its own soft descriptor limit
when necessary. SHA-256 and UTF-8 validation use the pinned Zig 0.13.0 standard
library through a small C ABI bridge, not a new hand-written hash implementation.
Prepared runtime manifests pin the C/include/bridge and target executable hashes;
compiler caches and test barriers stay outside runtime output. Required notices
are retained. Prepare all OS/architecture artifacts locally or in CI.

New POSIX versions use read-only owner files/directories, retaining an executable
bit only when declared by the prepared archive. Windows uses private new-entry
ACLs, retained no-delete-sharing handles and read-only files. No existing human
entry has its permissions changed. OS owners can still override their own files;
this is managed immutable publication and point-in-time integrity, not an OS
sandbox or a claim that a trusted host owner cannot edit anything.

## Authorization, Selection And History

The root pin is created only inside an already authorized namespace/Project
publication, after current local policy and retained physical-path ownership
checks. An observed inode is not an independent grant. The private binding
persists Project/path/root identity, refuses another namespace's known identity,
and rejects replacement on later use. No unknown namespace/global owner is
adopted, no caller supplies a root grant, and removal does not transfer it.

The final SQLite transaction compares the original selection revision again,
archives previous selection metadata, stores the version/manifest and changes the
current selection together with the original operation receipt. Stale requests
cannot override a concurrent metadata edit. A lost reply or post-publication
conflict leaves a complete or partial unselected artifact, never fabricated
activation. The existing unknown-result guard prevents write replay.

Queued immutable turns retain their admitted version, even after activation of a
newer version. Loading resolves the owned, non-revoked history record, verifies
the exact private version identity and every file/directory with the native
broker, and reads the actual entry. Unlisted content, edited helpers, links,
hardlinks, root replacement and changed hashes fail before adapter delivery.
Across one turn, tree verification is bounded to 128 MiB and 8192 entries.

`skill.unpublish` uses an exact non-null base revision and original request ID.
It atomically archives/deactivates metadata, revokes historical queued versions
and records its idempotent result. It does not remove files. An old deactivation
receipt cannot deactivate a subsequently installed version, even after cache
loss because its stale base is rejected. Legacy removal cannot bypass this
revocation step while any immutable version remains live.

`skill.dirs` retains legacy/human directories and includes the selected immutable
directory. `active` distinguishes selection metadata from a preserved legacy
path. `exists` is a directory observation, not a whole-tree execution certificate.
Only the execution verifier establishes the bounded integrity observation.

## Operational And Acceptance Boundaries

Whole-tree verification has real CPU, I/O, memory and handle costs. The design is
serialized and bounded, but a large archive may need thousands of handles and
read tens of MiB. Explain measured deployment/runtime overhead before activating
this on a shared server. Do not run compilers, dependency installs or suites there.
Retained versions/stages are persistent business data, not disposable release
archives; safe reference-aware cleanup/resolution remains unfinished.

Local acceptance includes actual binary/empty/executable content, no-replace and
controlled competing-entry races, source/namespace/root isolation, comparison
conflicts, queued old versions, deactivation, edited auxiliary content and lost
acknowledgement. The existing real Canvas archive is published and every file
read back byte-for-byte, then verified through actual Core selection with a
controlled adapter. Packaged daemon/SDK/WebSocket acceptance covers both modes.

None of this proves installed native-client/model behavior or Windows/Linux
filesystem/race acceptance merely from cross-compilation. A separate durable
server operation bound to original MCP client/lease/Auth family/epoch, current
Canvas association and exact bundle is still required. The default MCP installer
remains unexposed; account security, credentials, permissions and human decisions
remain excluded. The complete original Mac/Ubuntu/Windows goal is not complete.
