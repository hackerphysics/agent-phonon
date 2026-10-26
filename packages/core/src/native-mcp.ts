import type {IncomingMessage, ServerResponse} from "node:http";
import {Server} from "@modelcontextprotocol/sdk/server/index.js";
import {StreamableHTTPServerTransport} from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {CallToolRequestSchema, ListToolsRequestSchema, type Tool} from "@modelcontextprotocol/sdk/types.js";
import {zodToJsonSchema} from "zod-to-json-schema";
import type {z} from "zod";

/** Canonical JSON with sorted keys, used only to compare structurally equal JSON-Schema fragments. */
function canonicalJSON(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (item && typeof item === "object" && !Array.isArray(item)) {
      return Object.keys(item).sort().reduce((sorted, key) => { (sorted as Record<string, unknown>)[key] = (item as Record<string, unknown>)[key]; return sorted; }, {} as Record<string, unknown>);
    }
    return item;
  });
}
/** A const string, or a single-string enum, is a literal option for enum projection. */
function literalString(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const entry = value as Record<string, unknown>;
  if (typeof entry.const === "string") return entry.const;
  if (Array.isArray(entry.enum) && entry.enum.length === 1 && typeof entry.enum[0] === "string") return entry.enum[0] as string;
  return undefined;
}
/**
 * Provider-facing catalog projection of a Zod tool schema. Validators keep the exact Zod and
 * zodToJsonSchema output: a root anyOf of strict object variants is retained verbatim, but the
 * projection ADDS merged top-level properties (identical schemas once, distinct schemas as
 * unique anyOf options, all-literal string variants as a unique enum) plus the common-required
 * intersection, so providers that only read root properties/required can still see the
 * operation discriminator and its arguments. The input JSON Schema is never mutated and no
 * branch loses its strict additionalProperties/required constraints. Non-union schemas keep the
 * previous behavior (existing object root only).
 */
export function nativeMcpInputSchema(schema: z.ZodTypeAny): Tool["inputSchema"] {
  const original = zodToJsonSchema(schema, {$refStrategy: "none"}) as Record<string, unknown>;
  const projection: Record<string, unknown> = {type: "object", ...original};
  const branches = Array.isArray(original.anyOf) ? original.anyOf as unknown[] : [];
  const variants = branches.filter((branch): branch is Record<string, unknown> =>
    !!branch && typeof branch === "object" && !Array.isArray(branch)
    && (branch as Record<string, unknown>).type === "object"
    && typeof (branch as Record<string, unknown>).properties === "object");
  // Only a union comprised entirely of object variants is projected.
  if (variants.length < 2 || variants.length !== branches.length) return projection as Tool["inputSchema"];
  const options = new Map<string, Array<Record<string, unknown>>>();
  const requiredLists: string[][] = [];
  for (const variant of variants) {
    requiredLists.push(Array.isArray(variant.required) ? (variant.required as unknown[]).map(String) : []);
    for (const [name, property] of Object.entries(variant.properties as Record<string, unknown>)) {
      const entry = property && typeof property === "object" && !Array.isArray(property)
        ? structuredClone(property) as Record<string, unknown> : {};
      const list = options.get(name) ?? [];
      if (!list.some(existing => canonicalJSON(existing) === canonicalJSON(entry))) list.push(entry);
      options.set(name, list);
    }
  }
  const properties: Record<string, unknown> = {};
  for (const [name, list] of options) {
    const literals = list.map(literalString);
    if (literals.length > 1 && literals.every(value => value !== undefined)) properties[name] = {type: "string", enum: [...new Set(literals)]};
    else if (list.length === 1) properties[name] = list[0]!;
    else properties[name] = {anyOf: list};
  }
  const required = requiredLists[0]!.filter(name => requiredLists.every(list => list.includes(name)));
  return {...projection, properties, ...(required.length ? {required} : {})} as Tool["inputSchema"];
}

export interface NativeMcpTool {
  name: string;
  description: string;
  route: string;
  schema: z.ZodTypeAny;
}

/** Transport only: the existing turn controller owns validation and all effects. */
export class NativeMcpEndpoint {
  private active = new Set<Server>();
  private closed = false;
  private requests = 0;
  private catalog: Tool[];
  constructor(private authority: string, private tools: NativeMcpTool[], private invoke: (route: string, input: unknown) => Promise<unknown>) {
    this.catalog = tools.map(tool => ({name: tool.name, description: tool.description,
      inputSchema: nativeMcpInputSchema(tool.schema)}));
  }
  async handle(req: IncomingMessage, res: ServerResponse, input: unknown) {
    if (this.closed || this.active.size >= 32 || this.requests++ >= 256) {
      res.writeHead(this.closed ? 410 : 429, {"Content-Type": "application/json"}).end(JSON.stringify({error: "native_mcp_unavailable"})); return;
    }
    // A fresh stateless transport per request avoids cross-client MCP session state.
    const server = new Server({name: "phonon-current-turn", version: "1.0.0"}, {
      capabilities: {tools: {}},
      instructions: "These tools act only in the current Phonon conversation and turn. Use the provided canonical IDs. A submitted request or completed invocation is not successful work or delivered files. Reconcile uncertainty with the identical request identity, never a new attempt. Do not reveal capabilities. Consume an explicit submitted human response before acknowledging its decisionHash."
    });
    const transport = new StreamableHTTPServerTransport({sessionIdGenerator: undefined, enableJsonResponse: true,
      enableDnsRebindingProtection: true, allowedHosts: [this.authority]});
    server.setRequestHandler(ListToolsRequestSchema, async () => ({tools: this.catalog}));
    server.setRequestHandler(CallToolRequestSchema, async request => {
      try {
        const tool = this.tools.find(tool => tool.name === request.params.name);
        if (this.closed || !tool) throw new Error("native tool unavailable");
        const result = await this.invoke(tool.route, request.params.arguments ?? {});
        if (this.closed) throw new Error("native turn ended");
        const text = JSON.stringify(result);
        if (Buffer.byteLength(text) > 65536) throw new Error("native result too large");
        return {content: [{type: "text", text}]};
      } catch {
        return {isError: true, content: [{type: "text", text: "Native tool result is unconfirmed. Effects may have occurred; inspect status or reconcile the identical request identity. Never infer permission or successful delivery from this error."}]};
      }
    });
    this.active.add(server);
    const close = () => { this.active.delete(server); void server.close().catch(() => {}); };
    res.once("close", close);
    try { await server.connect(transport); await transport.handleRequest(req, res, input); }
    catch {
      if (!res.headersSent && !res.destroyed) res.writeHead(500, {"Content-Type": "application/json"}).end(JSON.stringify({jsonrpc: "2.0", id: null, error: {code: -32603, message: "Native MCP transport unavailable"}}));
    } finally { close(); }
  }
  async close() {
    this.closed = true;
    await Promise.allSettled([...this.active].map(server => server.close()));
    this.active.clear();
  }
}
