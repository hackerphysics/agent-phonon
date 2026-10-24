# Native Group Messages

`conversation.message` is a current-turn device-to-server request. The device
advertises `native_conversation_messages_v1`; the control plane owns group
membership, projects, routing permission, persisted messages and relay budgets.
Discovered harnesses and ordinary worker Agents do not become group members.

This is the human-visible discussion/result-exchange surface. Agent/DE session
collaboration is a separate upper-level surface described in
`PROJECT_COORDINATION.md`; it supports many collaboration purposes and forms.
Both can reuse the same messaging foundation, including identity, transport,
routing, durable delivery, idempotency, reconnect, observations and audit.
Sharing those mechanisms does not merge their membership, grants, presentation,
notification, dispatch or receipt contracts. A collaboration message does not
become a group message by changing visibility, and a group message is not
automatically mirrored into session mailboxes.

## Agent Interface

Embedded adapters receive `options.conversationMessage(input)`. Shell-capable
harnesses can POST JSON to `$AGENT_PHONON_MESSAGE_URL` using the same scoped Bearer
token as the native interaction channel. The optional OpenClaw tool is
`phonon_conversation_message`, under the existing explicitly enabled
`nativeInteractions` plugin and current-run host binding/tool policy.

Inputs are strict and accept no conversation, owner, sender, workspace, routing
endpoint or controller lineage:

- `{operation: "members"}` returns actual canonical DE IDs/names, the originating
  project group, the sender ID, enabled switch and current limits.
- `{operation: "send", requestId, text, mentionIDs, mode, attachmentIDs?}` addresses 1-8 distinct
  other group DEs. Text is bounded to 4,000 UTF-16 units. The UUID request identity
  is explicit. Mode is required: `insert`, `wait` or `queue`.
- `{operation: "status", requestId}` reads this DE's prior message receipt in the
  current group. It neither sends a message nor triggers dispatch.

Only explicit IDs trigger recipients. A plain final reply containing `@Name`
does not start another DE, and messages do not invoke the coordinator by default.
The sender is derived from the active native run, never from model arguments.
An actual DE must currently belong to the originating project group. Private
chats, ordinary Agent/Role Sessions and delegated workers cannot use group routing.

`recorded` means durable chat/input records, not executor acceptance or completion.
Recipient receipts retain the same honest insertion/wait/queue/failure semantics
as human-originated inputs. Known policy refusals return `not_accepted` and an
error code without creating a chat message. Missing status is `not_found`.
Transport failure is uncertain: query status or retry the identical request and
body in the original turn, never generate a fresh identity to hide uncertainty.
An old callback cannot survive its turn. A later active turn of the same DE may
query its prior receipt, but may not silently rebind a send to a new source.

Tool-sent prose is already visible as a message from its actual DE. The DE should
not repeat it verbatim as its final reply. Incoming peer content is separately
labelled as a DE message, not a human decision or approval.

## Explicit File Handoff

Devices supporting file-bearing messages also advertise
`native_conversation_message_files_v1`. The optional `attachmentIDs` array accepts
up to five distinct `native-file:<lowercase UUID>` references; `text` may be empty
only when files are present. Publish local files through the current document
channel first and use its `serverRef`. Verified received input manifests also
include `serverRef`; their local paths are not transferable references.

The service resolves immutable bytes and metadata only for the same owner,
originating group and project. Uploaded-but-unsent human drafts, unpublished
files, cross-chat references, URLs, paths and caller-supplied metadata cannot
become peer inputs. Limits are 20 MiB per file and 25 MiB per message.

Recipient workspace delivery and read-back verification precede model dispatch
or tool-gap insertion. Queue keeps separate turns; wait combines eligible inputs
and their files without merging the chat messages. Missing capabilities, invalid
scope or file-preparation failures never silently remove files or change mode.
`recorded` is not proof of verified delivery or acceptance. Retry uncertain sends
with the original request and body, including attachment IDs. A separate explicit
file-preparation retry may reuse an unstarted run, not repeat a model execution.
Cross-conversation forwarding remains unsupported.

## Durable Causality

The Phonon control plane currently enforces six automatic hops and 24 addressed
inputs per human origin, with up to 64 combined causal roots. Fan-out charges
each addressed recipient. These limits are server-owned, not client preferences.
They survive restart, duplicated requests, waiting batches and tool-gap insertion.
New human turns start a fresh origin; human insertion does not erase an executing
turn's existing origins.

Waiting still combines all eligible waiting inputs into one turn. Mixed origins
retain every ancestor budget and their maximum depths; merging cannot reset a
loop counter. An insertion charges attempted causal depth before its ACK so an
outgoing callback cannot race that acknowledgement and evade limits. This is
causal accounting, not a claim that the insertion was applied.

Disabling mutual mentions blocks existing chains and removes undispatched peer
inputs. Re-enabling does not resurrect them. Membership/project changes fence
new routing. Already in-flight/accepted work is not falsely described as undone.
Ordinary human input, boards, memory and historical messages are not cleared.

## Controller And SDK Contract

The controller stamps `nativeRunId`, `workflowId`, `sessionId` and `turnId` into
`ConversationMessageParams`. The server verifies live source proof, device/owner,
current membership, workspace/project rights and source lifecycle, outside DB
locks where remote checks are necessary. Model-provided routing is rejected.

TypeScript servers register `device.setConversationMessageHandler(handler)`;
Python uses `device.set_conversation_message_handler(handler)`. Awaitables are
awaited; an absent handler fails explicitly. Neither SDK invents group data or a
successful receipt. This channel does not implement off-turn proactive output,
detached Session recovery or an approval policy.

Real WebSocket clients dispatch long incoming requests without blocking reverse
RPC proofs/responses. Welcome/ACK arrival ordering is retained; session-specific
mutation and interruption rules still belong to their existing controllers.
