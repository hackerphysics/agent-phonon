import { Worker } from "node:worker_threads";
import { ManagedMcpStatusResult, type ManagedMcpConfigureParams, type AgentDescriptor } from "@agent-phonon/protocol";
import { McpConfigurationError } from "./managed-mcp-security.js";
import type { ManagedMcpManagerOptions } from "./managed-mcp.js";

export type ManagedMcpWorkerRequest = { inventory: AgentDescriptor[] } & (
  { operation: "configure"; snapshot: ManagedMcpConfigureParams } | { operation: "status" }
);
export interface ManagedMcpWorkerInput {
  options: Omit<ManagedMcpManagerOptions, "inventory">;
  request: ManagedMcpWorkerRequest;
}

export function runManagedMcpWorker(options: ManagedMcpWorkerInput["options"], request: ManagedMcpWorkerRequest): Promise<ManagedMcpStatusResult> {
  return new Promise((resolve, reject) => {
    let worker: Worker;
    try {
      worker = new Worker(new URL("./managed-mcp-worker.js", import.meta.url), { workerData: { options, request } satisfies ManagedMcpWorkerInput });
    } catch { reject(new McpConfigurationError("mcp_configuration_failed")); return; }
    let result: ManagedMcpStatusResult | undefined, error: McpConfigurationError | undefined;
    worker.once("message", (message: unknown) => {
      if (!message || typeof message !== "object") { error = new McpConfigurationError("mcp_configuration_failed"); return; }
      const response = message as { ok?: unknown; result?: unknown; code?: unknown };
      if (response.ok === true) {
        const parsed = ManagedMcpStatusResult.safeParse(response.result);
        if (parsed.success) result = parsed.data;
        else error = new McpConfigurationError("mcp_configuration_failed");
      } else error = new McpConfigurationError(typeof response.code === "string" && /^mcp_[a-z_]{1,90}$/.test(response.code) ? response.code : "mcp_configuration_failed");
    });
    worker.once("error", () => { error = new McpConfigurationError("mcp_configuration_failed"); });
    // Wait for actual exit so the configuration lock and worker are no longer live.
    worker.once("exit", code => {
      if (code !== 0 || error || !result) reject(error ?? new McpConfigurationError("mcp_configuration_failed"));
      else resolve(result);
    });
  });
}
