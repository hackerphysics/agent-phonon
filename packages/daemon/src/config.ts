import { readFileSync, existsSync, mkdirSync, writeFileSync, chmodSync } from "node:fs";
import type { ModelInfo } from "@agent-phonon/protocol";
import { homedir, hostname } from "node:os";
import { join, dirname } from "node:path";

/**
 * daemon 配置（bug-bash B4）。
 *
 * 一个 daemon 进程：一个设备 id、一个共享 sqlite、一个 HookBridge，
 * 注册若干 adapter，连接若干 server（每个 server = 一个 tenant 连接）。
 */
export interface ServerConfig {
  /** 服务端 ws/http URL。 */
  url: string;
  /** 本地自用放宽 policy（默认 false）。 */
  trustLocal?: boolean;
  /** 该连接的可选 device key（鉴权由 server 做，phonon 仅携带）。 */
  deviceKey?: string;
}

export interface AdapterConfig {
  /** adapter 类型：openclaw-gateway | openclaw-cli。 */
  type: "openclaw-gateway" | "openclaw-cli" | "claude-code" | "codex" | "hermes" | "opencode";
  /** OpenClaw Gateway WS URL（openclaw-gateway 用）。 */
  gatewayUrl?: string;
  /** Gateway token（openclaw-gateway 用；缺省从 ~/.openclaw/openclaw.json 读）。 */
  gatewayToken?: string;
  /** 默认 OpenClaw sub-agent。 */
  defaultAgent?: string;
  /** claude-code：网关 baseUrl/token/默认模型。 */
  claudeBinPath?: string;
  claudeBaseUrl?: string;
  claudeAuthToken?: string;
  claudeDefaultModel?: string;
  claudeModels?: ModelInfo[];
  /** codex：网关 baseUrl(/v1)/key/默认模型/wireApi。 */
  codexBinPath?: string;
  codexBaseUrl?: string;
  codexApiKey?: string;
  codexDefaultModel?: string;
  codexModels?: ModelInfo[];
  codexWireApi?: "responses" | "chat";
  /** hermes：默认模型/provider（用现有 hermes config）。 */
  hermesBinPath?: string;
  hermesModel?: string;
  hermesProvider?: string;
  /** opencode：binary 路径/默认模型。 */
  opencodeBinPath?: string;
  opencodeModel?: string;
}

export interface DaemonConfig {
  deviceId: string;
  /** sqlite 文件路径。 */
  dbPath: string;
  /** 受控项目根。 */
  workspaceRoot: string;
  /** 结构化日志级别。 */
  logLevel?: "debug" | "info" | "warn" | "error";
  hookBridge?: { port?: number; token?: string };
  /** 可观测 HTTP 服务。 */
  obs?: { enabled?: boolean; port?: number; token?: string };
  adapters: AdapterConfig[];
  servers: ServerConfig[];
}

const DEFAULT_DIR = join(homedir(), ".agent-phonon");
export const DEFAULT_CONFIG_PATH = process.env.PHONON_CONFIG ?? join(DEFAULT_DIR, "config.json");

export function defaultConfig(): DaemonConfig {
  return {
    deviceId: `dev-${hostname()}`,
    dbPath: join(DEFAULT_DIR, "phonon.db"),
    workspaceRoot: join(homedir(), "phonon-projects"),
    hookBridge: { port: 4318 },
    obs: { enabled: true, port: 4319 },
    adapters: [{ type: "openclaw-gateway", gatewayUrl: "ws://127.0.0.1:18789", defaultAgent: "main" }],
    servers: [],
  };
}

export function loadConfig(path = DEFAULT_CONFIG_PATH): DaemonConfig {
  if (!existsSync(path)) {
    throw new Error(`config not found at ${path} — run 'agent-phonon init' first`);
  }
  const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<DaemonConfig>;
  const d = defaultConfig();
  return {
    deviceId: raw.deviceId ?? d.deviceId,
    dbPath: raw.dbPath ?? d.dbPath,
    workspaceRoot: raw.workspaceRoot ?? d.workspaceRoot,
    hookBridge: { ...d.hookBridge, ...raw.hookBridge },
    obs: { ...d.obs, ...raw.obs },
    logLevel: raw.logLevel ?? d.logLevel,
    adapters: raw.adapters ?? d.adapters,
    servers: raw.servers ?? d.servers,
  };
}

export function writeConfig(cfg: DaemonConfig, path = DEFAULT_CONFIG_PATH): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  try { chmodSync(path, 0o600); } catch { /* best-effort */ } // 含 token，限制权限（bug-bash#2）
}

/** 脱敏配置（用于打印/日志，不露 token/key）。 */
export function redactConfig(cfg: DaemonConfig): DaemonConfig {
  const mask = (v?: string): string | undefined => (v ? `***${v.slice(-4)}` : v);
  return {
    ...cfg,
    hookBridge: cfg.hookBridge ? { ...cfg.hookBridge, token: mask(cfg.hookBridge.token) } : cfg.hookBridge,
    obs: cfg.obs ? { ...cfg.obs, token: mask(cfg.obs.token) } : cfg.obs,
    adapters: cfg.adapters.map((a) => ({
      ...a,
      gatewayToken: mask(a.gatewayToken),
      claudeAuthToken: mask(a.claudeAuthToken),
      codexApiKey: mask(a.codexApiKey),
    })),
    servers: cfg.servers.map((s) => ({ ...s, deviceKey: mask(s.deviceKey) })),
  };
}

/** 从 ~/.openclaw/openclaw.json 读 Gateway token（adapter 缺省）。 */
export function readOpenClawGatewayToken(): string | undefined {
  try {
    const p = join(homedir(), ".openclaw", "openclaw.json");
    const cfg = JSON.parse(readFileSync(p, "utf8"));
    return cfg?.gateway?.auth?.token;
  } catch {
    return undefined;
  }
}
