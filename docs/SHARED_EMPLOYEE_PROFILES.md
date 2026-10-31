# Shared Employee Profiles

`employee.profile.apply` optionally accepts `profileBinding`:

- Omit it to create or update an isolated, device-managed profile, as before.
- `{ "kind": "harness" }` binds the discovered native profile selected by `agent`.
- `{ "kind": "employee", "employeeId": "<uuid>" }` reuses a ready, directly
  owned profile in the same tenant and exact base harness. Chains and references
  to another tenant are rejected. `profileId` must match the source profile.

Harnesses advertise `employeeProfileBindings` only when supported. Existing
Hermes profile binding currently requires POSIX; Windows remains unsupported.
Managed `phn-*` profiles require the owned employee reference, not a native
harness binding. Native bindings never create, update or claim profile files,
change credentials or enable tools. Existing native policy still applies.

Every DE retains its own employee ID, revision, request hash, private project
and workspace. Sessions remain separately keyed. Only the native profile,
settings and memory are shared. DE identity is injected into that DE's Session,
not written into a shared profile. The controller must not submit shared
configuration documents as if a binding applied them.

Profile-owner updates are blocked while a dependent DE has an active or
unrecovered Session, including persisted sessions after restart. Readback keeps
profile/home identity checks. Updating a shared profile does not recreate
dependent DEs, replay work, copy memory or grant another tenant access.

The TypeScript SDK's typed `employeeProfiles.apply(params)` accepts the optional
field through its protocol type. Python's existing
`employee_profile_apply(**params)` forwards the same wire field unchanged;
there is no new method or SDK-specific translation.
