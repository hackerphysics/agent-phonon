# Workflow Skill Selection

Status: implemented and verified locally; not released or activated on the daily
devices. This is a prerequisite for Phonon's canonical Canvas execution mapping,
not a replacement session model or a claim that Canvas dispatch is finished.

## Protocol

`WorkflowNode.skills` accepts the same bounded array as `session.send.skills`:
at most sixteen names or structured selectors. DAG nodes, graph executors and
workers, and discussion participants/chairman all pass these selectors to the
existing SessionEngine. Node-scoped skill environment resolution uses the same
selectors. A workflow schedule retains its node fields through persistence and
dispatch. Existing nodes without skills retain their previous behavior.

Structured selectors additionally accept optional exact `revision` (lowercase
SHA-256) and `installationId` (UUID). For an immutable publication, take these
from the real native descriptor's `revision` and `publication.versionId`:

```ts
const selected = {
  name: skill.name,
  scope: "project" as const,
  revision: skill.revision,
  installationId: skill.publication.versionId,
};
await device.workflow.run({
  project: ownedRuntimeProject,
  clientRequestId: originalRequestID,
  plan: {mode: "dag", nodes: [{nodeId: "work", agent, model, skills: [selected], input}]},
});
```

Pins are checked against an actually owned, confirmed installation before model
invocation. They do not search another namespace/Project/runtime or grant access.
A same-name, same-semver replacement cannot satisfy the old identity. `force`
still means loading intent; it cannot bypass receipt, content, ownership or HITL
checks. Legacy names/scope/version selectors remain valid.

A dependent workflow node checks its selector when admitted to SessionEngine;
replacement before admission fails instead of rebinding. A native Session turn
already admitted to its queue retains the existing frozen immutable binding and
may load that retained version, subject to current authorization, revocation and
full-tree checks. This is not deletion or safe-cleanup permission. Workflow retry
hashes include selectors; a changed selector cannot reuse an old request ID.

## Compatibility

The receiver advertises `workflow_skill_selection_v1` and
`pinned_skill_selection_v1`. These describe syntax/validation support, not an
installed skill, filesystem readiness, model availability or permission.

Current TypeScript/Python SDK helpers check the relevant capability on the same
device before sending workflows or schedules with node skills, and Session/
schedule calls with exact pins. Missing/malformed capability observations and
failed reads stop before the mutator; there is no fallback to unpinned names.
New-feature packets are captured before that asynchronous read, so later caller
mutation cannot substitute fields. Ordinary legacy unskilled calls add no probe.
The Python helper retains JSON-compatible legacy tuple collections too.

Raw `device.call` users must perform this capability check themselves. An older
daemon can otherwise ignore the unknown node field. A controller with a durable
dispatch claim must perform capability preparation **before** its claim and send
the exact captured request through its fixed RPC path; do not insert an SDK
preflight read after a commit-to-send fence. Capability checks are not authority
checks and do not replace the controller's current source/Project/device fences.

## Canonical Conversation Workflows

The separate `ConversationWorkflowNode` describes canonical Phonon worker Agents,
not raw native harness IDs. Its optional `skills` array requires one to sixteen
unique `{name, revision, installationId, version?}` selections. It accepts neither
global scope nor `force`, paths, owner IDs or authority overrides. The controller
resolves the canonical Agent and workspace binding under the original source,
then supplies the native Project scope itself.

An active DE can call its existing `phonon_workflow` channel with
`{operation:"catalog", projectID, skillTarget:{agentID,bindingID}, offset?}` to
read bounded confirmed immutable Project selections. Pass exact returned
selections on the corresponding plan node. Catalog metadata is not proof of
filesystem readiness, a skill's business-source authority or permission to run.
The receiving controller must verify those separately. Omitted skills preserve
the old behavior and do not cause extra reads.

Core additionally advertises `native_workflow_skill_selection_v1` for this
conversation-channel syntax. Both SDK inbound handlers already pass the complete
JSON to their explicit controller callbacks, including `skillTarget` and node
pins; no new SDK method or authority fallback is added. Controller preparation
must still precede the durable dispatch claim. The canonical Phonon controller
also checks syntax support on the actual sending connection, so a downgrade
after preparation cannot silently drop a selected skill.

Canonical nodes additionally accept `canvasSkill` references with `productID`,
`deviceBindingID`, current post-install `baseBindingRevision` and `operationID`.
The controller resolves and freezes current Canvas authority, product revision,
association and actual installation receipts, deriving the native skill pin
itself. No source credentials, paths, hashes or approvals may be supplied by the
caller. The derived selection shares the sixteen-item maximum and must not also
be supplied generically. `native_workflow_canvas_skill_v1` advertises the channel
syntax only; it is not a Canvas grant or an installed-ready claim. SDK inbound
handlers transparently retain these reference fields in their explicit callback.

## Evidence And Limits

The scoped local source regression has 136 Node passes and 32 Python passes with
zero failures/skips. It includes real native immutable trees, all three workflow
modes, a real manual workflow schedule, stale/queued/version/account rejection,
workflow recovery/input/result and existing isolation/HITL regressions. The
prepared actual Canvas archive is exercised rather than skipped. SDK boundary
tests separately reject legacy/malformed capabilities and preserve original
packets and no-skill behavior. Earlier fixture-shape failures are retained as
diagnostics, not counted as successful execution.

An extracted self-contained daemon also passes actual local SDK/WebSocket/Core/
C-helper loading and stale-pin rejection with a controlled adapter. It starts
no installed harness or real model. Three-target artifacts are prepared only on
the Mac with target-correct helpers; no daily device or personal profile is
changed. Concurrent harness receiver changes are preserved, not reverted, and
the final artifact must match its recorded integrated source snapshot.

Evidence is preserved under Phonon's local acceptance directory
`mcp-workflow-skill-selection-r1`. Default MCP installer rollout, canonical Canvas
execution/provisioning mapping, safe retained-tree cleanup, complete repository
release gates and real three-device/client/model/HITL/account acceptance remain
separate requirements. No protocol method or credential/permission API is added.
