# Commit / Release Checklist

This checklist is a hard project constraint. Every coding agent must run it before every commit and before every release tag.

## Required gate

```bash
pnpm run consistency
pnpm -r build
pnpm -r test
```

Do not commit or tag a release until all three pass. If any gate fails, fix the root cause first; do not bypass by weakening protocol, SDK, daemon, or tests.

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
   - Python package name is `agent-phonon-sdk`; import module is `agent_phonon`.
   - `sdk-python/pyproject.toml` version and `sdk-python/agent_phonon/__init__.py::__version__` must match.

6. **Publish workflow consistency**
   - npm publishes `pnpm pack` tarballs, not raw `npm publish` from workspace packages, so `workspace:*` dependencies are rewritten.
   - PyPI publishes only `agent-phonon-sdk`, never the daemon name `agent-phonon`.

## Release-specific steps

### npm release

```bash
pnpm run consistency
pnpm -r build
pnpm -r test
# bump packages/protocol, packages/sdk-server-ts, packages/daemon together
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
pnpm run consistency
# bump sdk-python/pyproject.toml and sdk-python/agent_phonon/__init__.py together
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
