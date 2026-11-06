# Read-only reconciliation of pre-hint Hermes DE stops

A historical Hermes DE can have a persisted unknown stop but no native recovery
hint or checkpoint. Requiring a hint forever strands its subsequent input.

On macOS only, the detached-stop observer may recover identity from multiple
exact tool-call IDs in the original device-owned Session/turn transcript. The
bounded reader refuses symlinks, foreign ownership and writable-by-others logs.
The dedicated DE profile's read-only native history must contain all those IDs
in exactly one Session. Workspace, model, CLI source, unarchived/root history,
real closing timestamp after that evidence, no compression/turn lease, and a
fresh native process inventory remain mandatory. No timestamp-only, directory-
only, default-profile, PID-absence-only or Windows process-tree inference is
permitted. Missing or ambiguous evidence remains unknown and retryable.

This path never launches inference, creates a Session or edits native history.
The existing checkpoint/stop compare-and-swap and project/employee authority
checks fence persistence after asynchronous observation. Normal recovery then
reattaches that exact native Session; only a subsequent authorized input runs.

Validation: full workspace consistency/build/test gates, including the native
Hermes recovery suite's legacy successful reattachment and missing, ambiguous,
foreign-turn, unsettled, model mismatch and active-process refusals. Run under
umask 022: the existing launchd tests intentionally assert fixture modes.
