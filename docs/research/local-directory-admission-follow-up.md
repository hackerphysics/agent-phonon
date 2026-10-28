# Local Directory Admission Follow-Up

Correction: the original boolean-only implementation below missed revoke/re-admit
ABA between checks. Its claim that queued work never revives was too broad.
The source-only generation correction and current evidence are recorded in
`local-directory-admission-aba-correction.md`; the original run and hashes below
are historical evidence, not acceptance of the corrected implementation.

Workflow: `4a0f25c1-30b1-42b8-af8e-366d4197cd21`.
Baseline/current HEAD: `475ae2e914fa9ba974e3f025b4c23e904c0cbb9f`.
Workspace: `/Users/wanghaipeng/agent-phonon`.
This worker implemented source changes only. No commit, release, deployment,
production directory grant, real config/SQLite/credentials read, model invocation,
live device RPC, SSH, service action or extra worker/workflow was performed.
The earlier investigation report and four foreign test-server outputs survive.

## Authority And Changes

- Local CLI `directory admit|list|revoke` selects exactly one existing configured
  source. Owner-private config, exact URL/device-key/expectedTenantId fingerprint,
  protected transport and matching persisted welcome observation are required.
  RPC cannot write consent. URL-only old observations are not migrated.
- Separate local SQLite provenance uses a private owned nonlinked directory/file,
  verified ancestors, no-follow descriptor identity checks, immediate transactions,
  exact canonical root/dev/inode, tenant/source, timestamps and revoke tombstones.
  No arbitrary imports, HOME allow, policy-root mutation or MCP semantics changes.
- Existing directories register git:false with the existing protocol identity.
  Same-source/tenant reopen/list/get/runtime work; another source even with the
  same tenant is denied. Parents/siblings, foreign or unresolved ownership,
  employee homes and state/namespace containers are denied. Exact admitted-root
  browsing never requires enumeration of its unadmitted parent. Replacements and
  symlink roots fail. Source bytes, synthetic Git HEAD/config and roots survive.
- Connections always wire the controller-owned ProjectManager resolver. Session
  create, recovery observation/adoption, send, both queue drains, insertion,
  inject, employee update, model switch and compression recheck authority before
  effects, including after async preparation. Session cwd/inode is persisted
  separately from optional recovery checkpoints. Original executor errors survive.
  File policy rechecks consent and exec rechecks cwd/authority after realpath.
- Revocation closes future effects, not already-dispatched native work. Stop,
  interrupt, terminate and disposal do not require path consent. Forbidden queued
  sends are dropped, including native-stop settlement, not revived on re-admit.
  Compression denied before dispatch is failed/not-dispatched, not an unknown
  executor outcome. Actual dispatched uncertain outcomes retain the existing gate.
- No protocol/SDK/adapter changes. Configured-root behavior remains for unadmitted
  paths. Standalone SessionEngine fixtures may omit a manager; real connections
  do not. Windows local admission fails closed pending OS ownership attestation.
  This is a controller authority fence, not a new native tool OS sandbox.

## Executed Evidence

Node v24.22.1, installed dependencies, serial TypeScript source loader. No build,
install, dependency copy, compiled output, full suite or release gate ran.
First corrected fail-first run: **19 tests, 0 pass, 19 fail**. Seven missing local
API failures and twelve actual missing session guards. Both queue drains sent
`forbidden` after revocation. Initial interrupted coordination-fixture run was
not counted; its mock listen fix completed RED without cancellation.
Additional native-stop RED: **1 test, 0 pass, 1 fail**; actual inputs were
`first,fresh,revoked queue`. Final GREEN removes the third input.

Final focused run: **51/51**, zero failures/cancellations/skips. This includes
one owned compatibility wrapper asserting a further **31/31 existing tests**;
do not sum 51+31 as independent top-level cases. Existing directory/ownership
regressions are 12/12 within the focused count. New tests use tiny owned fixtures,
SQLite and fake adapters. Compatibility tests use existing synthetic CLI scripts,
not an installed model/provider. Direct connection durable queue evidence is
`inputs=['first']` after revoke, direct next send denied, terminate available.

```sh
LOADER='data:text/javascript,import {registerHooks} from "node:module";import {existsSync} from "node:fs";import {pathToFileURL} from "node:url";registerHooks({resolve(s,c,n){if(s==="@agent-phonon/core")return n(pathToFileURL(process.cwd()+"/packages/core/src/index.ts").href,c);if(s.startsWith(".")&&s.endsWith(".js")&&c.parentURL?.includes("/src/")){let u=new URL(s.slice(0,-3)+".ts",c.parentURL);if(existsSync(u))return n(u.href,c);}return n(s,c);}});'
node --experimental-transform-types --import "$LOADER" --test --test-concurrency=1 packages/core/src/local-directory-admission.test.ts packages/core/src/session-project-authority.test.ts packages/core/src/session-project-authority-recovery.test.ts packages/core/src/session-project-authority-compatibility.test.ts packages/core/src/workspace-directories.test.ts packages/core/src/project-path-ownership.test.ts packages/daemon/src/local-directory-admission.test.ts
node packages/core/node_modules/typescript/bin/tsc -p packages/core/tsconfig.json --noEmit
```

Core noEmit exits 0. Normal daemon noEmit initially reported stale core dist
declarations missing new exports, plus a corrected fixture import rootDir issue.
No build was used to hide this. Daemon+current core source noEmit exits 0 with:

```sh
node --input-type=module -e 'import ts from "./packages/core/node_modules/typescript/lib/typescript.js";const file="packages/daemon/tsconfig.json";const config=ts.readConfigFile(file,ts.sys.readFile);const parsed=ts.parseJsonConfigFileContent(config.config,ts.sys,"packages/daemon",{noEmit:true,rootDir:process.cwd(),baseUrl:process.cwd(),paths:{"@agent-phonon/core":["packages/core/src/index.ts"]}});const program=ts.createProgram(parsed.fileNames,parsed.options);const errors=[...parsed.errors,...ts.getPreEmitDiagnostics(program)];process.stdout.write(ts.formatDiagnosticsWithColorAndContext(errors,{getCanonicalFileName:x=>x,getCurrentDirectory:()=>process.cwd(),getNewLine:()=>"\n"}));process.exitCode=errors.length?1:0;'
```

Harness limits, not hidden greens: one mistaken argv-selector wrapper overran
the intended selection, timed out its subprocess recovery case and ended in a
Node internal async assertion (exit 134). A nested-run attempt inherited
NODE_TEST_CONTEXT and skipped tests; the wrapper now removes that variable and
requires the child 31-pass summary. Selected cases then passed both directly and
in the cleanup wrapper. The extra subprocess/socket cases are not verified.

## Cleanup And Visibility

Available disk before/after: 195 GiB. Existing node_modules 100M, core/dist 6M,
daemon/dist 10M and daemon/dist-test 768K were reused unchanged in size. No new
dependency/build trees, devices or services. withPeerFixture registers cleanup
immediately; controlled promises release in finally and before disposal.
One interrupted fixture and the failed wrapper's synthetic residue were removed
after matching manifest/owner PID and inactivity. The older compatibility helpers
left 25 small directories outside the wrapper; only their exact observed names,
birth window, synthetic contents/tenant and released owners were audited/removed.
The final compatibility wrapper contains all child files under its owned scope.
The peer fixture base was verified empty after final runs.

All task command sessions exited. Global ps is denied by macOS, so unrelated
activity is unknown. Native peers/inbox were unconfirmed before and after work;
this is not evidence of no conflicts. No unrelated file was cleaned. No retained
large task artifact. Source/docs/tests below are the deliberate deliverables.

## SHA-256 Files

```text
182c18af33d13412e5b60927ec26c98deaa8c7517b840a673b5f6151d11c4bce packages/core/src/local-directory-admission.ts
10b32dd85bb111b9573640fe194fc4c11f840a678beff0e9c6b6003f72824fd3 packages/core/src/client.ts
ab3895d86335815958e84027e77133116ed2dec6c86613cefbf286e5d83d225c packages/core/src/index.ts
7af8747ba9c00d14d61589b919886ea0ccd5b5dabe78c76b8a6ff18b7d1110e8 packages/core/src/policy.ts
409fc59789fe05d21ca9465f95b12d32d54ecb811cc1dbf147a4dc019776963b packages/core/src/project-manager.ts
80203f9ba2738da18d0ebc8dce098c17ab6e47b9c6bffd7d2232c2ec31387421 packages/core/src/session-engine.ts
15fe50d5b0314e2852f59c480036e61e3db904a14ce78302264ea3bb07398811 packages/core/src/store.ts
3b01a6d120c881c9e35135e65e88221b0ff67eb668fb02dcb42c5e0ae203f7d8 packages/core/src/workspace-directories.ts
1bcbd4f98790f0e1f1cbcc38e87466452abe5b4ee709624d64680d3d17e056c0 packages/daemon/src/cli.ts
4d478213020927cf3f55972af7f803d99dfbacc8fa1fdb84ff00c0cc1cc25b0a packages/daemon/src/local-directory-cli.ts
e53def55bf3bfe690c23572ea4cbd2fe3f20818f03c8c4156ff9c5c23427b0a1 packages/core/src/local-directory-admission.test.ts
916e20a1432349e5329b04843258816441c72701795f23b64a7845a903189f2c packages/core/src/session-project-authority.test.ts
4b5aa0fb9f5f348833542732da8f995f4721b8c936033f28c8e0f69847065b4e packages/core/src/session-project-authority-recovery.test.ts
4ed57b7fddccf90f5028de1855eb4ac94d3e9b8b8520e5c3b0a487c48c8ee9c2 packages/core/src/session-project-authority-compatibility.test.ts
e172776614b34f56dea4a57b47b8fa7dedebef3bfd313fb64bca5ced6c11eda0 packages/daemon/src/local-directory-admission.test.ts
8aba5304b9aaa9986a83c494e80176ce93cb381eb9445a0c533ff7fdfe5f6d3d docs/local-directory-admission.md
126d37be490f02a40a06e5e81cd6ebeaf356c0f5c23bf68f3947f8de1afb6d34 docs/research/local-directory-admission-blocker.md
```

This report's own SHA-256 and publication receipt are returned separately to avoid
self-referential hashing. Production directories remain pending the live release
gate; local GREEN is not live product verification or native stop proof.
