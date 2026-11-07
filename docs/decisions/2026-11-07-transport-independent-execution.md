# Device-owned execution and replaceable transport

A temporary socket outage must not call SessionEngine/WorkflowEngine.dispose.
PhononClient retains one authenticated tenant runtime across socket replacement;
explicit client shutdown and an authenticated tenant change still dispose it.
An unpublished candidate never becomes the retained runtime and remains subject
to the existing supersession/teardown fences. A failed hello cannot steal the
incumbent runtime. No competing scheduler is started on reconnect.

Local turns continue under their previously admitted project/employee/turn
and policy authority. Stream and workflow events remain durable while offline;
reconnection applies authoritative ACKs and replays the original event identities.
New scheduled model work is not started offline. The existing dispatch occurrence
clock retains each owed tick; reconnect drains due occurrences with expiry checks
without disposing or restarting the clock.

RPC detach keeps stable original human-decision requests waiting, including
requests first made offline. Reattach retransmits only interaction.request with
its unchanged JSON/application identity; it does not approve or consume a human
decision. Explicit turn cancellation/timeout/shutdown still ends the wait.
Uncertain effectful reverse calls are rejected with unconfirmed-receipt evidence,
not automatically replayed. Callers must reconcile their original request IDs.
Responses from in-flight old-channel handlers are epoch fenced so old numeric
RPC IDs cannot deliver into a new socket's request namespace.

Tests use real authenticated loopback WebSocket peers and original native chat
workflows: loss during a turn, offline/online completion with one adapter send,
unchanged Session/turn/workflow identities, durable event history, human decisions,
uncertain side effects and late old replies. Client tests retain heartbeat,
backoff, failed handshake, supersession and explicit shutdown checks. Scheduler
tests require one device clock and exact per-occurrence identities through
reconnect, repeated supersession, expiry, disabled definitions and process restart.

This change does not claim power-loss/process-crash continuation. Such recovery
still requires the existing native checkpoint and stop evidence; it never
replays arbitrary model/tool work. Network loss alone no longer produces a native
stop proof or a fabricated Cancelled outcome.
