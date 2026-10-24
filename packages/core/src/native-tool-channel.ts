export const nativeControllerToolNames = [
  "phonon_request_interaction", "phonon_acknowledge_interaction", "phonon_conversation_board",
  "phonon_workflow", "phonon_conversation_message", "phonon_publish_document",
  "phonon_project_coordination",
] as const;

/** Callback presence selects tools; one product capability never grants another. */
export function selectedNativeControllerTools(options: {
  requestInteraction?: unknown; conversationBoard?: unknown; conversationWorkflow?: unknown;
  conversationMessage?: unknown; publishDocument?: unknown; projectCoordination?: unknown;
}): string[] {
  return [
    ...(options.requestInteraction ? nativeControllerToolNames.slice(0,2) : []),
    ...(options.conversationBoard ? [nativeControllerToolNames[2]] : []),
    ...(options.conversationWorkflow ? [nativeControllerToolNames[3]] : []),
    ...(options.conversationMessage ? [nativeControllerToolNames[4]] : []),
    ...(options.publishDocument ? [nativeControllerToolNames[5]] : []),
    ...(options.projectCoordination ? [nativeControllerToolNames[6]] : []),
  ];
}

/** Only the paired current-turn endpoints issued by AgentInteractionBridge. */
export function verifiedNativeToolChannel(environment: Record<string, string | undefined>) {
  const local = (value: string | undefined, path: string) => {
    if (!value) throw new Error("missing local endpoint");
    const url = new URL(value);
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port || url.username || url.password
      || url.pathname !== path || url.search || url.hash || url.href !== value) throw new Error("invalid local endpoint");
    return url;
  };
  const url = local(environment.AGENT_PHONON_MCP_URL, "/mcp"), interaction = local(environment.AGENT_PHONON_INTERACTION_URL, "/interaction");
  const token = environment.AGENT_PHONON_INTERACTION_TOKEN;
  if (url.origin !== interaction.origin || typeof token !== "string" || !/^[a-zA-Z0-9_-]{43}$/.test(token)) throw new Error("invalid native capability");
  return {url, interaction, token};
}
