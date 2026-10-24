# Native Document Publication And File Transfer

Native document publication extends the existing `document.send` method, not the
method registry. Its native envelope carries `nativeRunId`, `workflowId`,
`sessionId`, `turnId`, and a stable UUID `requestId`. Generic document exchange
remains supported independently.

## Producer Contract

An active turn's `SendOptions.publishDocument` accepts a project-relative `path`,
`requestId`, and optional MIME type/caption. It never accepts content bytes,
owner/conversation identities, absolute paths, or parent traversal. The controller
reads the actual project/worktree file through the same policy-enforcing file
manager used by RPC, bounds it to 10 MiB, hashes the bytes, and supplies current
controller lineage. A successful return requires a matching delivered item with
a nonempty `serverRef`; sending an RPC is not itself delivery.

The authenticated per-turn loopback bridge exposes the same operation at
`AGENT_PHONON_DOCUMENT_URL`. The optional OpenClaw tool is
`phonon_publish_document`; it uses the same connection-bound URL, one-use host
permit, and revocation as the other native interaction tools. Retained callbacks
cannot publish after the turn ends, and disconnected tools cannot reuse a grant.

The server verifies live controller identity, current authorization and workspace
binding, bytes/size/hash, and a frozen request identity. A duplicate request with
the same identity returns the existing reference; changing the file or other
identity fields requires a new request ID. A later timestamp alone does not
create another publication. Publication is not off-turn/proactive messaging.

Ordinary Agent/DE publications appear with the actual sender in their originating
conversation. Delegated worker files belong to their task and workflow node;
workers do not become group members or send attachment messages to that group.
Publishing does not automatically copy files to a different device or workflow.

## Device File Capability

Linux advertises `secure_file_broker_linux_v1`. macOS advertises
`secure_file_transfer_darwin_v1` and `native_document_publish_v1` only after its
fixed helper probe succeeds. The helper uses `/usr/bin/python3 -I -S -B`, a
scrubbed environment, and bounded subprocess input/output/time. Missing helper
support is a capability failure, never permission to fall back to unanchored IO.

macOS read/write opens directories relative to pinned directory FDs with
`O_DIRECTORY | O_NOFOLLOW`, beginning at `/`, and validates regular files before
reading/truncating. Reads/writes use nonblocking open to reject special files
without waiting on a FIFO peer. Exclusive writes use `O_EXCL`. Read/write are
bounded to 16 MiB in the macOS helper; native publication is limited to
10 MiB on both platforms. macOS file list/stat/mkdir are still explicitly unsupported.

Incoming native attachments are immutable server-owned references. The service
writes them exclusively under deterministic `.phonon-inputs/<run>/<asset>.<ext>`
paths and reads them back to verify size and digest before a model turn or
tool-gap insertion receives their references. A lost write acknowledgement is
acceptable only when the read-back proves identical bytes. Preparation retries
are explicit and do not authorize replaying a possibly dispatched model turn.
