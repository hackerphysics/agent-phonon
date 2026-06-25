import { spawnSync } from "node:child_process";
import { Socket } from "node:net";
import { existsSync, cpSync, mkdirSync, rmSync, writeFileSync, readFileSync, chmodSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join, dirname, delimiter, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AdapterRegistry, OpenClawGatewayAdapter, ClaudeCodeAdapter, CodexAdapter, HermesAdapter, OpenCodeAdapter, spawnSyncAgent } from "@agent-phonon/core";
import { loadConfig, writeConfig, readOpenClawGatewayToken, type AdapterConfig, type DaemonConfig } from "./config.js";

/**
 * CLI 辅助命令（让 phonon 真正可用）：doctor / discover / adapter / plugin。
 */

function probe(bin: string, args: string[] = ["--version"]): { ok: boolean; out: string } {
  // spawnSyncAgent：win32 下给含空格的全路径（如 C:\Program Files\nodejs\claude.cmd）加引号，
  // 否则 cmd.exe 在空格处截断 → probe 误判为不可用 → autoDetect 不加 adapter → discover=0。
  const r = spawnSyncAgent(bin, args, { timeout: 8000 });
  return { ok: r.status === 0, out: (r.stdout?.toString() ?? "").trim().split("\n")[0] ?? "" };
}

function executableNames(bin: string): string[] {
  if (platform() !== "win32") return [bin];
  const exts = (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .map((e) => e.toLowerCase())
    .filter(Boolean);
  // Windows：带 PATHEXT 扩展名的版本优先（.cmd/.exe 才是真正可执行的）。
  // 裸名放最后——npm 全局会同时生成一个无扩展名的 Unix shell shim（如
  // `C:\Program Files\nodejs\claude`），它 existsSync 为 true 但 Windows 根本
  // 不能执行；旧实现把裸名放第一位导致 commandPath 命中这个 shim → adapter
  // spawn 时 ENOENT/EINVAL，最终 discover=0（doctor 却 ✓，因为 probe 用裸名+shell）。
  return [
    ...exts.map((e) => `${bin}${e}`),
    ...exts.map((e) => `${bin}${e.toUpperCase()}`),
    bin,
  ];
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

function gatewayReachable(url: string): Promise<boolean> {
  // 跨平台 TCP 探测（纯 Node net，不依赖 bash//dev/tcp，修 Windows 恒为 unreachable）。
  return new Promise((resolve) => {
    let u: URL;
    try { u = new URL(url.replace(/^ws/, "http")); } catch { resolve(false); return; }
    const port = Number(u.port) || (u.protocol === "https:" ? 443 : 80);
    const sock = new Socket();
    let done = false;
    const finish = (ok: boolean): void => { if (done) return; done = true; sock.destroy(); resolve(ok); };
    sock.setTimeout(3000);
    sock.once("connect", () => finish(true));
    sock.once("timeout", () => finish(false));
    sock.once("error", () => finish(false));
    sock.connect(port, u.hostname);
  });
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
export async function cmdDoctor(): Promise<void> {
  console.log("agent-phonon doctor\n");
  // OpenClaw Gateway
  const gwToken = readOpenClawGatewayToken();
  const gwUrl = "ws://127.0.0.1:18789";
  const gwOk = await gatewayReachable(gwUrl);
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

function systemctlUser(args: string[]): void {
  const r = spawnSync("systemctl", ["--user", ...args], { stdio: "inherit" });
  if (r.status !== 0) fail(`systemctl --user ${args.join(" ")} failed`);
}

function serviceUnitPath(): string {
  return join(homedir(), ".config", "systemd", "user", "agent-phonon.service");
}

function serviceUnitContent(): string {
  const node = process.execPath;
  const cli = resolve(process.argv[1] ?? fileURLToPath(import.meta.url));
  return `[Unit]\nDescription=agent-phonon device daemon\nAfter=network-online.target\nWants=network-online.target\n\n[Service]\nType=simple\nExecStart=${node} ${cli} start\nRestart=always\nRestartSec=5\nMemoryMax=256M\n\n[Install]\nWantedBy=default.target\n`;
}

// ── macOS launchd ──────────────────────────────────────────────
const LAUNCHD_LABEL = "ai.phonon.agent";

function launchAgentPath(): string {
  return join(homedir(), "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
}

function launchAgentContent(): string {
  const node = process.execPath;
  const cli = resolve(process.argv[1] ?? fileURLToPath(import.meta.url));
  const logDir = join(homedir(), ".agent-phonon");
  const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${esc(node)}</string>
    <string>${esc(cli)}</string>
    <string>start</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${esc(join(logDir, "daemon.out.log"))}</string>
  <key>StandardErrorPath</key><string>${esc(join(logDir, "daemon.err.log"))}</string>
</dict>
</plist>
`;
}

function launchctl(args: string[], opts: { check?: boolean } = {}): void {
  const r = spawnSync("launchctl", args, { stdio: "inherit" });
  if (opts.check && r.status !== 0) fail(`launchctl ${args.join(" ")} failed`);
}

function cmdServiceLaunchd(sub: string | undefined, opts: { force?: boolean }): void {
  const plist = launchAgentPath();
  switch (sub) {
    case "install": {
      if (existsSync(plist) && !opts.force) fail(`${plist} already exists (use --force to overwrite)`);
      mkdirSync(dirname(plist), { recursive: true });
      mkdirSync(join(homedir(), ".agent-phonon"), { recursive: true });
      writeFileSync(plist, launchAgentContent(), { mode: 0o644 });
      chmodSync(plist, 0o644);
      launchctl(["unload", plist]); // best-effort（覆盖安装时先卸）
      launchctl(["load", "-w", plist], { check: true });
      console.log(`installed + loaded launchd user agent → ${plist}`);
      console.log("it will start at login and is running now (RunAtLoad).");
      if (!existsSync(join(homedir(), ".agent-phonon", "config.json"))) console.log("config not found yet; run: agent-phonon init");
      break;
    }
    case "start":
      launchctl(["start", LAUNCHD_LABEL], { check: true });
      console.log(`started ${LAUNCHD_LABEL}`);
      break;
    case "stop":
      launchctl(["stop", LAUNCHD_LABEL], { check: true });
      console.log(`stopped ${LAUNCHD_LABEL}`);
      break;
    case "restart":
      launchctl(["stop", LAUNCHD_LABEL]);
      launchctl(["start", LAUNCHD_LABEL], { check: true });
      console.log(`restarted ${LAUNCHD_LABEL}`);
      break;
    case "status":
      // launchctl list <label> 返回该 job 的 dict（含 PID/LastExitStatus）；未加载则非零退出
      launchctl(["list", LAUNCHD_LABEL]);
      break;
    case "uninstall":
      launchctl(["unload", "-w", plist]);
      rmSync(plist, { force: true });
      console.log(`removed ${plist}`);
      break;
    default:
      fail("usage: agent-phonon service install|start|stop|restart|status|uninstall [--force]");
  }
}

function cmdServiceWindowsGuidance(): void {
  // Windows 没有 systemd//launchd 等价的「用户级常驻服务」一键方案：
  // Task Scheduler 不适合长驻守护，正经做法是 nssm/winsw（需外部二进制）。
  // 不做半成品 schtasks hack，给出可照做的手动指引（诚实优先）。
  const node = process.execPath;
  const cli = resolve(process.argv[1] ?? fileURLToPath(import.meta.url));
  console.log("Windows 暂无内置自启服务安装（systemd/launchd 在 Windows 无对应）。\n");
  console.log("推荐用 nssm（https://nssm.cc）把它注册成 Windows 服务：");
  console.log(`  nssm install agent-phonon "${node}" "${cli}" start`);
  console.log("  nssm start agent-phonon\n");
  console.log("或登录自启（开机后台运行，非真正服务）—— 在 PowerShell 执行：");
  console.log(`  $a = New-ScheduledTaskAction -Execute '${node}' -Argument '"${cli}" start'`);
  console.log("  $t = New-ScheduledTaskTrigger -AtLogOn");
  console.log("  Register-ScheduledTask -TaskName agent-phonon -Action $a -Trigger $t -RunLevel Limited");
}

export function cmdService(sub: string | undefined, opts: { force?: boolean } = {}): void {
  const plat = platform();
  if (plat === "darwin") return cmdServiceLaunchd(sub, opts);
  if (plat === "win32") return cmdServiceWindowsGuidance();
  if (plat !== "linux") {
    fail(`service ${sub ?? ""} not supported on platform=${plat} (linux systemd / macOS launchd / Windows nssm only)`);
  }
  const unit = serviceUnitPath();
  switch (sub) {
    case "install": {
      if (existsSync(unit) && !opts.force) fail(`${unit} already exists (use --force to overwrite)`);
      mkdirSync(dirname(unit), { recursive: true });
      writeFileSync(unit, serviceUnitContent(), { mode: 0o644 });
      chmodSync(unit, 0o644);
      systemctlUser(["daemon-reload"]);
      systemctlUser(["enable", "agent-phonon.service"]);
      console.log(`installed systemd user service → ${unit}`);
      console.log("start it with: agent-phonon service start");
      if (!existsSync(join(homedir(), ".agent-phonon", "config.json"))) console.log("config not found yet; run: agent-phonon init");
      break;
    }
    case "start":
      systemctlUser(["start", "agent-phonon.service"]);
      console.log("started agent-phonon.service");
      break;
    case "stop":
      systemctlUser(["stop", "agent-phonon.service"]);
      console.log("stopped agent-phonon.service");
      break;
    case "restart":
      systemctlUser(["restart", "agent-phonon.service"]);
      console.log("restarted agent-phonon.service");
      break;
    case "status":
      systemctlUser(["status", "agent-phonon.service", "--no-pager"]);
      break;
    case "uninstall":
      systemctlUser(["disable", "--now", "agent-phonon.service"]);
      rmSync(unit, { force: true });
      systemctlUser(["daemon-reload"]);
      console.log(`removed ${unit}`);
      break;
    default:
      fail("usage: agent-phonon service install|start|stop|restart|status|uninstall [--force]");
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
