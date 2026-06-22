# Commit / Release Checklist

This checklist is a hard project constraint. Every coding agent must run it before every commit and before every release tag.

## Required gate

Install local hooks once per clone:

```bash
pnpm run install-hooks
```

Run this gate before every commit and release tag:

```bash
pnpm run consistency
pnpm run release:guard -- <tag-if-any>
pnpm -r build
pnpm -r test
```

Do not commit or tag a release until the gate passes. If any gate fails, fix the root cause first; do not bypass by weakening protocol, SDK, daemon, or tests.

The tracked `.githooks/pre-push` hook runs `pnpm run consistency` before pushing `main`, and additionally runs `release:guard`, full build, and full tests before pushing release tags. This prevents most release failures locally, before GitHub Actions can send failure emails.

## Consistency checks

Before every commit, verify these invariants:

1. **Protocol ↔ implementation consistency**
   - `packages/protocol/src/schemas/methods.ts` is the source of truth.
   - Every server→phonon (`s2p`) method in `METHODS` must be implemented by the local daemon/core dispatcher.
   - Params/results must be validated through protocol schemas, not ad-hoc object assumptions.

2. **Protocol ↔ Server SDK consistency**
   - TypeScript Server SDK and Python Server SDK must expose the same public method surface for server-controlled device operations.
   - If a new protocol method is added, update both SDKs in the same commit unless the method is explicitly protocol-internal and documented as such.

3. **SDK parity**
   - Feature names may follow language style (`createSession` vs `create_session`), but capability coverage must match.
   - Do not add a TypeScript-only or Python-only convenience wrapper without either adding the equivalent wrapper or documenting why it is intentionally asymmetric.

4. **Daemon ↔ protocol consistency**
   - The local daemon must parse params and return results matching the protocol package.
   - Discovery must return accurate agent/model/capability data; no stale hard-coded model lists when a real catalog is available.

5. **Package/release consistency**
   - npm package versions (`@agent-phonon/protocol`, `@agent-phonon/server-sdk`, `agent-phonon`) move together for npm releases.
   - A tag `vX.Y.Z` must match those npm package versions exactly.
   - Python package name is `agent-phonon-sdk`; import module is `agent_phonon`.
   - `sdk-python/pyproject.toml` version and `sdk-python/agent_phonon/__init__.py::__version__` must match.
   - A tag `py-vX.Y.Z` must match both Python version fields exactly.

6. **Publish workflow consistency**
   - npm publishes `pnpm pack` tarballs, not raw `npm publish` from workspace packages, so `workspace:*` dependencies are rewritten.
   - PyPI publishes only `agent-phonon-sdk`, never the daemon name `agent-phonon`.

## Release-specific steps

### npm release

```bash
# bump packages/protocol, packages/sdk-server-ts, packages/daemon together
pnpm run consistency
pnpm run release:guard -- vX.Y.Z
pnpm -r build
pnpm -r test
# commit
git tag vX.Y.Z
git push origin main
git push origin vX.Y.Z
```

After GitHub Actions succeeds, verify:

```bash
npm view agent-phonon dist-tags.latest
npm view @agent-phonon/protocol dist-tags.latest
npm view @agent-phonon/server-sdk dist-tags.latest
```

Then install in a temp directory and run at least `agent-phonon --help` or the affected command.

### PyPI release

```bash
# bump sdk-python/pyproject.toml and sdk-python/agent_phonon/__init__.py together
pnpm run consistency
pnpm run release:guard -- py-vX.Y.Z
# build/install locally in a venv
# commit
git tag py-vX.Y.Z
git push origin main
git push origin py-vX.Y.Z
```

After GitHub Actions succeeds, verify:

```bash
pip install agent-phonon-sdk==X.Y.Z
python -c 'import agent_phonon; print(agent_phonon.__version__)'
```

## Incident notes

### 2026-06-22: v0.2.6 failed after history squash

After cleaning git history and recreating a release tag, npm publishing failed because the release workflow now runs `pnpm run consistency`. The npm package versions were bumped to `0.2.6`, and `sdk-python/pyproject.toml` was also changed to `0.2.6`, but `sdk-python/agent_phonon/__init__.py::__version__` still said `0.2.4`.

This was not a recurrence of the earlier npm `workspace:*` or provenance problem. It was the new consistency gate correctly blocking a cross-package version mismatch before publish.

Permanent prevention:

- `scripts/release-guard.mjs` checks `v*` tags against npm package versions and `py-v*` tags against both Python version fields.
- `.githooks/pre-push` runs the release guard before release tags leave the machine.
- Both npm and PyPI publish workflows run the release guard before publishing.

If this fails again, do not retry the workflow blindly. Read the release guard output, fix the version/source mismatch locally, and create a new release tag.
