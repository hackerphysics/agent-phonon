import {PhononError} from "../rpc.js";
import type {SendOptions} from "../adapter.js";
import {selectedNativeControllerTools,verifiedNativeToolChannel} from "../native-tool-channel.js";

/** Invocation-only MCP configuration; never serialize the capability value into argv. */
export function codexNativeToolArgs(options: SendOptions): string[] {
  const tools=selectedNativeControllerTools(options);
  if (!tools.length) return [];
  const environment = options.environment ?? {};
  try {
    const {url:mcp} = verifiedNativeToolChannel(environment);
    const config = {url: mcp.href, bearer_token_env_var: "AGENT_PHONON_INTERACTION_TOKEN", enabled: true, required: true,
      startup_timeout_sec: 10, tool_timeout_sec: 1800,enabled_tools:tools};
    // Replacing the reserved table also excludes stale headers or credentials.
    const table = "{ " + Object.entries(config).map(([key, value]) => key + " = " + JSON.stringify(value)).join(", ") + " }";
    // This grants access to the controller channel, not its human decisions or worker authorization.
    return ["-c", "mcp_servers.phonon_current_turn=" + table,
      ...tools.flatMap(name=>["-c",`mcp_servers.phonon_current_turn.tools.${name}.approval_mode="approve"`])];
  } catch {
    throw new PhononError("errCapabilityUnsupported", "Native Codex tools require a verified current-turn local MCP channel; update the device runtime");
  }
}
