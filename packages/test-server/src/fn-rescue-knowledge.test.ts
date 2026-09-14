import { test } from "node:test";
import assert from "node:assert/strict";
import { queryRescueKnowledge, rescueKnowledgeQuerySchema } from "../../core/dist/rescue-knowledge.js";
import { RescueAdapter } from "@agent-phonon/core";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

// A source-only copy must pass without private acceptance or installed dependencies.
test("knowledge generator is self-contained and rejects missing, changed or misattributed public evidence", () => {
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  const sandbox = mkdtempSync(join(tmpdir(), "phonon-knowledge-provenance-"));
  const manifestPath = "packages/core/src/rescue-knowledge-manifest.json";
  const manifest = JSON.parse(readFileSync(join(root, manifestPath), "utf8"));
  const evidence = manifest.entries[0].evidence[0];
  const evidencePath = evidence.path;
  const files = new Set<string>([
    manifestPath, manifest.authoring.source, "packages/core/src/rescue-knowledge-data.ts",
    "scripts/generate-rescue-knowledge.mjs",
    ...manifest.entries.flatMap((e: any) => e.evidence.map((v: any) => v.path)),
  ]);
  const put = (path: string, content: string | Buffer) => {
    mkdirSync(dirname(join(sandbox, path)), { recursive: true });
    writeFileSync(join(sandbox, path), content);
  };
  const run = () => spawnSync(process.execPath, ["scripts/generate-rescue-knowledge.mjs", "--check"], {
    cwd: sandbox, encoding: "utf8", timeout: 10_000,
    env: { PATH: process.env.PATH, HOME: sandbox, NO_COLOR: "1" },
  });
  const reject = (pattern: RegExp) => {
    const result = run();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, pattern);
  };
  try {
    for (const path of files) put(path, readFileSync(join(root, path)));
    assert.equal(existsSync(join(sandbox, "acceptance")), false);
    const valid = run();
    assert.equal(valid.status, 0, valid.stderr);
    const original = readFileSync(join(sandbox, evidencePath), "utf8");
    put(evidencePath, original + "\n");
    reject(/Evidence revision changed/);
    rmSync(join(sandbox, evidencePath));
    reject(/ENOENT/);
    put(evidencePath, original);
    evidence.path = "acceptance/private/REPORT.zh-CN.md";
    put(manifestPath, JSON.stringify(manifest));
    reject(/bundled public artifact/);
    evidence.path = evidencePath;
    const projection = JSON.parse(original);
    projection.source.sha256 = "0".repeat(64);
    const wrong = JSON.stringify(projection);
    put(evidencePath, wrong);
    evidence.sha256 = createHash("sha256").update(wrong).digest("hex");
    put(manifestPath, JSON.stringify(manifest));
    reject(/Public excerpt provenance mismatch/);
    // Re-pinning the wrapper must not bless a changed historical patch.
    for (const path of files) put(path, readFileSync(join(root, path)));
    const patchManifest = JSON.parse(readFileSync(join(root, manifestPath), "utf8"));
    const patchEntry = patchManifest.entries.flatMap((e: any) => e.evidence)
      .find((e: any) => e.original.kind === "exact-public-patch");
    const patchProjection = JSON.parse(readFileSync(join(sandbox, patchEntry.path), "utf8"));
    patchProjection.patch += "\n";
    const changedPatch = JSON.stringify(patchProjection);
    put(patchEntry.path, changedPatch);
    patchEntry.sha256 = createHash("sha256").update(changedPatch).digest("hex");
    put(manifestPath, JSON.stringify(patchManifest));
    reject(/Public patch must preserve original bytes/);
  } finally { rmSync(sandbox, { recursive: true, force: true }); }
});

const context = { agent: "opencode", version: "1.14.48", platform: "linux", protocol: "chat" as const };
test("knowledge index is bounded, lazy, versioned and secret/host independent", () => {
  const list = queryRescueKnowledge({ action: "list" });
  assert.equal(list.entries.length, 7);
  for (const e of list.entries) {
    assert.equal("body" in e, false);
    assert.match(e.revision, /^sha256:[a-f0-9]{64}$/);
    assert.ok(e.evidence.every(v => v.path.startsWith("docs/rescue-evidence/") && v.sha256.length === 64
      && v.original.path.startsWith("acceptance/") && v.original.sha256.length === 64));
    assert.equal(e.applicable, false);
  }
  assert.equal(queryRescueKnowledge({ action: "list", limit: 1 }).entries.length, 1);
  const loaded = queryRescueKnowledge({ action: "get", id: "opencode-custom-provider", ...context });
  assert.equal(loaded.entries[0]?.applicable, true);
  assert.match(JSON.stringify(loaded), /@ai-sdk\/openai-compatible/);
  assert.doesNotMatch(JSON.stringify(loaded), /\/home\/|\/Users\/|qwen3\.8|gpt-5\.6|127\.0\.0\.1:4000/);
});

test("knowledge incompatible agents/versions/platforms/protocols never receive a procedure", () => {
  assert.equal(queryRescueKnowledge({ action: "search", agent: "unknown-agent", text: "provider" }).entries.length, 0);
  for (const override of [{version:"99.0.0"}, {platform:"darwin"}, {platform:"win32"}, {protocol:"gemini" as const}, {agent:"hermes"}, {version:undefined}]) {
    const q = queryRescueKnowledge({action:"get",id:"opencode-custom-provider",...context,...override});
    assert.ok(q.entries.every(e => !e.applicable && !("body" in e) && !("steps" in e)));
  }
  assert.equal(queryRescueKnowledge({action:"get",id:"../../policy",...context}).entries.length,0);
  assert.equal(queryRescueKnowledge({action:"search",...context,text:"ProviderModelNotFound"}).entries[0]?.id,"opencode-custom-provider");
});

test("only exact observed native version display aliases are accepted", () => {
  for (const version of ["0.16.0", "v0.16.0", "Hermes Agent v0.16.0 (2026.6.5) · upstream c6b0eb4d"]) {
    const q = queryRescueKnowledge({action:"get",id:"hermes-named-provider",agent:"hermes",version,platform:"linux",protocol:"chat"});
    assert.equal(q.entries[0]?.applicable,true);
  }
  for (const version of ["0.16.0-rc.1", "Hermes Agent v0.16.0 (unknown build)", "not Hermes 0.16.0", "99.0.0"]) {
    const q = queryRescueKnowledge({action:"get",id:"hermes-named-provider",agent:"hermes",version,platform:"linux",protocol:"chat"});
    assert.equal(q.entries[0]?.applicable,false);assert.equal("body" in q.entries[0]!,false);
  }
});

test("knowledge result mutation cannot poison the next cold session and extra capabilities rejected", () => {
  const q = queryRescueKnowledge({action:"get", id:"opencode-custom-provider", ...context});
  (q.entries[0]!.agents as unknown as string[]).splice(0);
  assert.equal(queryRescueKnowledge({action:"get", id:"opencode-custom-provider", ...context}).entries[0]?.applicable,true);
  for (const data of [{action:"write"}, {action:"get",path:"/etc/passwd"}, {action:"list",limit:999}, {action:"search",text:"x".repeat(501)}]) {
    assert.equal(rescueKnowledgeQuerySchema.safeParse(data).success,false);
  }
});

test("knowledge accurately limits Codex/Copilot evidence and stopped GPT service", () => {
  const boundary = queryRescueKnowledge({action:"get",id:"codex-copilot-boundaries",agent:"codex",version:"unknown",platform:"linux"});
  assert.equal(boundary.entries[0]?.kind,"boundary-only");
  assert.match(JSON.stringify(boundary), /needs-version-validation/);
  const gpt = queryRescueKnowledge({action:"get",id:"claude-responses-final-items",agent:"claude-code",version:"2.1.123",platform:"linux",protocol:"responses"});
  assert.match(JSON.stringify(gpt), /stopped after acceptance/);
  assert.match(JSON.stringify(gpt), /cannot install\/start/);
  assert.match(JSON.stringify(gpt), /75fcf0df/);
});

test("SIMULATED official Responses SDK carries knowledge ID/revision result by same call ID in a fresh adapter", async () => {
  const {createServer}=await import("node:http");
  let requests=0; let replay=false;
  const server=createServer(async(req,res)=>{
    let text="";for await(const c of req)text+=c;const body=JSON.parse(text);requests++;
    assert.equal(req.headers.authorization,undefined);
    assert.ok(body.tools.some((t:any)=>t.name==="query_knowledge"));
    if(requests===1){
      const instructions = body.instructions ?? JSON.stringify(body.input.filter((i:any) => i.role === "system" || i.role === "developer"));
      assert.match(instructions,/query_knowledge/);
      assert.doesNotMatch(instructions,/providers\.<user-selected-id>\.api/);
      res.writeHead(200,{"content-type":"application/json"});
      res.end(JSON.stringify({id:"sim1",output:[{type:"function_call",id:"item1",call_id:"knowledge-call",name:"query_knowledge",arguments:JSON.stringify({action:"get",id:"opencode-custom-provider",...context})}]}));
    }else{
      const result=body.input.find((i:any)=>i.type==="function_call_output"&&i.call_id==="knowledge-call");
      const data=JSON.parse(result.output);assert.match(data.entries[0].revision,/^sha256:/);assert.ok(data.entries[0].body);replay=true;
      res.writeHead(200,{"content-type":"application/json"});res.end(JSON.stringify({id:"sim2",output:[{type:"message",id:"m",role:"assistant",content:[{type:"output_text",text:"Knowledge retrieved; no repair executed.",annotations:[]}]}]}));
    }
  });
  await new Promise<void>(r=>server.listen(0,"127.0.0.1",r));
  const {port}=server.address() as {port:number};
  const denied=async()=>{throw Error("policy denied")};
  const maintenance:any={targets:denied,diagnose:denied,configGet:denied,configPatch:denied,configEdit:denied,rollback:denied,packageUpdate:denied,serviceStatus:denied,serviceRestart:denied};
  const session=await new RescueAdapter({baseUrl:`http://127.0.0.1:${port}/v1`,authMode:"none",wireApi:"responses",defaultModel:"mock",maxSteps:3,timeoutMs:5000}).createSession({sessionId:"fresh-knowledge",agentId:"phonon-rescue",model:"mock",cwd:".",runtimeContext:{maintenance}});
  const events:any[]=[];
  try {
    await session.send("A fresh simulated knowledge lookup",{turnId:"t",verbosity:"tools",emit:e=>events.push(e)});
    assert.equal(replay,true);assert.equal(requests,2);
    assert.equal(events.find(e=>e.type==="tool_result").toolCallId,"knowledge-call");
    assert.ok(events.find(e=>e.type==="result"));
  } finally {await session.terminate();await new Promise<void>(r=>server.close(()=>r()));}
});


test("knowledge pack 2026.09.14.1 preserves native version, old npm, and unreleased daemon implementation boundaries", () => {
  for (const [id, agent, version, protocol] of [
    ["claude-native-messages", "claude-code", "2.1.123", "anthropic"],
    ["hermes-named-provider", "hermes", "0.16.0", "chat"],
  ] as const) {
    const q = queryRescueKnowledge({ action: "get", id, agent, version, platform: "linux", protocol });
    assert.equal(q.packVersion, "2026.09.14.1");
    const body = (q.entries[0] as { body?: string }).body!;
    assert.match(body, /adapter-fixes-20260909-192727/);
    assert.match(body, /0\.9\.1 alone/);
    assert.ok(q.entries[0]!.evidence.some(e => e.level === "unreleased-implementation-revision-not-npm-version"));
    if (agent === "claude-code") {
      assert.match(body, /claudeSettingsPath/); assert.match(body, /Pre-patch lacks/); assert.match(body, /legacy endpoint\/auth/);
    } else {
      assert.match(body, /hermes-bridge/); assert.match(body, /streaming:false/); assert.match(body, /HTTP404 fails turn\/workflow\/run/);
      assert.match(body, /idle after failed turn/); assert.match(body, /do not rewrite working YAML/);
    }
  }
});
