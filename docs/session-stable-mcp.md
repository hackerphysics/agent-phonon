# Session-stable native MCP

Phonon trusts the user's local machine. Native controller MCP uses one loopback
listener and bearer token for the lifetime of a live SessionEngine session,
not a different endpoint and token for every turn. Existing `phonon_current_turn`
aliases and tool schemas remain unchanged for adapter compatibility.

Each turn binds fresh controller callbacks carrying the original execution
identity. At completion or interruption, business calls are suspended, while the
listener and tools/list remain available. The next turn reuses the endpoint and
token with fresh callbacks and request budgets. HTTP requests capture their
execution binding before reading the body; delayed bodies/results cannot be
transferred into another turn. Human-response acknowledgement state is not reused.

Session termination and controller disposal close the listener and revoke the
token. Daemon restarts/recovery may create a new live listener; this is not a
persistent credential on disk. A changed tool capability set is rejected rather
than silently adding permissions to an already-discovered catalog.

The token authenticates a trusted local session, not a hostile-process boundary:
a local process which retains it can call during a later active turn. This is
intentional. The controller still rejects calls while idle, cancelled execution
callbacks, forged routing, wrong-session credentials and unconfirmed approvals.
Account ownership and business authorization remain checked by the existing
callbacks/server. We do not expose the listener beyond 127.0.0.1.

This change avoids rebuilding the device-side listener and rotating capability
values for ordinary follow-up turns. It does not keep every native CLI subprocess
alive, change adapter-specific discovery lifetimes, or promise provider prompt
cache improvements. No protocol or server SDK schema change is required.

Verification includes actual loopback MCP requests, identical endpoint/token/tool
catalog across turns, cancellation, delayed responses, isolated sessions and a
SessionEngine multi-turn test using the real bridge with a controlled adapter.
