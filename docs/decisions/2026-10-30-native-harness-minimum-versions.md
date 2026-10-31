# Native Harness Minimum Versions

Accepted user direction, October 30, 2026: support a minimum release, not a
single exact release. Ordinary native upgrades must not disable current-turn
input merely because the release string differs from a tested build.

## Contract

- Use a minimum supported native version and required API/capability checks.
- Later stable patch, minor and major versions remain eligible without a source
  edit. Stable floors exclude previews; the Codex alpha floor admits subsequent
  prereleases using numeric SemVer precedence.
- Do not reintroduce exact native release allowlists in discovery, invocation
  plugins, SDK qualification, history validation or receipt parsing.
- Version eligibility does not authorize an effect. Original tenant, source,
  project, session, turn, native permissions, cancellation, provider headroom
  and source-confirmed application remain mandatory.
- A missing or incompatible native API must be reported honestly. Never claim
  insertion from queue acceptance alone, retain input for a later task, restart
  execution to obtain a receipt or fabricate successful delivery/completion.
- If a new required native API raises the real minimum, document the reason
  and test the old/new boundary. Do not select an older CLI just to pass tests.

## Verified Floors

| Harness | Minimum |
| --- | --- |
| Claude Code | Node CLI >=2.0.1 with its bundled SDK, or native/modern CLI >=2.1.123 with owner-selected Agent SDK >=0.2.123; required hook APIs remain mandatory |
| Codex | 0.165.0-alpha.1.2 with native app-server steering |
| Copilot | 1.0.82 with the required native extension interface |
| Pi | 0.84.1 with the verified RPC lifecycle |
| Hermes | 0.21.1 with request/execution middleware |
| OpenCode | CLI and plugin SDK >=1.14.20 with supported provider transport |
| OpenClaw | Gateway >=2026.10.7 with the native plugin/policy interfaces |

This does not make the unsupported OpenClaw one-shot CLI an input-capable
runtime and does not restore any retired integration.

The external Claude SDK floor is separate from the legacy bundled interface:
native binary installations have no sibling `sdk.mjs`. The selected public SDK
must expose query/MCP APIs; its original query provides context usage through
`getContextUsage` and starts the selected executable through the public spawn
hook. Missing current usage defers optional insertion without failing or
replaying the original input. Later releases remain eligible, not exact pins.

## Distinct Identities

Native protocol/receipt format versions such as `version: 1` remain exact
contracts. Native source commits, artifact checksums, selected SDK/runtime
identity matching and test dependency metadata may also be exact: those pin
authority or reproducible evidence, not a production release allowlist.

The shared comparison is `nativeVersionAtLeast`. Regression tests cover later
patch/minor/major releases, malformed/older versions, prerelease precedence,
missing APIs and native identity/receipt failures. See `docs/MID_TURN_INPUT.md`
and Phonon Work's `agents/NATIVE_MID_TURN_MCP_TEST_RUN_2026-10-30.md` for the
separate seven-harness real-MCP acceptance evidence. These are local source and
test results, not release or deployment authorization.
