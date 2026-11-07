# Admission Generation ABA Correction

Workflow: `b9e002cb-139a-4f02-a611-56a67170e743`.
Date: 2026-10-28 (Asia/Shanghai).
HEAD remains `475ae2e914fa9ba974e3f025b4c23e904c0cbb9f`.
Workspace: `/Users/wanghaipeng/agent-phonon`.
This is this worker's source-only evidence, uncommitted and NOT live acceptance.
The originating supervisor must independently verify it.

## Corrected Claim

The previous boolean fence did not prove that revoked queues never revive.
The supervisor's exact revoke/re-admit-before-drain ABA was reproduced here.

- A local grant now has a durable unique generation. Same-current-grant admit
  preserves it; admit after a revoke tombstone creates a new UUID. Generation is
  not a timestamp, remote consent field or adapter assertion. Legacy local rows
  without a generation fail closed on use; a local write migrates them within
  the existing immediate transaction.
- Operations capture the current controller generation at admission, not for the
  session lifetime. Send carries it through its queue payload, both drain paths,
  detached recovery and final runTurn dispatch. Create, recovery observation and
  adoption, employee refresh, insertion, skills and compression preparation
  compare the captured generation before subsequent native effects.
- Draining filters stale operations individually: a new-generation queued input
  survives beside an old-generation input. An explicitly fresh operation can use
  the same unchanged session/cwd after re-admission. Old work is not replayed.
- Connection admission also fences the status await before session.send and the
  realpath await before existing-directory registration and project.exec.
  Successful project/session command receipt fingerprints include the local
  generation without changing request keys or the protocol. Same-generation
  retries work; old-generation and unverifiable legacy receipts cannot confirm
  a new grant, including through another connection's persisted cache.
- Compression stores its generation in a separate local receipt column. Command
  retries cannot cross generations. Historical compression status remains an
  observation, not new authorization or a rewritten execution outcome.
- Original fixed cwd/inode, source/tenant, private provenance, ownership, native
  owner, permission and cancellation checks remain. Source or inode replacement
  is still denied. No adapter, SDK, client, managed-MCP or protocol change was
  made in this correction. All seven native integrations remain unchanged.

## Executed Evidence

Node v24.22.1, existing dependencies, serial TypeScript source loader:

```sh
LOADER='data:text/javascript,import {registerHooks} from "node:module";import {existsSync} from "node:fs";import {pathToFileURL} from "node:url";registerHooks({resolve(s,c,n){if(s==="@agent-phonon/core")return n(pathToFileURL(process.cwd()+"/packages/core/src/index.ts").href,c);if(s.startsWith(".")&&s.endsWith(".js")&&c.parentURL?.includes("/src/")){let u=new URL(s.slice(0,-3)+".ts",c.parentURL);if(existsSync(u))return n(u.href,c);}return n(s,c);}});'
node --experimental-transform-types --import "$LOADER" --test --test-concurrency=1 --test-name-pattern='admission generation' packages/core/src/local-directory-admission.test.ts
```

Before any implementation edit, the completed RED run was **18 tests: 1 pass,
17 fail, 0 cancelled/skipped**. Finally and interrupt both dispatched actual
`['first','old-queued-input']` after revoke/re-admit. Native-stop left the old
queue to run after fresh input. Delayed create/recovery/skills/insertion/
compression/refresh and four cached-command cases also failed. Idempotent
current admit was the one passing case.

An earlier incomplete fixture attempt had two ABA failures and one cancelled
case: native-stop accidentally retained optional coordination in its fake
runtime. That attempt was interrupted, not counted as completed RED. The fixture
was corrected to omit optional runtime coordination; no real backend transport
was connected. The owned test process ended and its leftover fixture was audited
and removed as described below.

The original 18 then passed. Six added boundary cases cover mixed generations,
the RPC status await, local legacy migration, pending registration/exec and late
create adoption. Exec permission is explicitly enabled only in that synthetic
exec fixture so it reaches the generation fence; an earlier version of that
extra case had been masked by the default exec policy.

Final command on the final source/test bytes:

```sh
node --experimental-transform-types --import "$LOADER" --test --test-concurrency=1 packages/core/src/local-directory-admission.test.ts packages/core/src/session-project-authority.test.ts packages/core/src/session-project-authority-recovery.test.ts packages/core/src/session-project-authority-compatibility.test.ts packages/core/src/workspace-directories.test.ts packages/core/src/project-path-ownership.test.ts packages/daemon/src/local-directory-admission.test.ts
node packages/core/node_modules/typescript/bin/tsc -p packages/core/tsconfig.json --noEmit
node --input-type=module -e 'import ts from "./packages/core/node_modules/typescript/lib/typescript.js";const file="packages/daemon/tsconfig.json";const config=ts.readConfigFile(file,ts.sys.readFile);const parsed=ts.parseJsonConfigFileContent(config.config,ts.sys,"packages/daemon",{noEmit:true,rootDir:process.cwd(),baseUrl:process.cwd(),paths:{"@agent-phonon/core":["packages/core/src/index.ts"]}});const program=ts.createProgram(parsed.fileNames,parsed.options);const errors=[...parsed.errors,...ts.getPreEmitDiagnostics(program)];process.stdout.write(ts.formatDiagnosticsWithColorAndContext(errors,{getCanonicalFileName:x=>x,getCurrentDirectory:()=>process.cwd(),getNewLine:()=>"\n"}));process.exitCode=errors.length?1:0;'
git diff --check
```

Results, in the order above: **75/75**, core exit 0, source-mapped daemon exit 0,
diff check exit 0. No failures, cancellations or skips in the final test run.
The 75 include 24 generation cases and the previous 51. One top-level wrapper
also asserts **31/31 existing compatibility tests**; do not sum 75+31 as
independent top-level cases. The wrapper and original focused tests are unchanged
from the previous report. New untracked sources/docs also produced no whitespace
diagnostics with `git diff --no-index --check /dev/null <path>` (exit 1 for the
expected added-file differences).

## Limits And Cleanup

Revocation/generation fences do NOT stop already dispatched native execution.
Only native stop evidence can confirm stop. Pre-dispatch compression rejection
is failed/not-dispatched; uncertain dispatched outcomes retain their old gate.
The late-create/recover cases reject adoption and request termination, not prove
the native side stopped. Original native completion/error handling and optional
reasoning semantics were not replaced. This is not a native tool OS sandbox.
Windows local admission still fails closed. Full suites, builds and live product
or provider execution were not run; release/live verification remains outstanding.

No real config, SQLite, grants, credentials, Societas directory or backend record
was read or changed. No remote network/provider execution, SSH, deployment,
running-service change, global setting, app/simulator, dependency install,
build, commit/push/tag, extra worker/workflow or fallback was performed.
Only local fixtures/fake adapters and the unchanged synthetic compatibility CLIs
ran. Native coordination peers/inbox were checked once and unconfirmed, not
polled: conflicts remain unknown. Global ps is denied by macOS, so unrelated
active tasks cannot be certified absent.

Gates release in finally and fixture defers precede disposable work. All task
command sessions exited. The interrupted fixture's marker matched this checkout,
workflow, nonce and PID 34027, was inactive with no owned child processes, and
process.kill(pid,0) returned ESRCH before its exact directory was removed.
Final peer fixture base
`/var/folders/1n/bkyzxsnd5y31kfx7qk3shkbr0000gn/T/agent-phonon-peer-tests-26f52dae1e2b`
has **entries=[]**. No unrelated files were cleaned.

Available disk before/after: **195 GiB**. Existing node_modules 100M, core/dist
6.0M, daemon/dist 10M and daemon/dist-test 768K were reused unchanged in size.
No new dependency/build tree, temporary service/device or large retained task
artifact. Prior implementation files outside this correction and the four
foreign untracked test-server harness outputs are preserved.

## Final SHA-256

These are the changed source/test/docs bytes for this correction; this report's
own hash and publication receipt are returned separately, avoiding self-hashing.

```text
e6bd2413abebada5198b9504eeb5b7b8847db6cf320716fd23f723e82dd81359 packages/core/src/local-directory-admission.ts
39390614a196f469be95e572ea6ec7952d338a6305b93fb22c2d9f687904ef9a packages/core/src/policy.ts
61852a2eaac39d7689ff2780e4653bf5a75c271b6b5cd67477a4b48bdd9176be packages/core/src/index.ts
0f55d01a3fdebba95161fd4af59801ab34c76dd4976abc799498aa2ef2a415fe packages/core/src/session-engine.ts
a69c3008b4f01fa5d36d5bd00de85062b6ca9104635314e2caa1eaf65669892b packages/core/src/store.ts
c7a30302df5fb16969aa27d5f86e269abf8334819cdbdd61a8c1855106351d9a packages/core/src/project-manager.ts
46f44dea9e7323b350b034f838b01f92aabd2d0a4d8726f1fde98aa0b129e81b packages/core/src/local-directory-admission.test.ts
4c64207bf260430d6c80c0ab62e2d8d6b1bb6705f527bf21f10e7d58ccdf3210 docs/local-directory-admission.md
907d540523dd19508bda13b8b86144f3a8fd0e9014247f90f461ba5fda364478 docs/research/local-directory-admission-follow-up.md
```

The unchanged client, workspace-directories, daemon CLI/local-directory CLI,
three session authority test files, daemon admission test and earlier blocker
report hashes were rechecked against the previous follow-up and still match.
