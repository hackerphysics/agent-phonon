# AGENTS.md — agent-phonon hard constraints

These instructions apply to every coding agent working in this repository.

## Before every commit

Run the project consistency gate first:

```bash
pnpm run consistency
pnpm -r build
pnpm -r test
```

If any command fails, do not commit. Fix the root cause.

## Before every release tag

Run the same gate again immediately before tagging:

```bash
pnpm run consistency
pnpm -r build
pnpm -r test
```

Then follow `docs/COMMIT_RELEASE_CHECKLIST.md`.

## Non-negotiable consistency rules

- `packages/protocol/src/schemas/methods.ts` is the source of truth.
- The local daemon/core implementation must handle every protocol server→phonon method.
- TypeScript Server SDK and Python Server SDK must expose equivalent public functionality.
- If protocol changes, update daemon/core, TypeScript SDK, Python SDK, tests, and docs in the same commit unless the asymmetry is explicitly documented.
- npm releases publish `agent-phonon`, `@agent-phonon/protocol`, and `@agent-phonon/server-sdk` together.
- PyPI package name is `agent-phonon-sdk`; Python import path remains `agent_phonon`.
- Do not publish raw npm workspace packages; publish `pnpm pack` tarballs so `workspace:*` dependencies are rewritten.

Treat this file as a hard project policy, not a suggestion.
