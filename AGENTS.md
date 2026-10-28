# AGENTS.md — agent-phonon hard constraints

These instructions apply to every coding agent working in this repository.

## Timely commits and pushes

Commit and push each complete, independently verified task change promptly,
without waiting for another reminder, unless the user explicitly asks otherwise.
Keep commits scoped to the current task; never include unrelated work from the
shared worktree. Run required checks and hooks, preserve other tasks' changes,
and never bypass a failing gate or force-push to meet this preference. If checks,
permissions or remote conflicts block a commit or push, report the exact blocker
and distinguish implemented, committed and pushed status in the handoff.

## Before every commit

Install hooks once per clone, then run the project consistency gate:

```bash
pnpm run install-hooks
pnpm run consistency
pnpm -r build
pnpm -r test
```

If any command fails, do not commit. Fix the root cause.

## Before every release tag

Run the same gate again immediately before tagging:

```bash
pnpm run consistency
pnpm run release:guard -- <tag>
pnpm -r build
pnpm -r test
```

Then follow `docs/COMMIT_RELEASE_CHECKLIST.md`.

## Non-negotiable consistency rules

- `packages/protocol/src/schemas/methods.ts` is the source of truth.
- The local daemon/core implementation must handle every protocol server→phonon method.
- TypeScript Server SDK and Python Server SDK must expose equivalent public functionality.
- If protocol changes, update daemon/core, TypeScript SDK, Python SDK, tests, and docs in the same commit unless the asymmetry is explicitly documented.
- npm releases publish `agent-phonon`, `@agent-phonon/protocol`, and `@agent-phonon/server-sdk` together; `vX.Y.Z` tags must match all three npm package versions.
- PyPI package name is `agent-phonon-sdk`; Python import path remains `agent_phonon`; `py-vX.Y.Z` tags must match both `pyproject.toml` and `agent_phonon.__version__`.
- Do not publish raw npm workspace packages; publish `pnpm pack` tarballs so `workspace:*` dependencies are rewritten.

Treat this file as a hard project policy, not a suggestion.

## Native Agent Runtime Scope

The accepted 2026-10-24 user decision removes Herdr support and compatibility.
Do not reintroduce its adapter, nested bindings, discovery, config aliases,
plugin installers or fallback/session-migration paths. Maintain the native
Claude Code, Codex, Copilot, Pi, Hermes, OpenCode and OpenClaw integrations.
Research is not a compatibility commitment. See
`docs/decisions/2026-10-24-native-agents-only.md` and
`docs/research/herdr-agent-interaction.md`.

## Message Delivery

Reasoning settings are best-effort preferences. Missing/unsupported setting
metadata or missing confirmation must not reject the original input or replace
an actual native completion with failure. Do not replay a task to obtain setting
proof. Confirm only actual native values; keep execution outcome, delivery and
setting application separate. Owner/session/turn identity, permissions, required
approvals and cancellation are not optional and must still be revalidated before
effects after optional asynchronous work.
