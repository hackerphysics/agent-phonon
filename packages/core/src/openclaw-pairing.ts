import { WebSocket } from "ws";
import { z } from "zod";
import { isLoopbackGateway } from "./openclaw-gateway-discover.js";

export class GatewayConnectionError extends Error {
  constructor(message: string, readonly code: string, readonly requestId?: string, readonly recommendedNextStep?: string, readonly reason?: string) {
    super(message);
    this.name = "GatewayConnectionError";
  }
}

export function gatewayHandshakeError(raw: unknown): GatewayConnectionError {
  const error = z.object({ code: z.string().optional(), details: z.object({ code: z.string().optional(), requestId: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/).optional(),
    recommendedNextStep: z.string().regex(/^[a-z_]{1,64}$/).optional(), reason: z.string().regex(/^[a-z-]{1,64}$/).optional() }).optional() }).safeParse(raw);
  const details = error.success ? error.data.details : undefined;
  const code = details?.code ?? (error.success ? error.data.code : undefined) ?? "HANDSHAKE_FAILED";
  const safeCode = /^[A-Z0-9_]{1,80}$/.test(code) ? code : "HANDSHAKE_FAILED";
  const requestId = details?.requestId;
  const hint = safeCode === "PAIRING_REQUIRED" || safeCode === "NOT_PAIRED"
    ? `Pairing pending${requestId ? ` (${requestId})` : ""}; on the Gateway host run openclaw devices list, then openclaw devices approve ${requestId ?? "<requestId>"}. Remote blind approval is refused`
    : safeCode.startsWith("DEVICE_AUTH_") ? "Check the local device identity permissions/key and Gateway clock; reconnect for a fresh challenge. Do not delete the identity to bypass approval"
    : "Check Gateway credentials/auth configuration; device scope/role upgrades require explicit operator approval";
  return new GatewayConnectionError(`OpenClaw ${safeCode}: ${hint}`, safeCode === "NOT_PAIRED" ? "PAIRING_REQUIRED" : safeCode, requestId, details?.recommendedNextStep, details?.reason);
}

const pendingSchema = z.object({ requestId: z.string(), deviceId: z.string(), publicKey: z.string(), clientId: z.string(), clientMode: z.string(),
  role: z.string(), roles: z.array(z.string()).optional(), scopes: z.array(z.string()), isRepair: z.boolean().optional() });

/** No CLI fallback: it could target another profile or approve with broader owner authority. */
export async function approveLocalGatewayPairing(input: {
  baseUrl: string; token: string; requestId: string; deviceId: string; publicKey: string; scopes: string[]; assertCurrent: () => void; signal?: AbortSignal;
}): Promise<void> {
  if (!isLoopbackGateway(input.baseUrl)) throw new GatewayConnectionError("Remote blind approval refused; run openclaw devices list / approve on the Gateway host", "REMOTE_APPROVAL_REFUSED", input.requestId);
  if (!input.token || !/^[a-zA-Z0-9_-]{1,128}$/.test(input.requestId)) throw new Error("Local pairing requires a shared bootstrap credential and an exact requestId");
  const assertCurrent = () => {
    input.assertCurrent();
    if (input.signal?.aborted) throw new GatewayConnectionError("Gateway connection cancelled; no pairing/reconnect attempted", "CONNECTION_CANCELLED");
  };
  assertCurrent();
  const ws = new WebSocket(input.baseUrl.replace(/^http/, "ws"));
  try {
    await new Promise<void>((resolve, reject) => {
      let step: "connect" | "list" | "approve" = "connect";
      let challenged = false;
      let settled = false;
      const timer = setTimeout(() => finish(new Error("Local pairing approval timed out")), 10000);
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true; clearTimeout(timer);
        input.signal?.removeEventListener("abort", onAbort);
        ws.removeAllListeners("message");
        error ? reject(error) : resolve();
      };
      const onAbort = () => finish(new GatewayConnectionError("Gateway connection cancelled; no pairing/reconnect attempted", "CONNECTION_CANCELLED"));
      const send = (method: string, params: unknown) => {
        assertCurrent();
        ws.send(JSON.stringify({ type: "req", id: step, method, params }));
      };
      const onError = () => finish(new Error("Local pairing helper could not reach the Gateway"));
      const onClose = () => {
        finish(new Error("Local pairing helper closed; approve the exact request on the Gateway host"));
        ws.removeListener("error", onError); ws.removeListener("close", onClose);
      };
      ws.on("error", onError);
      ws.on("close", onClose);
      ws.on("message", raw => {
        try {
          assertCurrent();
          const frame = JSON.parse(raw.toString());
          if (step === "connect" && frame.type === "event" && frame.event === "connect.challenge" && !challenged) {
            challenged = true;
            send("connect", { minProtocol: 1, maxProtocol: 10, client: { id: "gateway-client", version: "0.0.1", platform: process.platform, mode: "backend" },
              role: "operator", scopes: input.scopes, auth: { token: input.token } });
          } else if (frame.type === "res" && frame.id === step) {
            if (!frame.ok) { finish(gatewayHandshakeError(frame.error)); return; }
            if (step === "connect") {
              if (!challenged || frame.payload?.type !== "hello-ok") throw new Error("Invalid local pairing helper handshake");
              step = "list"; send("device.pair.list", {});
            } else if (step === "list") {
              const list = z.object({ pending: z.array(z.unknown()), paired: z.array(z.object({ deviceId: z.string() })) }).parse(frame.payload);
              const matching = list.pending.filter(row => (row as { requestId?: unknown })?.requestId === input.requestId);
              const request = pendingSchema.parse(matching.length === 1 ? matching[0] : undefined);
              const sameScopes = [...new Set(request.scopes)].sort().join("\n") === [...new Set(input.scopes)].sort().join("\n");
              if (request.deviceId !== input.deviceId || request.publicKey !== input.publicKey || request.clientId !== "gateway-client" || request.clientMode !== "cli"
                || request.role !== "operator" || request.roles?.some(role => role !== "operator") || !sameScopes || request.isRepair
                || list.paired.some(row => row.deviceId === input.deviceId)) throw new Error("Pairing request identity/role/scopes changed or requires an upgrade; manual approval required");
              step = "approve"; send("device.pair.approve", { requestId: input.requestId });
            } else {
              if (frame.payload?.requestId !== input.requestId || frame.payload?.device?.deviceId !== input.deviceId) throw new Error("Unconfirmed pairing approval receipt");
              finish();
            }
          }
        } catch (error) { finish(error instanceof GatewayConnectionError && error.code === "CONNECTION_CANCELLED" ? error
          : new Error("Local pairing could not verify the exact new device request; inspect and approve it on the Gateway host")); }
      });
      input.signal?.addEventListener("abort", onAbort, { once: true });
      if (input.signal?.aborted) onAbort();
    });
  } finally { ws.terminate(); }
}
