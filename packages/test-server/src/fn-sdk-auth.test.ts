import { test } from "node:test";
import assert from "node:assert/strict";
import { Server } from "node:net";
import type { WebSocketServer } from "ws";
import { PhononServer } from "@agent-phonon/server-sdk";
import { AdapterRegistry, PhononClient } from "@agent-phonon/core";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function boundHost(server: PhononServer): string {
  const addr = (server as unknown as { wss: WebSocketServer }).wss.address();
  assert.ok(typeof addr === "object" && addr);
  return addr.address;
}

async function connect(server: PhononServer, deviceId: string, deviceKey?: string, expectedTenantId?: string) {
  const client = new PhononClient({ serverUrl: `ws://127.0.0.1:${server.port}`, deviceId, deviceKey, expectedTenantId,
    registry: new AdapterRegistry(), workspaceRoot: mkdtempSync(join(tmpdir(), "phonon-auth-")) });
  try { return await client.connect(); } finally { client.close(); }
}

test("A5 TS SDK: omitted host actually binds 127.0.0.1 and permits local anonymous hello", async () => {
  const server = new PhononServer();
  try {
    await server.listen();
    assert.equal(boundHost(server), "127.0.0.1");
    assert.deepEqual(await connect(server, "local"), { tenantId: "tenant-local" });
  } finally { await server.close(); }
});

test("A5 TS SDK: explicit non-loopback anonymous rejected before bind, including truthy non-boolean", t => {
  const bind = t.mock.method(Server.prototype, "listen", () => { throw new Error("unexpected bind"); });
  for (const host of ["0.0.0.0", "::", "192.0.2.1", ""]) {
    for (const allowAnonymous of [undefined, false, "true" as unknown as boolean]) {
      assert.throws(() => new PhononServer({ host, allowAnonymous }).listen(), /without authenticate/);
    }
  }
  assert.equal(bind.mock.callCount(), 0);
});

test("A5 TS SDK: explicit anonymous exception and authenticate reach bind with same host (mock, no socket)", t => {
  const hosts: string[] = [];
  t.mock.method(Server.prototype, "listen", function(_port: number, host: string) {
    hosts.push(host); throw new Error("fixture bind intercepted");
  });
  return (async () => {
    for (const opts of [{ allowAnonymous: true }, { authenticate: () => ({ tenantId: "fixture" }) }]) {
      await assert.rejects(new PhononServer({ host: "0.0.0.0", ...opts }).listen(), /fixture bind intercepted/);
    }
    assert.deepEqual(hosts, ["0.0.0.0", "0.0.0.0"]);
  })();
});

test("A5 TS SDK: async authentication rejects missing/wrong key or device; accepts correct identity", async () => {
  const server = new PhononServer({ allowAnonymous: true, authenticate: async (id, key) => {
    await Promise.resolve();
    return id === "fixture" && key === "fixture-only" ? { tenantId: "tenant-fixture" } : null;
  } });
  try {
    await server.listen();
    for (const [id, key] of [["fixture", undefined], ["fixture", "wrong"], ["wrong", "fixture-only"]]) {
      await assert.rejects(connect(server, id!, key), (e: { message: string }) => /unauthorized/.test(e.message));
      assert.equal(server.listDevices().length, 0);
    }
    assert.deepEqual(await connect(server, "fixture", "fixture-only", "tenant-fixture"), { tenantId: "tenant-fixture" });
    await assert.rejects(connect(server, "fixture", "fixture-only", "wrong-tenant"), /identity check/);
  } finally { await server.close(); }
});
