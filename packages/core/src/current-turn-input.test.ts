import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import type { SendOptions } from "./adapter.js";
import { CurrentTurnInput } from "./current-turn-input.js";
import type { PeerContextAccess, PeerContextBoundary, PeerContextCapability } from "./peer-context.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
const boundary = (): PeerContextBoundary => ({ boundaryId: randomUUID(), nativeSessionId: "native-root",
  budget: { state: "known", source: "native_estimate", contextWindowTokens: 128000, inputTokens: 1000, outputTokens: 4000, overheadTokens: 1024 } });

async function fixture(work: (state: { input: CurrentTurnInput; access: PeerContextAccess; options: SendOptions;
  stop: () => void; capability: PeerContextCapability; finish: () => void }) => Promise<void>, parent?: PeerContextAccess,receipt?:"native_context") {
  const input = new CurrentTurnInput(), started = deferred(), finished = deferred(), abort = new AbortController();
  let captured!: SendOptions;
  const capability: PeerContextCapability = { mode: "context_hook", boundary: "before_model", visibility: "hidden",
    evidence: "provider_payload", nativeSessionId: "native-root" };
  const run = input.run({ turnId: "active", verbosity: "tools", signal: abort.signal, emit: () => {}, ...(parent ? { peerContext: parent } : {}) },
    { enabled: true, capability: () => capability,receipt }, async options => { captured = options; started.resolve(); await finished.promise; });
  try {
    await started.promise;
    await work({ input, access: captured.peerContext!, options: captured, stop: () => abort.abort(), capability, finish: finished.resolve });
  } finally { finished.resolve(); await run; }
}

function insert(input: CurrentTurnInput, text = "new information", beforeApply?: () => void) {
  const controller = new AbortController();
  let settled = false;
  const promise = input.insert(text, { turnId: "active", signal: controller.signal, beforeApply });
  void promise.then(() => { settled = true; }, () => { settled = true; });
  return { promise, controller, settled: () => settled };
}

test("current-turn input waits for exact native provider payload, not a hook offer", () => fixture(async state => {
  const operation = insert(state.input), point = boundary();
  const offered = await state.access.prepare(point);
  assert.equal(offered.messages.length, 1);
  assert.ok(offered.messages[0]!.content.endsWith("new information"));
  assert.equal(operation.settled(), false);
  const observation = { boundaryId: point.boundaryId, nativeSessionId: point.nativeSessionId,
    messageIds: [offered.messages[0]!.messageId], evidence: "context_hook" as const };
  state.access.observe(observation);
  await Promise.resolve();
  assert.equal(operation.settled(), false);
  state.access.observe({ ...observation, evidence: "provider_payload" });
  await operation.promise;
  assert.equal(operation.settled(), true);
  assert.equal((await state.access.prepare(boundary())).messages.length, 0);
}));

test("qualified native context requires a separate application confirmation, not a hook offer",()=>fixture(async state=>{
  state.capability.evidence="context_hook";
  const operation=insert(state.input),point={...boundary(),inputEvidence:"context_hook" as const},batch=await state.access.prepare(point);
  const observation={boundaryId:point.boundaryId,nativeSessionId:point.nativeSessionId,messageIds:batch.messages.map(value=>value.messageId)};
  state.access.authorize!({...observation,evidence:"context_hook"});
  state.access.observe({...observation,evidence:"context_hook"});await Promise.resolve();assert.equal(operation.settled(),false);
  assert.throws(()=>state.access.observe({...observation,evidence:"provider_payload"}),{appCode:"errCapabilityUnsupported"});
  const url=state.options.environment!.AGENT_PHONON_PEER_CONTEXT_URL!;
  const response=await fetch(url+"/context-applied",{method:"POST",headers:{Authorization:"Bearer "+state.options.environment!.AGENT_PHONON_PEER_CONTEXT_TOKEN,"Content-Type":"application/json"},body:JSON.stringify(observation)});
  assert.equal(response.status,200);await operation.promise;
},undefined,"native_context"));

test("ordinary weak transports cannot opt themselves into native-context application",()=>fixture(async state=>{
  const operation=insert(state.input),point=boundary(),batch=await state.access.prepare(point);
  assert.throws(()=>state.access.contextApplied!({boundaryId:point.boundaryId,nativeSessionId:point.nativeSessionId,messageIds:batch.messages.map(value=>value.messageId)}),{appCode:"errCapabilityUnsupported"});
  assert.equal(operation.settled(),false);operation.controller.abort();await assert.rejects(operation.promise);
}));

test("current-turn input uses its private local bridge without a coordination callback", () => fixture(async state => {
  const operation = insert(state.input), point = boundary();
  const url = state.options.environment!.AGENT_PHONON_PEER_CONTEXT_URL!;
  const headers = { Authorization: "Bearer " + state.options.environment!.AGENT_PHONON_PEER_CONTEXT_TOKEN!, "Content-Type": "application/json" };
  const response = await fetch(url, { method: "POST", headers, body: JSON.stringify(point) });
  assert.equal(response.status, 200);
  const batch = await response.json() as { messages: Array<{ messageId: string }> };
  const observed = await fetch(url + "/observe", { method: "POST", headers, body: JSON.stringify({ ...point,
    budget: undefined, messageIds: batch.messages.map(value => value.messageId), evidence: "provider_payload" }) });
  assert.equal(observed.status, 200);
  await operation.promise;
}));

test("pre-effect authorization is read-only and cannot settle an insertion", () => fixture(async state => {
  let checks=0;
  const operation=insert(state.input,"authorized input",()=>{checks++;}),point=boundary(),batch=await state.access.prepare(point);
  const observation={boundaryId:point.boundaryId,nativeSessionId:point.nativeSessionId,
    messageIds:batch.messages.map(value=>value.messageId),evidence:"provider_payload" as const};
  const url=state.options.environment!.AGENT_PHONON_PEER_CONTEXT_URL!;
  const headers={Authorization:"Bearer "+state.options.environment!.AGENT_PHONON_PEER_CONTEXT_TOKEN!,"Content-Type":"application/json"};
  const response=await fetch(url+"/authorize",{method:"POST",headers,body:JSON.stringify(observation)});
  assert.equal(response.status,200);assert.deepEqual(await response.json(),{authorized:true});
  assert.equal(checks,2);assert.equal(operation.settled(),false);
  state.access.observe(observation);await operation.promise;
}));

test("pre-effect authorization rejects withdrawn input without an applied receipt", () => fixture(async state => {
  let allowed=true;
  const operation=insert(state.input,"withdrawn",()=>{if(!allowed)throw new Error("revoked");}),point=boundary(),batch=await state.access.prepare(point);
  allowed=false;
  assert.throws(()=>state.access.authorize!({boundaryId:point.boundaryId,nativeSessionId:point.nativeSessionId,
    messageIds:batch.messages.map(value=>value.messageId),evidence:"provider_payload"}),/revoked/);
  await assert.rejects(operation.promise,/revoked/);
}));

test("a weak per-request transport cannot receive or acknowledge ordinary input", () => fixture(async state => {
  const operation=insert(state.input),point={...boundary(),inputEvidence:"context_hook" as const};
  assert.equal((await state.access.prepare(point)).messages.length,0);
  await assert.rejects(operation.promise,{appCode:"errCapabilityUnsupported"});
  await assert.rejects(insert(state.input).promise,{appCode:"errCapabilityUnsupported"});
  await state.access.prepare({...boundary(),inputEvidence:"provider_payload"});
  const eligible=insert(state.input),next=boundary(),batch=await state.access.prepare(next);
  state.access.authorize!({boundaryId:next.boundaryId,nativeSessionId:next.nativeSessionId,
    messageIds:batch.messages.map(value=>value.messageId),evidence:"provider_payload"});
  assert.equal(eligible.settled(),false);
  state.access.observe({boundaryId:next.boundaryId,nativeSessionId:next.nativeSessionId,
    messageIds:batch.messages.map(value=>value.messageId),evidence:"provider_payload"});
  await eligible.promise;
}));

test("wrong native identities, turns and unoffered observations cannot acknowledge insertion", () => fixture(async state => {
  await assert.rejects(state.input.insert("wrong turn", { turnId: "other", signal: new AbortController().signal }), { appCode: "errSessionBusy" });
  const operation = insert(state.input), point = boundary();
  await assert.rejects(state.access.prepare({ ...point, nativeSessionId: "child" }), { appCode: "errSessionBusy" });
  const batch = await state.access.prepare(point);
  const observation = { boundaryId: point.boundaryId, nativeSessionId: point.nativeSessionId,
    messageIds: [batch.messages[0]!.messageId], evidence: "provider_payload" as const };
  assert.throws(() => state.access.observe({ ...observation, boundaryId: randomUUID() }));
  assert.throws(() => state.access.observe({ ...observation, nativeSessionId: "child" }));
  assert.throws(() => state.access.observe({ ...observation, messageIds: [randomUUID()] }));
  assert.equal(operation.settled(), false);
  state.access.observe(observation);
  await operation.promise;
  state.access.authorize!(observation);
  const next=boundary();await state.access.prepare(next);
  assert.throws(()=>state.access.authorize!({...observation,boundaryId:next.boundaryId}),{appCode:"errSessionBusy"});
  assert.throws(()=>state.access.observe({...observation,boundaryId:next.boundaryId}),{appCode:"errSessionBusy"});
}));

test("identical concurrent insertions keep independent native observations", () => fixture(async state => {
  const first = insert(state.input, "same"), second = insert(state.input, "same"), point = boundary();
  const batch = await state.access.prepare(point);
  assert.equal(batch.messages.length, 2);
  assert.notEqual(batch.messages[0]!.messageId, batch.messages[1]!.messageId);
  state.access.observe({ boundaryId: point.boundaryId, nativeSessionId: point.nativeSessionId,
    messageIds: [batch.messages[0]!.messageId], evidence: "provider_payload" });
  await first.promise;
  assert.equal(second.settled(), false);
  state.access.observe({ boundaryId: point.boundaryId, nativeSessionId: point.nativeSessionId,
    messageIds: [batch.messages[1]!.messageId], evidence: "provider_payload" });
  await second.promise;
}));

for (const mode of ["unknown", "exhausted", "missing"] as const) test(`native ${mode} headroom cannot admit current-turn input`, () => fixture(async state => {
  const operation = insert(state.input), point = boundary();
  const budget = mode === "unknown" ? { state: "unknown" as const, source: "native_estimate" as const }
    : mode === "missing" ? undefined : { ...point.budget!, state: "known" as const, source: "native_estimate" as const,
      contextWindowTokens: 4096, inputTokens: 4000, outputTokens: 2048, overheadTokens: 1024 };
  assert.equal((await state.access.prepare({ ...point, budget })).messages.length, 0);
  assert.equal(operation.settled(), false);
  operation.controller.abort();
  await assert.rejects(operation.promise, { appCode: "errSessionBusy" });
}));

test("cancelled input is removed before the next native boundary", () => fixture(async state => {
  const operation = insert(state.input);
  operation.controller.abort();
  await assert.rejects(operation.promise, { appCode: "errSessionBusy" });
  assert.equal((await state.access.prepare(boundary())).messages.length, 0);
}));

test("cancellation after a native offer still denies application before the provider call", () => fixture(async state => {
  const operation = insert(state.input), point = boundary(), batch = await state.access.prepare(point);
  operation.controller.abort();
  await assert.rejects(operation.promise, { appCode: "errSessionBusy" });
  assert.throws(() => state.access.observe({ boundaryId: point.boundaryId, nativeSessionId: point.nativeSessionId,
    messageIds: batch.messages.map(value => value.messageId), evidence: "provider_payload" }), { appCode: "errSessionBusy" });
}));

test("turn cancellation and native final events reject all unconfirmed inputs", async () => {
  for (const final of [false, true]) await fixture(async state => {
    const operation = insert(state.input);
    await state.access.prepare(boundary());
    if (final) state.options.emit({ type: "result", sessionId: "session", turnId: "active", seq: 0,
      at: new Date().toISOString(), status: "completed", text: "done", final: true } as never);
    else state.stop();
    await assert.rejects(operation.promise, { appCode: "errSessionBusy" });
    await assert.rejects(state.access.prepare(boundary()), { appCode: "errSessionBusy" });
  });
});

test("ordinary input cannot be acknowledged by a context-hook-only binding", () => fixture(async state => {
  state.capability.evidence = "context_hook";
  await assert.rejects(insert(state.input).promise, { appCode: "errCapabilityUnsupported" });
}));

test("authority is revalidated at the native effect, not only input admission", () => fixture(async state => {
  let allowed = true;
  const operation = insert(state.input, "revoked", () => { if (!allowed) throw new Error("source revoked"); });
  allowed = false;
  assert.equal((await state.access.prepare(boundary())).messages.length, 0);
  await assert.rejects(operation.promise, /source revoked/);
}));

test("withdrawn input denies its native payload receipt instead of acknowledging a later effect", () => fixture(async state => {
  let allowed = true;
  const operation = insert(state.input, "withdrawn before provider", () => { if (!allowed) throw new Error("source revoked"); });
  const point = boundary(), batch = await state.access.prepare(point);
  allowed = false;
  assert.throws(() => state.access.observe({ boundaryId: point.boundaryId, nativeSessionId: point.nativeSessionId,
    messageIds: batch.messages.map(value => value.messageId), evidence: "provider_payload" }), /source revoked/);
  await assert.rejects(operation.promise, /source revoked/);
}));

test("an asynchronous peer read cannot carry revoked input into a native request", async () => {
  const entered = deferred(), release = deferred();
  let allowed = true;
  const parent: PeerContextAccess = { async prepare(point) { entered.resolve(); await release.promise; return { ...point, messages: [], deferred: [] }; }, observe() {} };
  await fixture(async state => {
    const operation = insert(state.input, "revoked while waiting", () => { if (!allowed) throw new Error("source revoked"); });
    const prepare = state.access.prepare(boundary());
    try { await entered.promise; allowed = false; }
    finally { release.resolve(); }
    assert.equal((await prepare).messages.length, 0);
    await assert.rejects(operation.promise, /source revoked/);
  }, parent);
});

test("peer observations retain their own source receipts and do not acknowledge ordinary input", async () => {
  const id = randomUUID(), seen: string[][] = [];
  const parent: PeerContextAccess = { async prepare(point) { return { ...point, messages: [{ messageId: id, content: "peer data" }], deferred: [] }; },
    observe(value) { seen.push(value.messageIds); } };
  await fixture(async state => {
    const operation = insert(state.input), point = boundary(), batch = await state.access.prepare(point);
    state.access.observe({ boundaryId: point.boundaryId, nativeSessionId: point.nativeSessionId, messageIds: [id], evidence: "provider_payload" });
    assert.deepEqual(seen, [[id]]);
    assert.equal(operation.settled(), false);
    state.access.observe({ boundaryId: point.boundaryId, nativeSessionId: point.nativeSessionId,
      messageIds: [batch.messages.find(value => value.messageId !== id)!.messageId], evidence: "provider_payload" });
    await operation.promise;
    assert.deepEqual(seen, [[id]]);
  }, parent);
});

test("a full peer batch is preserved instead of dropping already journaled mail", async () => {
  const messages = Array.from({ length: 8 }, () => ({ messageId: randomUUID(), content: "peer" }));
  await fixture(async state => {
    const operation = insert(state.input), batch = await state.access.prepare(boundary());
    assert.deepEqual(batch.messages, messages);
    assert.equal(operation.settled(), false);
    operation.controller.abort();
    await assert.rejects(operation.promise);
  }, { async prepare(point) { return { ...point, messages, deferred: [] }; }, observe() {} });
});

test("turn settlement closes the private bridge and never retains input for a future turn", async () => {
  let input!: CurrentTurnInput, url = "";
  await fixture(async state => {
    input = state.input;
    url = state.options.environment!.AGENT_PHONON_PEER_CONTEXT_URL!;
    const operation = insert(state.input);
    state.finish();
    await assert.rejects(operation.promise, { appCode: "errSessionBusy" });
  });
  await assert.rejects(fetch(url));
  await assert.rejects(insert(input).promise, { appCode: "errCapabilityUnsupported" });
  await input.run({ turnId: "next", verbosity: "tools", emit() {} }, { enabled: true, capability: () => ({
    mode: "context_hook", boundary: "before_model", visibility: "hidden", evidence: "provider_payload", nativeSessionId: "native-root" }) },
  async options => { assert.equal((await options.peerContext!.prepare(boundary())).messages.length, 0); });
});

test("oversized and unbounded input batches are rejected without allocating a later turn", () => fixture(async state => {
  await assert.rejects(insert(state.input, "x".repeat(16000)).promise, { appCode: "errInvalidParams" });
  const pending = Array.from({ length: 32 }, () => insert(state.input, "bounded"));
  await assert.rejects(insert(state.input).promise, { appCode: "errSessionBusy" });
  state.stop();
  await Promise.all(pending.map(value => assert.rejects(value.promise, { appCode: "errSessionBusy" })));
}));
