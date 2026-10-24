# Active Workflow Input

`workflow.input` inserts text only into an explicitly identified active native
workflow/node/Session/turn. It requires `workflowId`, `nodeId`, `sessionId`,
`turnId`, `inputId` and `input`. It never starts a turn, resumes a workflow,
queues an input, changes reasoning or falls back to another mode.

Before entering the harness, the engine verifies current workflow ownership,
control epoch, actual node/Session/turn/configuration and working-directory
binding. The Session must support real tool-gap insertion. A late or unsupported
request is rejected rather than becoming another model invocation.

The device reserves a bounded SQLite receipt before crossing the native boundary.
Its stable key is tenant + workflow + input ID. The frozen content hash includes
the complete target and original text; plaintext input is not copied into this
ledger. A reused ID cannot change its text or target. At most 256 receipts are
allowed per workflow. Receipt lifetime follows the original workflow.

States:

- `inserting`: the original operation is still in flight on this controller.
- `inserted`: the harness acknowledged the input at the actual tool gap. This
  is not a claim that the model followed it or that the task completed.
- `unknown`: the native boundary/acknowledgement could not be confirmed. A retry
  returns the original observation without inserting again.

`workflow.input.status` accepts only the original workflow and input IDs and is
read-only. It returns `found:false` or the original receipt. A missing receipt
does not authorize a replacement input. An orphaned in-flight receipt is exposed
as unknown after controller recreation, not retried on the next turn. Late
acknowledgement can update only its original reserved receipt, never another
workflow attempt. Receipts remain readable after original execution completion.

The TypeScript API is `device.workflow.input(params)` and
`device.workflow.inputStatus(workflowId,inputId)`. Python exposes
`workflow_input(...)` and `workflow_input_status(...)`. The runtime advertises
`workflow_input_receipts_v1` in `device.info`.

The ordinary Dev insert/wait/FIFO source scheduler and mobile controls must be
connected to this primitive before that source is declared feature-complete.
Existing DE/native-chat scheduling and its original source contracts are not
replaced by this method.

The Pi adapter now implements real native steering through its verified RPC
lifecycle. A native queue acknowledgement alone is not inserted; actual input
delivery on the original run is also required. See `PI_RPC_STEERING.md` for
version checks, cancellation/recovery boundaries and actual-provider evidence.
Other adapters do not gain insertion merely because this method exists.
