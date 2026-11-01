# Windows Current-Turn Input

Windows remains part of the seven-harness objective. Mac/Linux qualification
does not certify native Windows execution, permissions, packaging or activation.
Minimum versions and required native APIs remain the same across platforms;
Windows is not an exact-build exception or a queue/restart fallback.

## Repeatable CI Qualification

The main-only `Windows current-turn input` workflow uses Windows Server 2025
x64 / Node 24 and runs one harness at a time. It prepares official Windows
executables or Windows-native npm/Python dependencies in CI, never on the
deployment host. Codex and Copilot upstream archives are SHA-256 verified.
Hermes uses a frozen upstream lock, with lazy installation disabled before
startup. No personal credentials or production history enter hosted CI.

Actual native tests exercise original-turn insertion, closed windows, denied
effects and same-session continuation. Pi has an installed-runtime RPC lane
instead of relying on the POSIX-only synthetic launcher cases. The subprocess
runner preserves only explicitly selected native paths, disables Hermes lazy
installation, and verifies owned cleanup. A CI receipt contains the source
commit, target, Node version, exact pass/failure counts and workflow run ID.
Absent native paths, missing cases, failures or cancellations cannot pass the
qualification. Version pins in this workflow select reproducible evidence;
they do not narrow the production minimum-version policy.

The prepared Job Object helper supervises native descendants and supplies
private started/empty evidence. A leader exit or a taskkill request is not
proof that the original native execution has stopped. The CI-built helper is
not itself a production deployment artifact or a replacement for the release
toolchain/provenance checks.

## Activation Boundary

CI qualification alone does not enable a user's Windows device. Prepare one
complete, source-bound Windows runtime from clean, committed, pushed main;
validate target artifacts and protected history migrations off-server before
activation. Preserve native credentials, profile directories, workspace
authority, approvals and the existing execution identity. Register only
owner-authorized peer/extension grants. Do not enable every permission or
overwrite unrelated native project configuration.

The November 1 inventory of `GUANGZI` found a healthy older device runtime,
four discovered native types and zero pending delivery. Inspected Codex
`0.162.0-alpha.2` and OpenClaw `2026.9.6` are below the insertion floors.
Pi and the official Copilot CLI were not found in the inspected command
inventory. This is an inventory result, not proof of absence everywhere on
disk, idle native gateways, or successful Windows deployment. Existing active
processes and unrelated tasks are preserved.
