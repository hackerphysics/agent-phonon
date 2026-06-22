# Contributing to agent-phonon

Thanks for your interest! agent-phonon is a monorepo (pnpm workspace) containing
the wire protocol, device-side core, adapters, SDKs, an OpenClaw plugin, and a
reference server.

## Repository layout

```
packages/
  protocol/        @agent-phonon/protocol      — zod schemas + types (the contract)
  core/            @agent-phonon/core          — device daemon: connection, session engine, adapters
  daemon/          agent-phonon                — device daemon CLI
  sdk-server-ts/   @agent-phonon/server-sdk    — TS server SDK (orchestrate devices)
  console/         @agent-phonon/console       — web console built on the server SDK
  openclaw-plugin/ @agent-phonon/openclaw-plugin — OpenClaw before_tool_call → HITL bridge
  test-server/     @agent-phonon/test-server   — in-repo reference server (NOT for production)
sdk-python/        agent-phonon (PyPI)         — Python server SDK
docs/                                          — PROTOCOL.md, design.md, agent CLI integration
```

## Prerequisites

- Node.js >= 20
- pnpm >= 9 (`corepack enable` then `corepack prepare pnpm@latest --activate`)
- Python >= 3.10 (only for the Python SDK)

## Getting started

```bash
pnpm install
pnpm -r build
pnpm -r test          # TS: protocol + core + reference-server functional tests
python3 sdk-python/test_e2e.py   # Python SDK e2e
```

## Development workflow

- **Protocol first.** Wire changes start in `packages/protocol` (zod schemas).
  Schemas are the single source of truth — types are inferred, and both SDKs and
  the reference server validate against them.
- **Adapters declare capabilities, core fills gaps.** Don't pretend a runtime
  supports something it doesn't; declare `AgentCapabilities` honestly and let
  core compensate.
- **Keep paths sandboxed.** Any file access must stay inside the
  project/worktree root and be realpath-checked (see `file-manager.ts`).
- **No machine-specific absolute paths** in code, tests, or docs. Derive runtime
  paths from config / env / `homedir()`. Tests must pass in CI under a different
  user/home.
- **No secrets in the repo.** Never commit API keys, tokens, `device.key`, or
  database backups. Config redaction (`redactConfig`) exists for a reason.

## Tests

Every behavioral change needs a test. The reference server (`test-server`)
hosts the functional suite; protocol-level checks live in
`packages/protocol/src/__tests__`. Run the full suite before opening a PR:

```bash
pnpm -r build && pnpm -r test
```

## Commit & PR conventions

- Conventional-commit-style subjects (`feat(...)`, `fix(...)`, `docs(...)`, …).
- Explain the *why* in the body, not just the *what*.
- Keep PRs focused; one logical change per PR.
- Update `docs/design.md` (ADR table) when you make a design decision worth
  recording, and `docs/PROTOCOL.md` when you change the wire surface.

## License

By contributing, you agree that your contributions are licensed under the
[MIT License](./LICENSE).
