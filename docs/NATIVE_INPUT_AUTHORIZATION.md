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
