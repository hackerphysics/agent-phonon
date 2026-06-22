import { spawnSync } from "node:child_process";
import { existsSync, cpSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join, dirname, delimiter } from "node:path";
import { fileURLToPath } from "node:url";
import { AdapterRegistry, OpenClawGatewayAdapter, ClaudeCodeAdapter, CodexAdapter, HermesAdapter, OpenCodeAdapter } from "@agent-phonon/core";
import { loadConfig, writeConfig, readOpenClawGatewayToken, type AdapterConfig, type DaemonConfig } from "./config.js";

/**
 * CLI 辅助命令（让 phonon 真正可用）：doctor / discover / adapter / plugin。
 */

function probe(bin: string, args: string[] = ["--version"]): { ok: boolean; out: string } {
  const r = spawnSync(bin, args, { timeout: 8000, shell: platform() === "win32" });
  return { ok: r.status === 0, out: (r.stdout?.toString() ?? "").trim().split("\n")[0] ?? "" };
}

function executableNames(bin: string): string[] {
  if (platform() !== "win32") return [bin];
  const exts = (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .map((e) => e.toLowerCase());
  return [bin, ...exts.map((e) => `${bin}${e}`), ...exts.map((e) => `${bin}${e.toUpperCase()}`)];
}

export function commandPath(bin: string): string | undefined {
  const home = homedir();
  const appData = process.env.APPDATA;
  const localAppData = process.env.LOCALAPPDATA;
  const dirs = [
    join(home, ".npm-global", "bin"),
    join(home, ".local", "bin"),
    join(home, ".bun", "bin"),
    join(home, ".cargo", "bin"),
    ...(appData ? [join(appData, "npm")] : []),
    ...(localAppData ? [join(localAppData, "Programs"), join(localAppData, "Microsoft", "WindowsApps")] : []),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    ...(process.env.PATH ?? "").split(delimiter).filter(Boolean),
  ];
  for (const dir of dirs) {
    for (const name of executableNames(bin)) {
      const p = join(dir, name);
      if (existsSync(p)) return p;
    }
  }

  const r = platform() === "win32"
    ? spawnSync("where.exe", [bin], { timeout: 3000 })
    : spawnSync("sh", ["-lc", `command -v ${bin}`], { timeout: 3000 });
  const out = (r.stdout?.toString() ?? "").trim().split(/\r?\n/)[0];
  return r.status === 0 && out ? out : undefined;
}

function gatewayReachable(url: string): boolean {
  // 简单 TCP 探测：用 node 连一下 ws 端口
  try {
    const u = new URL(url.replace(/^ws/, "http"));
    const r = spawnSync("bash", ["-c", `exec 3<>/dev/tcp/${u.hostname}/${u.port || 80} && echo ok`], { timeout: 3000 });
    return r.status === 0;
  } catch {
    return false;
  }
}

function openCodeBin(): string {
  const bundledDir = join(homedir(), ".opencode", "bin");
  for (const name of executableNames("opencode")) {
    const p = join(bundledDir, name);
    if (existsSync(p)) return p;
  }
  return commandPath("opencode") ?? "opencode";
}

export function autoDetectAdapters(adapters: AdapterConfig[]): AdapterConfig[] {
  const out = [...adapters];
  const has = (type: AdapterConfig["type"]): boolean => out.some((a) => a.type === type);

  if (!has("hermes")) {
    const hermesPath = commandPath("hermes");
    if (hermesPath && probe(hermesPath).ok) out.push({ type: "hermes", hermesBinPath: hermesPath });
  }

  const ocBin = openCodeBin();
  if (!has("opencode") && probe(ocBin).ok) out.push({ type: "opencode", opencodeBinPath: ocBin === "opencode" ? undefined : ocBin });

  for (const a of out) {
    if (a.type === "hermes" && !a.hermesBinPath) a.hermesBinPath = commandPath("hermes");
    if (a.type === "claude-code" && !a.claudeBinPath) a.claudeBinPath = commandPath("claude");
    if (a.type === "codex" && !a.codexBinPath) a.codexBinPath = commandPath("codex");
  }

  if (!has("claude-code")) {
    const claudePath = commandPath("claude");
    if (claudePath && probe(claudePath).ok) out.push({ type: "claude-code", claudeBinPath: claudePath, claudeDefaultModel: "default" });
  }
  if (!has("codex")) {
    const codexPath = commandPath("codex");
    if (codexPath && probe(codexPath).ok) out.push({ type: "codex", codexBinPath: codexPath, codexDefaultModel: "default" });
  }

  return out;
}

/** doctor：体检本机 agent 可用性 + Gateway + 插件。 */
export function cmdDoctor(): void {
  console.log("agent-phonon doctor\n");
  // OpenClaw Gateway
  const gwToken = readOpenClawGatewayToken();
  const gwUrl = "ws://127.0.0.1:18789";
  const gwOk = gatewayReachable(gwUrl);
  console.log(`OpenClaw Gateway (${gwUrl}): ${gwOk ? "✓ reachable" : "✗ unreachable"}${gwToken ? " (token found)" : " (no token in ~/.openclaw/openclaw.json)"}`);
  // OpenClaw plugin
  const pluginDir = join(homedir(), ".openclaw", "extensions", "agent-phonon-hitl");
  console.log(`OpenClaw HITL plugin: ${existsSync(pluginDir) ? "✓ installed" : "✗ not installed (run: agent-phonon plugin install openclaw)"}`);
  // CLI agents
  console.log("\nCLI agents:");
  for (const [name, bin] of [["Claude Code", "claude"], ["Codex", "codex"], ["Hermes", "hermes"]] as const) {
    const p = probe(bin);
    console.log(`  ${name} (${bin}): ${p.ok ? "✓ " + p.out : "✗ not found"}`);
  }
  // OpenCode (often not in PATH)
  const ocBin = openCodeBin();
  const oc = probe(ocBin);
  console.log(`  OpenCode (${ocBin}): ${oc.ok ? "✓ " + oc.out : "✗ not found"}`);
  // config
  console.log("");
  try {
    const cfg = loadConfig();
    const effective = autoDetectAdapters(cfg.adapters);
    console.log(`config: ${cfg.adapters.length} configured adapter(s), ${effective.length} effective adapter(s), ${cfg.servers.length} server(s)`);
  } catch {
    console.log("config: not initialized (run: agent-phonon init)");
  }
}

/** discover：不启 daemon，直接列本机可用 agent（按已配 adapter）。 */
export async function cmdDiscover(): Promise<void> {
  let cfg: DaemonConfig;
  try { cfg = loadConfig(); } catch { console.error("config not initialized — run 'agent-phonon init' first"); process.exit(1); return; }
  const reg = buildRegistry(cfg.adapters);
  const nested = await Promise.all(reg.all().map((a) => a.discoverAgents()));
  const agents = nested.flat();
  console.log(`discovered ${agents.length} agent(s):\n`);
  for (const a of agents) {
    console.log(`  ${a.available ? "✓" : "✗"} ${a.agentId}  (${a.displayName})${a.available ? "" : " — " + (a.unavailableReason ?? "unavailable")}`);
    if (a.models.length) console.log(`      models: ${a.models.map((m) => m.id).join(", ")}`);
  }
}

/** 从 adapter 配置构造 registry（discover/doctor 用）。 */
export function buildRegistry(adapters: AdapterConfig[]): AdapterRegistry {
  const reg = new AdapterRegistry();
  for (const a of autoDetectAdapters(adapters)) {
    if (a.type === "openclaw-gateway") {
      const token = a.gatewayToken ?? readOpenClawGatewayToken();
      if (token) reg.register(new OpenClawGatewayAdapter({ gateway: { baseUrl: a.gatewayUrl ?? "ws://127.0.0.1:18789", token }, defaultAgent: a.defaultAgent ?? "main" }));
    } else if (a.type === "claude-code") {
      reg.register(new ClaudeCodeAdapter({ env: { binPath: a.claudeBinPath, baseUrl: a.claudeBaseUrl, authToken: a.claudeAuthToken, defaultModel: a.claudeDefaultModel ?? "default", models: a.claudeModels } }));
    } else if (a.type === "codex") {
      reg.register(new CodexAdapter({ env: { binPath: a.codexBinPath, baseUrl: a.codexBaseUrl, apiKey: a.codexApiKey, defaultModel: a.codexDefaultModel ?? "default", models: a.codexModels, wireApi: a.codexWireApi ?? "responses" } }));
    } else if (a.type === "hermes") {
      reg.register(new HermesAdapter({ env: { binPath: a.hermesBinPath, defaultModel: a.hermesModel, provider: a.hermesProvider } }));
    } else if (a.type === "opencode") {
      reg.register(new OpenCodeAdapter({ env: { binPath: a.opencodeBinPath, defaultModel: a.opencodeModel } }));
    }
  }
  return reg;
}

/** adapter add：往 config 加一个 adapter。 */
export function cmdAdapterAdd(type: string, opts: Record<string, string | undefined>): void {
  const cfg = loadConfig();
  let a: AdapterConfig;
  switch (type) {
    case "openclaw":
    case "openclaw-gateway":
      a = { type: "openclaw-gateway", gatewayUrl: opts.gatewayUrl ?? "ws://127.0.0.1:18789", gatewayToken: opts.token, defaultAgent: opts.defaultAgent ?? "main" };
      break;
    case "claude-code":
      a = { type: "claude-code", claudeBinPath: opts.bin, claudeBaseUrl: opts.baseUrl, claudeAuthToken: opts.token, claudeDefaultModel: opts.model ?? "default" };
      break;
    case "codex":
      a = { type: "codex", codexBinPath: opts.bin, codexBaseUrl: opts.baseUrl, codexApiKey: opts.apiKey, codexDefaultModel: opts.model ?? "default", codexWireApi: (opts.wireApi as "responses" | "chat") ?? "responses" };
      break;
    case "hermes":
      a = { type: "hermes", hermesBinPath: opts.bin, hermesModel: opts.model, hermesProvider: opts.provider };
      break;
    case "opencode":
      a = { type: "opencode", opencodeBinPath: opts.bin, opencodeModel: opts.model };
      break;
    default:
      return fail(`unknown adapter type: ${type} (openclaw|claude-code|codex|hermes|opencode)`);
  }
  // 去重：同 type 覆盖
  cfg.adapters = cfg.adapters.filter((x) => x.type !== a.type);
  cfg.adapters.push(a);
  writeConfig(cfg);
  console.log(`added ${a.type} adapter (${cfg.adapters.length} total)`);
}

export function cmdAdapterList(): void {
  const cfg = loadConfig();
  const effective = autoDetectAdapters(cfg.adapters);
  if (effective.length === 0) { console.log("(no adapters available)"); return; }
  for (const a of effective) {
    const auto = cfg.adapters.some((x) => x.type === a.type) ? "" : " [auto]";
    console.log(`- ${a.type}${a.defaultAgent ? ` (agent: ${a.defaultAgent})` : ""}${auto}`);
  }
}

/** plugin install：装 OpenClaw HITL 插件（导出干净产物 + force 安装）。 */
export function cmdPluginInstall(which: string): void {
  if (which !== "openclaw") return fail(`plugin install supports: openclaw (got: ${which})`);
  // 找到 monorepo 里的 openclaw-plugin 包
  const here = dirname(fileURLToPath(import.meta.url));
  const pluginSrc = join(here, "..", "..", "openclaw-plugin");
  if (!existsSync(join(pluginSrc, "dist", "index.js"))) {
    return fail(`plugin not built. Run: cd ${pluginSrc} && pnpm build`);
  }
  // 导出干净产物（避免 pnpm workspace node_modules symlink 触发安全扫描）
  const dist = join(homedir(), ".agent-phonon", "openclaw-plugin-dist");
  rmSync(dist, { recursive: true, force: true });
  mkdirSync(dist, { recursive: true });
  cpSync(join(pluginSrc, "dist"), join(dist, "dist"), { recursive: true });
  cpSync(join(pluginSrc, "openclaw.plugin.json"), join(dist, "openclaw.plugin.json"));
  const pkg = JSON.parse(readFileSync(join(pluginSrc, "package.json"), "utf8")) as Record<string, unknown>;
  delete pkg.devDependencies;
  writeFileSync(join(dist, "package.json"), JSON.stringify(pkg, null, 2));
  console.log(`exported clean plugin → ${dist}`);
  const r = spawnSync("openclaw", ["plugins", "install", "--force", dist], { stdio: "inherit" });
  if (r.status === 0) console.log("\n✓ installed. Restart OpenClaw Gateway to load: systemctl --user restart openclaw-gateway.service");
  else fail("openclaw plugins install failed");
}

function fail(msg: string): void {
  console.error("error:", msg);
  process.exit(1);
}
