import { test } from "node:test";
import assert from "node:assert/strict";
import { sshAddressList, addressKind, collectDeviceSSHHints } from "../../core/dist/device-ssh-info.js";
import { DeviceInfoResult } from "@agent-phonon/protocol";
import type { NetworkInterfaceInfo } from "node:os";

const iface = (address: string, internal = false): NetworkInterfaceInfo => ({ address, internal, family: address.includes(":") ? "IPv6" : "IPv4", netmask: "", mac: "", cidr: null } as NetworkInterfaceInfo);
test("SSH discovery deduplicates addresses, identifies Tailscale by evidence and excludes loopback/link-local", () => {
  const addresses = sshAddressList({ en0: [iface("192.168.1.2"), iface("2001:db8::2"), iface("127.0.0.1", true), iface("fe80::1"), iface("169.254.1.1")], utun4: [iface("100.100.1.2"), iface("fd7a:115c:a1e0::1")] }, ["100.100.1.2", "fd7a:115c:a1e0::1"], ["203.0.113.2", "2001:db8::2", "not-an-ip"]);
  assert.equal(addresses.length, 5);
  assert.equal(addresses[0]?.kind, "tailscale");
  assert.deepEqual(addresses.filter(value => value.kind === "tailscale").map(value => value.interface), ["utun4", "utun4"]);
  assert.equal(addresses.find(value => value.address === "192.168.1.2")?.kind, "private");
  assert.equal(addresses.filter(value => value.address === "2001:db8::2").length, 1);
  assert.equal(addressKind("100.64.0.1"), "private", "CGNAT alone is not evidence of Tailscale");
  for (const value of ["::", "::1", "ff02::1", "fe80::1", "::ffff:127.0.0.1", "127.1.1.1", "0.0.0.0", "224.0.0.1"]) assert.equal(addressKind(value), undefined);
});
test("device.info SSH hints remain optional and bounded without changing any RPC method", () => {
  const base = { at: new Date().toISOString(), hostname: "host", os: { platform: "linux", type: "Linux", release: "6", arch: "x64" } };
  assert.equal(DeviceInfoResult.parse(base).ssh, undefined);
  const ssh = { username: "developer", port: 22, addresses: [{ address: "100.100.1.2", kind: "tailscale", family: "IPv4" }] };
  assert.deepEqual(DeviceInfoResult.parse({ ...base, ssh }).ssh, ssh);
  assert.equal(DeviceInfoResult.safeParse({ ...base, ssh: { ...ssh, addresses: [{ ...ssh.addresses[0], address: "host\ncommand" }] } }).success, false);
  assert.equal(DeviceInfoResult.safeParse({ ...base, ssh: { ...ssh, port: 65536 } }).success, false);
  assert.equal(DeviceInfoResult.safeParse({ ...base, ssh: { ...ssh, addresses: Array(65).fill(ssh.addresses[0]) } }).success, false);
});
test("public discovery failure never breaks local hints and is cached instead of retried on every report", async t => {
  const request = t.mock.method(globalThis, "fetch", async () => { throw new Error("offline"); });
  const first = await collectDeviceSSHHints(), second = await collectDeviceSSHHints();
  assert.equal(first.port, 22); assert.equal(second.port, 22); assert.ok(first.addresses.length <= 64);
  assert.equal(request.mock.callCount(), 2, "one IPv4/IPv6 attempt, then the failure cache");
});
