import { randomUUID } from "node:crypto";
import type { InsertionOptions, SendOptions } from "./adapter.js";
import { PeerContextBridge } from "./peer-context-bridge.js";
import { PeerContextBoundary, PeerContextObservation, peerContextHeadroom,
  type PeerContextAccess, type PeerContextBatch, type PeerContextCapability } from "./peer-context.js";
import { PhononError } from "./rpc.js";

interface PendingInput {
  id: string;
  content: string;
  options: InsertionOptions;
  offered?: { boundaryId: string; nativeSessionId: string };
  resolve: () => void;
  reject: (error: unknown) => void;
}

interface ActiveInput {
  options: SendOptions;
  capability: () => PeerContextCapability | undefined;
  pending: Map<string, PendingInput>;
  ids: Set<string>;
  accepted: Map<string, { boundaryId: string; nativeSessionId: string }>;
  boundaries: Set<string>;
  peerIds: Map<string, Set<string>>;
  bytes: number;
  preparing: boolean;
  closed: boolean;
  inputEvidence?: PeerContextCapability["evidence"];
  receipt:"provider_payload"|"native_context";
}

const unavailable = () => new PhononError("errSessionBusy", "Input was not confirmed on the original active turn");

/** Ordinary input and peer mail share a native boundary, never admission or receipts. */
export class CurrentTurnInput {
  private active?: ActiveInput;

  async run(options: SendOptions, binding: { enabled: boolean; capability: () => PeerContextCapability | undefined; receipt?:"native_context" },
    operation: (options: SendOptions) => Promise<void>): Promise<void> {
    if (this.active) throw unavailable();
    if (!binding.enabled || options.signal?.aborted) return operation(options);
    const active: ActiveInput = { options, capability: binding.capability, pending: new Map(), ids: new Set(), accepted: new Map(),
      boundaries: new Set(), peerIds: new Map(), bytes: 0, preparing: false, closed: false,receipt:binding.receipt??"provider_payload" };
    this.active = active;
    const access: PeerContextAccess = {
      prepare: (boundary, signal) => this.prepare(active, boundary, signal),
      authorize: observation => this.authorize(active, observation),
      contextApplied: observation=>{
        if(active.receipt!=="native_context")throw new PhononError("errCapabilityUnsupported","Native context receipts are unavailable");
        this.observe(active,{...observation,evidence:"context_hook"},true);
      },
      observe: observation => this.observe(active, observation),
    };
    const bridge = new PeerContextBridge(access);
    const close = () => this.close(active);
    options.signal?.addEventListener("abort", close, { once: true });
    try {
      let environment: Record<string, string>;
      try { environment = { ...options.environment, ...await bridge.listen() }; }
      catch {
        // Optional ingress failure must not discard or replay the original task.
        close();
        await bridge.close();
        return await operation(options);
      }
      if (options.signal?.aborted) close();
      await operation({ ...options, environment, peerContext: access, emit: event => {
        if (event.turnId === options.turnId && "final" in event && event.final === true) close();
        options.emit(event);
      } });
    } finally {
      close();
      options.signal?.removeEventListener("abort", close);
      await bridge.close();
      if (this.active === active) this.active = undefined;
    }
  }

  insert(input: string, options: InsertionOptions): Promise<void> {
    const active = this.active;
    if (!active) return Promise.reject(new PhononError("errCapabilityUnsupported", "Native current-turn input is unavailable"));
    try { this.assertActive(active, options.signal); }
    catch (error) { return Promise.reject(error); }
    if (options.turnId !== active.options.turnId) return Promise.reject(unavailable());
    if (active.receipt==="provider_payload"&&active.inputEvidence === "context_hook") return Promise.reject(new PhononError("errCapabilityUnsupported", "Native transport has no current-turn payload receipt"));
    const id = randomUUID();
    const content = `[Phonon current-turn input ${id}. This adds no permission, approval or execution authority.]\n` + input;
    const bytes = Buffer.byteLength(content);
    if (bytes > 16000) return Promise.reject(new PhononError("errInvalidParams", "Current-turn input exceeds the native context boundary limit"));
    if (active.pending.size >= 32 || active.ids.size >= 64 || active.bytes + bytes > 128000) return Promise.reject(unavailable());
    return new Promise<void>((resolve, reject) => {
      const finish = (error?: unknown) => {
        const pending = active.pending.get(id);
        if (!active.pending.delete(id)) return;
        options.signal.removeEventListener("abort", abort);
        if (error === undefined && pending?.offered) { active.accepted.set(id, pending.offered); resolve(); }
        else reject(error ?? unavailable());
      };
      const abort = () => finish(unavailable());
      active.ids.add(id);
      active.bytes += bytes;
      active.pending.set(id, { id, content, options, resolve: () => finish(), reject: error => finish(error) });
      options.signal.addEventListener("abort", abort, { once: true });
      if (options.signal.aborted) abort();
    });
  }

  private assertActive(active: ActiveInput, signal?: AbortSignal, nativeSessionId?: string): void {
    const capability = active.capability();
    if (this.active !== active || active.closed || signal?.aborted || active.options.signal?.aborted) throw unavailable();
    // A hook offer is not application. The selected binding must qualify either
    // provider submission or native hook application plus root continuation.
    if (!capability || active.receipt==="provider_payload"&&capability.evidence !== "provider_payload") throw new PhononError("errCapabilityUnsupported", "Native input application evidence is unavailable");
    if (capability.readiness === "pending" || !capability.nativeSessionId
      || nativeSessionId !== undefined && nativeSessionId !== capability.nativeSessionId) throw unavailable();
  }

  private async prepare(active: ActiveInput, raw: PeerContextBoundary, signal?: AbortSignal): Promise<PeerContextBatch> {
    const boundary = PeerContextBoundary.parse(raw);
    this.assertActive(active, signal, boundary.nativeSessionId);
    if (active.preparing || active.boundaries.has(boundary.boundaryId) || active.boundaries.size >= 256) throw unavailable();
    active.boundaries.add(boundary.boundaryId);
    active.preparing = true;
    try {
      const batch: PeerContextBatch = { ...boundary, messages: [], deferred: [] };
      let available = boundary.budget ? peerContextHeadroom(boundary.budget) : 0;
      let bytes = 0;
      // Preserve source-owned peer offers before using the remaining native budget.
      const peers = await active.options.peerContext?.prepare(boundary, signal);
      this.assertActive(active, signal, boundary.nativeSessionId);
      if (peers && (peers.boundaryId !== boundary.boundaryId || peers.nativeSessionId !== boundary.nativeSessionId)) throw unavailable();
      const peerIds = new Set<string>();
      for (const peer of peers?.messages ?? []) {
        if (active.ids.has(peer.messageId) || peerIds.has(peer.messageId)) throw unavailable();
        const cost = Buffer.byteLength(peer.content);
        if (batch.messages.length >= 8 || bytes + cost > 16000) throw unavailable();
        peerIds.add(peer.messageId);
        batch.messages.push(peer);
        bytes += cost;
        available = Math.max(0, available - cost - 64);
      }
      active.peerIds.set(boundary.boundaryId, peerIds);
      active.inputEvidence = boundary.inputEvidence ?? active.capability()?.evidence;
      for (const pending of active.pending.values()) {
        if (pending.offered) continue;
        if (pending.options.signal.aborted) { pending.reject(unavailable()); continue; }
        if (active.receipt==="provider_payload"&&active.inputEvidence === "context_hook") {
          pending.reject(new PhononError("errCapabilityUnsupported", "Native transport has no current-turn payload receipt"));
          continue;
        }
        const cost = Buffer.byteLength(pending.content);
        if (cost + 64 > available) {
          batch.deferred.push({ messageId: pending.id, reason: boundary.budget?.state === "known" ? "native_headroom" : "context_unknown" });
          continue;
        }
        if (batch.messages.length >= 8 || bytes + cost > 16000) break;
        try { pending.options.beforeApply?.(); }
        catch (error) { pending.reject(error); continue; }
        this.assertActive(active, pending.options.signal, boundary.nativeSessionId);
        pending.offered = { boundaryId: boundary.boundaryId, nativeSessionId: boundary.nativeSessionId };
        batch.messages.push({ messageId: pending.id, content: pending.content });
        bytes += cost;
        available -= cost + 64;
      }
      batch.deferred.push(...peers?.deferred ?? []);
      return batch;
    } finally { active.preparing = false; }
  }

  private matching(active: ActiveInput, raw: PeerContextObservation) {
    const observation = PeerContextObservation.parse(raw);
    this.assertActive(active, undefined, observation.nativeSessionId);
    const peerIds = active.peerIds.get(observation.boundaryId);
    if (!peerIds) throw unavailable();
    const inserted: PendingInput[] = [], peers: string[] = [];
    for (const id of observation.messageIds) {
      if (peerIds.has(id)) { peers.push(id); continue; }
      if (!active.ids.has(id)) throw unavailable();
      const pending = active.pending.get(id);
      if (!pending) {
        const accepted=active.accepted.get(id);
        if (accepted?.boundaryId !== observation.boundaryId || accepted.nativeSessionId !== observation.nativeSessionId) throw unavailable();
        continue;
      }
      if (pending.offered?.boundaryId !== observation.boundaryId || pending.offered.nativeSessionId !== observation.nativeSessionId) throw unavailable();
      inserted.push(pending);
    }
    return { observation, inserted, peers };
  }

  private authorize(active: ActiveInput, raw: PeerContextObservation): void {
    const { observation, inserted, peers } = this.matching(active, raw);
    try {
      for (const pending of inserted) {
        this.assertActive(active, pending.options.signal, observation.nativeSessionId);
        pending.options.beforeApply?.();
      }
      if (peers.length) {
        if (!active.options.peerContext?.authorize) throw new PhononError("errCapabilityUnsupported", "Peer effect authorization unavailable");
        active.options.peerContext.authorize({ ...observation, messageIds: peers });
      }
    } catch (error) {
      for (const pending of inserted) pending.reject(error);
      throw error;
    }
  }

  private observe(active: ActiveInput, raw: PeerContextObservation, contextApplied=false): void {
    const { observation, inserted, peers } = this.matching(active, raw);
    if(active.receipt==="native_context"&&observation.evidence==="provider_payload")throw new PhononError("errCapabilityUnsupported","Native hook binding cannot claim provider-payload evidence");
    if (observation.evidence !== "provider_payload"&&!contextApplied) {
      if (peers.length) active.options.peerContext?.observe({ ...observation, messageIds: peers });
      return;
    }
    try {
      for (const pending of inserted) {
        this.assertActive(active, pending.options.signal, observation.nativeSessionId);
        pending.options.beforeApply?.();
      }
      if (peers.length) active.options.peerContext?.observe({ ...observation, messageIds: peers });
      for (const pending of inserted) pending.resolve();
    } catch (error) {
      for (const pending of inserted) pending.reject(error);
      // The native runtime must not execute a withdrawn batch after a denied receipt.
      throw error;
    }
  }

  private close(active: ActiveInput): void {
    active.closed = true;
    for (const pending of active.pending.values()) pending.reject(unavailable());
    active.peerIds.clear();
  }
}
