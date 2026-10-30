# Claude Code Current-Turn Input

The local binding uses the installed Claude Code 2.0.1 bundled public SDK and
the Node runtime paired with that owner-selected CLI. It does not patch an
installed launcher/SDK, install another dependency tree, change credentials or
rewrite personal configuration. The SDK parent and native child use the paired
interpreter; the owned startup preload restores the original tool PATH.

Streaming stdin is not the insertion primitive. Installed characterization
observes the same message entering a tool result and then being repeated as a
later native input, with an additional model request. A streaming or replay
acknowledgement therefore cannot be relabelled as exactly one current-task
insertion.

The insertion path uses the original root's qualified `PostToolUse` context
API in one single-input SDK query. The original prompt, native session/cwd,
transcript path, observed root tool ID, startup-policy proof and native token
headroom must match. Child tool callbacks cannot drain the root inbox.

The controller authorizes the batch before native context effects. The binding
reports context application only after that hook output and the same original
root's next native `message_start` continuation. An offer alone cannot finish
the input. This is native-context application, not a fabricated native user
message or provider-payload/remote-consumption observation. Peer data retains
its separate weaker evidence ceiling.

The SDK ends the single original query normally. A completed/aborted query
rejects unconfirmed input and closes its private channel; no queued prompt,
query restart or second task is used to obtain a receipt. Existing native
permission settings, explicit tool denial and owner-selected standalone
settings remain authoritative.

Installed tests use an isolated home and controlled local Anthropic provider,
not paid-model or physical cross-device evidence. The adapter uses the shared
original-window/source fence independently of the separate directory-admission
changes. Production release remains a separate requirement.

October 30 real-MCP acceptance passes six cases: public HTTP and the maintained
managed stdio proxy, each covering insertion, original-window closure and native
MCP sender denial. The actual Codex sender calls `phonon_send_message` twice with
one ID/body; the installed Claude receiver retains its original native UUID and
one SDK query/result. Content appears in its actual next root provider request,
and the source-confirmed delivery precedes original execution completion. The
managed grant belongs to the sender; receiving ordinary input does not require
enabling the separate project coordination mailbox.

This full chain found two real integration gaps that isolated adapter tests did
not exercise. A rejected optional peer inbox used to prevent ordinary offers.
The shared ingress now ignores that optional read failure without consuming or
acknowledging peer mail, then revalidates the ordinary input's original scope.
Cancellation, changed native identity and revoked ordinary sources still reject.

Native tool-result records can also arrive while a checkpoint or authorization
RPC is pending. The hook now recomputes conservative native headroom on both
sides of authorization, including the exact context carrier and accumulated
tool/peer costs. Unknown/exhausted capacity, a changed inference generation,
a reduced window, an increased output reserve and concurrent tool growth remain fenced. Small late
records may use remaining capacity; a large late record cannot force context
into a full window. Qualified native-context application is still confirmed by
the original root continuation, never an offer alone.

The isolated Git-object MCP matrix, 513 configured delivery regressions and
99 combined native/ingress/controller regressions pass without skips. They use controlled local provider responses and owned native
state, not paid inference, physical cross-device execution or activation. See
`phonon-work/agents/NATIVE_MID_TURN_MCP_TEST_RUN_2026-10-30.md` for the maintained
runner, source-tree provenance, failed attempts and final cleanup evidence.
