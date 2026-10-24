# Native Agent Runtime Scope

Date: 2026-10-24 (Asia/Shanghai)
Status: accepted, explicit user decision. Supersedes earlier Herdr support.

## Decision

agent-phonon does not support or provide compatibility with Herdr. It is not an
optional integration, fallback, hidden backend or future qualification target.
Do not reintroduce it without a new explicit product decision.

Use the maintained native adapters: Claude Code, Codex, GitHub Copilot CLI, Pi,
Hermes, OpenCode and OpenClaw. The built-in rescue agent remains separate.
OpenClaw's existing gateway integration is unchanged by this decision.

Herdr's workspace, terminal, process and Agent lifecycle management substantially
overlap our device daemon. A second control layer adds compatibility and
ownership checks without advancing our primary remote-operation, cross-device
continuity and project-collaboration experience. Concentrate maintenance on the
native paths and their actual capabilities.

## Removal Boundary

- Remove discovery, diagnostics, adapter registration, public exports, config
  fields and CLI examples for Herdr.
- Remove all six nested bindings and their dedicated tests: Pi, Codex, Hermes,
  Claude Code, OpenCode and Copilot.
- Remove the Hermes/OpenCode owner-plugin installers that existed only for
  those nested bindings; retain the independent native integrations.
- Remove active support claims, qualification backlog and installation guides.
- Reject removed or unknown adapter types before discovery/launch; do not ignore
  them silently, map composite IDs to native IDs or adopt old sessions.
- Do not add protocol aliases or migration helpers for Herdr.

An owner with old adapter config must explicitly remove it and select a supported
native adapter. This source change never rewrites that config or creates a
replacement session. Existing conversation history, opaque historical IDs,
databases, secrets, personal plugins and user-installed Herdr are not deleted,
reset or uninstalled. Historical data is not executable compatibility support.

Immutable historical release/test archives and their provenance/checksums remain
historical evidence, not supported distributions or current acceptance. Do not
edit signed/frozen bytes or fabricate new provenance just to remove a name.
Prepare a fresh native-only artifact before a separately authorized rollout.
This change does not deploy or restart any installed service.

## Learning Without Compatibility

The separate [interaction study](../research/herdr-agent-interaction.md) records
source-pinned mechanisms worth learning from. It is not a support contract,
installation guide or authorization to copy a terminal-wrapper architecture.
Keep native structured APIs and original session/turn identity authoritative.

## Verification Contract

Regression tests reject removed config without modifying it, reject direct
registry/discovery attempts, check that Core exports no Herdr adapter, and scan
production Core/daemon sources for reintroduced dependencies. Phonon Work's
managed MCP list and mutations admit only maintained native kinds, including
when obsolete harness/binding rows still exist. Ordinary native regressions
remain required; research does not qualify untested providers or OS versions.

## Local Verification

On 2026-10-24 the focused source lane passed 161 tests with no failures; 52
explicit opt-in installed-CLI cases were skipped. The compiled daemon
config/Pi-registration/managed-MCP lane passed 44 tests with no skips. Phonon
Work's new native-only managed-MCP lane passed six tests. These overlap in
coverage and are not a claim of full release or cross-device acceptance.

Both repositories' complete source/test no-emit typechecks passed. Protocol/Core
compilation, the daemon JS/declaration bundle, protocol/SDK consistency and
rescue-knowledge integrity checks passed. Five isolated built-CLI checks cover
help, adapter rejection, both removed installer commands and unchanged legacy
config on rejection. Current production source and built runtime scans contain
no Herdr dependency. Only negative tests, this decision/research and explicit
unsupported notices retain references outside immutable historical evidence.

Reused stable build directories and existing dependencies. Removed 132 obsolete
generated files (about 1.22 MiB) belonging to deleted modules/tests. Owned test
fixtures/processes were cleaned; no simulator, service rollout or dependency
installation was needed. Standard pnpm invocation was unavailable because its
dependency-check wrapper attempted a reinstall and aborted; direct existing
compiler/test binaries were used instead. Full installed-CLI/provider,
database-backed managed-MCP and release-wide test lanes were not run.
