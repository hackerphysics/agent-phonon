# SSH connection hints

`device.info` optionally includes:

```json
{
  "ssh": {
    "username": "developer",
    "port": 22,
    "addresses": [
      {"address": "100.100.1.2", "kind": "tailscale", "family": "IPv4"},
      {"address": "192.168.1.20", "kind": "private", "family": "IPv4", "interface": "en0"},
      {"address": "203.0.113.20", "kind": "public", "family": "IPv4"}
    ]
  }
}
```

This additive optional result uses the existing `device.info` method. TypeScript `device.info()` and Python `await device.info()` expose the same fields without a new RPC. Older devices may omit `ssh` entirely.

Discovery reads the operating-system user and interfaces, optionally Tailscale's own CLI status, and outbound public IPs from api4.ipify.org/api6.ipify.org. External requests contain no device identity or credentials, but the IP discovery service necessarily observes the source address. They are time-bounded (1.5 seconds), bounded in response size and cached for ten minutes; failures retry after one minute. An unavailable IP provider/Tailscale command never prevents the rest of device.info. Missing user database entries omit the username. Addresses are deduplicated and bounded to 64.

These are connection hints, not proof of reachability or sshd configuration. Port 22 is only a default. A service's runtime username may differ from the SSH login account. An outbound NAT/proxy address may not support inbound SSH. The mobile client lets the owner select/override everything; it does not probe reachability, enable SSH, provision keys/users or route terminal traffic through the daemon.

SSH authentication and host-key verification happen directly between the mobile client and sshd. No passwords, private keys or server host trust are reported through agent-phonon. Last observed addresses can remain cached for rescue while the Agent is offline.
