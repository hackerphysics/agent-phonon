import { requestFingerprint } from "./idempotency.js";
import { PhononError } from "./rpc.js";
import type { PhononStore } from "./store.js";
import type { MessageReceiveParams, MessageReceiveResult } from "@agent-phonon/protocol";

export function receiveMessage(store: PhononStore, tenant: string, input: MessageReceiveParams): MessageReceiveResult {
  const serialized = JSON.stringify(input);
  if (Buffer.byteLength(serialized) > 512 * 1024) throw new PhononError("errInvalidParams", "message exceeds transport limit");
  const requestHash = requestFingerprint(input);
  return store.receiveMessage(tenant, input, requestHash, serialized);
}
