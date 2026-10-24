# Native Conversation Boards

Every native private chat, project group and ordinary Agent conversation has an
optional server-owned shared board. It is a concise working state, not another
transcript, memory file, project registry or task approval policy. Clearing it
does not clear messages, files, long-term memory or another conversation's board.

## Current-Turn Access

`native_conversation_board_v1` advertises the real controller channel. For native
chat reply turns the controller stamps `nativeRunId`, `workflowId`, `sessionId`
and `turnId` on the `conversation.board` device-to-server request. Model-authored
inputs never accept a destination conversation, project, device, author or route.
Non-native turns do not receive this channel.

Embedded adapters call `SendOptions.conversationBoard(input)`. CLI harnesses can
POST JSON to the per-turn `AGENT_PHONON_BOARD_URL` with the same
`AGENT_PHONON_INTERACTION_TOKEN` bearer capability used by the human interaction
channel. The bound loopback endpoint is `/board`; it rejects browser origins,
invalid tokens, bodies over 64 KiB and unknown fields. Board and form operations
share the turn's concurrency/submission bounds. Ending the turn closes the
listener and invalidates retained callbacks. Capabilities never enter prompts.

The explicitly enabled OpenClaw plugin also offers the optional native tool
`phonon_conversation_board`. Its host registration binds a same-origin `/board`
endpoint, and the tool uses the same generation/run/tool-call proof and one-use
parameter permit as native human-input tools. Add this tool to the applicable
OpenClaw allowlist explicitly. Older bindings without a board endpoint expose
no board tool. The plugin cannot use the legacy fail-open bridge to authorize
board operations. See [Native Agent Interactions](NATIVE_INTERACTIONS.md).

## Read, Write And Conflict

Read with `{"operation":"read"}`. It returns
`{status:"ok", board:{conversationID, goal, items, revision, authorID, updatedAt}}`.
A never-written board has revision zero and empty content.

Write a complete concise replacement, retaining item UUIDs for unchanged items:

```json
{
  "operation": "write",
  "requestId": "a517446a-025b-461b-81fd-8c47988d2a7c",
  "baseRevision": 2,
  "goal": "Verify the release",
  "items": [{
    "id": "254431af-7be4-4b7e-a2c3-937e4517b040",
    "kind": "todo",
    "text": "Check device results",
    "completed": false
  }]
}
```

The goal is at most 70 graphemes, each item at most 60, and the board at most
400 graphemes across at most eight items. Item UUIDs must be unique. Items are
`todo` or `note`; optional `sourceMessageID` must identify a message in this
same owner/conversation. Blank items and invalid/overlong content are rejected,
not truncated. Emoji and combining characters use grapheme counting.

A successful write increments the board revision, records the actual executor
as author and preserves the prior revision in the same history used by human
edit/clear/restore commands. It does not add a chat message. An empty goal and
empty items explicitly clear the board. A later human restore is a new human
revision, not a change to the historical author's identity.
The phone previews the full historical goal/items before explicit restoration,
freezing the current base revision while that preview is open. Clear confirmations
also retain their observed version. Failures are displayed within the active
board/revision view instead of being hidden behind its sheet.

Stale `baseRevision` returns `{status:"conflict", board:latestBoard}` without a
write. The agent must decide how to merge; neither the app nor controller
blindly retries with a newer version. A fresh human edit has exactly the same
conflict behavior, and the phone preserves its unsaved draft.

Successful agent writes persist an owner/request-UUID receipt atomically with
the board/history change. An identical in-turn retry returns its original result
with `replayed:true`, even after a later board edit. Reusing that UUID with changed
content or lineage is rejected. Transport timeout/disconnection does not prove
that a write was rolled back: retry the identical request while the original turn
is valid, or read current state from a fresh authorized turn. Stopping a task
does not undo an already committed board update.

## Authorization And SDKs

The control plane resolves the origin from the frozen native run, not the request
body's desired destination. It checks the authenticated device/owner, current
reply-node Session/turn proof, group/Agent membership, private DE home or canonical
project binding, live original author authorization, archive/stop/finished state
and project writer access for writes. External authorization/proof RPCs happen
outside the database transaction. Under the owner/conversation lock it rechecks
the source and native session authorization before applying CAS and provenance.
Human board mutations also require current project writer access.

TypeScript servers register `device.setConversationBoardHandler(handler)`;
Python servers register `device.set_conversation_board_handler(handler)`.
Both await the handler and reject unsupported use when it is absent, rather
than returning a fabricated successful empty board. Applications must authorize
and persist the controller-stamped origin before returning a result.

Deterministic controller/loopback and PostgreSQL/Gateway/daemon tests cover
reads/writes, private/group isolation, provenance, duplicate replay, conflicts,
clear/history, authorization failure and stopped sources. Python additionally
exercises a real cross-language read/write request over WebSocket. The installed
OpenClaw SDK smoke uses an isolated home; it does not activate a personal Gateway
plugin or start model inference. Wider live-provider execution remains separate.
