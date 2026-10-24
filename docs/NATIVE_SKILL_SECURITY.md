# Native Skill Namespace And Retry Identity

## Source Contract

Remote `PhononConnection` skill management derives its namespace from the
authenticated connection, never a request field. Metadata reads use current
SQLite state, current Project namespace and current runtime allowlist rather
than a connection-time copy of every tenant's skills. Explicit foreign/missing
Project selectors fail alike. Local operator Store/Manager inspection remains
separate from this always-namespaced remote path.

An additive nullable `skills.tenant_id` column and partial scoped-identity index
preserve old rows. Legacy Project records can be visible only through an actual
current Project namespace. Unknown legacy global ownership is not guessed or
backfilled. NULL Project IDs no longer duplicate new scoped global records.
Global directory discovery filters to recorded owned names and exact paths;
moving a runtime directory cannot lend an old name to another location.

Both global installation and removal require the existing explicit local
`allowGlobalSkillInstall` permission. Skill mutations, queries and original
retry receipts also apply `allowedAgents`. URL/local-path source policy and
Project ownership are checked before receipt lookup, so a cached success is not
an authorization bypass. Existing unowned global targets are not adopted.
Global runtime files are host-level shared resources under an explicit local
opt-in; they are not a project-scoped MCP business operation or a promise of
fully isolated concurrent global filesystem publishing.

## Retry Identity

`skill.install` and `skill.uninstall` now formally accept optional
`clientRequestId`. Parsed payload fingerprints reject changed targets/content
under a confirmed key, including after reconnect. Unverifiable legacy receipts
remain stored but cannot be replayed as a verified new installation.

The TypeScript helper accepts this option on both mutations. Python uses
`client_request_id=` and omits absent `projectId`/request IDs instead of emitting
protocol-invalid nulls. No public tenant-selector field or new RPC method was
added. Device information advertises `skill_namespace_identity_v1` for these
namespace/confirmed-retry semantics.

This capability is **not** an atomic-install, durable exactly-once or secure
filesystem-broker attestation. A failed/lost reply may have filesystem effects;
absence of a confirmed receipt is not permission to repeat an uncertain write.

## Filesystem Boundaries

Project skill destinations are canonicalized beneath the registered Project.
The Project itself must also pass the physical namespace ownership contract in
`NATIVE_PROJECT_OWNERSHIP.md`; separate IDs cannot authorize shared directories.
Existing symlink/junction ancestors are refused for installation/removal. Inline
destinations are validated before any inline file is written. Existing hard-link
leaves and special targets are refused; ordinary-file handles are checked before
truncation, with no-follow/nonblocking flags where supported. Copied sources must
be ordinary files/directories, not symlinks or hard-linked files.

These changes block the reproduced static parent-link and leaf-hardlink escapes.
Archive input now also passes the bounded in-memory parser and destination plan
in `NATIVE_SKILL_ARCHIVES.md`; no unverified archive is extracted onto disk.
Neither check certifies race-free directory ancestry or atomic publication.
Fully anchored publishing across all supported OSes, target-matched adversarial
acceptance and partial-result recovery remain required gates before a new MCP
installer is exposed. Do not weaken checks or substitute an unsupported
platform's preflight checks for a verified broker.

The rooted C helper/private driver prototype in `NATIVE_FS_BROKER.md` now has
off-server builds for all three device targets and local handle/identity/race
coverage. Its startup probes are not target filesystem acceptance or a complete
installer. It is not integrated or exposed through MCP. Persistent namespace/
root-ID binding, whole-tree publication/unknown state and actual skill loading
remain part of the original unfinished work.

## Evidence And Scope

Local tests first reproduced cross-tenant metadata disclosure, unrestricted
global removal, runtime-allowlist bypass and static link/hardlink writes. The
actual Core RPC/source suites subsequently pass 136 cases, including 11 new skill
security cases, Protocol/TypeScript SDK contracts and existing isolation/HITL/
policy/Project/skill regressions. Python SDK/helper regressions pass 24 cases.
All preparation/builds/suites run locally; no remote activation or installed
personal configuration is changed. This is not native-model/three-device release
acceptance and does not complete the unfinished MCP installer/execution work.
