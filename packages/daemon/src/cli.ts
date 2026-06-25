#!/usr/bin/env node
import { PhononDaemon } from "./daemon.js";
import {
  loadConfig,
  defaultConfig,
  writeConfig,
  redactConfig,
  DEFAULT_CONFIG_PATH,
  type DaemonConfig,
} from "./config.js";
import { existsSync } from "node:fs";
import { cmdDoctor, cmdDiscover, cmdAdapterAdd, cmdAdapterList, cmdPluginInstall, cmdService } from "./commands.js";

/**
 * agent-phonon CLI（bug-bash B4）。
 *   agent-phonon init                 生成默认配置
 *   agent-phonon start                启动 daemon（前台；systemd 托管）
 *   agent-phonon server add <url> [--trust-local]   加一个 server 连接
 *   agent-phonon server list          列已配 server
 *   agent-phonon config               打印当前配置路径与内容
 */
const [cmd, ...args] = process.argv.slice(2);

function flag(name: string): boolean {
  return args.includes(`--${name}`);
}
function opt(name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

async function main(): Promise<void> {
  switch (cmd) {
    case "init": {
      if (existsSync(DEFAULT_CONFIG_PATH) && !flag("force")) {
        console.error(`config already exists at ${DEFAULT_CONFIG_PATH} (use --force to overwrite)`);
        process.exit(1);
      }
      writeConfig(defaultConfig());
      console.log(`wrote default config → ${DEFAULT_CONFIG_PATH}`);
      console.log("Add a server: agent-phonon server add ws://your-server:port --trust-local");
      break;
    }
    case "server": {
      const sub = args[0];
      const cfg = loadConfig();
      if (sub === "add") {
        const url = args[1];
        if (!url) {
          console.error("usage: agent-phonon server add <url> [--trust-local] [--device-key <key>]");
          process.exit(1);
        }
        cfg.servers.push({ url, trustLocal: flag("trust-local"), deviceKey: opt("device-key") });
        writeConfig(cfg);
        console.log(`added server ${url} (${cfg.servers.length} total)`);
      } else if (sub === "list") {
        if (cfg.servers.length === 0) console.log("(no servers configured)");
        for (const s of cfg.servers) console.log(`- ${s.url}${s.trustLocal ? " [trustLocal]" : ""}`);
      } else {
        console.error("usage: agent-phonon server add|list");
        process.exit(1);
      }
      break;
    }
    case "config": {
      const cfg = loadConfig();
      console.log(`config: ${DEFAULT_CONFIG_PATH}`);
      // 默认脱敏；--show-secrets 才明文（bug-bash#2）
      console.log(JSON.stringify(flag("show-secrets") ? cfg : redactConfig(cfg), null, 2));
      break;
    }
    case "start": {
      const cfg: DaemonConfig = loadConfig();
      const daemon = new PhononDaemon(cfg);
      await daemon.start();
      console.log(`[agent-phonon] daemon started (device=${cfg.deviceId}, servers=${cfg.servers.length})`);
      const shutdown = async () => {
        console.log("\n[agent-phonon] shutting down…");
        await daemon.stop();
        process.exit(0);
      };
      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);
      // 保持前台
      await new Promise(() => {});
      break;
    }
    case "doctor":
      await cmdDoctor();
      break;
    case "discover":
      await cmdDiscover();
      // Some adapters keep background sockets/handles (e.g. OpenClaw Gateway).
      // discover is a one-shot CLI command, so exit explicitly after printing.
      process.exit(0);
    case "adapter": {
      const sub = args[0];
      if (sub === "add") cmdAdapterAdd(args[1] ?? "", { gatewayUrl: opt("gateway-url"), token: opt("token"), defaultAgent: opt("agent"), baseUrl: opt("base-url"), apiKey: opt("api-key"), model: opt("model"), provider: opt("provider"), wireApi: opt("wire-api"), bin: opt("bin") });
      else if (sub === "list") cmdAdapterList();
      else { console.error("usage: agent-phonon adapter add <type> | list"); process.exit(1); }
      break;
    }
    case "service": {
      cmdService(args[0], { force: flag("force") });
      break;
    }
    case "plugin": {
      const sub = args[0];
      if (sub === "install") cmdPluginInstall(args[1] ?? "");
      else { console.error("usage: agent-phonon plugin install openclaw"); process.exit(1); }
      break;
    }
    default:
      console.log("agent-phonon — device daemon for scheduling local AI agents\n");
      console.log("setup:");
      console.log("  init                          generate default config");
      console.log("  doctor                        check agent availability / Gateway / plugin");
      console.log("  adapter add <type> [opts]     configure an adapter override (auto-detect covers common local agents)");
      console.log("  adapter list                  list configured + auto-detected adapters");
      console.log("  plugin install openclaw       install OpenClaw HITL plugin");
      console.log("  service install|start|status  manage Linux systemd --user service");
      console.log("  server add <url> [--trust-local] [--device-key <k>]");
      console.log("  server list");
      console.log("  config [--show-secrets]       show config (redacted by default)");
      console.log("\nrun:");
      console.log("  discover                      list available agents (without starting daemon)");
      console.log("  start                         start the daemon (systemd-managed)");
      console.log("\nadapter add examples:");
      console.log("  agent-phonon adapter add openclaw --agent phonon");
      console.log("  agent-phonon adapter add codex --base-url https://gw/v1 --api-key <k> --model gpt-5.5");
      console.log("  agent-phonon adapter add hermes");
      break;
  }
}

main().catch((err) => {
  console.error("[agent-phonon]", (err as Error)?.message ?? err);
  process.exit(1);
});
