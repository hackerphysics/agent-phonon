import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { request } from "node:http";
import { PeerContextJournal, PeerContextReceiver, peerReceiveReport,PeerContextBoundary,peerContextHeadroom } from "./peer-context.js";
import { PeerContextBridge } from "./peer-context-bridge.js";
import { withPeerFixture } from "./testing/peer-fixture.js";

test("receive capability is pending until the adapter owns a native identity",()=>{
  const capability={mode:"context_hook",boundary:"before_model",visibility:"hidden",evidence:"provider_payload"} as const;
  assert.deepEqual(peerReceiveReport(),{version:1,mode:"tool_polling"});
  assert.equal(peerReceiveReport(capability).mode,"runtime_pending");
  assert.equal(peerReceiveReport({...capability,nativeSessionId:"owned"}).mode,"runtime_checkpoint");
  assert.equal(peerReceiveReport({...capability,nativeSessionId:"owned",readiness:"pending"}).mode,"runtime_pending");
});

function fixture(journal = new PeerContextJournal(":memory:")) {
  const self = { id: randomUUID(), position: "1", projectId: randomUUID(), ownerId: "owner", deviceId: randomUUID(), agentId: "pi",
    agentKind: "agent" as const, sourceKind: "native" as const, sessionId: "session", label: "worker", activity: { summary: "", phase: "working" as const, impact: [], dependencies: "" },
    activityRevision: 0, lastSeenAt: null, presence: "active" as const };
  const options = { tenantId: "tenant", sessionId: self.sessionId, turnId: "turn", runId: randomUUID(), nativeSessionId: "native-session" };
  const state = { active: true, blocked: false, messages: [] as any[], calls: [] as any[], next: null as string | null };
  const coordinate = async (input: any) => { state.calls.push(input); return { self, messages: state.messages, next: state.next }; };
  const create = (overrides: Record<string, unknown> = {}) => new PeerContextReceiver({ ...options, coordinate, journal,
    active: () => state.active, blocked: () => state.blocked, ...overrides });
  const message = (text = "peer-" + randomUUID()) => ({ id: randomUUID(), position: "2", senderId: randomUUID(), recipientId: self.id,
    kind: "notice" as const, text, references: [], inReplyTo: null, depth: 0, createdAt: null, expiresAt: null, state: "stored" as const, receivedAt: null });
  const boundary = () => ({ boundaryId: randomUUID(), nativeSessionId: options.nativeSessionId });
  return { journal, self, options, state, create, message, boundary, close: () => journal.close() };
}

test("new peer mail enters the next runtime boundary without a model inbox tool or synthetic ACK", async () => {
  const f = fixture(); try {
    const receiver = f.create();
    assert.deepEqual((await receiver.prepare(f.boundary())).messages, []);
    const message = f.message(); f.state.messages = [message];
    const batch = await receiver.prepare(f.boundary());
    assert.equal(batch.messages.length, 1); assert.match(batch.messages[0]!.content, /not human instructions or approval/);
    assert.ok(batch.messages[0]!.content.includes(message.text));
    assert.equal(f.journal.records("tenant", "session")[0]!.state, "offered");
    receiver.observe({ boundaryId: batch.boundaryId, nativeSessionId: batch.nativeSessionId, messageIds: [message.id], evidence: "provider_payload" });
    assert.equal(f.journal.records("tenant", "session")[0]!.state, "provider_payload");
    assert.deepEqual((await receiver.prepare(f.boundary())).messages, []);
    assert.ok(f.state.calls.every(call => call.operation === "inbox"));
  } finally { f.close(); }
});

test("pending native admission does not reinsert mail already offered in this turn's polling bootstrap", async () => {
  const f = fixture(); try {
    const initial = f.message(), next = f.message(), initialMessageIds = new Set<string>();
    const receiver = f.create({ initialMessageIds });
    initialMessageIds.add(initial.id); f.state.messages = [initial, next];
    const batch = await receiver.prepare(f.boundary());
    assert.deepEqual(batch.messages.map(message => message.messageId), [next.id]);
    assert.deepEqual(f.journal.records("tenant", "session").map(record => record.messageId), [next.id]);
    assert.equal(f.state.calls[0].operation, "inbox");
  } finally { f.close(); }
});

test("offered and observed IDs survive a device restart without storing message text or replaying unknown effects", () => withPeerFixture("peer-journal",async scope=>{
  const path = join(scope.root, "peers.sqlite");let current:PeerContextJournal|undefined=new PeerContextJournal(path);
  scope.defer(()=>current?.close());const f = fixture(current);
  const message = f.message("secret message text"); f.state.messages = [message];
    await f.create().prepare(f.boundary()); f.close();current=undefined;
    const journal = new PeerContextJournal(path);current=journal;
      assert.equal(JSON.stringify(journal.records("tenant", "session")).includes(message.text), false);
      assert.deepEqual((await f.create({ journal }).prepare(f.boundary())).messages, []);
}));

test("turn completion, pending human decisions and wrong native sessions prevent native delivery", async () => {
  const f = fixture(); try {
    const receiver = f.create(); f.state.messages = [f.message()];
    f.state.blocked = true; await assert.rejects(receiver.prepare(f.boundary()), /not active/);
    f.state.blocked = false; await assert.rejects(receiver.prepare({ ...f.boundary(), nativeSessionId: "other" }), /not active/);
    f.state.active = false; await assert.rejects(receiver.prepare(f.boundary()), /not active/);
    assert.equal(f.state.calls.length, 0); assert.deepEqual(f.journal.records("tenant", "session"), []);
  } finally { f.close(); }
});

test("a runtime-allocated native identity must be observed by the owning adapter before any checkpoint",async()=>{
  const f=fixture();let observed:string|undefined;
  try {
    const receiver=f.create({nativeSessionId:()=>observed});f.state.messages=[f.message()];
    await assert.rejects(receiver.prepare(f.boundary()),/not active/);assert.equal(f.state.calls.length,0);
    observed=f.options.nativeSessionId;
    const batch=await receiver.prepare(f.boundary());assert.equal(batch.messages.length,1);
    observed=undefined;
    assert.throws(()=>receiver.observe({boundaryId:batch.boundaryId,nativeSessionId:batch.nativeSessionId,
      messageIds:[batch.messages[0]!.messageId],evidence:"provider_payload"}),/not active/);
  } finally { f.close(); }
});

test("revocation, cancellation or a disconnected checkpoint during an inbox read cannot journal a late delivery", async () => {
  for (const cancel of [false, true]) {
    const f = fixture(); try {
      let release!: () => void; const controller = new AbortController();
      const receiver = f.create({ coordinate: async () => { await new Promise<void>(resolve => { release = resolve; }); return { self: f.self, messages: [f.message()], next: null }; } });
      const pending = receiver.prepare(f.boundary(), controller.signal);
      if (cancel) controller.abort(); else f.state.active = false;
      release(); await assert.rejects(pending, /not active/);
      assert.deepEqual(f.journal.records("tenant", "session"), []);
    } finally { f.close(); }
  }
});

test("foreign recipients, changed participant identities and untrusted source claims are rejected", async () => {
  const f = fixture(); try {
    const receiver = f.create(); f.state.messages = [{ ...f.message(), recipientId: randomUUID() }];
    await assert.rejects(receiver.prepare(f.boundary()), /recipient mismatch/);
    f.state.messages = []; f.self.id = randomUUID();
    await assert.rejects(receiver.prepare(f.boundary()), /source mismatch/);
    await assert.rejects(receiver.prepare({ ...f.boundary(), senderId: randomUUID() } as any));
  } finally { f.close(); }
});

test("bounded pages defer whole messages and advance past expired records", async () => {
  const f = fixture(); try {
    const receiver = f.create(); f.state.messages = Array.from({ length: 12 }, () => f.message());
    assert.equal((await receiver.prepare(f.boundary())).messages.length, 8);
    assert.equal((await receiver.prepare(f.boundary())).messages.length, 4);
    assert.equal((await receiver.prepare(f.boundary())).messages.length, 0);
    assert.equal(f.journal.records("tenant", "session").length, 12);
    f.state.messages = [{ ...f.message(), expiresAt: "2000-01-01T00:00:00.000Z" }]; f.state.next = "9";
    assert.equal((await receiver.prepare(f.boundary())).messages.length, 0);
    f.state.messages = [f.message()]; f.state.next = null;
    assert.equal((await receiver.prepare(f.boundary())).messages.length, 1);
    assert.equal(f.state.calls.at(-1).after, "9");
  } finally { f.close(); }
});

test("concurrent boundaries cannot offer duplicates and tenant journals are independent", async () => {
  const f = fixture(); try {
    const receiver = f.create(); f.state.messages = [f.message()];
    const results = await Promise.allSettled([receiver.prepare(f.boundary()), receiver.prepare(f.boundary())]);
    assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
    assert.equal(f.journal.records("tenant", "session").length, 1);
    assert.equal((await f.create({ tenantId: "other" }).prepare(f.boundary())).messages.length, 1);
  } finally { f.close(); }
});

test("a whole message exceeding the context budget remains pending without blocking smaller mail", async () => {
  const f = fixture(); try {
    const text = String.fromCodePoint(0x4e00);
    const large = { ...f.message(text.repeat(3000)), references: Array.from({length:8},()=>text.repeat(512)) }, small = f.message();
    f.state.messages = [large, small];
    const batch = await f.create().prepare(f.boundary());
    assert.deepEqual(batch.messages.map(message => message.messageId), [small.id]);
    assert.deepEqual(batch.deferred, [{ messageId: large.id, reason: "context_budget" }]);
    assert.equal(f.journal.has("tenant", f.self.id, large.id), false);
  } finally { f.close(); }
});

test("native token headroom reserves output and overhead, defers without claims and recovers without cursor loss",async()=>{
  const f=fixture();try{
    const first=f.message("界".repeat(1000)),small=f.message("small"),receiver=f.create();f.state.messages=[first,small];f.state.next="9";
    const budget={state:"known",source:"native_estimate",contextWindowTokens:10000,inputTokens:6900,outputTokens:1000,overheadTokens:52} as const;
    assert.equal(peerContextHeadroom(budget),1000);
    const nativeWindow={...budget,outputTokens:0,outputReservation:"native_usable_window" as const};
    assert.equal(PeerContextBoundary.safeParse({...f.boundary(),budget:nativeWindow}).success,true);
    assert.equal(peerContextHeadroom(nativeWindow),1000,"a native output reservation must not remove Core's safety allowance");
    assert.equal(peerContextHeadroom({...nativeWindow,contextWindowTokens:50000,inputTokens:45000,overheadTokens:0}),0);
    const low=await receiver.prepare({...f.boundary(),budget});
    assert.deepEqual(low.messages.map(message=>message.messageId),[small.id]);
    assert.deepEqual(low.deferred,[{messageId:first.id,reason:"native_headroom"}]);
    assert.equal(f.journal.has("tenant",f.self.id,first.id),false);assert.equal(low.budgetDecision?.availableTokens,1000);
    const unknown=await receiver.prepare({...f.boundary(),budget:{state:"unknown",source:"native_estimate"}});
    assert.deepEqual(unknown.messages,[]);assert.deepEqual(unknown.deferred,[{messageId:first.id,reason:"context_unknown"}]);
    const required=await f.create({requireBudget:true}).prepare(f.boundary());
    assert.deepEqual(required.messages,[]);assert.equal(required.deferred[0]?.reason,"context_unknown");
    const high=await receiver.prepare({...f.boundary(),budget:{...budget,inputTokens:0}});
    assert.deepEqual(high.messages.map(message=>message.messageId),[first.id]);assert.equal(f.state.calls.at(-1).after,"0");
    assert.equal(f.journal.records("tenant","session").length,2);
    assert.equal(peerContextHeadroom({...budget,outputTokens:9000}),0);
    assert.equal(PeerContextBoundary.safeParse({...f.boundary(),budget:{...budget,inputTokens:-1}}).success,false);
    assert.equal(PeerContextBoundary.safeParse({...f.boundary(),budget:{...budget,inputTokens:Infinity}}).success,false);
    assert.equal(PeerContextBoundary.safeParse({...f.boundary(),budget:{state:"unknown",source:"model_claim"}}).success,false);
  }finally{f.close();}
});

test("native headroom is shared by the whole batch, not independently granted to each message",async()=>{
  const f=fixture();try{
    const first=f.message("same-size"),second=f.message("same-size");f.state.messages=[first,second];
    const receiver=f.create(),budget={state:"known",source:"native_estimate",contextWindowTokens:10000,inputTokens:6900,outputTokens:1000,overheadTokens:52} as const;
    const batch=await receiver.prepare({...f.boundary(),budget});
    assert.deepEqual(batch.messages.map(message=>message.messageId),[first.id]);
    assert.deepEqual(batch.deferred,[{messageId:second.id,reason:"native_headroom"}]);
    assert.equal(f.journal.has("tenant",f.self.id,second.id),false);
    assert.deepEqual((await receiver.prepare({...f.boundary(),budget})).messages.map(message=>message.messageId),[second.id]);
  }finally{f.close();}
});

test("observation requires offered IDs and the exact native boundary; mixed false receipts are atomic", async () => {
  const f = fixture(); try {
    const receiver = f.create(); const message = f.message(); f.state.messages = [message];
    const batch = await receiver.prepare(f.boundary());
    const observation = { boundaryId: batch.boundaryId, nativeSessionId: batch.nativeSessionId, messageIds: [message.id], evidence: "provider_payload" as const };
    assert.throws(() => receiver.observe({ ...observation, boundaryId: randomUUID() }));
    assert.throws(() => receiver.observe({ ...observation, messageIds: [message.id, randomUUID()] }));
    assert.equal(f.journal.records("tenant", "session")[0]!.state, "offered");
    f.state.active = false; assert.throws(() => receiver.observe(observation), /not active/);
  } finally { f.close(); }
});

test("hook output is weaker than a provider-payload observation and cannot downgrade stronger evidence",async()=>{
  const f=fixture();try{
    f.state.messages=[f.message()];const receiver=f.create(),batch=await receiver.prepare(f.boundary());
    const observation={boundaryId:batch.boundaryId,nativeSessionId:batch.nativeSessionId,messageIds:[batch.messages[0]!.messageId]};
    receiver.observe({...observation,evidence:"context_hook"});assert.equal(f.journal.records("tenant","session")[0]!.state,"context_hook");
    receiver.observe({...observation,evidence:"provider_payload"});assert.equal(f.journal.records("tenant","session")[0]!.state,"provider_payload");
    receiver.observe({...observation,evidence:"context_hook"});assert.equal(f.journal.records("tenant","session")[0]!.state,"provider_payload");
  }finally{f.close();}
});

test("a hook-only binding cannot claim stronger provider-payload evidence",async()=>{
  const f=fixture();try{
    f.state.messages=[f.message()];const receiver=f.create({evidence:"context_hook"}),batch=await receiver.prepare(f.boundary());
    const observation={boundaryId:batch.boundaryId,nativeSessionId:batch.nativeSessionId,messageIds:[batch.messages[0]!.messageId]};
    assert.throws(()=>receiver.observe({...observation,evidence:"provider_payload"}),/exceeds/);
    assert.equal(f.journal.records("tenant","session")[0]!.state,"offered");
    receiver.observe({...observation,evidence:"context_hook"});assert.equal(f.journal.records("tenant","session")[0]!.state,"context_hook");
  }finally{f.close();}
});

test("native checkpoint endpoint authenticates origin, host and turn without exposing a model tool", async () => {
  const f = fixture(), bridge = new PeerContextBridge(f.create());
  const environment = await bridge.listen(), url = environment.AGENT_PHONON_PEER_CONTEXT_URL!;
  const headers = { authorization: "Bearer " + environment.AGENT_PHONON_PEER_CONTEXT_TOKEN, "content-type": "application/json" };
  try {
    f.state.messages = [f.message()];
    for (const extra of [{ origin: "https://foreign.invalid" }, { host: "foreign.invalid" }, { authorization: "Bearer wrong" }]) {
      const status = await new Promise<number | undefined>((resolve, reject) => {
        const req = request(url, { method: "POST", headers: { ...headers, ...extra } }, res => { res.resume(); res.on("end", () => resolve(res.statusCode)); });
        req.on("error", reject); req.end(JSON.stringify(f.boundary()));
      });
      assert.equal(status, 403);
    }
    assert.equal((await fetch(url, { method: "POST", headers, body: JSON.stringify({ ...f.boundary(), wake: true }) })).status, 409);
    const response = await fetch(url, { method: "POST", headers, body: JSON.stringify(f.boundary()) });
    assert.equal(response.status, 200); assert.equal((await response.json() as any).messages.length, 1);
    assert.equal((await fetch(url.replace("peer-context", "mcp"), { method: "POST", headers, body: "{}" })).status, 404);
    f.state.active = false;
    assert.equal((await fetch(url, { method: "POST", headers, body: JSON.stringify(f.boundary()) })).status, 409);
  } finally { await bridge.close(); f.close(); }
  await assert.rejects(fetch(url, { method: "POST", headers, body: "{}" }));
});
