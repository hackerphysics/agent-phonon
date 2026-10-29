# Codex Native Current-Turn Input

`CodexAppServer` owns one supervised native app-server process and one original
turn. Steering never calls `turn/start`, forks a thread, restarts an executor or
queues a replacement task. It sends `turn/steer` with the original native
`expectedTurnId` and a private `clientUserMessageId`.

A steering promise needs both the matching native `turnId` acknowledgement and
the corresponding `userMessage` completion on that same native thread/turn.
The client ID and exact text must match. A queue acknowledgement alone, another
client's item, a different turn, or an assistant echo cannot confirm insertion.
Identical concurrent inputs have independent IDs. Abort, terminal events and
process failure reject unconfirmed input without retaining a future prompt.

The owner supplies a repeatable insertion guard immediately before the native
effect. Ordinary native effects after asynchronous setup or human interaction
use the controller's `SendOptions.beforeNativeEffect` guard. An adapter is not
a tenant, directory or approval authority.

Native approval callbacks are scoped to their observed active item and original
turn. They preserve the user's native approval policy, never auto-approve, and
cannot accept a delegated DE answer as human assent. Native application receipts
are separate from execution outcome. In particular a generic failed command is
not enough to claim that a particular refusal receipt was applied.

The local adapter integration qualifies the installed `0.165.0-alpha.1.2`
protocol. It retains existing invocation-scoped MCP configuration and credentials,
legacy native history, and exact-session resume. Older unqualified runtimes keep
their existing exec transport and do not gain an optimistic steering flag.
No persistent owner configuration is rewritten.

Installed acceptance uses a controlled local Responses provider and real native
tool execution. It covers insertion before original-task completion, direct and
SessionEngine dispatch, same-session continuation, real native approval allow and
deny, cancellation with observed process-tree exit, and refreshed MCP bindings.
It is not paid-model, physical cross-device or production deployment evidence.

Adapter integration and the shared project-authority boundary remain local until
their concurrent source dependency can be safely integrated. The low-level
transport and native request handlers are independently testable components;
their presence alone must not enable an adapter capability.
