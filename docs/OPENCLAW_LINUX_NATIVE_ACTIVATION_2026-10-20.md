# Ubuntu OpenClaw Native Plugin Activation Plan

Status: **BLOCKED_SCOPE_EXPANSION**, not native-interaction activated. The exact
approved artifact is installed and loaded as version `0.1.0`; `nativeInteractions`
remains false, the owned optional-tool allowlist is still empty, and no native
binding RPC or effective Phonon tool is exposed. Further config/runtime writes
require main review of the native lifecycle's unexpectedly widened scope.

## Actual Hot Receipt

The requested native RPC selected only `agent-phonon-hitl`, with
`waitForDrain: true`. One authenticated lifecycle connection was held from
23:35:00.741 until the receipt at 23:44:03.727 Asia/Shanghai. It was not cancelled
or retried for observation timeout. The native receipt was:

```text
ok: true
requested pluginIds: [agent-phonon-hitl]
restartRequired: false
operationId: 90d6ba30-e597-4ae2-a859-e0fabc4f5846
generation: 3
runtime.pluginIds: [agent-phonon-hitl, brave, feishu, pew-session-sync]
warning: Plugin replacement waited for retained work to finish.
agent-phonon-hitl sourceDigest:
02a49a22d57d08db4bce97ff8321ca07906372d6b78406581f746c8f909ec868
selected entry:
/home/haipw/.openclaw/extensions/agent-phonon-hitl/dist/index.js
entry SHA256:
06bdd34cb28f601794099fce8b2a2e67ac3b1eae4b50014a35f0692fdbbfaf4b
```

The scope guard stopped before the config patch. Although the request contained
only the approved plugin, the host's replacement set also included `brave`,
`feishu`, and `pew-session-sync`. Native health confirms Feishu's channel was
stopped at 23:43:53.332 and started at 23:43:56.499; it is now connected, running,
`ready`, and not restart-pending. No explicit channel restart/abort, Gateway
process restart, or systemctl action was sent by the helper. Do not describe this
receipt as a target-only replacement or repeat it without scope review.

Latest authoritative verification at **23:45:12.856 Asia/Shanghai**:

- Gateway PID `1181`, start ticks `760`, boot ID
  `19f6c410-aeef-4775-b04e-662d92016993` are unchanged.
- Registry generation `3`; the four receipt-listed plugin runtimes are active.
- Config remains valid and byte-identical, SHA256
  `9f767b9e3a0870473512ce328376bf48e0af1e983009d3a2b933a53da5173986`.
- Full unrelated-config SHA256 remains
  `9d1d261a03d3e9de3b08301c42565e10b295eef2ba97e2c6d6021044e5b4d4ad`.
- `nativeInteractions: false`, owned `alsoAllow: []`, native binding methods `[]`,
  owned effective Phonon tools `[]`. No model message/replay was sent.
- Shutdown budget: `timeoutMs: 325000`, `reserveMs: 10000`,
  `nativeStopBudget: true`; roots `3`, other four active-work counts `0`, write
  custody `[]`. This is a snapshot, not an idle reservation.
- All lifecycle/observer RPCs and local command handles are closed. No pending
  drain, held lifecycle connection, restart, or retry exists.

## Completed Changes And Rollback

The original config and six old plugin files were copied privately off-server
before mutation. The artifact's exact 69,151-byte archive and all five runtime
hashes were verified locally and remotely. Linux `renameat2(RENAME_EXCHANGE)`
performed each directory exchange atomically on the same filesystem; no missing
plugin path or mixed-file bundle was exposed. No remote build, dependency install,
test suite, additional Gateway, or test service was run.

The first fresh-CAS patch was rejected before persistence because the running
plugin schema still contained only `bridgeUrl` and `interceptTools`. A subsequent
target reload required native capability consent before runtime application.
That refusal was reconciled and the disk exchange rolled back successfully.
The standard native review then matched exactly the six approved tools and six
`tools: <name>` contracts, with every other declared capability array empty.
Only that target's accepted-surface metadata was acknowledged through the native
API after an additional private install-record backup. All other plugin install
records and all non-consent target record fields were verified unchanged.

```text
Target acceptedSurfaceHash:
49191d3449c131edb65803e5e186384fde322eb9031850746aac9139cbfeeab0
Other install records SHA256, before and after:
9b0ab390a6a6355df5d6fdc205b8ae183345263b279aef8e3030528e09e93da0
```

Temporary upload/archive and old-plugin staging were removed after exact
inventory/ownership/hash verification at 23:47:06.601. No unrelated files were
deleted. Rollback material remains only off-server, directory 0700/files 0600:
`/private/tmp/phonon-openclaw-linux-20261020-r2-JeyoTr/backup-before-activation`.
It includes original config/plugin bytes and before/after install-record exports;
secret config bytes were never printed. A rollback would itself require a planned
native lifecycle action; no automatic rollback of the published registry was
attempted after the scope guard fired.

Sanitized current receipt:
`/private/tmp/phonon-openclaw-linux-20261020-r2-JeyoTr/activation-final-receipt.json`.
Read-only state receipt:
`/private/tmp/phonon-openclaw-linux-20261020-r2-JeyoTr/activation-scope-blocker-state.json`.
These supersede earlier SSH/global-idle blocker reports.

Installed-source caveat: selected IDs seed replacement, but
`server-plugin-reload-BeiD3aB3.mjs:315-329` expands changed IDs when fresh preflight
does not retain previous record identities. Target-instance drain is not an
all-root-idle requirement, but selecting one ID does **not** prove the final
runtime replacement set will contain only that ID. The actual receipt above is
authoritative. Main must review this behavior before any further flag/tool patch.

## Verified Scope

- Host: `haipw@100.109.74.51`, OpenClaw Gateway PID `1181`, version `2026.9.9`.
- Existing Phonon runtime a1 PID `222181` remained present during inspection.
- Owned test employee: `13455311-6320-41e6-9201-cad0688d0080`.
- Native agent: `phn-a420815c3aef58afb413202044f51416d299363a`.
- Workspace: `/home/haipw/phonon-projects/.phonon-employees/fcc581658c780175675f583f/13455311-6320-41e6-9201-cad0688d0080`.
- Native `IDENTITY.md` ownership marker and local `.phonon-employee` nonce agree.
- Existing agents `main` and `phonon`, all other plugin entries, global tool
  policy, credentials, daily memory, and transcripts are outside mutation scope.

Before activation, installed `agent-phonon-hitl` was version `0.0.1`, with only legacy HITL.
Its manifest has no native interaction config/tools. The current config lacks
`nativeInteractions: true`, and the test agent has no optional-tool allowlist.
This explains the exact first-turn plugin-unavailable error without requiring
an inference attempt or a shared core transport change.

Pre-activation file hashes (config is still unchanged; bundle is now the approved new hash):

```text
/home/haipw/.openclaw/openclaw.json
SHA256 9f767b9e3a0870473512ce328376bf48e0af1e983009d3a2b933a53da5173986
/home/haipw/.openclaw/extensions/agent-phonon-hitl/dist/index.js
SHA256 d4b6a100ba411d358ca83a2fbdb0bd723f6bc2a3d606108a30686104a0d84e22
```

## Prepared Artifact

```text
/private/tmp/phonon-openclaw-linux-20261020-r2-JeyoTr/agent-phonon-hitl-linux-ready.tar.gz
SHA256 35753ff55a957b10480015ae2e999edf4a742e3940e39fd93d743d98f780ddc0
69151 bytes compressed; dist/index.js is 332904 bytes
```

The neighboring `agent-phonon-hitl.sha256.json` records individual file hashes.
The archive contains only `package.json`, `openclaw.plugin.json`, `dist/index.js`,
`LICENSE`, and `THIRD_PARTY_NOTICES.txt`. Protocol/Zod dependencies are bundled;
only Node built-ins and the installed host's `openclaw/plugin-sdk/plugin-entry`
remain external. There are no macOS native dependencies, tests, source maps,
package managers, caches, or install/build scripts in the runtime artifact.

The artifact was generated from the freshly built plugin using its existing
`scripts/prepare-artifact.mjs` and has now been loaded on Ubuntu as described above. Keep archives,
checksum sidecars, and any verified rollback copy off-server. Inspect the old
plugin's exact owned file inventory before replacing it; do not delete other
extensions or unrelated files.

## Scoped Config Plan

The read-only `packages/openclaw-plugin/scripts/plan-native-enable.mjs` verifies
canonical owned files, workspace/nonce identity, expected file hash, and tool
policy. It refuses global exposure, unrelated agent grants, explicit denials,
and ambiguous allowlists. It has no apply/install/restart mode and never emits
credentials, marker nonces, persona documents, memory, or chat bodies.

The generated plan is:

```text
/private/tmp/phonon-openclaw-linux-20261020-r2-JeyoTr/owned-enable-plan.json
```

Its merge patch changes only:

- `plugins.entries.agent-phonon-hitl.config.nativeInteractions` to `true`.
- `agents.entries.phn-a420815c3aef58afb413202044f51416d299363a.tools.alsoAllow`
  to the six known Phonon optional tool names.

All other settings, including legacy bridge/interception behavior, are preserved.
The Mac's working configuration confirms `nativeInteractions` plus per-agent
`tools.alsoAllow`; do not copy its interception settings, credentials, global
allowlists, or other agent entries to Ubuntu.

The plan's file SHA256 is an inspection precondition, **not** the RPC CAS hash.
After approval, obtain a fresh native `config.get` hash on the authenticated
admin transport and pass it as `baseHash` to `config.patch`. Never send a full
redacted config back to the host, and never use `config.apply` as a shortcut.

## Reload And Idle Safety

The live Gateway advertises `config.get`, `config.patch`, `plugins.reload`,
`tools.catalog`, and `tools.effective`. Read-only inspection confirmed a valid
`config.get` snapshot, a native CAS hash, keyed `agents.entries`, and the exact
owned workspace. No mutating RPC was sent.

Installed 2026.9.9 source provides these relevant contracts:

- `plugins-mutations-Bym4dAJo.mjs`: admin/current-authority plugin lifecycle RPC.
- `management-mutations-06fGwlh8.mjs`: `plugins.reload` accepts selected plugin
  IDs, source/install preconditions, and `waitForDrain`.
- `server-plugin-reload-BeiD3aB3.mjs`: drains retained/admitted work, replaces and
  publishes a new registry generation, then retires the previous resources.
- `config-reload-plan-DOkuhSW9.mjs`: agent-entry updates and plugin changes are
  handled through hot runtime application.
- `ws-connection-CsJ9cE0L.mjs`: authenticated clients receive a connection abort
  signal; `gateway-method-runtime-CbptWtKV.mjs` forwards current authority.
- `config-BwxVHElu.mjs`: native CAS and hot-application acknowledgment precede a
  successful `config.patch` response; unapplied/restart-required writes fail.

Preferred authorized sequence:

1. Hold dispatch for the owned test DE. Do not replay its failed/unknown inputs.
2. Verify the artifact and old plugin ownership; preserve a rollback copy locally.
   Transfer/unpack only the prepared runtime, without npm or compilation.
3. Recheck the ownership plan and current config revision; apply only its narrow
   merge patch with native CAS. Never remove an explicit deny.
4. If the hot config application already proves the new source/registry is
   active, do not reload it a second time. Otherwise use the existing Gateway's
   admin `plugins.reload` for only `agent-phonon-hitl` with `waitForDrain: true`
   and bounded caller cancellation. Inspect its runtime generation/source
   selection and `restartRequired` receipt. Do not start a parallel Gateway. Do
   not assume editing files alone loaded new code.
5. Verify the native binding RPC is advertised and test-only tool policy is
   effective. Confirm all unrelated config hashes and PID `1181` are unchanged.
6. Main may authorize a fresh controlled test turn and scheduling-pause decision.
   A fresh turn is not evidence that the previously failed input was executed.

If the actual receipt requires a Gateway restart, **stop and ask main**. There
is no authorization for a restart in this plan. Before any approved restart,
use a native admission/drain fence and recheck admin `status.shutdownBudget`:
`activeWork` must show zero root requests, cron runs, session mutations, terminal
persistence, and lifecycle writes, with no retained write custody or queued work.
Do not infer idle from CPU use, one agent's status, or a stale observation. If the
host cannot prove drained/idle, do not force a restart or abort daily work.

The observed read-only idle snapshot had all five active-work counts zero and
empty write custody. This does not reserve a future idle window. Check again at
activation. Hash verification, unpacking, module loading, and registry retirement
have small but nonzero CPU/memory costs; active plugin work can make drain wait.

## Future Managed DEs

The approved source fix is confined to `adapters/openclaw-gateway.ts` and focused
OpenClaw tests. For a new controller-managed `phn-<40 hex>` DE (or interrupted
first-provision retry), operator-enabled native plugin policy permits a scoped
CAS addition of only the six known tool names after local/native nonce and
workspace verification. It preserves global/provider/agent denials and other
settings, checks transport generation, and verifies the confirmed config revision
and ownership after the write. It does not install/enable the plugin, restart the
Gateway, or silently migrate existing ready DEs. Missing/disabled plugin or
unavailable config-read authority leaves ordinary profile provisioning unchanged.

The daemon must be rebuilt off-server from this source before future automatic
DE provisioning uses the fix. Existing test DE activation remains operator-scoped.

## Verification Boundary

Local plugin tests include the actual installed **Mac 2026.9.3** SDK's before-tool
wrapper, wrong-run blocking, and disconnect revocation (10/10 with SDK opt-in).
This is not a claim that a Linux model turn or the Ubuntu SDK test suite ran.
Ubuntu 2026.9.9 compatibility evidence is its read-only installed source and live
Gateway observation methods. Final Linux activation/receipt and one controlled
model turn remain main-authorized work. No security fallback was introduced.
