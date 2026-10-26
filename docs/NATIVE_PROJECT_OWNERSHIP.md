# Native Project Directory Ownership

## Live Git Observation

`project.git.status` retains its existing parameters and result fields and adds
an optional `workspace` observation. The TypeScript SDK infers this result from
the protocol catalog; Python's existing `git_status` returns the same dictionary.
Older peers may omit the observation; absence never proves a clean workspace.

The observation identifies the canonical execution directory, repository root,
live branch/HEAD, linked-worktree status and timestamp. Counts include each
tracked changed file once plus individual untracked files, exclude ignored
files, and count a rename once at its destination. Conflict and type changes
are `unmerged` and `typeChanged`, not silently unmodified. NUL-delimited status
preserves Unicode, whitespace and newline filenames.

Read commands have a shared ten-second deadline and one-MiB output bound. They
disable optional Git locks and filesystem-monitor hooks. Ownership, directory
identity, checkout identity and Git metadata roots are rechecked before returning.
Non-Git directories, parent repositories outside the registered root, malformed
or oversized output and changed authority return errors, never fabricated zero
counts. A no-repository diagnostic returns `errNotGitRepo`; other Git failures
stay errors and must not be inferred as a non-Git or clean directory. This read
neither creates nor migrates sessions or worktrees.

## Contract

Project IDs and namespace labels alone do not isolate physical files. Remote
Project managers derive their namespace from the authenticated connection and
also check the canonical directory against current Projects, worktrees and
retained path claims. Different namespaces cannot register the same directory,
an ancestor, a descendant or an existing symlink alias. Prefix siblings remain
distinct. Comparison conservatively folds case and Unicode normalization on
macOS and Windows.

New namespaced defaults use
`<workspaceRoot>/.namespaces/<sha256(namespace)>/<generated Project ID>`.
Display names are not filesystem paths. New directories request mode `0700`;
existing directories and user data are not chmodded, moved or reassigned.
Namespace containers themselves cannot be selected as ordinary Projects.
Default worktree locations also use generated IDs, not display/branch names.

An additive SQLite `project_path_owners` table retains claims. `BEGIN IMMEDIATE`
serializes checking and reserving a path before asynchronous filesystem/Git
operations begin. A failed creation or Project/worktree metadata removal does
not transfer ownership of remaining files. Claims survive store reopen. No
Agent-facing ownership transfer, permission administration or cleanup operation
is introduced. Embedded managers without SQLite retain process-local claims,
not a promise of cross-process/restart persistence.

Remote list/get no longer expose unmapped legacy Projects, including readonly
lookups. Ambiguous historical metadata remains stored but is denied, never
adopted or silently backfilled. Explicit trusted local managers without a
namespace retain operator inspection. Worktree removal additionally requires
the exact owning Project; worktree/session/Git cwd resolution rechecks policy
and physical ownership.

## Compatibility And Limits

Device information advertises `project_path_ownership_v1` for this contract.
The Agents gateway requires it before directory discovery/access, provisioning
or new execution. Old `project_namespace_v1` labels are insufficient. Existing
execution status, stop and human-request observation do not require this new
capability; the normal ownership/credential/HITL checks still apply.

The capability is not an authorization grant, inode identity proof, race-free
directory publication certificate or exactly-once installation guarantee.
Ancestor replacement races and archive/publishing safety remain separate gates
in `NATIVE_SKILL_SECURITY.md`. Do not register a new MCP installer on the strength
of this flag alone. The server and native runtime need matching prepared builds;
an old daemon does not gain these semantics from a newer server or SDK.

## Evidence

Eight local actual-Core-RPC cases reproduce same-name directory sharing,
cross-account explicit/ancestor/descendant/symlink registration, retained-file
adoption after metadata removal/reopen, racing claims, namespace-container
takeover, unknown/ambiguous legacy data, failed-create claims and real Git
worktree ownership/removal. Source regressions include these cases alongside
skill, Protocol, SDK, policy, Project and HITL coverage.

This is local source evidence, not installed-model acceptance on Mac, Ubuntu or
Windows. Prepare target-compatible artifacts locally or in CI; never build,
install dependencies or run suites on a deployment server.
