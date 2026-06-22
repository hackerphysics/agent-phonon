#!/usr/bin/env node
import { PhononConsole } from "./server.js";

/**
 * phonon-console: 启动带 web 控制台的服务端。
 *   phonon-console [--phonon-port N] [--http-port N] [--device-key K] [--require-hitl]
 */
const args = process.argv.slice(2);
const opt = (n: string): string | undefined => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };
const flag = (n: string): boolean => args.includes(`--${n}`);

const console_ = new PhononConsole({
  phononPort: Number(opt("phonon-port") ?? 4500),
  httpPort: Number(opt("http-port") ?? 4600),
  deviceKey: opt("device-key"),
  requireHitl: flag("require-hitl"),
});

const { phononPort, httpPort } = await console_.listen();
console.log(`[phonon-console] devices dial in at:  ws://<host>:${phononPort}`);
console.log(`[phonon-console] web console:         http://127.0.0.1:${httpPort}`);
console.log(`[phonon-console] HITL: ${flag("require-hitl") ? "manual approval (browser)" : "auto-allow"}`);
console.log(`\nPoint a phonon device here: agent-phonon server add ws://127.0.0.1:${phononPort} --trust-local`);

process.on("SIGINT", async () => { await console_.close(); process.exit(0); });
process.on("SIGTERM", async () => { await console_.close(); process.exit(0); });
