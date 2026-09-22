import { readFileSync, existsSync, mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { generateText, tool } from "ai";
import { z } from "zod";
import type { ModelInfo, TenantPolicy } from "@agent-phonon/protocol";
import { discoveryOptions, type DiscoveryOptions, createRescueModel, rescueProviderOptions, validateRescueEndpoint, type RescueConnectionOptions, type MaintenanceManagerConfig } from "@agent-phonon/core";
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
  /** Pin the welcome tenant identity; mismatch rejects the connection. */
  expectedTenantId?: string;
  /** Explicit non-loopback plaintext transport exception. Default remains false. */
  allowInsecure?: boolean;
  /** 该 tenant 的本地设备授权边界；设备始终拥有最终否决权。 */
  policy?: Partial<TenantPolicy>;
}

export interface AdapterConfig {
  /** adapter 类型：openclaw-gateway | openclaw-cli。 */
  type: "openclaw-gateway" | "openclaw-cli" | "claude-code" | "codex" | "hermes" | "opencode" | "copilot" | "herdr";
  /** OpenClaw Gateway WS URL（openclaw-gateway 用）。 */
  gatewayUrl?: string;
  /** Gateway token（openclaw-gateway 用；缺省从 ~/.openclaw/openclaw.json 读）。 */
  gatewayToken?: string;
  /** 默认 OpenClaw sub-agent。 */
  defaultAgent?: string;
  /** claude-code：网关 baseUrl/token/默认模型。 */
  claudeBinPath?: string;
  /** Local owner-selected standalone settings; takes precedence over legacy endpoint/auth/model overrides. */
  claudeSettingsPath?: string;
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
  /** GitHub Copilot CLI：binary 路径/默认模型/模型清单。 */
  copilotBinPath?: string;
  copilotModel?: string;
  copilotModels?: ModelInfo[];
  /** Herdr 多 agent runtime：binary 路径/默认模型/默认 kind/轮询节奏。 */
  herdrBinPath?: string;
  herdrModel?: string;
  herdrDefaultKind?: import("@agent-phonon/core").HerdrKind;
  herdrTurnTimeoutSeconds?: number;
  herdrPollIntervalMs?: number;
}

export interface RescueAgentConfig extends RescueConnectionOptions {
  /** 内置救援 Agent 默认启用；未配置 endpoint 时 discovery 显示 unavailable。 */
  enabled?: boolean;
  model?: string;
  maxSteps?: number;
  timeoutMs?: number;
}

export interface DaemonConfig {
  deviceId: string;
  /** sqlite 文件路径。 */
  dbPath: string;
  /** 受控项目根。 */
  workspaceRoot: string;
  /** 结构化日志级别。 */
  logLevel?: "debug" | "info" | "warn" | "error";
  /** Shared discovery inventory; owner-only polling and per-adapter deadline. */
  discovery?: DiscoveryOptions;
  hookBridge?: { port?: number; token?: string };
  /** 可观测 HTTP 服务。 */
  obs?: { enabled?: boolean; port?: number; token?: string };
  /** 确定性宿主机维护目标（server 与 phonon-rescue 都只能按本地 id 调用）。 */
  maintenance?: MaintenanceManagerConfig;
  /** 不依赖任何外部 Agent CLI 的内置 OpenAI-compatible 救援 Agent。 */
  rescueAgent?: RescueAgentConfig;
  adapters: AdapterConfig[];
  servers: ServerConfig[];
}

const DEFAULT_DIR = join(homedir(), ".agent-phonon");
export const DEFAULT_CONFIG_PATH = process.env.PHONON_CONFIG ?? join(DEFAULT_DIR, "config.json");

function defaultMaintenance(): MaintenanceManagerConfig {
  return {
    backupDir: join(DEFAULT_DIR, "maintenance-backups"),
    targets: [
      {
        targetId: "agent-phonon", label: "agent-phonon", command: "agent-phonon",
        // Self config is diagnostic-only: never let a remote tenant rewrite policy/maintenance allowlists.
        configs: [{ configId: "main", label: "agent-phonon config", path: DEFAULT_CONFIG_PATH, format: "json", writable: false }],
        services: [{ serviceId: "daemon", label: "agent-phonon daemon", linuxUserUnit: "agent-phonon.service", macLabel: "ai.phonon.agent", windowsService: "agent-phonon" }],
      },
      {
        targetId: "openclaw", label: "OpenClaw", command: "openclaw",
        configs: [{
          configId: "main", label: "OpenClaw config", path: join(homedir(), ".openclaw", "openclaw.json"), format: "json", writable: true,
          // Restrict repair to model/agent configuration; never gateway auth, channels, plugins, or exec policy.
          allowedRootKeys: ["models", "agents"],
        }],
        package: { manager: "npm", packageName: "openclaw" },
        services: [{ serviceId: "gateway", label: "OpenClaw Gateway", linuxUserUnit: "openclaw-gateway.service", macLabel: "ai.openclaw.gateway", windowsService: "OpenClaw Gateway" }],
      },
      {
        targetId: "claude-code", label: "Claude Code", command: "claude",
        configs: [{ configId: "settings", label: "Claude settings", path: join(homedir(), ".claude", "settings.json"), format: "json", writable: false }],
      },
      { targetId: "codex", label: "Codex CLI", command: "codex", configs: [{ configId: "main", path: join(homedir(), ".codex", "config.toml"), format: "toml", writable: false }] },
      {
        targetId: "copilot", label: "GitHub Copilot CLI", command: "copilot",
        configs: [{ configId: "settings", label: "Copilot settings", path: join(homedir(), ".copilot", "settings.json"), format: "json", writable: true, allowedRootKeys: ["model"] }],
      },
      { targetId: "opencode", label: "OpenCode", command: "opencode" },
      { targetId: "hermes", label: "Hermes", command: "hermes", configs: [{ configId: "main", path: join(homedir(), ".hermes", "config.yaml"), format: "yaml", writable: false }] },
    ],
  };
}

export function defaultConfig(): DaemonConfig {
  return {
    deviceId: `dev-${hostname()}`,
    dbPath: join(DEFAULT_DIR, "phonon.db"),
    workspaceRoot: join(homedir(), "phonon-projects"),
    discovery: discoveryOptions(),
    hookBridge: { port: 4318 },
    obs: { enabled: true, port: 4319 },
    maintenance: defaultMaintenance(),
    rescueAgent: { enabled: true },
    adapters: [{ type: "openclaw-gateway", gatewayUrl: "ws://127.0.0.1:18789", defaultAgent: "main" }],
    servers: [],
  };
}

export function loadConfig(path = DEFAULT_CONFIG_PATH): DaemonConfig {
  if (!existsSync(path)) {
    throw new Error(`config not found at ${path} — run 'agent-phonon init' first`);
  }
  const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<DaemonConfig>;
  validateServerConfigs(raw.servers ?? []);
  const d = defaultConfig();
  return {
    deviceId: raw.deviceId ?? d.deviceId,
    dbPath: raw.dbPath ?? d.dbPath,
    workspaceRoot: raw.workspaceRoot ?? d.workspaceRoot,
    discovery: discoveryOptions(raw.discovery),
    hookBridge: { ...d.hookBridge, ...raw.hookBridge },
    obs: { ...d.obs, ...raw.obs },
    logLevel: raw.logLevel ?? d.logLevel,
    maintenance: raw.maintenance ?? d.maintenance,
    rescueAgent: { ...d.rescueAgent, ...raw.rescueAgent },
    adapters: raw.adapters ?? d.adapters,
    servers: raw.servers ?? d.servers,
  };
}

/** Validate security options without coercion, trimming identity, or logging config values. */
export function validateServerConfigs(servers: ServerConfig[]): void {
  if (!Array.isArray(servers)) throw new Error("servers must be an array");
  for (const [i, server] of servers.entries()) {
    if (!server || typeof server !== "object") throw new Error(`servers[${i}] must be an object`);
    if (server.allowInsecure !== undefined && typeof server.allowInsecure !== "boolean") {
      throw new Error(`servers[${i}].allowInsecure must be a boolean`);
    }
    const tenant = server.expectedTenantId;
    if (tenant !== undefined && (typeof tenant !== "string" || !tenant.trim() || tenant !== tenant.trim() || /[\x00-\x1f\x7f]/.test(tenant))) {
      throw new Error(`servers[${i}].expectedTenantId must be a non-empty string without surrounding whitespace or control characters`);
    }
  }
}

export async function probeRescueEndpoint(input: RescueConnectionOptions & { baseUrl: string; model: string }): Promise<{ ok: boolean; status?: number; error?: string }> {
  try {
    const result = await generateText({
      model: createRescueModel(input, input.model),
      providerOptions: rescueProviderOptions(input),
      prompt: "Call the phonon_probe tool with no arguments.",
      tools: { phonon_probe: tool({ description: "Capability probe", inputSchema: z.object({}), strict: false }) },
      // Native thinking endpoints may reject forced tool_choice. Choose auto
      // up front (never retry/fallback), then require an actual probe call below.
      toolChoice: input.wireApi === "anthropic" || input.wireApi === "gemini"
        ? "auto" : { type: "tool", toolName: "phonon_probe" },
      maxOutputTokens: 128,
      maxRetries: 0,
      abortSignal: AbortSignal.timeout(20_000),
    });
    if (!result.toolCalls.some((call) => call.toolName === "phonon_probe")) {
      return { ok: false, error: "endpoint returned success but did not produce the required tool call" };
    }
    return { ok: true };
  } catch (err) {
    const error = err as Error & { statusCode?: number };
    return { ok: false, status: error.statusCode, error: error.message };
  }
}

export function configureRescueAgent(cfg: DaemonConfig, input: RescueConnectionOptions & { baseUrl: string; model: string }): DaemonConfig {
  validateRescueEndpoint(input);
  if (!input.model.trim()) throw new Error("rescue model is required");
  if (input.authMode !== "none" && !input.apiKey && !input.apiKeyEnv && !input.apiKeyRef) throw new Error("rescue API key, --api-key-env, --api-key-ref, or explicit loopback --no-auth is required");
  return {
    ...cfg,
    rescueAgent: {
      ...cfg.rescueAgent,
      enabled: true,
      baseUrl: input.baseUrl.replace(/\/+$/, ""),
      model: input.model,
      wireApi: input.wireApi ?? "chat",
      authMode: input.authMode ?? "api-key",
      apiKey: input.apiKey,
      apiKeyEnv: input.apiKeyEnv,
      apiKeyRef: input.apiKeyRef,
    },
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
    rescueAgent: cfg.rescueAgent ? { ...cfg.rescueAgent, apiKey: mask(cfg.rescueAgent.apiKey) } : cfg.rescueAgent,
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
