# Native Skill Install Receipts

## Scope

This is durable dispatch/receipt handling for nonce-bearing `skill.install`, not
an immutable filesystem publisher, OS sandbox, MCP authorization or a new default
MCP installer. Existing native merge installation remains a merge operation.
Unknown partial targets are preserved, never erased or replayed automatically.

`skill_install_receipts_v1` is reported only with a persistent native SQLite
store. An in-memory embedded receiver can expose current observations, but never
advertises restart durability. Matching Protocol/Core/Daemon and both SDKs are
required; sending a nonce to an older receiver does not establish this contract.

## Admission And Dispatch

An additive `skill_install_operations` table stores the authenticated namespace,
exact request identity, canonical parsed-payload hash, Agent/name/scope/Project,
phase, private dispatch owner/resource key and eventual result. It stores no
archive bytes, task contents, source paths or credentials as request material.
Existing skill rows and generic idempotency receipts are not backfilled into
invented new dispatch evidence. Request keys are nonempty, at most 512 characters;
both SDKs preserve them exactly.

The receiver records `prepared` before asynchronous preparation. Invalid inline
destinations are checked before target creation. Immediately before the first
target mutation it rechecks connection/policy/Project scope and atomically claims
`dispatched`. An index serializes each canonical target; resource keys use a
conservative portable case/NFC equivalence, including on case-sensitive hosts.
Different request IDs, runtimes, case aliases, nonce-less installs and removal
cannot bypass an active or unknown write on that target.

Final skill metadata, its private entry execution receipt and the confirmed
operation result commit in one SQLite transaction under the exact dispatch
owner. A failed final statement rolls metadata back, not filesystem effects.
Any failure after dispatch therefore retains `unknown`, not a safe retry claim.
Failure before dispatch records `failed` with known no-target-dispatch evidence.
Changed same-key payloads fail instead of replacing original history.

Connection disposal marks its claimed work unknown, drains its install promises
and prevents late metadata confirmation. Scope is checked again before commit.
An actual killed-process regression confirms that partial files and the durable
dispatch claim survive; reopening does not perform another write.

## Read-Only Status

Protocol: `skill.install.status` with `clientRequestId`, `agent`, `name`, `scope`
and `projectId` only for Project scope. The name is an exact lookup identifier,
not an interpreted path. Owner/path/source/permission/retry fields are refused.
Current method/runtime policy and Project namespace checks precede lookup.

TypeScript uses `device.skill.installStatus(params)`; Python uses
`device.skill_install_status(agent, name, scope, client_request_id, project_id)`.

| State | Meaning |
| --- | --- |
| `not_found` | No matching new-style record; `outcomeKnown=false`. Legacy effects/cache receipts may still exist. Not proof of no effects. |
| `prepared` | This operation has not claimed target dispatch. Preparation is not completion. |
| `dispatched` | The same store observes the actual live owner. Outcome is not yet known. |
| `unknown` | Claimed work has no confirmed result, or this observer cannot see its owner. Never infer that another owner stopped. |
| `failed` | Preparation failed before target dispatch. The original fingerprint remains reserved. |
| `confirmed` | This exact request committed its original result. It is historical, not proof of current tree contents or execution readiness. |

An independent store may report `controller_not_observed` while the original
writer is still active. This read does not rewrite the stored phase, fence the
live owner or start a replacement. A later confirmed result can still be read.
Neither lookup nor retry clears unknown resource locks. Explicit safe resolution
of partial legacy state remains unfinished; do not substitute a new nonce.

## Persistent Receiver Identity

`device.info.skillReceiverID` and `skill_install_receiver_identity_v1` identify
one persistent native SQLite namespace. Each authenticated account namespace has
its own randomly generated UUID; reconnecting or opening that store in another
controller retains it. An in-memory store never advertises this extension.
The ID is metadata, not a credential, permission or physical-filesystem proof.

New operation rows capture this ID in a nullable immutable `receiver_id` column.
Legacy rows stay null and are never retagged from a device observation, retry,
generic-cache receipt or a new controller. The namespace identity itself cannot
be updated/deleted through the native store. Receiver loss therefore cannot
turn old observations into a different receiver's proof.

Status adds `receiverID` only when `includeReceiverIdentity:true` is explicitly
requested and the exact original operation's captured identity matches the
current namespace identity. `not_found` has no receiver proof. Missing or legacy
evidence remains absent, never fabricated; the lookup does not create a missing
identity, change phase, claim dispatch or replay work. Requests without the
extension retain the previous response shape for strict older consumers.

Immutable publication may pin the observed ID with `expectedReceiverID`.
The native receiver checks that pin before generic idempotency-cache lookup and
again before physical mutation and final metadata commit. A cached result cannot
evade a changed receiver. The pin is part of the canonical request fingerprint;
changing it cannot adopt another operation. Unpinned native calls retain their
existing policy/namespace/Project contract, but do not establish a server's
original-receiver binding by themselves.

TypeScript uses `device.skill.publish({...params,expectedReceiverID})` and
`device.skill.installStatus({...scope,includeReceiverIdentity:true})`. Python
uses keyword-only `expected_receiver_id=` on `skill_publish` and
`include_receiver_identity=True` on `skill_install_status`. Defaults send neither
new field. Both SDKs return the original receipt without synthesizing proof.

The separate opt-in `includeRecoveryContext:true` / `include_recovery_context=True`
provides exact recovery observation metadata without changing default responses.
`skill.install.fence` can persistently prevent an uncertain original transaction's
late metadata confirmation under explicit local recovery permission. It leaves
the outcome unknown, target locked and files intact; it is not an Agent MCP
unlock or a cleanup primitive. See `NATIVE_SKILL_FENCES.md`.

A server may reconcile across a changed WebSocket generation only after
revalidating its original account/client/lease/Auth family/grant epoch, original
device credential/runtime-device identity, current owned Project and actual
receiver capability/ID. It must require an opted-in exact original nonce/Agent/
Project/bundle/publication receipt carrying that same captured receiver ID.
Legacy unbound operations remain generation-bound. A replaced device/store,
missing proof or unknown result cannot trigger a new write. A confirmed receipt
is still historical evidence, not current-content or model-readiness approval.

Generic-cache deletion cannot cause another write once the native ledger has a
confirmed result. Replaying an older confirmed request after a newer install
returns its original receipt, without undoing the newer metadata/files.

## Execution And Gateway

Managed skill admission and queued dispatch refuse a target with an active or
unknown install, including unchanged `SKILL.md` with partially updated helpers.
This does not establish whole-tree integrity, prevent all external edits or make
legacy in-place writes safe for already-running native clients. Immutable version
publication and frozen tree selection remain required for the default installer.

The existing human Canvas gateway can query the exact original receipt after an
ambiguous installation reply, only with the actual receiver capability and same
owned connection. It accepts only a typed confirmed result matching nonce,
Agent/Project/name/scope, bundle hash, path and optional version. Prepared/failed/
unknown/malformed/foreign results remain unconfirmed. It never sends a second
installation or borrows a replacement connection, and rechecks the live device
credential before returning. This is read-only acknowledgement reconciliation,
not proof that human-edited files still match the old archive.

## Remaining Gates

The native ledger is namespace/request scoped. It is not the separate durable
server operation bound to the original MCP client/lease/Auth family/grant epoch,
Canvas association and bundle. Those source fences, whole-tree immutable staging
and activation, persistent root authorization, target filesystem/race acceptance
and real installed-client/model/HITL/account acceptance on all three devices are
still required. No general filesystem, credential, permission, human-decision or
default MCP installation tool is exposed by this increment.

The subsequent native immutable version path is implemented separately in
`NATIVE_IMMUTABLE_SKILLS.md`. It reuses this dispatch ledger while preserving the
legacy merge contract, and still does not replace original-MCP-source server
authorization or the remaining physical-device/installed-model acceptance.
