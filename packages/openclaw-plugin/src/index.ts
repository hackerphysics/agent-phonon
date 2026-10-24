/**
 * agent-phonon HITL Bridge — OpenClaw plugin（design §8 / B 阶段）。
 *
 * OpenClaw 的 tool 级拦截（block/approval）必须走 plugin hooks（before_tool_call），
 * internal hooks 做不到。本插件把 before_tool_call 转给 phonon-core 的 HITL bridge：
 *
 *   OpenClaw agent 要调工具
 *     → before_tool_call 拦截
 *       → POST phonon-core bridge { sessionKey, toolName, params }
 *         → core 映射 session→tenant，发 hook.fired 给 server，阻塞等 hook.resolve
 *       ← decision { action: continue|abort|inject|modify }
 *     → 转成 OpenClaw 的 allow / block / 改参
 *
 * The legacy hook below remains fail-open. Native human-input tools use a
 * separate, opt-in, fail-closed current-run binding.
 */

// @ts-expect-error — SDK 由 OpenClaw 运行时提供，构建期可能不可解析
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { NativeInteractionTools, NATIVE_TOOLS, type NativeInteractionApi } from "./native-interactions.js";
import { NativePeerContexts, type NativePeerApi } from "./peer-context.js";

export const DEFAULT_BRIDGE = "http://127.0.0.1:4318";

export interface PluginConfig {
  bridgeUrl?: string;
  interceptTools?: string[];
  bridgeToken?: string;
  nativeInteractions?: boolean;
  peerContext?: boolean;
}

export interface ToolCallEvent {
  toolName: string;
  params: Record<string, unknown>;
}

/** before_tool_call 的第二个参数（PluginHookToolContext）——sessionKey 在这里。 */
export interface ToolCtx {
  agentId?: string;
  sessionKey?: string;
  sessionId?: string;
  runId?: string;
  toolName?: string;
  pluginConfig?: PluginConfig;
}

export interface BridgeDecision {
  action: "continue" | "abort" | "inject" | "modify";
  reason?: string;
  patch?: Record<string, unknown>;
}

/** 询问 phonon-core 的 HITL bridge；不可达/超时返回 null（fail-open）。 */
export async function askBridge(
  bridgeUrl: string,
  body: { sessionKey: string; toolName: string; params: unknown },
  timeoutMs = 120000,
  token?: string,
): Promise<BridgeDecision | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${bridgeUrl}/hook/before_tool_call`, {
      method: "POST",
      headers: token
        ? { "content-type": "application/json", authorization: `Bearer ${token}` }
        : { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    return (await res.json()) as BridgeDecision;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** 把 bridge decision 映射成 OpenClaw before_tool_call 的返回。纯函数，便于单测。 */
export function decisionToResult(
  decision: BridgeDecision | null,
  params: Record<string, unknown>,
): unknown {
  if (!decision) return undefined; // fail-open 放行
  switch (decision.action) {
    case "abort":
      // OpenClaw 真实形状：{ block: true, blockReason }
      return { block: true, blockReason: decision.reason ?? "blocked by agent-phonon HITL" };
    case "modify":
      return { params: { ...params, ...(decision.patch ?? {}) } };
    case "inject":
    case "continue":
    default:
      return undefined;
  }
}

// Startup and model-tool registry loads may register the same module separately.
const nativeInteractionTools = new NativeInteractionTools();
const nativePeerContexts = new NativePeerContexts({loadRuntimeResolver:async()=>{
  // Load the qualified host API only for opted-in peers, preserving older HITL-only hosts.
  // @ts-expect-error -- this SDK subpath is supplied by the qualified native host.
  const {resolveEffectiveAgentRuntime}=await import("openclaw/plugin-sdk/command-auth-native");
  return ({config,sessionKey,model,sessionEntry})=>{
    const separator=model.indexOf("/");if(separator<1||separator===model.length-1)return;
    return resolveEffectiveAgentRuntime({cfg:config,provider:model.slice(0,separator),modelId:model.slice(separator+1),agentId:sessionKey.split(":")[1],sessionKey,sessionEntry});
  };
}});

export default definePluginEntry({
  id: "agent-phonon-hitl",
  name: "agent-phonon HITL Bridge",
  description: "Routes tool calls to agent-phonon for human-in-the-loop approval.",
  register(api: NativeInteractionApi & NativePeerApi & { pluginConfig?: PluginConfig }) {
    if (api.pluginConfig?.nativeInteractions === true||api.pluginConfig?.peerContext===true)
      nativeInteractionTools.register(api,{coordinationOnly:api.pluginConfig?.nativeInteractions!==true});
    if (api.pluginConfig?.peerContext === true) nativePeerContexts.register(api);
    api.on(
      "before_tool_call",
      async (event: ToolCallEvent, ctx: ToolCtx) => {
        // Native tools own their run-proof hook and never enter the legacy bridge.
        if (NATIVE_TOOLS.includes(event.toolName)) return;
        const cfg = api.pluginConfig ?? ctx?.pluginConfig ?? {};
        const bridgeUrl = cfg.bridgeUrl ?? DEFAULT_BRIDGE;
        const intercept = cfg.interceptTools ?? [];
        const sessionKey = ctx?.sessionKey;
        if (intercept.length > 0 && !intercept.includes(event.toolName)) return;
        if (!sessionKey) {
          return;
        }
        const decision = await askBridge(bridgeUrl, {
          sessionKey,
          toolName: event.toolName,
          params: event.params,
        }, 120000, cfg.bridgeToken);
        return decisionToResult(decision, event.params);
      },
      { priority: 50 },
    );
  },
});
