# Safe local test entrypoints

From the repository root, with the workspace's existing dependencies installed:

```sh
pnpm run consistency
pnpm -r build
pnpm -r typecheck
pnpm test
pnpm test:e2e
pnpm test:python
```

- `pnpm test`: consistency plus workspace defaults (protocol, functional/SDK tests,
  daemon config and daemon security integration). Core/SDK `test` scripts build;
  those builds are not behavioral test counts.
- `pnpm test:e2e`: builds the workspace and explicitly selects local workflow,
  Git, **scheduler**, and daemon observability integration. Local mock adapters,
  temporary repositories/databases, and real loopback WS/HTTP only.
- `pnpm test:python`: builds the Node dependencies, runs `unittest test_auth`
  (including Python-server/Node-client authentication and tenant rejection), then
  **all three** standalone SDK scenarios: multi-device, workflow, maintenance.
  Requires the existing SDK dependency `websockets>=12.0`; no new test library.
- These root entrypoints create temporary HOME/XDG/TMP directories and use an
  environment allowlist without inherited credentials/provider/proxy settings.
  No install, Git hooks, production config edits or live model calls. Temporary
  fixtures are removed on completion; stdout contains child exit codes. This is
  environment isolation, **not an OS network sandbox**.
- Git fixtures provide repository-local synthetic committer identity; do not set
  global Git identity just to run tests.

To use an **already provisioned** Python venv (no automatic installation):

```sh
PHONON_TEST_PYTHON=/absolute/path/to/venv/bin/python pnpm test:python
PHONON_TEST_PYTHON=/absolute/path/to/compat-venv/bin/python pnpm test:python:compat
```

`test:python:compat` is a separate optional unittest suite requiring the existing
[scripts/claude-gpt-compat/requirements.lock](../scripts/claude-gpt-compat/requirements.lock)
versions (including LiteLLM). It sets `LITELLM_LOCAL_MODEL_COST_MAP=True` and does
not fetch a remote cost map or force SDK users/CI to install compat dependencies.

## Explicitly live, never part of default/local/all

The package-level `test:all` now means default + **local** E2E, not production
integration. `test:e2e` aliases `test:e2e:local`. The five excluded test files are
`test-server/{e2e,e2e-full,e2e-gateway,e2e-hitl}.test.ts` and
`daemon/daemon.test.ts`: even an apparently non-generating test may discover a
native CLI or read real Gateway configuration. They remain available only via
`test:live`, which requires the additional `PHONON_LIVE_TESTS=1` opt-in after
reviewing access, credentials, cost and environment. Root local entrypoints do
not run them. Manual `real-llm-e2e.ts` and `live-hitl.mjs` remain separate live
operations, not local test coverage.

## Security behavior, not RPC-string parity

The consistency script checks RPC method presence, **not** listener defaults,
constructor options, authentication or transport identity. Dedicated TS/daemon
and Python tests exercise these behaviors. Anonymous wildcard bind exceptions
are tested using intercepts/mocks before creating sockets; daemon's transport
exception uses only OS loopback `127.0.0.2` (outside the client's exact localhost
allowlist), never a public endpoint. No claim of TLS/MITM, production, native
model, or cross-platform acceptance follows from local PASS.
