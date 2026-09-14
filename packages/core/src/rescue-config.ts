import { readFileSync } from "node:fs";

export interface RescueConnectionOptions {
  baseUrl?: string;
  /** Explicit wire protocol, independent of model ID; defaults to chat. */
  wireApi?: "chat" | "responses" | "anthropic" | "gemini";
  /** Default api-key; none is an explicit loopback-only opt-in. */
  authMode?: "api-key" | "none";
  apiKey?: string;
  apiKeyEnv?: string;
  apiKeyRef?: string;
}

export function validateRescueEndpoint(input: RescueConnectionOptions): string {
  if (input.wireApi !== undefined && !["chat", "responses", "anthropic", "gemini"].includes(input.wireApi)) {
    throw new Error("rescue wireApi must be chat, responses, anthropic or gemini");
  }
  let url: URL;
  try { url = new URL(input.baseUrl ?? ""); } catch { throw new Error("rescue baseUrl is required and must be a valid URL"); }
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname.toLowerCase());
  if (url.username || url.password) throw new Error("rescue baseUrl must not contain credentials");
  if (url.search || url.hash) throw new Error("rescue baseUrl must not contain query parameters or a fragment; use a key reference for authentication");
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error("rescue base URL must use HTTPS (HTTP only for loopback)");
  }
  if (input.authMode !== undefined && input.authMode !== "none" && input.authMode !== "api-key") {
    throw new Error("rescue authMode must be api-key or none");
  }
  if (input.authMode === "none") {
    if (!loopback) throw new Error("rescue authMode none is allowed only for explicit loopback endpoints");
    if (input.apiKey || input.apiKeyEnv || input.apiKeyRef) throw new Error("rescue authMode none cannot be combined with API key settings");
  }
  return input.baseUrl!.replace(/\/+$/, "");
}

/** Shared by runtime, discovery and probe. Explicit none never reads key files/env. */
export function resolveRescueConnection(input: RescueConnectionOptions): { baseUrl: string; apiKey?: string } {
  const baseUrl = validateRescueEndpoint(input);
  if (input.authMode === "none") return { baseUrl };
  let apiKey = input.apiKeyEnv ? process.env[input.apiKeyEnv] : undefined;
  if (!apiKey && input.apiKeyRef) {
    try { apiKey = readFileSync(input.apiKeyRef, "utf8").trim(); } catch { /* use configured fallback */ }
  }
  apiKey ||= input.apiKey || process.env.PHONON_RESCUE_API_KEY;
  if (!apiKey) throw new Error("rescue API key unavailable; configure apiKey/apiKeyEnv/apiKeyRef or explicit loopback authMode none");
  return { baseUrl, apiKey };
}
