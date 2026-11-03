# OpenCode native temporary-file retention

## Incident

On 2026-11-03 the operator traced Ubuntu temporary-file creation with bpftrace
to the installed OpenCode 1.14.48 executable, launched by agent-phonon 0.10.1.
The operator reported approximately 200 short-lived invocations per hour,
4.7 MB per retained library, and approximately 21 GiB/day of accumulation.
This is disk-resource leakage, not evidence of file exfiltration.

The files are named `.<hex>-00000000.so`. Their creator exits and closes its
descriptors, so an idle lsof/fuser snapshot does not establish ownership.
Phonon's periodic native inventory amplifies the upstream extraction behavior
even when no user turn is running. Changing only the invocation plugin's
cleanup does not address these files.

## Containment

Every OpenCode inventory probe, session-version qualification and execution
receives a private, mode-0700 directory via `BUN_TMPDIR`, `TMPDIR`, `TMP` and
`TEMP`. Bun's own temporary-directory selector must be overridden as well as
the system/JavaScript selectors. Remote environment values cannot redirect
these owned files into a shared directory.

Cleanup runs in finally after the existing supervisor confirms process-tree
exit. It verifies directory device/inode, owner, permissions and a nonce-bound
manifest before recursively removing only that invocation's directory. A live
or unconfirmed process tree, or changed ownership, retains the directory for
explicit reconciliation rather than deleting active or unrelated resources.
The manifest records the owning daemon PID and native child/process group.
An uncatchable daemon termination can leave an owned directory; manifests aid
manual recovery but are not an automatic stale-directory deletion policy.

Startup auto-detection registers an existing executable without running an
unsupervised synchronous version probe. Availability is established by normal
supervised discovery. Doctor uses that same supervised discovery path. Native
configuration, authentication, sessions and the inventory polling contract are
unchanged.

## Verification

Focused local regression covers repeated four-command discovery, session
qualification/execution, remote temporary-environment overrides, missing and
failed binaries, cancellation, ownership changes and unconfirmed process trees.
Existing OpenCode peer-context and completion regressions remain applicable.

The exact Ubuntu executable was copied read-only and hash verified:
`8732bd22e724fc19055e0e2800b763dbe9efc1e9ca004dc2f8836a9c124303b7`.
In a local Linux x64 container, five `debug config --pure` invocations each
created one 4,699,808-byte shared library under the selected private directory;
cleanup removed all five and left the container's shared `/tmp` unchanged.
The same binary's `--version` did not reproduce extraction in that check;
not every native subcommand necessarily leaks. No test suite or build ran on
the deployment server.

## Existing files

Do not delete shared `/tmp/*.so` files by extension, filename or age alone.
Existing libraries require creator provenance, owner/inode/hash verification
and confirmation that no active process still maps them. Keep one bounded
piece of evidence off-server if needed. This change contains future Phonon
invocations; it does not claim to fix upstream OpenCode or clean unrelated
standalone invocations.
