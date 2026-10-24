# Windows Process Job Qualification

Status: maintained source/native component and actual Windows probes pass.
Not deployed; iOS original stop/paused-queue acceptance is not complete.

The old default Windows supervisor cannot prove whole-tree exit. Sending
taskkill, reaching a force deadline or observing the leader exit stays unknown.
The new optional, device-owned prepared helper uses a private Job Object:

- The native executable is checksum/manifest verified before startup.
- `PROC_THREAD_ATTRIBUTE_JOB_LIST` assigns the root atomically at creation;
  it starts suspended and is resumed only after control setup.
- Kill-on-job-close and no breakaway permission keep descendants in the Job.
  The original filesystem/network/approval policy and user token are unchanged.
- Only stdin/stdout/stderr handles are inherited by the target. Separate
  evidence/control fds belong to the native helper, not model/tool output.
- An original started-PID record followed by active-process-zero accounting
  proves Job exit. Missing, foreign, malformed or duplicate records stay unknown.
- Parent close terminates the Job; explicit force terminates all descendants.
  Normal output/arguments/exit code are preserved, including spaced cmd shims.
- Missing helpers retain legacy behavior, never fabricated stop confirmation.

Native source `packages/core/native/process-job.c` cross-compiles locally with
the existing cached Zig0.13.0 package. Final Windows x64 helper37,888 bytes:
`25d27fb55cf2b445847d643c4fa562336702503f1fe00999952c5ba0667de5f3`.
Source SHA-256:
`ec1a5212c052c66e262858e39c96f647e3957ad808a88f6a52f1db29e3be1744`.
Runtime copying is optional via `PHONON_PROCESS_JOB_ARTIFACT_ROOT`; copying
refuses stale source/toolchain/hash/size, links and existing destinations.
No protocol/SDK permission or remote executable-selection field added.

## Verified Gates

Actual Windows6 cases, no model responses or extra daemon:

1. Original arguments, binary output and nonzero exit propagation.
2. A cmd shim and script with spaces.
3. Forced exit of a live root and descendant.
4. Root exit with a detached descendant remaining; no early stop confirmation.
5. Installed desktop Codex0.162.0-alpha.2 in MXC: workspace write succeeds,
   outside canary write is denied inside the same Job.
6. Installed Codex held on one synthetic loopback inference request: no model
   response, explicit interrupt, original Job empty and exactly one interrupted
   terminal event. Personal Codex config/auth fingerprints unchanged.

The final probe runs in an owned Interactive/Limited task, then removes its
task/root/profile/native helper. Independent inspection confirms no test helper
process remains and the daily `Phonon Work Agent` is still running.

Local evidence-parser11 and package8 cases pass without skips. Source
supervisor/native-stop/final-result regression17 passes with one explicit
installed-CLI opt-in skip; actual Windows installed-CLI probes above are separate.
Core and daemon noEmit typechecks and both repositories' diff checks pass.

Earlier cmd-quoting attempts failed and were cleaned. One SSH-only MXC probe
returned3221225794 and its test failed to close a provider listener outside a
finally block. After independently verifying all helper/execution processes
gone, only that exact owned probe PID was stopped and its root removed. Cleanup
is corrected and final Interactive/Limited probe passes, without sandbox
downgrade. An attempted bundled local regression failed module resolution;
the corrected existing tsx/source-path invocation runs the actual source cases.
Failed attempts are not promoted into acceptance passes.

Evidence: `~/.local/share/phonon-work/test-runs/windows-process-job/`.
One local cached toolchain353MiB is temporarily retained read-only because the
authorized MCP lane is actively using it for its own serial native-FS build;
do not remove during that compile. Task-local build/probe directories and
remote resources are removed. The helper runtime and concise evidence remain.

Open: helper deployment with exact daily-runtime regression, original iOS stop
and paused wait/FIFO behavior, native command-in-flight/MXC job interactions,
broader harness/three-OS matrix, physical phone/APNs and independent Loop.
