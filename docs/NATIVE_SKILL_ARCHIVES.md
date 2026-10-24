# Bounded Native Skill Archives

## Receiver Contract

Native `skill.install` now prepares `tar.gz` input entirely in memory with the
exact pinned `tar` parser, version `7.5.22`. It does not list with one system
utility and extract with another, invoke an external unpacker or extract an
unverified archive into a temporary directory. Both Core and the distributed
Daemon declare the same production dependency. The six added dependency
archives have SHA-512 pins computed from locally obtained package archives;
a subsequent frozen local installation passed.

Before creating a skill target, the receiver checks canonical Base64, actual
compressed size, an optional exact size declaration and optional SHA-256. It
then decompresses under a hard output bound and builds a complete file plan.
PAX/GNU names are validated after the parser applies their metadata; raw names
are also checked before Windows separator normalization can hide a backslash.
Only ordinary files and directories are publishable. Links, special/ignored
entries, sparse metadata, parser warnings, incomplete blocks/files/end markers
and nonzero content after the archive end are refused.

Names must be relative and bounded. Traversal, empty/dot components, backslashes,
drive/alternate-stream syntax, control/invalid UTF-8 replacement characters,
Windows device names and trailing dots/spaces are refused. Duplicate, case/NFC
aliases and file/directory conflicts, including implicit parents, are refused.
File ownership, permissions, timestamps and other filesystem metadata from the
archive are never applied.

| Bound | Limit |
| --- | --- |
| Compressed input | 16 MiB |
| Expanded tar, including headers/padding | 64 MiB |
| Individual file | 16 MiB |
| Individual metadata entry | 64 KiB |
| Entries, including metadata | 4096 |
| Explicit/implicit filesystem paths | 4096 |
| Path bytes / nesting | 2048 / 64 components |
| Component bytes/characters | 255 / 255 |
| Concurrent preparation per process | 2 |

Capacity refusal is before publication and releases no new authorization.
These bounds are not a promise of negligible memory or CPU usage.

Current Project identity/runtime policy is checked again after asynchronous
preparation. Every planned existing destination is preflighted before any
archive file is written. A late static hardlink or invalid path cannot overwrite
an earlier existing instructions file and then return a misleading failure.
Installed metadata is recorded only after the writes finish.

## Compatibility

This intentionally rejects permissive or nonportable archives that were
previously accepted, rather than silently rewriting their names or ignoring
their size declarations. macOS AppleDouble entries such as `._.` are not portable
filenames; create portable archives without those metadata sidecars. The native
tar fixture sets `COPYFILE_DISABLE=1`, and the existing Canvas Python producer
already excludes sidecars and emits bounded regular-file PAX archives.

The wire method and SDK fields are unchanged. Size declarations, if supplied,
must now equal actual compressed bytes; SDK/source retry identity and namespace
checks still apply. No new MCP tool or generic archive/path proxy was added.

## Evidence And Remaining Work

Seventeen local tests include actual Core RPC preservation of existing files and
receipts, PAX/GNU/Unicode cases, links/specials, destination hardlinks, corruption,
compression/file/entry/path bounds, withdrawn Project identity and preparation
capacity. The combined focused source regression passes 164 cases without skips.

The actual Canvas 1.3.0 bundle, SHA-256
`0bc1916e4767f415b4512260aed8b9399a46d8cba1fc227cb8ffcee65f8348bf`,
was installed through real local Core RPC in two isolated namespaces. All 2817
files in each new target were read back byte-for-byte; foreign Project reads and
writes were refused. No model session or physical remote device was fabricated.

This is input preflight and static destination protection, **not** atomic or
race-free directory publication. Existing native install merge semantics remain:
unlisted files are not deleted or silently adopted as part of a verified new
tree. A filesystem failure during a valid publication can still have partial
effects, and absence of a confirmed receipt does not authorize automatic replay.
Fully anchored publication on every target OS, durable source-bound
prepared/dispatched/confirmed/unknown state, human-edit protection and real
native-client/model acceptance remain required before an MCP installer is
registered. See `NATIVE_SKILL_SECURITY.md` and the Phonon MCP operation matrix.

All builds, dependency preparation and suites ran locally. These are not release
artifacts or completed Mac/Ubuntu/Windows acceptance, and no deployment server
build, installation, suite or production activation occurred.
