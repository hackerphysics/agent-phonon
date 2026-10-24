import type {IncomingMessage, ServerResponse} from "node:http";
import {Server} from "@modelcontextprotocol/sdk/server/index.js";
import {StreamableHTTPServerTransport} from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {CallToolRequestSchema, ListToolsRequestSchema, type Tool} from "@modelcontextprotocol/sdk/types.js";
import {zodToJsonSchema} from "zod-to-json-schema";
import type {z} from "zod";

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
      inputSchema: {type: "object", ...zodToJsonSchema(tool.schema, {$refStrategy: "none"})} as Tool["inputSchema"]}));
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
