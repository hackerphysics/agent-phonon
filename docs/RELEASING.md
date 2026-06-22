# Release Guide

How to publish agent-phonon's packages to npm and PyPI. One-time setup, then
tag-driven releases.

## Package map

| Directory | Package | Registry |
|---|---|---|
| `packages/protocol` | `@agent-phonon/protocol` | npm |
| `packages/daemon` | `agent-phonon` (bundles core) | npm (unscoped) |
| `packages/sdk-server-ts` | `@agent-phonon/server-sdk` | npm |
| `sdk-python` | `agent-phonon-sdk` | PyPI |
| `packages/core` | — (bundled into the daemon, not published) | — |
| `packages/console` | — (reference/demo, not published) | — |
| `packages/openclaw-plugin` | — (installed via OpenClaw, not published) | — |
| `packages/test-server` | — (private, not published) | — |

Three packages are published to npm (`@agent-phonon/protocol`,
`@agent-phonon/server-sdk`, `agent-phonon`) plus one to PyPI (`agent-phonon-sdk`).
The Python distribution is named `agent-phonon-sdk`, while the import module remains
`agent_phonon`. The daemon bundles `@agent-phonon/core` via tsup, so it ships self-contained.

---

## One-time setup

### npm (Trusted Publishing / OIDC — no token)

The npm publish workflow uses **Trusted Publishing**, so no `NPM_TOKEN` secret is
stored in GitHub. GitHub Actions authenticates to npm via OIDC.

1. **Create the org** (free, public packages unlimited):
   https://www.npmjs.com/org/create → name `agent-phonon` → Free. (Done.)
2. **Configure a trusted publisher** for each package on npmjs.com:
   package → Settings → Trusted Publisher → Add →
   - Provider: GitHub Actions
   - Owner: `hackerphysics`
   - Repository: `agent-phonon`
   - Workflow: `publish-npm.yml`
3. **First-publish bootstrap problem**: a trusted publisher attaches to an
   *existing* package, but our packages don't exist on npm yet. Resolve it one
   of two ways:
   - **Org-level pending publisher** (preferred): on the org settings, add a
     pending trusted publisher so the first OIDC publish is allowed to create
     the package, **or**
   - **Seed once with a token**: create a Granular token (write to
     `@agent-phonon` + `agent-phonon`), run the workflow once via
     `workflow_dispatch` with the token, then remove the token and rely on OIDC.

> npm CLI >= 11.5 is required for OIDC; the workflow pins Node 24 which bundles
> a new enough npm.

### PyPI (trusted publishing, no token)

1. On https://pypi.org, add a **pending trusted publisher** before the project
   exists (Account → Publishing), with:
   - PyPI Project Name: `agent-phonon-sdk`
   - Owner: `hackerphysics`
   - Repository: `agent-phonon`
   - Workflow: `publish-pypi.yml`
   - Environment: `pypi`
2. After the first successful publish the project exists and the trusted
   publisher becomes permanent.

> First PyPI release alternative: build locally (`cd sdk-python && python -m
> build`) and `twine upload dist/*` once with a token, then rely on OIDC after.

---

## Cutting a release

### npm packages

```bash
# bump versions (all at once or per package), commit, then tag:
git tag v0.1.0
git push origin v0.1.0
```

The `publish-npm.yml` workflow builds, tests, and publishes every public
package in dependency order with npm provenance. `workspace:*` deps are replaced
with concrete versions automatically by pnpm. Already-published versions are
skipped.

Dry run (pack only, no publish): Actions → Publish npm packages → Run workflow →
`dry_run = true`.

### Python SDK

```bash
# bump version in sdk-python/pyproject.toml and sdk-python/agent_phonon/__init__.py, commit, then tag:
git tag py-v0.1.0
git push origin py-v0.1.0
```

The `publish-pypi.yml` workflow builds the sdist+wheel, checks for stray files,
and publishes to PyPI via OIDC.

Test first: Actions → Publish Python SDK to PyPI → Run workflow → `target =
testpypi`.

---

## Versioning notes

- Pre-1.0: breaking changes can land in minor bumps; document them in the
  protocol/design docs.
- Keep `@agent-phonon/protocol` versioned carefully — it's the contract every
  other package and SDK depends on.
- npm and Python versions are independent (different tag prefixes: `v*` vs
  `py-v*`).
- PyPI distribution name is `agent-phonon-sdk`; import path is `agent_phonon`.
