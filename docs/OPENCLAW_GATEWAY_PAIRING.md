# OpenClaw Gateway Pairing

Phonon discovers a **local** Gateway from `OPENCLAW_CONFIG_PATH`, otherwise
`OPENCLAW_STATE_DIR/openclaw.json`, otherwise `~/.openclaw/openclaw.json`.
It reads `gateway.port` (default 18789), `gateway.bind`, TLS and shared auth.
Discovery always selects loopback, never `gateway.remote.url` or a LAN address.
Token and password auth are supported; `none` is honored only when explicitly
configured. Other authentication modes require explicit adapter configuration.
An explicit `gatewayUrl` and `gatewayToken` still override discovery. Local
credentials are never implicitly forwarded to an explicit remote Gateway.
Previously saved explicit URLs remain pinned; remove `gatewayUrl` to discover
the configured port. `agent-phonon doctor` reports missing config/credentials
and an unavailable listener without displaying secrets.

## Identity And Reconnect

Each endpoint has a stable Ed25519 identity under
`~/.agent-phonon/openclaw-gateway/<sha256-of-ws-endpoint>/identity.json`.
The role-scoped credential is stored alongside it in `operator-token.json`,
with device/client/role and approved scopes. Directories are created with 0700
and files with 0600; public, symlinked, malformed or mismatched state is rejected,
not silently replaced. Windows initializes a protected inheritable owner/System/
Administrators ACL on a new empty root and verifies private ACLs before reads.
`GatewayConfig.deviceStateDir` selects another private
Phonon-owned root. Do not copy these files into a repository or logs.

Phonon retains `client.id: gateway-client` and uses `mode: cli` with its
device identity. Gateway 2026.10.7 treats `mode: backend` as a reserved local
self-call bypass: it accepts the signed connection but creates no pairing record
and issues no initial device token. Only the approval helper uses that mode.
The normal client waits for the server nonce and integer challenge `ts`, then
signs the v3 device/client/role/scopes/token/nonce/platform payload. No unsigned
or device-less fallback is used for the normal connection. `hello-ok` device
tokens are saved and reused as `auth.deviceToken` by subsequent clients and
reconnects. Tokens are isolated by endpoint and identity. A narrower socket does
not overwrite the stored scope metadata for the same token; live requests always
retain an explicit caller scope limit. Otherwise reconnect reuses the saved
grant intersected with Phonon's existing read/write/admin scope ceiling, never
implicitly asks for an upgrade or adopts additional server-advertised scopes.
Revoked or invalid tokens fail with guidance,
without automatically bypassing revocation through shared-token authentication.

## Local Approval Boundary

`PAIRING_REQUIRED` produces a `GatewayConnectionError` with `code`, `requestId`
and `recommendedNextStep`, plus a `phonon.pairing.required` event. Automatic
approval is limited to URLs whose hostname is exactly `127.0.0.1`, `::1` or
`localhost`. Remote and non-loopback hosts **never** receive blind approval.

For a new local device, a bounded, shared-authenticated, reserved `gateway-client`
helper calls `device.pair.list`, verifies the **exact** pending request against
Phonon's device ID, public key, client, operator role and requested scopes, then
calls `device.pair.approve` for that request ID only. Existing paired devices,
repairs, scope/role/metadata upgrades, changed/superseded requests and broader
pending grants require manual approval. The helper uses the original caller's
scopes, never adds pairing/admin scopes, and has no elevated CLI fallback.
The existing default scope request remains read/write/admin; a caller-provided
narrower scope set is not widened to make approval work.

The client reconnects once after a confirmed approval and never replays a chat
to obtain authentication or settings proof. Cancellation is rechecked after
asynchronous lookup and before approval/reconnect. Logs prefixed
`[openclaw-pairing]` and `phonon.pairing.audit` events record actor, UID/PID,
timestamp, request ID, device ID and requested/approved/failed decisions, without
keys or credentials. Gateway-native silent pairing remains subject to Gateway
policy and its own security audit trail.

Set the local adapter's `gatewayAutoPair: false` (or `GatewayConfig.autoPair`) to
disable Phonon's helper. This does not change the Gateway's own local policy.
For a pending request, remote Gateway, failed approval or upgrade, run on the
**Gateway host**:

```bash
openclaw devices list
openclaw devices approve <exact-requestId>
```

Review the listed device and grant first. Phonon does not select “latest”, approve
another device, widen a grant, alter Gateway config, or delete an identity to
evade consent. `DEVICE_AUTH_*` errors require checking the private identity,
Gateway clock and a fresh challenge; retain existing keys while investigating.
