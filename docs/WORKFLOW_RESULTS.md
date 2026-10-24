# Device-Local Workflow Result Pages

Capability `workflow_result_pages_v1` adds the read-only `workflow.result` method.
`workflowId`, optional `nodeId` and UTF-16 `offset` select an original result,
not an arbitrary file. Each page contains at most 16,000 UTF-16 units without
splitting a surrogate pair. Nonzero offsets require the original `version`.
A changed result raises `errWorkflowResultChanged`; missing workflows/nodes
raise `errWorkflowNotFound`. Neither error starts or resumes work.

The version is SHA-256 of JSON `[workflowId,nodeId-or-null,status,fullText]`,
matching the existing Dev result identity. `knownVersion` negotiates a small
receipt for an already downloaded page: only an exact current version returns
`omitted:true` with no `text`. Different versions return the actual page unless
the caller pinned a now-changed `version`. A receipt must be resolved only
against the same owner/device/project/workflow/node/offset/version and range.
It is not an empty result. Active results are observations, not immutable cache.

The device reads its current in-memory workflow or tenant-scoped stored original
workflow. Reads do not create Sessions, replay inputs, write journals, alter
checkpoints, recover queues, acknowledge execution or imply business acceptance.
The normal connection method policy still applies. Services must additionally
verify current project/binding/device authority before and after returning data.
When the device is offline, clients may show a clearly marked saved observation,
not claim a fresh source verification.

TypeScript: `device.workflow.result({workflowId,offset:0,knownVersion})`.
Python: `await device.workflow_result(workflow_id, known_version=version)`.
