# Security Policy

## Reporting a vulnerability

Please **do not** open a public issue for security vulnerabilities.

Instead, report privately via [GitHub Security Advisories](../../security/advisories/new)
(Security → Report a vulnerability), or email the maintainers.

We aim to acknowledge reports within 72 hours and to ship a fix or mitigation
as quickly as the severity warrants.

## Scope & threat model

agent-phonon is a **device-side control plane**: a server can remotely create
sessions, run local AI agents, install skills, read/write files, and configure
environment variables on a paired device. Because of this, the security model
matters:

- **Local policy is the authorization boundary.** phonon does not authenticate
  end users; the device owner configures a per-tenant `TenantPolicy`
  (allowed project roots, allowed agents, allowed methods, file-write,
  skill-install, env-reveal, upload limits, deny-path patterns). Defaults are
  restrictive (writes off, allowlists empty, sensitive paths denied).
- **Filesystem sandboxing.** `file.*` operations are constrained to a
  project/worktree root. Path resolution is realpath-based and rejects symlink
  escapes; `stat`/`list` use `lstat` and never follow symlinks out of the root.
- **Secrets at rest.** Environment variable values are encrypted at rest
  (AES-256-GCM) with a device key stored in a `0600` file separate from the
  database. `env.list` redacts by default; plaintext reveal requires explicit
  policy (`allowEnvReveal`).
- **Skill archives.** `tar.gz` skill installs verify sha256 and reject absolute
  paths, `..` traversal, and symlinks before installing.
- **HITL fail-open vs fail-closed.** The OpenClaw HITL bridge is fail-open by
  design (unreachable bridge → tool allowed) and only adjudicates sessions
  phonon owns. Operators who need fail-closed behavior should configure it
  explicitly.

### Things that are intentionally *not* secrets

The `device.key` file and any `*.bak-*` database backups are device-local and
**must never be committed**. They are covered by `.gitignore`.

## Supported versions

This project is pre-1.0. Security fixes target the latest released minor of each
published package (`agent-phonon`, `@agent-phonon/*`, the Python `agent-phonon`).
