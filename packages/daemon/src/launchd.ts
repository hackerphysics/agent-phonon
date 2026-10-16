import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, constants, existsSync, fchmodSync, fstatSync, mkdirSync, openSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

export const LAUNCHD_LABEL = "ai.phonon.agent";

export interface LaunchdOptions {
  home: string;
  node: string;
  cli: string;
  configPath: string;
  path?: string;
  uid: number;
  label?: string;
}

interface LaunchctlResult {
  status: number | null;
  stdout: string;
  error?: Error;
}

interface LaunchdDependencies {
  launchctl: (args: string[]) => LaunchctlResult;
  waitForExit: (pid: number) => Promise<void>;
  log: (message: string) => void;
}

function xml(value: string): string {
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) throw new Error("invalid character in launchd configuration");
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function launchAgentContent(options: LaunchdOptions): string {
  const { home, node, cli, configPath } = options;
  for (const path of [home, node, cli, configPath]) {
    if (!isAbsolute(path)) throw new Error("launchd paths must be absolute");
  }
  // launchd does not source the user's shell. Preserve executable search paths,
  // but never copy provider credentials or the rest of the shell environment.
  const path = [...new Set([
    dirname(node), ...(options.path ?? "").split(":"),
    join(home, ".local", "bin"), join(home, ".npm-global", "bin"),
    join(home, ".bun", "bin"), join(home, ".cargo", "bin"),
    "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin",
  ].filter(isAbsolute))].join(":");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${xml(options.label ?? LAUNCHD_LABEL)}</string>
  <key>ProgramArguments</key>
  <array><string>${xml(node)}</string><string>${xml(cli)}</string><string>start</string></array>
  <key>WorkingDirectory</key><string>${xml(home)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key><string>${xml(home)}</string>
    <key>PATH</key><string>${xml(path)}</string>
    <key>PHONON_CONFIG</key><string>${xml(configPath)}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>5</integer>
  <key>ExitTimeOut</key><integer>10</integer>
  <key>Umask</key><integer>63</integer>
  <key>StandardOutPath</key><string>${xml(join(home, ".agent-phonon", "daemon.out.log"))}</string>
  <key>StandardErrorPath</key><string>${xml(join(home, ".agent-phonon", "daemon.err.log"))}</string>
</dict>
</plist>
`;
}

async function waitForExit(pid: number): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (true) {
    try { process.kill(pid, 0); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
      throw error;
    }
    if (Date.now() >= deadline) throw new Error(`daemon PID ${pid} has not exited; refusing to start an overlapping instance`);
    await sleep(50);
  }
}

export class LaunchdService {
  public readonly plist: string;
  private readonly domain: string;
  private readonly target: string;
  private readonly deps: LaunchdDependencies;

  public constructor(private readonly options: LaunchdOptions, deps: Partial<LaunchdDependencies> = {}) {
    const label = options.label ?? LAUNCHD_LABEL;
    if (!/^[A-Za-z0-9.-]+$/.test(label)) throw new Error("invalid launchd service label");
    if (!Number.isSafeInteger(options.uid) || options.uid <= 0) throw new Error("run service commands as the signed-in user, without sudo");
    this.plist = join(options.home, "Library", "LaunchAgents", `${label}.plist`);
    this.domain = `gui/${options.uid}`;
    this.target = `${this.domain}/${label}`;
    this.deps = {
      launchctl: args => spawnSync("/bin/launchctl", args, { encoding: "utf8", timeout: 20_000 }),
      waitForExit,
      log: message => console.log(message),
      ...deps,
    };
  }

  private checked(args: string[]): void {
    const result = this.deps.launchctl(args);
    if (result.error || result.status !== 0) throw new Error(`launchctl ${args.join(" ")} failed (${result.error?.message ?? result.status})`);
  }

  private state(): { loaded: boolean; pid?: number; lastExit?: number } {
    const result = this.deps.launchctl(["print", this.target]);
    if (result.error) throw new Error(`cannot inspect launchd service: ${result.error.message}`);
    // launchctl print is diagnostic text, not a plist. Read only its numeric fields.
    if (result.status === 113) return { loaded: false };
    if (result.status !== 0) throw new Error(`cannot inspect launchd service (exit ${result.status})`);
    const pid = /^\s*pid = (\d+)\s*$/m.exec(result.stdout);
    const lastExit = /^\s*last exit code = (-?\d+)\s*$/m.exec(result.stdout);
    return { loaded: true, pid: pid ? Number(pid[1]) : undefined, lastExit: lastExit ? Number(lastExit[1]) : undefined };
  }

  private async unload(state: ReturnType<LaunchdService["state"]>): Promise<void> {
    if (!state.loaded) return;
    this.checked(["bootout", this.target]);
    if (state.pid) await this.deps.waitForExit(state.pid);
  }

  public async run(sub: string | undefined, opts: { force?: boolean } = {}): Promise<void> {
    const label = this.options.label ?? LAUNCHD_LABEL;
    if (sub === "install") {
      if (existsSync(this.plist) && !opts.force) throw new Error(`${this.plist} already exists (use --force to overwrite)`);
      const content = launchAgentContent(this.options);
      if (!existsSync(this.options.node) || !existsSync(this.options.cli)) throw new Error("Node or agent-phonon CLI is missing; reinstall before installing the service");
      mkdirSync(dirname(this.plist), { recursive: true });
      mkdirSync(join(this.options.home, ".agent-phonon"), { recursive: true, mode: 0o700 });
      // launchd opens redirected logs before applying the job's Umask.
      for (const name of ["daemon.out.log", "daemon.err.log"]) {
        const fd = openSync(join(this.options.home, ".agent-phonon", name),
          constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
        try {
          if (!fstatSync(fd).isFile()) throw new Error("launchd log path must be a regular file");
          fchmodSync(fd, 0o600);
        } finally { closeSync(fd); }
      }
      const temporary = `${this.plist}.tmp-${randomUUID()}`;
      try {
        writeFileSync(temporary, content, { mode: 0o600, flag: "wx" });
        renameSync(temporary, this.plist);
      } finally { rmSync(temporary, { force: true }); }
      this.deps.log(`installed launchd user agent: ${this.plist}`);
      this.deps.log("starts at login; start now with: agent-phonon service start (or restart an already loaded service)");
      if (!existsSync(this.options.configPath)) this.deps.log("config not found; run: agent-phonon init");
      return;
    }
    if (!["start", "stop", "restart", "status", "uninstall"].includes(sub ?? "")) {
      throw new Error("usage: agent-phonon service install|start|stop|restart|status|uninstall [--force]");
    }
    const domain = this.deps.launchctl(["print", this.domain]);
    if (domain.error || domain.status !== 0) throw new Error("macOS GUI session unavailable; run as the signed-in user without sudo");
    const state = this.state();
    if (sub === "status") {
      if (state.pid) this.deps.log(`${label}: running (PID ${state.pid})`);
      else if (state.loaded) this.deps.log(`${label}: loaded but not running (last exit status ${state.lastExit ?? "unknown"})`);
      else this.deps.log(`${label}: ${existsSync(this.plist) ? "stopped" : "not installed"} (run: agent-phonon service ${existsSync(this.plist) ? "start" : "install"})`);
      return;
    }
    if (sub === "stop" || sub === "uninstall") {
      // bootout removes KeepAlive supervision; launchctl stop would respawn it.
      await this.unload(state);
      if (sub === "uninstall") {
        rmSync(this.plist, { force: true });
        this.deps.log(`removed ${this.plist}; config, credentials, database and logs preserved`);
      } else this.deps.log(`stopped ${label} until the next login or service start`);
      return;
    }
    if (!existsSync(this.plist)) throw new Error("service not installed; run: agent-phonon service install");
    if (!existsSync(this.options.configPath)) throw new Error("config not found; run: agent-phonon init");
    if (sub === "restart") await this.unload(state);
    else if (state.pid) { this.deps.log(`${label}: already running (PID ${state.pid})`); return; }
    this.checked(["enable", this.target]);
    if (sub === "start" && state.loaded) this.checked(["kickstart", this.target]);
    else this.checked(["bootstrap", this.domain, this.plist]);
    this.deps.log(`${sub === "restart" ? "restarted" : "started"} ${label}; use service status to inspect the process`);
  }
}
