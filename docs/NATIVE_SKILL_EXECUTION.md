# Confirmed Native Skill Execution

## Selection And Authority

`session.send.skills` and session schedule targets use the same bounded contract:
a name or `{name, scope?, version?, force?}`. Names use the existing safe native
skill-name alphabet, at most 128 characters; at most 16 selections are admitted.
Unknown path, owner, permission and identity fields are refused. `force` is
loading intent, never approval or an authority override. TypeScript and Python
session helpers preserve the structured fields exactly.

Selection derives from the current connection namespace, Session Project,
actual runtime policy and installed metadata, not caller-provided paths.
Unqualified names prefer that Project over the runtime's owned global skill.
Explicit scope/version is checked. An allowed second runtime can use an
unambiguous owned Project receipt; global records remain runtime-specific.
Ambiguous receipts fail instead of silently choosing another source.

Skills are task data. Frontmatter is parsed only for a bounded string version;
name, account, grants, model settings and human decisions are never taken from it.
Loaded content confers no credentials, permission administration, human identity,
HITL answers or review bypass. Existing service/actor checks still apply.

## Receiver Confirmation

Additive nullable native SQLite `skills.execution_json` stores a private receiver
receipt: random installation ID, expected filesystem root identity and SHA-256
of the exact supplied `SKILL.md`. After writes finish, the prepared broker reads
the entry under the captured root, refuses links/aliasing, and confirms actual
bytes before recording this receipt and observed version.

Old rows, unavailable native assets, missing canonical `SKILL.md` and unlisted
leftovers from merge-style installation cannot fabricate confirmation. Old
metadata/files remain preserved but are unavailable as confirmed managed
selections until a current receiver confirms a new installation. Private root/
installation IDs are not exposed through the public skill metadata DTO.

The legacy install merge path still works without packaged broker assets. That
does not promise verified selection or safe atomic installation. Explicit
managed selection has no unverified name-only execution fallback.

## Admission And Dispatch

Core freezes namespace, Project, target runtime, installation ID, scope/version,
source/entry hashes, path and root identity when input is admitted. Queued turns
retain that set. Even a same-byte reinstall has a new receiver ID and cannot
replace the source of an admitted turn. Removal, lost Project ownership and
root/content/receipt changes fail before a model turn starts.

Targets with active or unknown nonce-bearing installation are also refused at
admission/queued dispatch, even when entry bytes are unchanged but auxiliary
files were partially written. See `NATIVE_SKILL_INSTALL_RECEIPTS.md`; this is not
full auxiliary-tree integrity or concurrent immutable publication.

Actual loading follows all other asynchronous runtime preparation, including
reasoning discovery, Employee resolution and interaction-bridge startup. It
immediately precedes the final abort/current-turn fence and adapter send, so a
withdrawal during preparation cannot reuse an earlier successful read.
All scopes/receipts are rechecked, rooted reads are compared with the confirmed
entry hash, and selected roots/records are checked again. A bounded
JSON task-context block supplies the document, exact `SKILL.md` path, base
directory, scope/version and digests to every adapter. Adapters receive normalized
names, not object stringification. The original user input remains distinct in
the transcript; environment secrets are not copied into the context block.

Injection uses the same checks within the original active turn/window, without
creating a model invocation or changing identity. Turn closure during async
preparation cannot insert into a replacement turn.

Instructions are bounded to 128 KiB per entry and 256 KiB per set, with strict
UTF-8 and no silent truncation. Entry verification does not prove auxiliary-file
or merged-tree immutability. Whole-tree publication, durability and human-edit
preservation remain gates for the default MCP installer.

The separate schema-2 immutable path now implements native version publication,
whole-tree verification and retained queued versions; see
`NATIVE_IMMUTABLE_SKILLS.md`. The paragraph above describes legacy entry receipts,
not the new tree receipt. Original-source server authorization and physical
client/model/filesystem acceptance remain separate default-installer gates.

## Prepared Runtime Packaging

Prepare binaries locally/CI as in `NATIVE_FS_BROKER.md`. For an ordinary daemon
build, `PHONON_FS_BROKER_ARTIFACT_ROOT` selects already-prepared assets for the
post-build copy. No compiler or dependency install runs on a deployment server.

The standalone copier accepts a new runtime/native folder and optional target:

```sh
node packages/daemon/scripts/copy-native-fs-broker.mjs /prepared/native /new/runtime/native linux-x64
```

It validates maintained C source/toolchain, exact filenames, binary sizes/hashes
and notices before output. Target-only copies exclude other OS binaries.
Existing output, stale source and tampered bytes are refused. Runtime lookup is
package-local, never selected by a wire input.

The isolated MCP daemon builder disables default tsup config hooks and copies
assets only into its fresh temporary output; provenance records native hashes.
An earlier test build triggered the default post-build hook. Its six matching
owned native files were checked and removed without touching other distribution
contents; subsequent isolated builds leave the main distribution unchanged.

## Evidence And Remaining Work

Fifteen actual local Core Session cases cover structured selection, receipt
reopen, cross-account/runtime scope, versions, insertion, queued replacement/
removal, same-byte receiver changes, edited/hardlinked content, replaced roots
withdrawal during asynchronous runtime preparation and uncertain auxiliary writes.
The extended source suite passes 347 cases without skips. SDK forwarding has
regressions in both languages; the selected Python SDK suite passes 24 cases.

A prepared maintained-source daemon with copied native assets also passes actual
local WebSocket/SDK/Daemon selection and content delivery using default packaged
lookup. Its adapter is controlled, not an installed native client/model. The
separate actual-service regression is recorded in Phonon's
`docs/mcp-business-operations.md`, including actor/revocation/HITL guards.
No hardware/model acceptance is inferred from these fixtures.

The original full goal still requires durable source-bound installation and
unknown-result handling, immutable active-version updates, all-OS filesystem/
ACL/race acceptance, installed client/model/HITL/account acceptance on all three
devices and remaining provider/business parity. The default MCP installer remains
unexposed; no production activation or personal Agent configuration change occurred.

## Exact Pins And Workflow Nodes

Structured selectors now additionally accept `revision` and `installationId` to
reject a same-name/version replacement. Workflow nodes pass their explicit
selectors through the existing SessionEngine in DAG, graph and discussion modes;
workflow schedules retain the same fields. New TypeScript/Python SDK helpers
require the relevant advertised feature before sending these new shapes, without
silently stripping or rebinding them. Names, scope, version and force keep their
existing semantics. Pins are data, not permissions, and an admitted native queue
retains its existing frozen version subject to current source/content checks.
Full contract, critical dispatch-fence ordering and local evidence are in
`WORKFLOW_SKILLS.md`. Canonical Canvas dispatch and actual target/model acceptance
are still separate work, not established by these native engine tests.
