import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PhononServer } from "../../sdk-server-ts/dist/index.js";
import { PhononDaemon } from "./daemon.js";
import { loadConfig, type DaemonConfig, type ServerConfig } from "./config.js";

function config(server: ServerConfig): DaemonConfig {
  const root = mkdtempSync(join(tmpdir(), "phonon-daemon-security-"));
  const file = join(root, "config.json");
  writeFileSync(file, JSON.stringify({ deviceId: "fixture-device", dbPath: join(root, "state.db"), workspaceRoot: root,
    hookBridge: { port: 0 }, obs: { enabled: true, port: 0 }, logLevel: "error", adapters: [],
    rescueAgent: { enabled: false }, maintenance: { backupDir: join(root, "backups"), targets: [] }, servers: [server] }));
  return loadConfig(file);
}

async function health(daemon: PhononDaemon): Promise<{ ok: boolean; connections: { connected: boolean }[] }> {
  return await (await fetch(`http://127.0.0.1:${daemon.obsPort}/health`)).json() as never;
}

async function waitConnected(daemon: PhononDaemon): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if ((await health(daemon)).connections[0]?.connected) return;
    await new Promise(r => setTimeout(r, 20));
  }
  assert.fail("daemon did not establish the expected connection");
}

test("A5 daemon config: validates identity/boolean without coercion (JSON and direct constructor)", () => {
  for (const expectedTenantId of [null, 1, false, "", " ", " tenant", "tenant ", "x\ny", "x\ty", "x\0y", "x\x7fy"]) {
    assert.throws(() => config({ url: "ws://127.0.0.1", expectedTenantId } as ServerConfig), /expectedTenantId/);
  }
  for (const allowInsecure of [null, "false", "true", 0, 1, {}]) {
    assert.throws(() => config({ url: "ws://127.0.0.1", allowInsecure } as ServerConfig), /allowInsecure/);
    const cfg = config({ url: "ws://127.0.0.1" });
    cfg.servers[0]!.allowInsecure = allowInsecure as boolean;
    assert.throws(() => new PhononDaemon(cfg, { adapters: [] }), /allowInsecure/);
  }
  const cfg = config({ url: "ws://127.0.0.1", expectedTenantId: "tenant-fixture", allowInsecure: false });
  assert.equal(cfg.servers[0]!.expectedTenantId, "tenant-fixture");
  assert.equal(cfg.servers[0]!.allowInsecure, false);
  assert.equal(config({ url: "ws://127.0.0.1" }).servers[0]!.allowInsecure, undefined);
});

for (const match of [false, true]) {
  test(`A5 daemon JSON -> client: welcome tenant ${match ? "accepted" : "rejected"}`, { timeout: 10000 }, async () => {
    const server = new PhononServer({ authenticate: () => ({ tenantId: "tenant-fixture" }) });
    const port = await server.listen();
    const disconnected = new Promise<void>(resolve => server.once("device", d => d.once("disconnect", resolve)));
    const daemon = new PhononDaemon(config({ url: `ws://127.0.0.1:${port}`, expectedTenantId: match ? "tenant-fixture" : "wrong-fixture" }), { adapters: [] });
    try {
      await daemon.start();
      if (match) {
        await waitConnected(daemon);
        assert.equal((await health(daemon)).ok, true);
        assert.ok(await server.getDevice("fixture-device")!.info());
      } else {
        // A completed hello followed by client close, not merely a pre-connect health sample.
        await disconnected;
        assert.equal((await health(daemon)).connections[0]!.connected, false);
      }
    } finally { await daemon.stop(); await server.close(); }
  });
}

test("A5 daemon JSON -> client: strict plaintext default/false, explicit exception connects locally", { timeout: 10000 }, async () => {
  // 127.0.0.2 is OS loopback, but deliberately outside core's exact 127.0.0.1 allowlist.
  // Thus exercise its non-loopback policy branch without external traffic/wildcard listeners.
  const server = new PhononServer({ host: "127.0.0.2", authenticate: () => ({ tenantId: "tenant-fixture" }) });
  const port = await server.listen();
  try {
    for (const allowInsecure of [undefined, false, true]) {
      const daemon = new PhononDaemon(config({ url: `ws://127.0.0.2:${port}`, allowInsecure, expectedTenantId: "tenant-fixture" }), { adapters: [] });
      try {
        if (allowInsecure === true) { await daemon.start(); await waitConnected(daemon); }
        else { await assert.rejects(daemon.start(), /insecure.*rejected/); assert.equal(server.listDevices().length, 0); }
      } finally { await daemon.stop(); }
    }
  } finally { await server.close(); }
});
