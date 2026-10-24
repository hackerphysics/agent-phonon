# Rooted Native File Broker Prototype

## Status And Boundary

The new C helper and private TypeScript driver are prerequisites for the
unfinished skill publisher and Windows file handling. They are **not** mounted
as Phonon RPC/MCP methods or a default FileManager replacement, installed as a
daemon service or advertised as completed device capabilities. Prepared packaged
assets are now used by SkillManager to confirm and load selected entry bytes as
described in `NATIVE_SKILL_EXECUTION.md`. Existing native skill installation still
has its documented merge behavior, not a completed atomic publisher.

The separate new `skill.publish` path now uses optional PFS2 tree extensions and
manifest schema 2, described in `NATIVE_IMMUTABLE_SKILLS.md`. It does not replace
legacy installation or attest all target filesystems from probe availability.

The helper runs with its caller's ordinary OS identity. It has no network,
credential, account, permission-administration or HITL interface. It cannot grant
Phonon authority. A future caller must validate the actual account, Project,
device, source authorization and consent before selecting a root. Root IDs are
filesystem observations, not grants; querying a fresh root must never be used to
self-authorize an unrelated path or adopt unknown historical ownership.

## Private Protocol And Operations

The bounded `PFS2` stdin protocol is length-framed, with finite operations and no
shell strings or caller-selected executable. The driver selects a target-specific
binary from a trusted artifact root, verifies its manifest, type/size and SHA-256,
uses bounded stdout/stderr and a deadline, and rejects malformed or uncertain
receipts. A mutating transport failure is not reported as confirmed no-effects.

- `probe` reports only protocol/platform/compiled operation availability. It
  accepts no filesystem path and is not a filesystem-security attestation.
- `root` observes an existing directory identity without granting access.
- Every content operation requires an explicit expected root identity. The
  helper compares it immediately after opening the root, before creating any
  relative parents. A directory replaced before invocation cannot borrow an
  earlier approved identity.
- `read`, `write`, `mkdir` and `stat` use rooted handles. Reads are binary-safe
  and bounded; writes are exclusive unless overwrite is explicitly requested.
  An existing file is checked as regular and singly linked before truncation.
- `publish_new` moves a prepared directory to a new basename in the same parent
  with no replacement. Even an existing empty destination is retained. This
  is an atomic directory-name operation, not an atomic skill update transaction.

Root/path fields are bounded to 4096/2048 bytes, depth to 256 held handles and
per-file content to 16 MiB. Dot/empty/traversal components, backslashes, drive/ADS
syntax in relative components, portable device names and trailing dots/spaces
are refused. Malformed/trailing input is checked before filesystem mutation.
Stat may observe a leaf link itself; content operations never follow it.

## OS Implementations

| Target | Implementation | Current Evidence |
| --- | --- | --- |
| macOS arm64 | Root-to-leaf `openat`/no-follow handles; retained ancestor checks; leaf-only link stat; `renameatx_np(RENAME_EXCL)` | 18 local broker cases, including controlled swaps and no-overwrite publication, pass. |
| Linux x86_64 | Same descriptor traversal and identity checks; `renameat2(RENAME_NOREPLACE)`; statically linked musl runtime | Cross-compilation, format/hash inspection and an actual Ubuntu protocol-2 startup probe pass. Filesystem operations on Ubuntu are not yet accepted. |
| Windows x64 | Component-relative `NtCreateFile`, reparse rejection, no delete-sharing on retained handles, actual file IDs/link checks, private owner/SYSTEM ACLs only for newly created entries, no-replace native rename | Cross-compilation, PE/import runtime startup and an actual Windows protocol-2 probe pass. Windows filesystem/ACL/race behavior is not yet accepted. |

Windows currently supports canonical local drive roots, not UNC/device namespace
paths. Unsupported filesystems and OS operations fail closed. No broad capability
claim may be inferred from compilation or the path-free startup probe.

## Off-Server Build

Use a local macOS arm64 host with Xcode clang and the pinned Zig 0.13.0 compiler:

```sh
node scripts/build-native-fs-broker.mjs /tmp/new-native-fs-broker --zig /absolute/path/to/zig
```

Targets compile serially. Compiler caches and the separately compiled test-barrier
binary stay outside the runtime artifact root. The runtime artifact contains only
three small target-specific executables, manifest and required licenses/notices.
It contains no compiler, source, tests, test hooks, dependency-install tooling or
build cache. Deployment preparation must select the actual target OS/architecture
and retain its notices; never run this builder or suites on a deployment server.

The builder reserves `<output>.build` as a fixed private workspace with an owner
and child-process manifest; an existing output/workspace is refused, never
overwritten or deleted. Both Zig global and local caches stay inside it and are
removed after success/failure. Compiler processes have deadlines. SIGINT/SIGTERM
stop and drain only owned compiler groups before verified cleanup; failed builds
remove their incomplete output without replacing the original failure. A crash
or SIGKILL may leave the manifest for an explicit ownership/inactivity audit.

No verification executable is produced by default. A local test runner that
needs the barrier helper must explicitly request a new path outside both roots:

```sh
node scripts/build-native-fs-broker.mjs /absolute/local/native-fs \
  --zig /absolute/path/to/zig \
  --verification-output /absolute/local/tests/phonon-fs-broker-test
```

That explicit test file is caller-owned retained evidence, not a runtime asset;
the caller must remove it after tests. The builder requires 1 GiB free local
space before allocating outputs, but cross-target compilation may require more.
`node --test --test-concurrency=1 scripts/native-fs-build.test.mjs` checks only
resource lifecycle using synthetic compiler output and an actual owned signal
test process. It neither downloads Zig nor qualifies production target binaries.

The observed final protocol-2 source SHA-256 is
`77984c138f853ab3d2743b1c5ec2b8d399f7e0de98bd07216c0b059cbe045350`.
Runtime sizes/hashes:

| Target | Bytes | SHA-256 |
| --- | --- | --- |
| macOS arm64 | 35360 | `599b21727f5ab5c86cbec04eb0b938cbd136c0fdfbeeeb80f0862e580c3469a1` |
| Linux x86_64 | 38024 | `141b66ac82559bbb79b6beaa8aa9c4fb709e1e971c81f83ecf1f435bd654ec77` |
| Windows x64 | 78848 | `765870fc29e9356229d86209ba3fa6bdcaa86c844c998e33d40dd836f750da4f` |

## Evidence And Remaining Integration

The full focused source regression passes **182** cases with all prepared broker
artifacts present and no skips; **18** exercise the broker/codec/build outputs.
Separate test-only barriers prove root/parent swaps after opening cannot redirect
reads or overwrite the replacement tree; a competing destination is preserved.
A previously captured root identity also rejects replacement before the helper
opens it; persistent namespace/root-ID integration remains unfinished.

The actual Mac, Ubuntu x86_64 and Windows AMD64 startup probes pass. Ubuntu and
Windows received only their small prepared executable and notices, checked hashes,
ran a path-free probe, and removed the owned staging files/directories. Remote
builds, dependency installs, suites, parallel Agent services and personal Agent
configuration changes did not occur.

Still required: target-matched filesystem/race acceptance; packaging into actual
native releases; namespace-bound persistent root IDs; full source-bound native/
server installation state with uncertain-result recovery; whole-tree staging and
durability; immutable-version selection and conditional active metadata updates;
human-edit/history preservation; and actual native-client/model acceptance.

The earlier structured `session.send.skills` observation returned SQLite binding
error `-32000`; that defect and name-only managed prompting are now fixed through
confirmed entry receipts, frozen selectors and actual task-context delivery.
See `NATIVE_SKILL_EXECUTION.md` for the local Core/WebSocket/SDK evidence and
remaining whole-tree/installed-client/model gates. Schema round-trips and startup
probes remain insufficient evidence of actual native-client skill execution.

The original complete MCP business/three-device goal remains active. This
component neither completes that goal nor narrows eligible installation updates
to create-only behavior; updates require the still-unfinished versioned
publication/selection transaction.

## Exclusive Directory Preparation

The private `mkdir_new` operation (PFS2 opcode 9) is an automatic-workspace
preparation prerequisite. Unlike legacy `mkdir`, it atomically refuses an
existing leaf, including an empty directory, link or file. It accepts only an
already-authorized root identity and an existing parent; parent creation and
overwrite are rejected. Ordinary directory creation still uses the existing
private POSIX modes / Windows owner-and-SYSTEM creation ACL. It grants no account,
Project, execution or cleanup authority and is not a public RPC/MCP method.

Legacy path-free probe packets and replies are unchanged. A private opt-in probe
argument of 1 reports `exclusive_mkdir_v1` in addition to the existing tree
extensions. The TypeScript driver checks this before `mkdir_new`; old helpers
reject the extended probe and cause `unsupported`, never a fallback to legacy
open-or-create. Lost/malformed mutation replies still mean uncertain effects,
not permission to retry or adopt the target. A future durable provisioner must
persist its root/target/operation identity before creating files and reconcile
uncertainty without claiming arbitrary existing directories.

Local macOS arm64 directory-only tests exercise the actual changed C traversal,
exclusive creation, competing creators, root/parent replacement, old-helper
refusal and unchanged legacy mkdir. Because the pinned Zig 0.13.0 toolchain is
currently absent, their Apple-clang test binary links abort-on-use tree-function
stubs. It is explicitly not a runtime artifact, cryptographic/tree acceptance or
a replacement compiler/toolchain. It and its test/race directories are removed
after validation. Existing prepared assets remain byte-for-byte untouched.

Current three-target packaging is **not ready**: C source fingerprints no longer
match prior helper manifests, and the normal package copier must keep rejecting
that mismatch. Do not edit a manifest to make old binaries appear current, use
the test binary as a release, download another large toolchain without approval,
or compile on a deployment server. Restore an approved local/CI pinned toolchain
and prepare all target-correct helpers before any runtime/release gate or device
activation. Linux/Windows filesystem and exclusive-mkdir behavior require their
own actual-device evidence. This does not complete automatic workspace
provisioning or the full MCP/three-device objective.
