import { randomUUID } from "node:crypto";
import type { SendOptions } from "../adapter.js";
import { interactionHash } from "../interaction-receipts.js";
import type { CodexNativeFrame } from "./codex-app-server.js";

/** Native permission callbacks retain the original turn and real human authority. */
export class CodexNativeRequests {
  private readonly items = new Map<string, { type: string }>();
  private readonly decisions = new Map<string, { requestId: string; hash: string; decision: string }>();
  constructor(private options: SendOptions) {}

  observe(frame: CodexNativeFrame): void {
    const item = frame.params.item;
    if (frame.method === "item/started" && item && typeof item.id === "string") {
      if (this.items.has(item.id) || this.items.size >= 128) throw new Error("Native item identity is not unique");
      this.items.set(item.id, { type: item.type });
    } else if (frame.method === "item/completed" && item && typeof item.id === "string") {
      const approval = this.decisions.get(item.id);
      this.items.delete(item.id); this.decisions.delete(item.id);
      if (approval && (approval.decision === "accept" && ["completed", "failed"].includes(item.status)
        || approval.decision === "decline" && item.status === "declined")) {
        try { this.options.acknowledgeInteraction?.(approval.requestId, approval.hash); }
        catch { /* Native execution and an optional application receipt remain separate. */ }
      }
    }
  }

  async request(frame: CodexNativeFrame, signal: AbortSignal): Promise<unknown> {
    this.assertActive(signal);
    const input = frame.params;
    const item = this.items.get(input.itemId);
    if (!item || !this.options.requestInteraction) throw new Error("Native human request has no active item or human channel");
    if (!["item/commandExecution/requestApproval", "item/fileChange/requestApproval", "item/permissions/requestApproval", "item/tool/requestUserInput"].includes(frame.method)) throw new Error("Unsupported native server request");
    const requestId = randomUUID();
    if (frame.method === "item/tool/requestUserInput") {
      if (!Array.isArray(input.questions) || !input.questions.length || input.questions.length > 3) throw new Error("Native question shape is unsupported");
      const questions = input.questions;
      if (questions.some((q: any) => typeof q.id !== "string" || typeof q.question !== "string" || q.isSecret)) throw new Error("Native question is unsupported");
      const approval = item.type === "mcpToolCall";
      const reply = await this.options.requestInteraction({ requestId,
        ...(approval ? { presentation: { kind: "approval" as const, decisionField: questions[0].id } } : {}),
        form: { title: "Codex", fields: questions.map((q: any) => ({
          key: q.id, label: q.question, required: true,
          ...(Array.isArray(q.options) && q.options.length ? { type: "select" as const,
            options: q.options.map((o: any) => ({ value: String(o.label), label: String(o.label) })) } : { type: "textarea" as const }),
        })), submitLabel: "Submit" } });
      this.assertActive(signal);
      if (reply.requestId !== requestId || approval && reply.responder) throw new Error("Native question response is unconfirmed");
      if (reply.action !== "submit") return { answers: {} };
      const answers: Record<string, { answers: string[] }> = {};
      for (const question of questions) {
        const value = reply.values?.[question.id];
        if (typeof value !== "string" && (!Array.isArray(value) || value.some(v => typeof v !== "string"))) throw new Error("Native answer is unsupported");
        answers[question.id] = { answers: typeof value === "string" ? [value] : value };
      }
      return { answers };
    }
    const expectedType = frame.method === "item/fileChange/requestApproval" ? "fileChange" : frame.method === "item/commandExecution/requestApproval" ? "commandExecution" : undefined;
    if (expectedType && item.type !== expectedType) throw new Error("Native approval item mismatch");
    const available = Array.isArray(input.availableDecisions) ? input.availableDecisions : ["accept", "decline", "cancel"];
    const choices = ["accept", "decline", "cancel"].filter(value => available.includes(value));
    if (!choices.length) throw new Error("Native approval decisions are unsupported");
    const reply = await this.options.requestInteraction({ requestId, presentation: { kind: "approval", decisionField: "decision" }, form: {
      title: frame.method === "item/permissions/requestApproval" ? "Codex Permission Request" : "Codex Approval",
      description: JSON.stringify({ itemId: input.itemId, command: input.command, cwd: input.cwd, reason: input.reason,
        network: input.networkApprovalContext, additionalPermissions: input.additionalPermissions, grantRoot: input.grantRoot, permissions: input.permissions }),
      fields: [{ key: "decision", label: "Decision", type: "select", required: true,
        options: choices.map(value => ({ value, label: value === "accept" ? "Allow Requested Action" : value === "decline" ? "Decline" : "Cancel" })) }],
      submitLabel: "Confirm", cancelLabel: "Cancel",
    } });
    this.assertActive(signal);
    if (reply.requestId !== requestId || reply.responder) throw new Error("A native permission decision requires its actual human responder");
    const decision = reply.action === "submit" ? reply.values?.decision : "cancel";
    if (typeof decision !== "string" || !choices.includes(decision)) throw new Error("Native approval decision is unsupported");
    this.decisions.set(input.itemId, { requestId, hash: interactionHash(reply), decision });
    if (frame.method === "item/permissions/requestApproval") {
      if (!input.permissions || typeof input.permissions !== "object" || Array.isArray(input.permissions)) throw new Error("Native requested permissions are unsupported");
      const permissions = decision === "accept" ? Object.fromEntries(Object.entries(input.permissions).filter(([key]) => ["fileSystem", "network"].includes(key))) : {};
      return { permissions, scope: "turn" };
    }
    return { decision };
  }

  private assertActive(signal?: AbortSignal): void {
    if (signal?.aborted || this.options.signal?.aborted) throw new Error("Native controller source turn ended");
    this.options.beforeNativeEffect?.();
  }

}
