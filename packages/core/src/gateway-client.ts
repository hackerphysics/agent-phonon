import { WebSocket } from "ws";
import { randomUUID, createHash } from "node:crypto";
import { z } from "zod";
import { nativeVersionAtLeast } from "@agent-phonon/protocol";

/**
 * OpenClaw Gateway WebSocket 客户端（传输层）。
 *
 * 借鉴 LMA src/openclaw-client.ts 的传输层（握手 + RPC + 事件路由），
 * 不抄其飞书业务逻辑。协议帧：{type:"req"|"res"|"event", id, method, params/payload}。
 *
 * 握手：连上 → 收 connect.challenge(event) → 发 connect(req, operator scopes + token) → hello-ok。
 */

const GATEWAY_PROTOCOL_MIN = 1;
const GATEWAY_PROTOCOL_MAX = 10;

export interface GatewayConfig {
  /** ws 或 http URL（http 会自动转 ws）。 */
  baseUrl: string;
  token: string;
  /** Optional narrower connection scopes; model switching must not persist agent defaults. */
  scopes?: string[];
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
  timer: NodeJS.Timeout;
}

/** Gateway 事件回调：method=事件名（agent/chat/...），payload=事件体。 */
export type GatewayEventHandler = (event: string, payload: Record<string, unknown>) => void;

export class GatewayClient {
  private ws: WebSocket | null = null;
  private connected = false;
  private epoch=0;
  private capabilities=new Set<string>();
  connectionEpoch(){return this.epoch;}
  supportsCapability(name:string){return this.connected&&this.capabilities.has(name);}
  private config: GatewayConfig;
  private pending = new Map<string, Pending>();
  private eventHandlers = new Set<GatewayEventHandler>();
  private connectPromise: Promise<void> | null = null;

  constructor(config: GatewayConfig) {
    this.config = config;
  }

  onEvent(handler: GatewayEventHandler): void {
    this.eventHandlers.add(handler);
  }

  isConnected(): boolean {
    return this.connected;
  }

  /** Inventory is read as this caller; neither the catalog nor this receipt grants native tools. */
  async bindNoninteractivePolicy(input:{sessionKey:string;sessionId:string;runId:string;agentId:string;model:string}):Promise<{
    epoch:number;confirm:()=>Promise<void>;release:(options?:{dispatched:boolean})=>Promise<void>;
  }> {
    const gateway=new URL(this.config.baseUrl);
    if(!["127.0.0.1","[::1]","localhost"].includes(gateway.hostname))throw new Error("Phonon noninteractive policy requires a local Gateway");
    await this.connect();
    const epoch=this.epoch,policyId=randomUUID();
    let params:Record<string,unknown>|undefined;
    const release=async(options={dispatched:true})=>{if(params&&this.isConnected()&&this.epoch===epoch)await this.rpcOnConnection(epoch,"phonon.policy.release",{...params,dispatched:options.dispatched},5000).catch(()=>{});};
    try{
      const inventory=await this.rpcOnConnection(epoch,"tools.catalog",{agentId:input.agentId,includePlugins:true},5000);
      const effective=await this.rpcOnConnection(epoch,"tools.effective",{agentId:input.agentId,sessionKey:input.sessionKey},10000);
      const catalog:Record<string,unknown>={...inventory,effective};
      if(catalog.agentId!==input.agentId||!Array.isArray(catalog.groups)||Buffer.byteLength(JSON.stringify(catalog))>524288)throw new Error("unsupported catalog");
      params={...input,version:1,policyId,expiresAt:Date.now()+1799000,catalog};
      const receiptSchema=z.object({version:z.literal(1),bound:z.literal(true),policy:z.literal("phonon-noninteractive-v1"),nativeVersion:z.string().refine(value=>nativeVersionAtLeast(value,"2026.10.7")),
        policyId:z.literal(policyId),sessionKey:z.literal(input.sessionKey),sessionId:z.literal(input.sessionId),runId:z.literal(input.runId),
        catalogHash:z.literal(createHash("sha256").update(JSON.stringify(catalog)).digest("hex")),executionFence:z.literal("native-controller-v1")}).strict();
      receiptSchema.parse(await this.rpcOnConnection(epoch,"phonon.policy.bind",params,5000));
      const confirm=async()=>{
        receiptSchema.parse(await this.rpcOnConnection(epoch,"phonon.policy.confirm",params!,5000));
        if(!this.isConnected()||this.epoch!==epoch)throw new Error("Phonon policy connection changed");
      };
      await confirm();return {epoch,confirm,release};
    }catch{await release({dispatched:false});throw new Error("OpenClaw Phonon noninteractive policy was not confirmed; no chat dispatched. Requires the qualified plugin, current native authority and catalog/effective inventory");}
  }

  /** A policy-bound dispatch must never reconnect and silently acquire a different transport. */
  rpcOnConnection(epoch:number,method:string,params:unknown,timeoutMs=120000):Promise<Record<string,unknown>>{
    if(!this.connected||this.epoch!==epoch)return Promise.reject(new Error("OpenClaw policy connection is no longer current"));
    return this.rpc(method,params,timeoutMs);
  }

  /** Loopback capabilities must never be forwarded to a remote Gateway host. */
  async bindNativeInteractions(sessionKey: string, runId: string, env: Record<string, string>,options:{coordinationOnly?:boolean}={}): Promise<() => Promise<void>> {
    const gateway = new URL(this.config.baseUrl);
    if (!["127.0.0.1", "[::1]", "localhost"].includes(gateway.hostname)
      || !["ws:", "wss:", "http:", "https:"].includes(gateway.protocol)) throw new Error("Native interactions require a local OpenClaw Gateway");
    const params = { version: 1, sessionKey, runId, expiresAt: Date.now() + 1799000,
      ...(!options.coordinationOnly?{interactionUrl: env.AGENT_PHONON_INTERACTION_URL, receiptUrl:env.AGENT_PHONON_INTERACTION_RECEIPT_URL}:{}),
      token: env.AGENT_PHONON_INTERACTION_TOKEN,...(options.coordinationOnly?{coordinationOnly:true}:{}) };
    if(env.AGENT_PHONON_BOARD_URL)Object.assign(params,{boardUrl:env.AGENT_PHONON_BOARD_URL});
    if(env.AGENT_PHONON_WORKFLOW_URL)Object.assign(params,{workflowUrl:env.AGENT_PHONON_WORKFLOW_URL});
    if(env.AGENT_PHONON_MESSAGE_URL)Object.assign(params,{messageUrl:env.AGENT_PHONON_MESSAGE_URL});
    if(env.AGENT_PHONON_DOCUMENT_URL)Object.assign(params,{documentUrl:env.AGENT_PHONON_DOCUMENT_URL});
    if(env.AGENT_PHONON_COORDINATION_URL)Object.assign(params,{coordinationUrl:env.AGENT_PHONON_COORDINATION_URL});
    const release = async () => {
      if (this.isConnected()) await this.rpc("phonon.interactions.release", { sessionKey, runId }, 5000).catch(() => {});
    };
    try {
      const result = await this.rpc("phonon.interactions.bind", params, 5000);
      if (result.version !== 1 || result.bound !== true) throw new Error("unverified binding");
      return release;
    } catch {
      await release();
      throw new Error("OpenClaw native interaction plugin is unavailable; install and explicitly enable its tools before running native chat");
    }
  }

  async bindPeerContext(input:{sessionKey:string;sessionId:string;runId:string;workspaceDir:string;model:string;projectionId:string;nativeInput?:true},env:Record<string,string>):Promise<()=>Promise<void>> {
    const gateway=new URL(this.config.baseUrl);
    if(!["127.0.0.1","[::1]","localhost"].includes(gateway.hostname)||!["ws:","wss:","http:","https:"].includes(gateway.protocol))throw new Error("Peer checkpoints require a local Gateway");
    await this.connect();
    const epoch=this.epoch,release=async()=>{
      if(this.isConnected()&&this.epoch===epoch)await this.rpc("phonon.peers.release",{sessionKey:input.sessionKey,runId:input.runId},5000).catch(()=>{});
    };
    try{
      const result=await this.rpc("phonon.peers.bind",{...input,version:1,expiresAt:Date.now()+1799000,
        endpoint:env.AGENT_PHONON_PEER_CONTEXT_URL,token:env.AGENT_PHONON_PEER_CONTEXT_TOKEN},5000);
      if(!this.isConnected()||this.epoch!==epoch||result.version!==1||result.bound!==true||result.projectionId!==input.projectionId)throw new Error("unconfirmed peer binding");
      return release;
    }catch{await release();throw new Error("OpenClaw current-run peer binding is unavailable");}
  }

  connect(): Promise<void> {
    if (this.connectPromise) return this.connectPromise;
    this.connectPromise = this.doConnect();
    return this.connectPromise;
  }

  private doConnect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const wsUrl = this.config.baseUrl.replace(/^http/, "ws");
      const ws = new WebSocket(wsUrl);
      this.ws = ws;
      let handshakeDone = false;
      const handshakeTimer=setTimeout(()=>{if(!handshakeDone){reject(new Error("Gateway handshake timed out"));ws.close();}},10000);
      handshakeTimer.unref();

      ws.on("message", (raw: Buffer) => {
        if(this.ws!==ws)return;
        let frame: Record<string, unknown>;
        try {
          frame = JSON.parse(raw.toString());
        } catch {
          return;
        }

        if (!handshakeDone) {
          if (frame.type === "event" && frame.event === "connect.challenge") {
            ws.send(
              JSON.stringify({
                type: "req",
                id: "connect-1",
                method: "connect",
                params: {
                  minProtocol: GATEWAY_PROTOCOL_MIN,
                  maxProtocol: GATEWAY_PROTOCOL_MAX,
                  client: { id: "gateway-client", version: "0.0.1", platform: "linux", mode: "backend" },
                  role: "operator",
                  scopes: this.config.scopes ?? ["operator.read", "operator.write", "operator.admin"],
                  caps: ["tool-events"],
                  auth: { token: this.config.token },
                  userAgent: "agent-phonon/0.0.1",
                },
              }),
            );
          } else if (frame.type === "res" && frame.ok && (frame.payload as { type?: string })?.type === "hello-ok") {
            handshakeDone = true;
            clearTimeout(handshakeTimer);
            this.connected = true;
            const advertised=(frame.payload as {features?:{capabilities?:unknown}}).features?.capabilities;
            this.capabilities=new Set(Array.isArray(advertised)?advertised.filter((value):value is string=>typeof value==="string"):[]);
            this.epoch++;
            resolve();
          } else if (frame.type === "res" && !frame.ok) {
            clearTimeout(handshakeTimer);
            reject(new Error(`handshake failed: ${JSON.stringify(frame.error)}`));
          }
          return;
        }

        // 响应
        if (frame.type === "res" && frame.id) {
          const p = this.pending.get(frame.id as string);
          if (p) {
            this.pending.delete(frame.id as string);
            clearTimeout(p.timer);
            if (frame.ok) p.resolve(frame.payload);
            else p.reject(new Error(`RPC error: ${JSON.stringify(frame.error)}`, {cause: frame.error}));
          }
          return;
        }

        // 事件 → 分发给所有 handler
        if (frame.type === "event" && typeof frame.event === "string") {
          for (const h of this.eventHandlers) {
            try {
              h(frame.event, (frame.payload as Record<string, unknown>) ?? {});
            } catch {
              /* ignore handler error */
            }
          }
        }
      });

      ws.on("error", (err) => {
        if (!handshakeDone) {clearTimeout(handshakeTimer);reject(err);}
      });
      ws.on("close", () => {
        clearTimeout(handshakeTimer);
        if(!handshakeDone)reject(new Error("Gateway closed before authentication"));
        if(this.ws!==ws)return;
        this.connected = false;
        this.capabilities.clear();
        this.connectPromise = null;
        for (const [, p] of this.pending) {
          clearTimeout(p.timer);
          p.reject(new Error("gateway connection closed"));
        }
        this.pending.clear();
      });
    });
  }

  /** 发一个 Gateway RPC。 */
  async rpc(method: string, params: unknown, timeoutMs = 120000): Promise<Record<string, unknown>> {
    if (!this.connected) await this.connect();
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`RPC timeout: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      this.ws!.send(JSON.stringify({ type: "req", id, method, params }));
    });
  }

  /** A write-only model patch cannot acquire Gateway sticky-config admin authority. */
  async patchSessionModel(key: string, model: string): Promise<Record<string, unknown>> {
    const client = new GatewayClient({ ...this.config, scopes: ["operator.read", "operator.write"] });
    try { return await client.rpc("sessions.patch", { key, model }, 10000); }
    finally { client.close(); }
  }

  close(): void {
    const socket=this.ws;
    this.ws = null;
    this.connected = false;
    this.capabilities.clear();this.connectPromise=null;
    for(const pending of this.pending.values()){clearTimeout(pending.timer);pending.reject(new Error("Gateway client closed"));}
    this.pending.clear();socket?.close();
  }
}
