import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import {
  PI_HITL_EXTENSION_SOURCE,
  materializePiHitlExtension,
  piHitlExtensionHash,
  PiAdapter,
} from "@agent-phonon/core";

/**
 * Behavioural tests for the Pi blocking HITL extension.
 *
 * The extension runs inside Pi's process, so it cannot import phonon's bundle and
 * must stay self-contained. To still test it for real, we load the shipped source
 * (type-only import stripped) as an ES module, hand it a mock ExtensionAPI that
 * captures the `tool_call` handler, and drive that handler against a stubbed
 * fetch. This exercises the actual decision logic Pi would run.
 */

async function loadExtension(env: Record<string, string | undefined>): Promise<(api: unknown) => void> {
  const dir = mkdtempSync(join(tmpdir(), "phonon-pi-hitl-"));
  const file = join(dir, "ext.mjs");
  // Pi loads extensions through jiti, which transpiles TS. Do the same here so we
  // test the shipped TypeScript rather than a hand-stripped approximation.
  const js = ts.transpileModule(PI_HITL_EXTENSION_SOURCE, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  writeFileSync(file, js, { mode: 0o600 });
  const saved = { ...process.env };
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    const mod = await import(pathToFileURL(file).href);
    return mod.default;
  } finally {
    process.env = saved;
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Capture the handler the extension registers for `tool_call`. */
function captureHandler(activate: (api: unknown) => void, env: Record<string, string | undefined> = {}) {
  let handler: ((e: unknown) => Promise<unknown>) | undefined;
  const api = { on: (event: string, h: (e: unknown) => Promise<unknown>) => { if (event === "tool_call") handler = h; } };
  activate(api);
  return handler;
}

function withFetchStub(response: unknown, ok = true, capture?: (url: string, init: unknown) => void) {
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: unknown) => {
    capture?.(String(url), init);
    if (!ok) return { ok: false, status: 500, json: async () => ({}) } as unknown as Response;
    return { ok: true, status: 200, json: async () => response } as unknown as Response;
  }) as typeof fetch;
  return () => { globalThis.fetch = original; };
}

const BASE_ENV = {
  AGENT_PHONON_HITL_BRIDGE: "http://127.0.0.1:4318",
  AGENT_PHONON_HITL_SESSION: "sess-1",
  AGENT_PHONON_HITL_TOKEN: "tok",
  AGENT_PHONON_HITL_TIMEOUT_MS: "5000",
  AGENT_PHONON_HITL_FAIL_MODE: "closed",
};

test("pi HITL extension sends the documented bridge contract", async () => {
  const activate = await loadExtension(BASE_ENV);
  const handler = captureHandler(activate);
  assert.ok(handler, "extension must register a tool_call handler");

  let seenUrl = "";
  let seenBody: any;
  let seenAuth: unknown;
  const restore = withFetchStub({ action: "continue" }, true, (url, init) => {
    seenUrl = url;
    seenBody = JSON.parse((init as { body: string }).body);
    seenAuth = (init as { headers?: unknown }).headers;
  });
  try {
    const event = { toolName: "bash", input: { command: "ls -la" }, toolCallId: "c1" };
    await handler(event);
  } finally {
    restore();
  }
  assert.equal(seenUrl, "http://127.0.0.1:4318/hook/before_tool_call");
  assert.deepEqual(seenBody, { sessionKey: "sess-1", toolName: "bash", params: { command: "ls -la" } });
  const authHeader = (seenAuth as unknown as { authorization?: string })?.authorization;
  assert.equal(authHeader, "Bearer tok", "bridge token must be forwarded");
});

test("pi HITL extension blocks when the bridge says abort", async () => {
  const activate = await loadExtension(BASE_ENV);
  const handler = captureHandler(activate)!;
  const restore = withFetchStub({ action: "abort", reason: "needs human approval" });
  try {
    const out = await handler({ toolName: "bash", input: { command: "rm -rf /" }, toolCallId: "c1" });
    assert.deepEqual(out, { block: true, reason: "needs human approval" });
  } finally {
    restore();
  }
});

test("pi HITL extension mutates tool input in place on modify", async () => {
  const activate = await loadExtension(BASE_ENV);
  const handler = captureHandler(activate)!;
  const restore = withFetchStub({ action: "modify", patch: { command: "ls" } });
  try {
    const event: any = { toolName: "bash", input: { command: "rm -rf /" }, toolCallId: "c1" };
    const out = await handler(event);
    assert.equal(out, undefined, "modify must not block");
    assert.deepEqual(event.input, { command: "ls" }, "input mutated in place");
  } finally {
    restore();
  }
});

test("pi HITL fails CLOSED on dangerous tools when the bridge is unreachable", async () => {
  const activate = await loadExtension(BASE_ENV);
  const handler = captureHandler(activate)!;
  // Network failure path.
  const original = globalThis.fetch;
  globalThis.fetch = (async () => { throw new Error("ECONNREFUSED"); }) as typeof fetch;
  try {
    const out = await handler({ toolName: "bash", input: { command: "rm -rf /" }, toolCallId: "c1" });
    assert.equal((out as { block?: boolean })?.block, true, "dangerous tool must block when gate is down");
  } finally {
    globalThis.fetch = original;
  }
});

test("pi HITL still allows harmless tools when the bridge is unreachable", async () => {
  const activate = await loadExtension(BASE_ENV);
  const handler = captureHandler(activate)!;
  const original = globalThis.fetch;
  globalThis.fetch = (async () => { throw new Error("ECONNREFUSED"); }) as typeof fetch;
  try {
    const out = await handler({ toolName: "read", input: { path: "a.txt" }, toolCallId: "c1" });
    assert.equal(out, undefined, "read must not be blocked by an outage");
  } finally {
    globalThis.fetch = original;
  }
});

test("pi HITL fail-open mode does not block on outage when explicitly opted out", async () => {
  const activate = await loadExtension({ ...BASE_ENV, AGENT_PHONON_HITL_FAIL_MODE: "open" });
  const handler = captureHandler(activate)!;
  const original = globalThis.fetch;
  globalThis.fetch = (async () => { throw new Error("ECONNREFUSED"); }) as typeof fetch;
  try {
    const out = await handler({ toolName: "bash", input: { command: "ls" }, toolCallId: "c1" });
    assert.equal(out, undefined);
  } finally {
    globalThis.fetch = original;
  }
});

test("pi HITL extension is inert when no bridge is configured", async () => {
  const activate = await loadExtension({ ...BASE_ENV, AGENT_PHONON_HITL_BRIDGE: undefined });
  let registered = false;
  const api = { on: () => { registered = true; } };
  activate(api);
  assert.equal(registered, false, "must not register a gate it cannot enforce");
});

test("materializePiHitlExtension writes once and is idempotent", () => {
  const dir = mkdtempSync(join(tmpdir(), "phonon-pi-hitl-dir-"));
  try {
    const a = materializePiHitlExtension(dir);
    const first = readFileSync(a, "utf8");
    const b = materializePiHitlExtension(dir);
    assert.equal(a, b, "same path for same content");
    assert.equal(readFileSync(b, "utf8"), first, "content unchanged");
    assert.ok(first.includes("AGENT_PHONON_HITL_BRIDGE"));
    assert.ok(piHitlExtensionHash().length === 16);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("PiAdapter declares pre_tool only when a bridge is attached", () => {
  const without = new PiAdapter();
  assert.deepEqual(without.capabilities.hooks, [], "no bridge => no advertised gate");

  const with_ = new PiAdapter();
  with_.setHitl({ bridgeUrl: "http://127.0.0.1:4318" });
  assert.deepEqual(with_.capabilities.hooks, ["pre_tool"]);

  with_.setHitl(undefined);
  assert.deepEqual(with_.capabilities.hooks, [], "clearing the gate must retract the claim");
});