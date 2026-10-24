# Native Unconfirmed Skill Metadata Fences

## Scope And Local Authority

`skill.install.fence` is a separate scoped recovery primitive, not a default
Agent MCP tool, filesystem cleanup, permission grant or installation confirmation.
It requires explicit device-owner `allowSkillRecovery:true` and the current
method/Agent/owned-Project policy. `trustLocal` never grants it implicitly.
`skill_install_fence_v1` reports persistent implementation availability, not
caller permission or target-OS acceptance.

The server must reserve this primitive for its human-authorized safety workflow.
Neither the current-turn native MCP catalogue nor Unified Phonon MCP tools expose
it, a raw RPC proxy, a force-unlock operation or an Agent-settable recovery policy.

## Exact Observation

Request `skill.install.status` with `includeRecoveryContext:true` to observe
`recovery.revision`, current namespace `receiverID`, nullable original receiver
binding and any existing fence ID. The observation hashes the actual durable
operation plus current selection revision. It is a CAS value, not a grant or
evidence that an independently observed writer stopped.

Status never creates a missing receiver, changes phase, claims dispatch or
backfills legacy proof. Ordinary status requests retain their old response shape.
Global host recovery is not offered; the primitive accepts Project scope only.

## Atomic Fence

The request has its own `clientRequestId` plus `originalRequestId`, exact
Agent/name/Project, observed `expectedReceiverID` and `baseRecoveryRevision`.
It cannot contain a path, archive, actor/owner override, approval or deletion flag.
Inside one SQLite write transaction it rechecks namespace/receiver/owned Project,
the original operation and revision, and only permits an actually claimed
`dispatched` or `unknown` operation with a retained target key. Prepared, failed
and confirmed records cannot be relabelled through this path.

It stores an immutable independent fence receipt, marks the original state
unknown and records its fence ID atomically. Exact retries return the same
validated receipt; changed identity/payload or stale observations fail. This
uses its own durable ledger rather than a generic cached response. An old
installation/publication cannot bypass its fence using a generic cached success.
Original receiver tags and their unknown legacy null values remain unchanged.

The old writer may still finish physical I/O. It cannot subsequently confirm or
activate metadata: final commit requires a still-dispatched, unfenced original
claim. That condition also fences older controllers that honor the dispatched
claim. Existing installed metadata and selection/history are not changed by the
fence. A previously selected immutable version may continue to load its original
unchanged tree while an unselected uncertain tree stays preserved.

## Deliberately Not Released

The result is `disposition=unconfirmed_metadata_fenced`, `outcomeKnown=false`,
`targetLocked=true`, `filesDeleted=false`, `originalWritesMayContinue=true`.
These describe this metadata fence, not quiescence, absence of physical effects,
complete work or permission to delete. The original active-resource guard remains
in force for old/new request IDs, legacy loading, merging and removal. No target
lock, file or installed/human metadata is erased.

Actual safe replacement/release still requires a separate human/source protocol,
Canvas late-record fencing, legacy partial-directory quarantine and retained
session/workflow/version-reference handling. Those gates remain unfinished in
the main repository's `docs/mcp-skill-recovery.md`. Do not replace them with a
phase edit, a cleared index or a fabricated completed installation.

## SDKs And Acceptance

TypeScript: `device.skill.installStatus({...scope,includeRecoveryContext:true})`
then `device.skill.fence(params)`. Python: keyword-only
`include_recovery_context=True` on `skill_install_status`, then
`skill_install_fence(...)`. Both return the original typed metadata-fence result
without synthesizing success. Protocol/Core and both SDKs are updated together;
the method registry now has 114 entries.

Local cases cover both confirmation/fence orders, a live partial writer,
immutable publication after physical tree completion, independent store reopen,
legacy null proof, stale/cross-account/receiver scopes, exact retry identity,
immutable history, forbidden default/trustLocal policy and generic-cache denial.
A prepared daemon/default broker/real SDK WebSocket case preserves an actual
unknown target and its files. Adapters are controlled, not real installed models.
None of this replaces Linux/Windows filesystem or three-device client/model/HITL/
account acceptance. No remote build, dependency installation, test suite or new
overlapping remote Agent is needed or authorized by these local results.
