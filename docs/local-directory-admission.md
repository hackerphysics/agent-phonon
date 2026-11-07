# Local Existing Directories

`workspaceRoot` remains the default creation location, not the complete list of
directories a local owner may select. Remote requests cannot grant filesystem
consent. An inode returned by directory discovery is an observation, not consent.

For an already configured authenticated source with `expectedTenantId`, first
establish a normal connection using the new runtime. Its matching welcome is
recorded privately. Then the local owner may run:

```sh
agent-phonon directory admit /canonical/existing/project --server 0
agent-phonon directory list --server 0
agent-phonon directory revoke /canonical/existing/project --server 0
```

`--server` selects one actual configured URL or index. `--config` selects an
existing owner-private config. There is no arbitrary server/account grant flag,
JSON import, remote approval endpoint, config-root rewrite or automatic bootstrap.
The source fingerprint binds exact configured URL, device key and pinned tenant;
HTTPS/WSS or loopback transport is required. Existing URL-only tenant observations
are not migrated. Changed source credentials or tenant pins need a new observation.

Consent uses `<dbPath>.local-directories/consent.sqlite`, a local-only, 0600 SQLite
file in a 0700 directory. Config, provenance and state ancestors must be owned,
nonlinked and protected. Existing permissions are never repaired automatically.
The selected directory must be canonical, owned, existing, nonlinked and not
group/world writable. Consent pins its device/inode identity. Home/root, internal
state, namespace containers, employee homes, unresolved/foreign project ownership
and conflicting local consent cannot be admitted. Windows admission fails closed
until equivalent OS ownership/provenance checks exist; ordinary roots are unchanged.

Registration uses the existing `project.create` with `git:false`, the exact path
and `existingDirectoryIdentity`. It does not initialize Git, rewrite source bytes,
change branches or create files. Repeated registration returns one Project.
Admission permits that exact root and its descendants for only its source/tenant,
not parents or siblings. All other policy gates remain independent. It does not
change native tools' own OS permissions or provide a new native filesystem sandbox.

Each local grant has a durable unique generation. Repeating admit on a current
grant preserves it; re-admitting after revocation creates a new generation without
changing the source/tenant or cwd/inode restrictions. Session operations capture
the active generation at admission and carry it through queues and asynchronous
preparation, comparing it immediately before native effects. A revoke/re-admit
cycle cannot revive old queued or preparing operations, even when no check ran
during the revoked interval. Fresh operations on the unchanged session may use
the new grant. Cached command identities include their original generation;
retrying an old successful command cannot confirm work under the new grant.
Compression stores the generation separately from its historical result receipt.

Every project use still checks current consent and the controller-owned cwd/inode.
Revocation does not stop already dispatched native work. Interrupt, native-stop
observation, termination and disposal remain available; only actual native evidence
can confirm stop. Historical compression status is observation, not new authority.
Legacy grants without a generation fail closed until a local write migrates them;
legacy command receipts without matching generation are not inferred to be current.

This change is source-only until the separate build/release/live validation gate.
No live directory admission or production configuration change was made by tests.
