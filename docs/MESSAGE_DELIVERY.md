# Message Transport And Execution

`message.receive` persists the original message in the device's existing
SQLite store. Its stable key is tenant/message/recipient; its canonical payload
hash and first receipt survive controller and process replacement. Changed
payloads with the same identity are rejected. Current method, project, agent
and optional original session identity remain authorized on every retry.

This operation never calls an adapter, recovers a session, starts a workflow,
changes a stop proof or treats a queued message as model acceptance. It is
independent of execution status and delivery of output streams. Servers keep
their canonical input queue and use the device receipt as transport evidence;
execution remains on the original authorized workflow path.

The TypeScript and Python session SDKs expose `receiveMessage` and
`receive_message`. Devices advertise `message_inbox_v1`. Older devices return
their actual method error and the server retains pending input for a later
compatible receiver instead of inventing a failed execution.

Regression coverage: `fn-message-delivery.test.ts` exercises unknown-stop
admission, durable replay after process/controller replacement, payload
conflicts, project denial and zero model execution.
