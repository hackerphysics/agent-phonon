# Conversation Workflow Delegation

`native_workflow_delegation_v1` adds the typed device-to-server request
`conversation.workflow`. The controller stamps native run/workflow/Session/turn
identity; model arguments never select an owner, chat, RPC method or endpoint.
The protocol registry contains 100 methods, with matching TS/Python handlers.
`native_detached_workflow_v1` adds optional detached delivery to the same method;
it does not introduce a raw RPC or another method.

## Agent Surface

Embedded adapters receive `options.conversationWorkflow(input)`. Shell-capable
harnesses can POST JSON to `$AGENT_PHONON_WORKFLOW_URL`, using the existing
current-turn interaction Bearer capability. The loopback route shares origin,
size, concurrency and lifetime protections with native interactions. Explicitly
enabled/allowlisted OpenClaw plugins expose optional `phonon_workflow`; no tool
exists without its current-run binding and workflow endpoint.

Current OpenClaw releases discover plugin tools from `contracts.tools` in
`openclaw.plugin.json`. The prepared plugin declares all six native tools and
marks them optional in `toolMetadata`, matching runtime registration. This is
discovery metadata, not permission: explicit plugin enablement/tool allowlisting
and the current connection/run binding are still required. Updating the manifest
does not expose capability tokens to the model or shell.
Startup and model-tool registry registrations share the same module-owned
binding manager; registry rebuilds must not create an unrelated unbound hook.
Bindings still belong to the original live admin connection and exact run.
Disconnect, expiry and release invalidate tools across those registrations.

Operations:

- `catalog`: optional canonical `projectID` and nonnegative `offset`. Returns
  explicitly created Agents, Roles, Projects and workspace binding IDs, never
  credentials. The native control plane pages resources and returns `nextOffset`
  when necessary. A discovered harness is not an Agent.
- `execute`: a unique UUID `requestId`, `plan`, optional `replacesRequestId` and
  optional `delivery`. Omission/`wait` keeps the synchronous decision/results
  contract. `detached` returns a durable `status` with `data.detached=true`, not
  completion. The source DE can end its turn while review/work stays visible.
  Retry uncertainty with identical full input including delivery, never a new ID
  or silently changed mode. Controllers require the new device capability first.
- `status`: original `requestId`, optional `nodeID` and nonnegative `offset`.
  Reads current state or full result chunks without executing again. Chunk
  offsets count Unicode code points. Workers may read only their own parent
  plan; a current DE may inspect prior plans in its originating conversation.

The result's outer status describes the RPC (`catalog`, `status`, `finished`,
`unknown`). Always inspect `data.state` for the actual execution outcome.
Rejection, requested changes, cancellation and unknown are not successful work.
Catalog pages shrink when necessary to stay within the native tool byte limit;
follow the returned offset rather than assuming a page size. Execution RPCs
return bounded IDs/result summaries, not duplicate role prompts or the full
frozen plan. The phone's authorized detail endpoint retains those full records.

```json
{
  "operation": "execute",
  "requestId": "22222222-2222-4222-8222-222222222222",
  "delivery": "detached",
  "plan": {
    "projectID": "33333333-3333-4333-8333-333333333333",
    "title": "Implement and review",
    "goal": "Deliver verified changes",
    "review": "request",
    "maxParallel": 2,
    "nodes": [{
      "id": "implement",
      "title": "Implement the change",
      "agentID": "44444444-4444-4444-8444-444444444444",
      "bindingID": "55555555-5555-4555-8555-555555555555",
      "input": "Implement the requested change and report evidence.",
      "dependsOn": [],
      "reasoning": {"level": "high"}
    }]
  }
}
```

Use actual catalog IDs, not these examples. A node may select an independent
canonical `roleID`. No raw path, model override, credential or `agentConfig` is
accepted. Plans are bounded DAGs: 1-16 unique nodes, valid acyclic dependencies,
1-4 parallel tasks, and a bounded document size. Other low-level workflow modes
remain available through the existing protocol; this conversation surface is a
cross-device DAG broker, not an arbitrary protocol proxy.

## Review Is Source-Selected

`review` is required. `request` means the DE is asking the human to approve the
specific plan. `not_requested` explicitly declares that the DE did not ask for
approval; the phone never infers this choice or manufactures a human decision.
Device-local permissions and user/project authorization still apply either way.

The control plane freezes Agent/Role revisions, native harness/model, actual
device, canonical binding/directory, reasoning and instructions. The displayed
version/content hash identifies that immutable scope. Changed resources cannot
silently alter approved work. A rejected/changes-requested plan may be superseded
using a new request UUID and `replacesRequestId`; old content/decisions remain
readable and the replacement gets a new version and its own review choice.

No state-recovery path may bypass the explicit requested-review decision. The
human response, task dispatch acceptance, and verified results remain distinct.
The execution API and model tools cannot submit a human approval.

## Execution And Isolation

Only an actual DE may catalog/execute. Groups cannot retarget another Project;
private chats can explicitly select an accessible canonical Project without
turning the DE's private chat/home into that Project. Ordinary workers never
join the group, acquire a DE persona, or send chat replies as members.

The control plane schedules frozen nodes on their actual devices, reusing each
daemon's durable single-node workflow executor. Dependency inputs contain actual
recorded results; excerpts are marked and full results remain retrievable.
Each child has its own immutable dispatch identity, Session/turn lineage,
contiguous persisted output and cancellation tombstone. Lost ACKs are reconciled
by the original identity. Ambiguous dispatches are not automatically rerun.
Known native running receipts can restore an uncertain transport projection.
Per-plan concurrency is rechecked under the owner lock at admission.

Workers use existing burner Session cleanup; the originating DE chat is retained.
Child reasoning receipts do not overwrite the DE's context controls. Current
worker board changes retain real canonical worker authorship. Worker questions
appear through the original DE/chat with an explicit executor in details and
the existing typed response/consumption receipt contract. Worker callbacks cannot
launch another workflow or impersonate their DE coordinator.

One DE-authored plan card updates in place. Child results stay in execution
details and return to the source DE; the DE produces its own final reply. The
service does not insert worker prose as a fake DE final message. Human insertion
targets only the DE's current chat turn, never an arbitrary child task.

Stops fence new admission and request verified child cancellation; they do not
undo completed effects. Already completed work is not relabeled cancelled merely
because a stop arrived late. A source stop fences new work. Synchronous plans also
end with their source turn; explicitly detached plans can continue within frozen
scope/current authority after that turn ends. Child tools still require the
child's own active run, parent plan and binding. Stopped sources, changed group
Projects and finished children cannot reuse callbacks.

A controller may queue one actual DE report turn in the originating conversation
after a detached plan ends. It is not a fake human message or copied worker
prose. The report uses the retained chat and current authorization, profile,
workspace and durable dispatch checks; report status is separate from work
completion. Offline/busy/paused DEs wait, and expired authority needs an explicit
human renewal. Completed/unknown dispatched attempts are never reset or blindly
run again. Known pre-dispatch report failures may be explicitly retried while
preserving their old execution records. Pure automatic report chains are limited
to six turns; human review/renewal provides a new authorization point without
resetting group-peer causal budgets.

Workflow delegation does not itself grant login renewal or proactive control.
Auth/Agents own bounded login renewal; independent native text observations use
the separate [proactive channel](NATIVE_PROACTIVE.md), not ended workflow tools.
Native login expiry still applies. Unknown transport or authorization never
permits a new model attempt merely because a receipt was lost.

## SDKs And Evidence

### Explicit Worker File Handoff

Optional node `attachmentIDs` select canonical `native-file:<UUID>` references
from the originating conversation and execution Project. Optional
`artifactSources` name direct dependency nodes whose actual published files the
worker needs; duplicate sources, unknown/non-direct dependencies, device paths
and duplicate file IDs are rejected. Dependency edges alone never imply file
forwarding. These fields are preserved by both SDK callback dictionaries and
the native tool schema; the method registry remains at 100 methods.

The control plane freezes existing file metadata and the output-source policy
with the plan. Once dependencies complete, it resolves a bounded immutable task
manifest (five files, 25 MiB total, 20 MiB each), writes the actual bytes through
the existing device file policy and verifies them by read-back before model
dispatch. It does not grant new file-policy permission. Unknown preparation can
be explicitly retried only on the same unstarted task; a dispatched or uncertain
model run is never reset. Synchronous DE calls remain waiting while file
preparation needs attention. A dependency that publishes no files does not
fabricate an input. DE peer/cross-chat file forwarding remains separate.

```ts
device.setConversationWorkflowHandler(async params => {
  return await authorizePersistAndRun(params);
});
```

```python
device.set_conversation_workflow_handler(authorize_persist_and_run)
```

An absent handler is unsupported, never a successful empty catalog/plan. The
handler owns authorization, review state and durable orchestration, not the SDK.
See `fn-conversation-workflow.test.ts`, Python options/cross-language workflow
tests, and the mobile service's actual local HTTP/PG/Gateway/two-daemon tests.
Automated execution adapters are deterministic, not paid-provider inference.

SDK connection lifetime is terminal per peer: retained device/session calls after
disconnect are rejected immediately, failed sends remove their pending entries,
and late handler replies are not written to closed transports. TypeScript and
Python share this behavior. A replacement connection owns a new peer; closing an
old connection cannot make a new model attempt valid.
