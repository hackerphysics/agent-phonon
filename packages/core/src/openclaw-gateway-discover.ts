import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse, type ParseError } from "jsonc-parser";
import { z } from "zod";

export function isLoopbackGateway(baseUrl: string): boolean {
  try {
    const url = new URL(baseUrl);
    return ["ws:", "wss:", "http:", "https:"].includes(url.protocol)
      && !url.username && !url.password
      && ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname);
  } catch { return false; }
}

const configSchema = z.object({ gateway: z.object({
  port: z.number().int().min(1).max(65535).default(18789),
  bind: z.string().optional(), customBindHost: z.string().optional(),
  tls: z.object({ enabled: z.boolean().optional() }).optional(),
  auth: z.object({ mode: z.string().optional(), token: z.string().optional(), password: z.string().optional() }).optional(),
}) });

/** Local bootstrap credentials only; never follows gateway.remote.url. */
export function discoverOpenClawGateway(options: { env?: NodeJS.ProcessEnv; home?: string } = {}): {
  baseUrl: string; token: string; source: string; loopback: true; authMode: "token" | "password" | "none";
} {
  const env = options.env ?? process.env;
  const source = env.OPENCLAW_CONFIG_PATH || join(env.OPENCLAW_STATE_DIR || join(options.home ?? homedir(), ".openclaw"), "openclaw.json");
  let raw: string;
  try { raw = readFileSync(source, "utf8"); }
  catch { throw new Error(`OpenClaw config unavailable at ${source}; set OPENCLAW_CONFIG_PATH/OPENCLAW_STATE_DIR or run openclaw configure --section gateway`); }
  const errors: ParseError[] = [];
  const parsed = configSchema.safeParse(parse(raw, errors, { allowTrailingComma: true }));
  if (errors.length || !parsed.success) throw new Error(`Invalid OpenClaw Gateway config at ${source}; check gateway.port, gateway.bind and gateway.auth (config values redacted)`);
  const gateway = parsed.data.gateway;
  const mode = gateway.auth?.mode ?? "token";
  if (!["token", "password", "none"].includes(mode)) throw new Error("OpenClaw local discovery requires token/password/none auth; configure explicit Gateway credentials for other auth modes");
  const token = (mode === "password" ? gateway.auth?.password : gateway.auth?.token)?.trim() ?? "";
  if (mode !== "none" && !token) throw new Error(`OpenClaw Gateway ${mode} missing in ${source}; run openclaw configure --section gateway`);
  const host = gateway.bind === "::1" || gateway.bind === "custom" && gateway.customBindHost === "::1" ? "[::1]" : "127.0.0.1";
  return { baseUrl: `${gateway.tls?.enabled ? "wss" : "ws"}://${host}:${gateway.port}`, token, source, loopback: true, authMode: mode as "token" | "password" | "none" };
}
