#!/usr/bin/env node
import { PhononTestServer } from "./index.js";

/**
 * 手动启动 test-server：`phonon-test-server [port]`
 * 起一个监听端口的参考 server，等 phonon 拨入；打印拨入设备与收到的 stream 事件。
 * 仅用于本地测试/联调，不是生产服务端。
 */
const port = Number(process.argv[2] ?? 4319);

const server = new PhononTestServer({
  port,
  assignTenant: (deviceId) => `tenant-${deviceId}`,
});

const actualPort = await server.listen();
console.log(`[phonon-test-server] listening on ws://127.0.0.1:${actualPort}`);
console.log("[phonon-test-server] waiting for phonon device to dial in… (Ctrl-C to stop)");

// 简单轮询打印新拨入设备
let known = 0;
setInterval(async () => {
  try {
    const dev = await server.firstDevice(500).catch(() => null);
    if (dev && known === 0) {
      known = 1;
      console.log(`[phonon-test-server] device connected: ${dev.deviceId} → tenant ${dev.tenantId}`);
      // 自动跑一次 discovery 展示
      const disco = (await dev.peer.requestRaw("discovery.list", {})) as {
        agents: Array<{ agentId: string; available: boolean; models: unknown[] }>;
      };
      console.log("[phonon-test-server] discovery.list →", JSON.stringify(disco.agents.map((a) => ({ agentId: a.agentId, available: a.available })), null, 2));
    }
  } catch {
    /* ignore */
  }
}, 1000);

process.on("SIGINT", async () => {
  console.log("\n[phonon-test-server] shutting down");
  await server.close();
  process.exit(0);
});
