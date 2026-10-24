import { createHash } from "node:crypto";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { InteractionForm, InteractionPresentation, InteractionRequestResult } from "@agent-phonon/protocol";
import { AgentBoardInput, ConversationBoardResult } from "@agent-phonon/protocol";
import { AgentWorkflowInput,ConversationWorkflowResult } from "@agent-phonon/protocol";
import { AgentMessageInput, ConversationMessageResult } from "@agent-phonon/protocol";
import { NativeDocumentInput, DocumentSendResult } from "@agent-phonon/protocol";
import { AgentCoordinationInput, ProjectCoordinationResult } from "@agent-phonon/protocol";

export const REQUEST_TOOL = "phonon_request_interaction";
export const ACK_TOOL = "phonon_acknowledge_interaction";
export const BOARD_TOOL = "phonon_conversation_board";
export const WORKFLOW_TOOL = "phonon_workflow";
export const MESSAGE_TOOL = "phonon_conversation_message";
export const DOCUMENT_TOOL = "phonon_publish_document";
export const COORDINATION_TOOL = "phonon_project_coordination";
export const NATIVE_TOOLS = [REQUEST_TOOL, ACK_TOOL, BOARD_TOOL, WORKFLOW_TOOL, MESSAGE_TOOL, DOCUMENT_TOOL, COORDINATION_TOOL];
export const BIND_METHOD = "phonon.interactions.bind";
export const RELEASE_METHOD = "phonon.interactions.release";

const sessionKey = z.string().max(512).regex(/^agent:[a-zA-Z0-9_-]+:phonon-[a-zA-Z0-9_-]+$/);
const identity = z.object({ sessionKey, runId: z.string().uuid() }).strict();
const bindingInput = identity.extend({
  version: z.literal(1), expiresAt: z.number().int(),
  interactionUrl: z.string().url().optional(), receiptUrl: z.string().url().optional(),
  boardUrl: z.string().url().optional(),
  workflowUrl:z.string().url().optional(),
  messageUrl: z.string().url().optional(),
  documentUrl: z.string().url().optional(),
  coordinationUrl: z.string().url().optional(),
  coordinationOnly:z.literal(true).optional(),
  token: z.string().regex(/^[a-zA-Z0-9_-]{43}$/),
}).strict();
const requestInput = z.object({
  requestId: z.string().min(1).max(512).optional(), form: InteractionForm,
  presentation: InteractionPresentation.optional(),
  timeoutSeconds: z.number().int().min(0).max(3600).optional(),
}).strict();
const ackInput = z.object({
  requestId: z.string().min(1).max(512), decisionHash: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
const response = InteractionRequestResult.extend({ decisionHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict();

export interface NativeToolContext { sessionKey?: string; agentId?: string }
export interface NativeToolEvent { toolName: string; params: Record<string, unknown>; runId?: string; toolCallId?: string }
export interface NativeHookContext extends NativeToolContext { runId?: string; toolCallId?: string }
export interface Client {
  connId?: string; invalidated?: boolean; connectionSignal?: AbortSignal;
  connect: { role?: string; scopes?: string[] };
}
export interface GatewayCall {
  params: Record<string, unknown>; client: Client | null;
  hasCurrentClientAuthority?: () => boolean;
  respond: (ok: boolean, payload?: unknown, error?: { code: string; message: string }) => void;
}
interface Tool {
  name: string; label: string; description: string; parameters: Record<string, unknown>;
  execute: (toolCallId: string, params: unknown, signal?: AbortSignal) => Promise<{
    content: Array<{ type: "text"; text: string }>; details: unknown;
  }>;
}
export interface NativeInteractionApi {
  registerGatewayMethod: (method: string, handler: (call: GatewayCall) => void, opts: { scope: "operator.admin" }) => void;
  registerTool: (factory: (ctx: NativeToolContext) => Tool[] | null, opts: { names: string[]; optional: boolean }) => void;
  on: (name: string, handler: (event: any, ctx: any) => unknown, opts?: unknown) => void;
  lifecycle?: { registerRuntimeLifecycle: (value: { id: string; cleanup: (ctx: { sessionKey?: string; runId?: string }) => void }) => void };
}
type Permit = { name: string; hash: string; expiresAt: number };
type Binding = z.infer<typeof bindingInput> & {
  owner: string; current: () => boolean; abort: AbortController;
  fingerprint: string;
  permits: Map<string, Permit>; timer: ReturnType<typeof setTimeout>; detach: () => void;
};

export function parameterHash(value: unknown): string {
  const canonical = (item: any): any => Array.isArray(item) ? item.map(canonical)
    : item && typeof item === "object" ? Object.fromEntries(Object.keys(item).sort().map(key => [key, canonical(item[key])])) : item;
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

export function loopbackEndpoint(raw: string, path: string): URL {
  const url = new URL(raw);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port || url.username || url.password
    || url.pathname !== path || url.search || url.hash || url.href !== raw) throw new Error("invalid native endpoint");
  return url;
}

export async function readJson(result: Response): Promise<unknown> {
  if (!result.ok || !result.body) throw new Error("native interaction unavailable");
  const reader = result.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > 65536) throw new Error("native response too large");
      chunks.push(next.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally { await reader.cancel().catch(() => {}); }
}

export function nativeGatewayAuthority(call: GatewayCall): {owner:string;signal:AbortSignal;current:()=>boolean} {
  const client=call.client;
  if(!client?.connId||!client.connectionSignal)throw new Error("Current native admin transport required");
  const signal=client.connectionSignal,hasAuthority=call.hasCurrentClientAuthority;
  const current=()=>!client.invalidated&&!signal.aborted&&client.connect.role==="operator"
    &&client.connect.scopes?.includes("operator.admin")===true&&hasAuthority?.()!==false;
  if(!current())throw new Error("Current native admin transport required");
  return {owner:client.connId,signal,current};
}

const requestParameters = zodToJsonSchema(requestInput, { $refStrategy: "none" });
const ackParameters = zodToJsonSchema(ackInput, { $refStrategy: "none" });
const boardParameters = zodToJsonSchema(AgentBoardInput, { $refStrategy: "none" });
const workflowParameters=zodToJsonSchema(AgentWorkflowInput,{$refStrategy:"none"});
const messageParameters = zodToJsonSchema(AgentMessageInput, { $refStrategy: "none" });
const documentParameters = zodToJsonSchema(NativeDocumentInput, { $refStrategy: "none" });
const coordinationParameters = zodToJsonSchema(AgentCoordinationInput, { $refStrategy: "none" });

/** Host-only registrations stay in memory; model tools never accept routing or capabilities. */
export class NativeInteractionTools {
  private bindings = new Map<string, Binding>();
  private coordinationOnly=false;

  register(api: NativeInteractionApi,options:{coordinationOnly?:boolean}={}): void {
    this.coordinationOnly=options.coordinationOnly===true;
    api.registerGatewayMethod(BIND_METHOD, call => this.gateway(call, false), { scope: "operator.admin" });
    api.registerGatewayMethod(RELEASE_METHOD, call => this.gateway(call, true), { scope: "operator.admin" });
    api.registerTool(ctx => this.tools(ctx), { names: this.coordinationOnly?[COORDINATION_TOOL]:NATIVE_TOOLS, optional: true });
    api.on("before_tool_call", (event: NativeToolEvent, ctx: NativeHookContext) => this.beforeToolCall(event, ctx), { priority: 1000 });
    api.on("agent_end", (_event: unknown, ctx: NativeHookContext) => this.releaseRun(ctx));
    api.lifecycle?.registerRuntimeLifecycle({ id: "phonon-native-interactions", cleanup: ctx => {
      if (ctx.runId) this.releaseRun(ctx);
      else for (const binding of this.bindings.values()) if (!ctx.sessionKey || binding.sessionKey === ctx.sessionKey) this.remove(binding);
    } });
  }

  private gateway(call: GatewayCall, release: boolean): void {
    try {
      const {owner,signal,current}=nativeGatewayAuthority(call);
      if (release) {
        const input = identity.parse(call.params), binding = this.get(input.sessionKey);
        if (binding && binding.runId === input.runId) {
          if (binding.owner !== owner) throw new Error("binding owner mismatch");
          this.remove(binding);
          call.respond(true, { version: 1, released: true });
        } else call.respond(true, { version: 1, released: false });
        return;
      }
      const input = bindingInput.parse(call.params), now = Date.now();
      if(this.coordinationOnly&&!input.coordinationOnly||input.coordinationOnly&&(!input.coordinationUrl||input.boardUrl||input.workflowUrl||input.messageUrl||input.documentUrl))throw new Error("native capability scope mismatch");
      const endpoint = input.coordinationOnly?loopbackEndpoint(input.coordinationUrl!,"/coordination"):loopbackEndpoint(input.interactionUrl!, "/interaction");
      if (input.coordinationOnly&&(input.interactionUrl||input.receiptUrl)
        ||!input.coordinationOnly&&loopbackEndpoint(input.receiptUrl!, "/applied").origin !== endpoint.origin
        || input.boardUrl && loopbackEndpoint(input.boardUrl, "/board").origin !== endpoint.origin
        || input.workflowUrl && loopbackEndpoint(input.workflowUrl,"/workflow").origin!==endpoint.origin
        || input.messageUrl && loopbackEndpoint(input.messageUrl,"/message").origin!==endpoint.origin
        || input.documentUrl && loopbackEndpoint(input.documentUrl,"/document").origin!==endpoint.origin
        || input.coordinationUrl && loopbackEndpoint(input.coordinationUrl,"/coordination").origin!==endpoint.origin
        || input.expiresAt <= now || input.expiresAt > now + 1800000) throw new Error("invalid native binding lifetime");
      for (const key of this.bindings.keys()) this.get(key);
      const existing = this.get(input.sessionKey);
      if (existing) {
        if (existing.owner !== owner || existing.runId !== input.runId
          || parameterHash(input) !== existing.fingerprint) throw new Error("native binding busy");
        call.respond(true, { version: 1, bound: true });
        return;
      }
      if (this.bindings.size >= 64) throw new Error("native binding limit");
      const retire = () => this.remove(binding);
      const binding: Binding = { ...input, owner, current, fingerprint: parameterHash(input), abort: new AbortController(), permits: new Map(),
        timer: setTimeout(retire, input.expiresAt - now), detach: () => signal.removeEventListener("abort", retire) };
      binding.timer.unref();
      this.bindings.set(input.sessionKey, binding);
      signal.addEventListener("abort", retire, { once: true });
      call.respond(true, { version: 1, bound: true });
    } catch {
      // Errors must not echo request parameters, endpoints or bearer capabilities.
      call.respond(false, undefined, { code: "INVALID_REQUEST", message: "Native interaction binding unavailable or unauthorized" });
    }
  }

  private get(key?: string): Binding | undefined {
    const binding = key ? this.bindings.get(key) : undefined;
    if (binding && (binding.expiresAt <= Date.now() || !binding.current())) { this.remove(binding); return; }
    return binding;
  }
  private remove(binding: Binding): void {
    if (this.bindings.get(binding.sessionKey) !== binding) return;
    this.bindings.delete(binding.sessionKey);
    binding.abort.abort(); binding.permits.clear(); binding.token = "";
    clearTimeout(binding.timer); binding.detach();
  }
  private releaseRun(ctx: NativeHookContext): void {
    const binding = this.get(ctx.sessionKey);
    if (binding && ctx.runId === binding.runId) this.remove(binding);
  }

  beforeToolCall(event: NativeToolEvent, ctx: NativeHookContext): unknown {
    if (!NATIVE_TOOLS.includes(event.toolName)) return;
    const binding = this.get(ctx.sessionKey), runId = ctx.runId ?? event.runId, toolCallId = ctx.toolCallId ?? event.toolCallId;
    const reason = !ctx.sessionKey ? "session_identity_missing" : !binding ? "binding_unavailable" : !toolCallId ? "call_identity_missing" : !runId ? "run_identity_missing"
      : runId !== binding.runId ? "run_identity_mismatch" : event.runId && event.runId !== runId ? "event_run_mismatch"
      : event.toolCallId && event.toolCallId !== toolCallId ? "event_call_mismatch"
      : ctx.agentId !== binding.sessionKey.split(":")[1] ? "agent_identity_mismatch" : undefined;
    if (reason) {
      return { block: true, blockReason: `Native interaction is not authorized for this run (${reason})` };
    }
    if (!binding || !toolCallId) return { block: true, blockReason: "Native interaction is not authorized for this run" };
    if(binding.coordinationOnly&&event.toolName!==COORDINATION_TOOL)return {block:true,blockReason:"This run has project coordination authority only"};
    for (const [id, permit] of binding.permits) if (permit.expiresAt <= Date.now()) binding.permits.delete(id);
    if (binding.permits.size >= 128) return { block: true, blockReason: "Native interaction tool limit" };
    binding.permits.set(toolCallId, { name: event.toolName, hash: parameterHash(event.params), expiresAt: Date.now() + 60000 });
  }

  tools(ctx: NativeToolContext): Tool[] | null {
    const binding = this.get(ctx.sessionKey);
    if (!binding || ctx.agentId !== binding.sessionKey.split(":")[1]) return null;
    const make = (mode: "request" | "ack" | "board" | "workflow" | "message" | "document" | "coordination"): Tool => {
      const coordination=mode==="coordination",ack = mode === "ack", board = mode === "board", workflow=mode==="workflow",message=mode==="message",document=mode==="document",name = coordination?COORDINATION_TOOL:document?DOCUMENT_TOOL:message?MESSAGE_TOOL:workflow?WORKFLOW_TOOL:board ? BOARD_TOOL : ack ? ACK_TOOL : REQUEST_TOOL;
      return {
        name,
        label: coordination?"Project machine coordination":document?"Publish a generated file":message?"Message a group DE":workflow?"Delegate a workflow":board ? "Conversation board" : ack ? "Acknowledge human response" : "Request human input",
        description: document?"Publish a real regular file from this execution's project/worktree under device file policy. Provide a fresh UUID requestId, a project-relative path and optional display name, MIME type and caption. The controller reads and hashes at most 10 MiB; model-authored bytes and cross-chat/owner routes are not accepted. Reconcile uncertain publication with the identical request identity and unchanged file, not a new attempt. A serverRef confirms publication, not task completion. Subordinate workers publish in execution details, not as group members.":message?"Digital employees may read members of their originating project group, then send their own text with explicit canonical mentionIDs and an insert/wait/queue mode. Only current group DEs may communicate, only when mutual mentions are enabled. No cross-chat routing or impersonation. The group enforces bounded relay hops and deliveries. A recorded message is not executor acceptance or completion. Query status or retry the identical requestId and payload if uncertain; never invent a new attempt. Messages sent here are already visible in the group; do not repeat them verbatim as your final reply.":workflow?"Digital employees may read the canonical project/Agent/Role/workspace catalog, then execute a bounded DAG on explicitly created Agents. Use real catalog IDs, not harness IDs or paths. Set review=request only when you are asking for human approval; not_requested declares your own policy choice. Prefer delivery=detached for review or long-running work: it returns a durable submission, not completion, and the controller can request one report in this conversation later. delivery=wait keeps the synchronous decision/results contract. Retry uncertainty with the identical requestId and complete payload, never a new ID or changed delivery. Workers do not join the chat. Unknown, cancellation, rejection and requested changes are not successful execution.":board ? "Read or update only this conversation's shared board. Read first; write with a fresh UUID requestId and the observed baseRevision. Keep goal within 70 graphemes, each item 60, total 400, at most 8 items. A conflict returns the latest board without writing; decide how to merge instead of overwriting it. Use the same requestId and identical input to retry an uncertain write. Empty goal and items explicitly clear the board without clearing messages or memory." : ack
          ? "Explicitly acknowledge consuming a submitted human response using its requestId and decisionHash. This is not task completion."
          : "Ask the human in the originating Phonon chat using a typed form. Only presentation.kind=approval requests approval. Wait for the explicit result; cancel, timeout or errors are never permission. After consuming a submit result call phonon_acknowledge_interaction. Zero or omitted timeout imposes no response deadline.",
        parameters: coordination?coordinationParameters:document?documentParameters:message?messageParameters:workflow?workflowParameters:board ? boardParameters : ack ? ackParameters : requestParameters,
        execute: async (id, raw, signal) => {
          const permit = binding.permits.get(id);
          binding.permits.delete(id);
          if (this.get(ctx.sessionKey) !== binding || !permit || permit.name !== name
            || permit.expiresAt <= Date.now() || permit.hash !== parameterHash(raw) || signal?.aborted) throw new Error("Native interaction run ended or tool call is unauthorized");
          const input = coordination?AgentCoordinationInput.parse(raw):document?NativeDocumentInput.parse(raw):message?AgentMessageInput.parse(raw):workflow?AgentWorkflowInput.parse(raw):board ? AgentBoardInput.parse(raw) : ack ? ackInput.parse(raw) : requestInput.parse(raw);
          const body = JSON.stringify(input);
          if (Buffer.byteLength(body) > 65536) throw new Error("Native interaction request too large");
          const combined = AbortSignal.any([binding.abort.signal, ...(signal ? [signal] : [])]);
          try {
            const result = await readJson(await fetch(coordination?binding.coordinationUrl!:document?binding.documentUrl!:message?binding.messageUrl!:workflow?binding.workflowUrl!:board ? binding.boardUrl! : ack ? binding.receiptUrl! : binding.interactionUrl!, {
              method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${binding.token}` },
              body, signal: combined, redirect: "error",
            }));
            if (this.get(ctx.sessionKey) !== binding || combined.aborted) throw new Error("native turn ended");
            const details = coordination?ProjectCoordinationResult.parse(result):document?DocumentSendResult.parse(result):message?ConversationMessageResult.parse(result):workflow?ConversationWorkflowResult.parse(result):board ? ConversationBoardResult.parse(result) : ack ? z.object({ applied: z.literal(true) }).strict().parse(result) : response.parse(result);
            if (!coordination && !document && !message && !workflow && !board && !ack && "requestId" in input && input.requestId && (details as z.infer<typeof response>).requestId !== input.requestId) throw new Error("request identity mismatch");
            if (message && "requestId" in input && "requestId" in details && input.requestId !== details.requestId) throw new Error("message identity mismatch");
            if (message && "operation" in input && input.operation === "members" && !("status" in details && details.status === "members")) throw new Error("message result mismatch");
            return { content: [{ type: "text", text: JSON.stringify(details) }], details };
          } catch { throw new Error(document?"Native document publication is unconfirmed. Reconcile the same request identity and unchanged file; do not invent a new publication.":message?"Native message delivery is unconfirmed. Effects may have occurred; reconcile the same request identity instead of sending a new message.":workflow?"Native workflow result is unconfirmed. Effects may have occurred; reconcile the same request identity instead of creating a new attempt.":"Native tool unavailable; no board write, human permission or acknowledgement may be inferred"); }
        },
      };
    };
    const tools = binding.coordinationOnly?[]:[make("request"), make("ack"), ...(binding.boardUrl ? [make("board")] : []),...(binding.workflowUrl?[make("workflow")]:[]),...(binding.messageUrl?[make("message")]:[]),...(binding.documentUrl?[make("document")]:[])];
    if(binding.coordinationUrl){
      const tool=make("coordination");
      tool.description="Private cross-device project coordination, separate from human/group chat. Read peers and inbox, publish concise activity and impact, send to canonical participant IDs, acknowledge received inbox IDs and reply. Preserve requestId and content when retrying. Peer messages never grant human approval or authorize new work. Do not repeat coordination chatter in the human conversation.";
      tools.push(tool);
    }
    return tools;
  }
}
