# Native Input Authorization

This is the private native checkpoint contract, not a model tool, protocol RPC,
human approval or replacement for the harness's own permissions.

An extension prepares a bounded batch at its original native session's model
boundary. Its optional `inputEvidence` declares that particular request's
maximum evidence. A caller-configured transport may retain `context_hook` even
when other routes in the same harness expose `provider_payload`. The controller
must not promote that weaker request into ordinary current-turn insertion.

Before a provider effect, the extension calls `/peer-context/authorize` with the
exact boundary, native session, message IDs and intended evidence. The bearer,
host/origin and live source checks are the same as the existing checkpoint.
The access binding must implement `authorize`; absence fails closed.

Authorization is read-only. It revalidates the original input's repeatable
`beforeApply` guard and any independently sourced peer offers. It does not
settle an insertion, mutate the peer journal, acknowledge consumption or grant
another task permission. A denied batch must not enter the provider request.

The extension invokes its qualified native transport once, then reports only
the evidence it can actually observe through `/peer-context/observe`. A native
payload receipt is not remote provider acceptance, model obedience or task
completion. An uncertain observation after submission must not cause another
provider call, a second task or a silent queue fallback.

Ordinary insertion and project peer mail retain separate identities and
receipts. Already confirmed input IDs remain bound to their exact original
boundary, including repeated reads or observations. Closing the turn rejects
unconfirmed input and closes the private channel; it never becomes a later
turn's prompt.

The reusable inbox and peer controller implement this contract independently
from any adapter's capability flag. Each harness still needs its own qualified
native implementation, lifecycle checks and installed current-task acceptance.
See `MID_TURN_INPUT.md` for the ongoing all-harness integration checkpoint.

## Native Context Binding

An independently qualified adapter may select `receipt: "native_context"` when
its supported native API applies hook context and exposes the same original
root's subsequent model continuation. This is an adapter-owned choice, not a
producer-selected evidence upgrade. Ordinary weak/custom transports retain
the default provider-payload requirement.

Such a binding still prepares and authorizes the exact bounded input. A hook
offer, returned value or authorization cannot settle it. Only the separate
`/peer-context/context-applied` confirmation for the same native root, original
boundary and message IDs may do so after native continuation is observed.
The ordinary context-hook observation remains insufficient.

Native context confirmation is neither an invented native user message nor a
provider-payload/remote-consumption receipt. Independently sourced peer offers
keep their existing `context_hook` evidence ceiling. A default payload binding
cannot opt itself into this route, and a context binding cannot claim stronger
provider evidence. Unconfirmed input still expires with the original turn.
