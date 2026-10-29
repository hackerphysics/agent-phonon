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

The adapter uses the shared original-window/source fence independently of
separate directory-admission changes. The transport/request handlers and the
adapter's runtime qualification are distinct; transport presence alone must
not enable an adapter capability.

October 30 cross-session acceptance now passes through the actual public HTTP
and managed stdio-proxy Phonon MCP paths. Two real installed Codex sessions
verify exact-retry insertion before original receiver completion, unchanged
original session/turn/run identity, closed-window refusal without replay and
actual native MCP approval denial. The six native cases and 513 configured
delivery regressions pass without skips. The fixture explicitly authorizes
only its synthetic send tool; no personal config or production runtime is
changed. See the [Phonon Work evidence at `56e8bd5`](https://github.com/hackerphysics/phonon-work/blob/56e8bd5df45b1c203426dc91bece81f0a60843e1/agents/NATIVE_MID_TURN_MCP_TEST_RUN_2026-10-30.md).
This does not certify the other harnesses' complete MCP chains or a release.
