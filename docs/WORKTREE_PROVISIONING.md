# Durable Linked Checkouts

`worktree_provision_v1` and `worktreeProvisionReceiverID` are advertised only with
persistent qualified local storage, an allowed workspace root, both RPC methods
and explicit `allowProjectProvision`. Windows is not yet qualified for the
private ledger and does not advertise this capability. Existing worktree APIs
remain unchanged.

`project.worktree.provision` accepts the original `projectId`, a UUID
`clientRequestId`, observed `expectedReceiverID`, `name`, local `baseBranch` and
fresh `newBranch`. It accepts no caller path, remote, force or owner. The target
is allocated beneath the configured root and registered under a new independent
`worktree-<UUID>` project ID. New sessions can select this ID without moving or
changing the source or any existing session. TypeScript exposes
`device.project.worktree.provision/provisionStatus`; Python exposes
`worktree_provision/worktree_provision_status`.

The device pins the source directory and Git metadata identities, resolves the
base branch to an exact local commit, and commits a single creation claim before
the Git mutation. No fetch, hooks, shell or submodule recursion is requested.
Supervised Git commands share a deadline and bounded output. The source path,
Git/common directory and ownership are rechecked around reads and mutation.
The confirmed independent directory remains guarded by its directory identity,
Git pointer and shared repository metadata identity during later project access.

`project.worktree.provision.status` takes `projectId`, `clientRequestId` and
`expectedReceiverID`. States are `not_found`, `prepared`, `dispatched`, `unknown`,
`failed` or `confirmed`. A confirmed receipt includes the workspace, directory
identity, original base commit and created branch. These describe creation, not
a later live branch or cleanliness observation; use `project.git.status` for
current Git facts. The strict private SQLite sidecar retains immutable request,
receiver, source, target and claim identity, with a bounded per-tenant history.

Submitting the identical request reads its original result after the first
claim. Changed payloads and foreign identities are rejected. Uncertain creation
is never automatically retried, removed or converted into successful creation
from a matching-looking path. The original Git branch/directory is preserved for
explicit inspection rather than silently deleting possible work. Registration
can be completed from a confirmed durable receipt after a controller restart.

Local real Git tests cover source/linked branch isolation, dirty target state,
same-request concurrency and restart, permission/namespace refusal, invalid local
branch names, uncertain dispatch and directory/Git-pointer replacement. These
device tests do not establish iOS or Registry integration acceptance.
