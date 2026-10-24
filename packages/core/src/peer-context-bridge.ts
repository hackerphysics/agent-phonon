import { createServer, type Server } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { PeerContextBoundary, PeerContextObservation, type PeerContextAccess } from "./peer-context.js";

/** Private runtime checkpoint endpoint, deliberately absent from the model's tool catalog. */
export class PeerContextBridge {
  private server?: Server;
  private token = randomBytes(32).toString("base64url");
  private authority = "";
  private requests = 0;
  private pending = 0;
  private closed = false;
  private closing?: Promise<void>;
  constructor(private access: PeerContextAccess) {}

  async listen(): Promise<Record<string, string>> {
    this.server = createServer((req, res) => {
      const controller = new AbortController();
      res.on("close", () => controller.abort());
      const reply = (status: number, value: unknown) => {
        if (!res.destroyed) res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" }).end(JSON.stringify(value));
      };
      void (async () => {
        const actual = Buffer.from(req.headers.authorization ?? ""), expected = Buffer.from("Bearer " + this.token);
        if (this.closed || req.method !== "POST" || !["/peer-context", "/peer-context/observe"].includes(req.url ?? "")) return reply(404, { error: "not_found" });
        if (req.headers.origin || req.headers.host !== this.authority || actual.length !== expected.length || !timingSafeEqual(actual, expected)) return reply(403, { error: "forbidden" });
        if (this.pending >= 2 || this.requests >= 512) return reply(429, { error: "checkpoint_limit" });
        this.pending++; this.requests++;
        try {
          const chunks: Buffer[] = []; let bytes = 0;
          for await (const raw of req) {
            const chunk = Buffer.from(raw); bytes += chunk.length;
            if (bytes > 4096) return reply(413, { error: "request_too_large" });
            chunks.push(chunk);
          }
          const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          if (this.closed) throw new Error("closed");
          if (req.url === "/peer-context") {
            const batch = await this.access.prepare(PeerContextBoundary.parse(input), controller.signal);
            if (this.closed || controller.signal.aborted) throw new Error("closed");
            reply(200, batch);
          } else {
            this.access.observe(PeerContextObservation.parse(input));
            reply(200, { observed: true });
          }
        } catch { reply(409, { error: "peer_context_unavailable" }); }
        finally { this.pending--; }
      })().catch(() => reply(409, { error: "peer_context_unavailable" }));
    });
    this.server.requestTimeout = 3000;
    await new Promise<void>((resolve, reject) => { this.server!.once("error", reject); this.server!.listen(0, "127.0.0.1", resolve); });
    const address = this.server.address();
    if (!address || typeof address === "string") throw new Error("Peer context bridge unavailable");
    this.authority = `127.0.0.1:${address.port}`;
    return { AGENT_PHONON_PEER_CONTEXT_URL: `http://${this.authority}/peer-context`, AGENT_PHONON_PEER_CONTEXT_TOKEN: this.token };
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true; this.token = "";
    const server = this.server;
    this.closing = server ? new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }) : Promise.resolve();
    return this.closing;
  }
}
