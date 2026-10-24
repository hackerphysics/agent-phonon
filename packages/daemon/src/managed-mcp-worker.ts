import { parentPort, workerData } from "node:worker_threads";
import { ManagedMcpManager } from "./managed-mcp.js";
import { McpConfigurationError } from "./managed-mcp-security.js";
import type { ManagedMcpWorkerInput } from "./managed-mcp-worker-client.js";

if (parentPort) {
  try {
    const { options, request } = workerData as ManagedMcpWorkerInput;
    const manager = new ManagedMcpManager({ ...options, inventory: async () => request.inventory });
    const result = request.operation === "configure" ? await manager.configure(request.snapshot) : manager.status();
    parentPort.postMessage({ ok: true, result });
  } catch (error) {
    parentPort.postMessage({ ok: false, code: error instanceof McpConfigurationError ? error.code : "mcp_configuration_failed" });
  } finally { parentPort.close(); }
}
