# Local Directory Admission: Scope Blocker

Worker result for workflow `b08b1703-f52e-4e88-b145-c094e8e2d983`.
Recorded 2026-10-27T15:29:02Z, checkout `/Users/wanghaipeng/agent-phonon`.
Baseline HEAD: `475ae2e914fa9ba974e3f025b4c23e904c0cbb9f`.

## Disposition

Follow-up disposition (workflow `4a0f25c1-30b1-42b8-af8e-366d4197cd21`):
the supervisor authorized narrow session-engine authority changes. A source-only
implementation and focused regressions now remain in the worktree. See
`local-directory-admission-follow-up.md` for current evidence and limitations.
The original investigation-only result below is preserved as historical evidence;
it is not a description of the current follow-up worktree or a live-release claim.

Not fixed. The experimental implementation and its temporary tests were removed
using apply_patch after review exposed a required change in the explicitly
excluded session engine. No product source changes remain. This report is the
only retained deliverable. The prior foreign untracked test-server outputs are
preserved. No production config, data, grants, sessions, services, real Societas
directories, deployment, provider, or protocol was read/changed by this worker.
No commit, push, tag, install, full build/suite, simulator, or extra worker ran.

## Proposed Authority Model

- workspaceRoot remains a default creation location and ordinary remote roots
  remain enforced. Project associations do not create filesystem consent.
- A local-owner CLI selects one exact configured server/account and canonical
  existing directory; persist source fingerprint, pinned tenant, path, directory
  identity, local provenance timestamp, and revocation tombstone in PhononStore.
  The experimental source hash included exact URL, deviceKey and configured
  expectedTenantId, with secure transport or loopback only. No RPC writes consent.
- Fail closed without pinned account/source, with ambiguous ownership, other
  source (including same tenant), foreign ancestor/descendant, employee homes,
  namespace storage, daemon state, home/root, replacement inode, or symlink.
- Read durable admission on each use, including cached mutation receipts and
  reconnect; allow only inside the selected directory, never siblings/parents.
  Existing-directory registration stays git:false, no init/remote/branch writes.
- Keep configured roots unchanged. Local revocation must also invalidate queued
  input and operations paused in asynchronous preparation, not just future RPCs.
  A local CLI is an owner authority boundary, not a way to interpret remote prose
  or inode observations as approval. A terminal prompt alone is not OS attestation.

## Blocking Evidence

`packages/core/src/session-engine.ts:951` drains queued inputs directly through
startTurn; there is another drain at line 1007. runTurn awaits coordination,
skills and optional native preparation before `adapterSession.send` at line 916.
The final guard at line 914 checks agent permission, not project authority.
An RPC-entry check in index.ts cannot cover these later effects.
Creation/reattachment and compression also await preparation before adapter calls
(lines 341-343, 448-465 and 1140-1143). This worker did not edit session-engine.ts.

A synthetic adapter regression on the experimental admission implementation:

```text
register synthetic SocietasApp using local admission
create synthetic codex session, block first send on an owned Promise
send first -> disposition=started
send second -> disposition=queued
revoke admission in SQLite, then release the first send
expected adapter inputs: ['first']
actual adapter inputs: ['first', 'must not run after revoke']
AssertionError: automatic queue draining bypasses RPC admission/revocation checks
tests 1, pass 0, fail 1 (exit 1)
```

The regression used withPeerFixture, real synthetic SQLite/owned directories,
an in-memory fake adapter and deferred cleanup; no native agent/model ran.
Do not treat earlier green directory tests as an end-to-end security result.

Required supervisor decision: authorize a narrowly scoped session-engine.ts
change. Reuse its existing controller-owned resolveCwdForReattach callback (or
approve an explicit project-authority callback) to validate project/worktree
identity against the pinned session cwd immediately before native effects,
including automatic queue draining and after asynchronous preparation. Cover
creation, recovery, insertion, compression and queued send with fail-first tests.
Preserve stop/cancellation access after revocation. No protocol change is needed.
Do not emulate this with registry monkey-patching, agent-id-only checks, or
relaxation of policy roots. Review local provenance storage protection before
shipping; the experimental prototype was not an accepted security design.

## Commands And Results

All tests were serial, using installed dependencies and Node v24.22.1 directly
against TypeScript source without writing compiled outputs. Source loader:

```sh
LOADER='data:text/javascript,import {registerHooks} from "node:module";import {existsSync} from "node:fs";import {pathToFileURL} from "node:url";registerHooks({resolve(s,c,n){if(s==="@agent-phonon/core")return n(pathToFileURL(process.cwd()+"/packages/core/src/index.ts").href,c);if(s.startsWith(".")&&s.endsWith(".js")&&c.parentURL?.includes("/src/")){let u=new URL(s.slice(0,-3)+".ts",c.parentURL);if(existsSync(u))return n(u.href,c);}return n(s,c);}});'
node --experimental-transform-types --import "$LOADER" --test --test-concurrency=1 packages/core/src/local-directory-admission.test.ts
node --experimental-transform-types --import "$LOADER" --test --test-concurrency=1 packages/core/src/local-directory-admission.test.ts packages/core/src/workspace-directories.test.ts packages/core/src/project-path-ownership.test.ts packages/daemon/src/local-directory-admission.test.ts
node --experimental-transform-types --import "$LOADER" --test --test-concurrency=1 --test-name-pattern=BLOCKER packages/core/src/local-directory-admission.test.ts
node --experimental-transform-types --import "$LOADER" --test --test-concurrency=1 packages/core/src/workspace-directories.test.ts packages/core/src/project-path-ownership.test.ts
node packages/core/node_modules/typescript/bin/tsc -p packages/core/tsconfig.json --noEmit
node packages/daemon/node_modules/typescript/bin/tsc -p packages/daemon/tsconfig.json --noEmit
```

The admission files above were experimental and are now absent; commands are
the executed command forms, not an assertion that removed tests remain runnable.
Initial core fail-first: 7 tests, 1 pass, 6 fail (missing local API).
After storage-only implementation: 7 tests, 2 pass, 5 fail, including actual
`project path outside allowed roots` on SocietasApp registration. Daemon fail-first:
module export absent (exit 1); a prior loader attempt also failed Invalid URL.
Intermediate directory run: 11 tests, 10 pass, 1 fail (test expected content rather
than file.read's data field); corrected run: 13/13. Expanded prototype: 22/22.
Then the blocking queued-input regression failed 0/1 as recorded above.
After removal: existing directory/ownership tests 12/12, both noEmit commands
exit 0; core noEmit also passed on the intermediate prototype. Daemon noEmit
after removal resolves existing local core declarations, not prototype exports.
No consistency/release gate, full suite/build, or live runtime verification ran.

## Source SHA-256

Restored source files match HEAD (git diff --exit-code returned 0):

```text
fbd5b9858994824ad9e4ad393bf8fb1af693f0641c84172f515b8fb4ccd12d0a packages/core/src/client.ts
7b4bfd4cf4ec98208e7f32bd056894c27a51ef292a4905ac9e32218055e3c1cf packages/core/src/index.ts
423350a1dc936683d0ee872dbb509f194866484f8bf259de444a1a6ebcc43983 packages/core/src/policy.ts
0e8137d2f3ea197fd22ce4ab6c51e83814c86e667f8652948902f384a9a13b26 packages/core/src/project-manager.ts
3b632a63bf9b300c2393500123c633ec959f795e99c5a836cc202f4843638efe packages/core/src/store.ts
2565d5cc401e955f94332e00fd6942530376059385eac65e7410faf4fee391c3 packages/core/src/workspace-directories.ts
2389b8c8b517710f6db5777a8fdd0e7da44c8007bf59b4f0c3f6545b42c13737 packages/daemon/src/cli.ts
c9fcd9ac69be931520a2ad7779a7d51c1d3dfcb643c9d827ba23b1be0bff0b55 packages/daemon/src/config.ts
63a24916e5b687e73641c9b3909be84b2ce6d9937cc5ea18e7508787243c297d packages/core/src/session-engine.ts
dd9a9a7d992381b3c7133ff45ab0558afdae9473c44524bbb6cbcc1d98437b28 packages/core/src/adapter.ts
```

Deleted prototype test SHA-256 with failing queue case:
`f7fe79632f3ed8539ec6ee09c0778a8344cfc9faed8743abcb91e3fb57fffb09`.

## Cleanup And Visibility

Available disk before/after: 196 GiB (df -h .). Existing dependencies 100M,
core/dist 6M, daemon/dist 10M, daemon/dist-test 768K retained unchanged in size.
No build directory or extra dependency tree was allocated. Peer fixture base
agent-phonon-peer-tests-26f52dae1e2b was empty before and after runs; cleanup ran
through fixture ownership callbacks, including assertion failure. Test commands
exited; no task-owned services/devices remain. Global process enumeration was
denied by macOS, so unrelated process activity could not be established. Native
coordination presence/peers/inbox returned unconfirmed before edits and again
before cleanup; absence of conflicts was not assumed. No unrelated files cleaned.
