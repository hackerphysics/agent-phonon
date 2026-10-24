import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { ChildProcess } from "node:child_process";
import type { AdapterSession, SendOptions } from "../adapter.js";
import { CopilotAdapter, parseCopilotVersion } from "./copilot.js";
import { PeerContextBridge } from "../peer-context-bridge.js";
import { withPeerFixture } from "../testing/peer-fixture.js";

const CLI = String.raw`
import {readFileSync,writeFileSync,appendFileSync} from "node:fs";
import {join} from "node:path";
import {pathToFileURL} from "node:url";
const args=process.argv.slice(2),mode=process.env.PHONON_COPILOT_TEST_MODE;
appendFileSync(process.env.PHONON_COPILOT_TEST_CALLS,JSON.stringify({args,privateEnv:!!process.env.AGENT_PHONON_PEER_CONTEXT_TOKEN||!!process.env.AGENT_PHONON_PEER_CONTEXT_URL})+"\n");
if(args.includes("--version")){console.log(process.env.PHONON_COPILOT_TEST_VERSION||"1.0.82");process.exit(0);}
let prompt="";for await(const chunk of process.stdin)prompt+=String(chunk);
const plugin=args.indexOf("--plugin-dir"),forced=args.indexOf("--session-id"),resume=args.find(arg=>arg.startsWith("--resume="));
const sid=forced>=0?args[forced+1]:resume&&/^[a-f0-9-]{36}$/.test(resume.slice(9))?resume.slice(9):process.env.PHONON_COPILOT_TEST_SESSION;
const emit=value=>process.stdout.write(JSON.stringify(value)+"\n");
if(plugin>=0&&mode!=="denied"){
 const directory=join(args[plugin+1],"extensions","peer-context"),path=join(directory,"channel.json"),channel=JSON.parse(readFileSync(path,"utf8"));
 process.env.SESSION_ID=sid;
 const {installCopilotPeerContext}=await import(pathToFileURL(join(directory,"bridge.mjs")).href);
 let hooks;
 const binding=await installCopilotPeerContext({channel,joinSession:async config=>{hooks=config.hooks;return {sessionId:sid,on(){},rpc:{tasks:{list:async()=>({tasks:[]})},permissions:{pendingRequests:async()=>({items:[]})}}};},onReady:value=>writeFileSync(join(directory,"native-ready.json"),JSON.stringify(value),{mode:0o600})});
 if(mode==="hold")await new Promise(()=>{setInterval(()=>{},1000);});
 const output=await hooks.onUserPromptSubmitted({workingDirectory:process.cwd(),prompt},{sessionId:sid});
 emit({type:"phonon.fixture.context",present:!!output?.additionalContext});
 binding.deactivate();
}
emit({type:"user.message",data:{content:prompt}});
emit({type:"assistant.message_delta",data:{deltaContent:"Intermediate plan"}});
emit({type:"assistant.message",data:{content:"Intermediate plan",toolRequests:[{id:"root-read",name:"view"}]}});
emit({type:"assistant.message_delta",agentId:"native-child",data:{deltaContent:"Child private output"}});
emit({type:"assistant.message",agentId:"native-child",data:{content:"Child private output"}});
emit({type:"tool.execution_start",agentId:"native-child",data:{toolCallId:"child-read",toolName:"view",arguments:{}}});
if(mode!=="missing-final")emit({type:"assistant.message",data:{content:"Final original task complete"}});
if(mode==="native-error")emit({type:"session.error",data:{message:"Native task error"}});
if(mode!=="missing-result")emit({type:"result",sessionId:mode==="foreign-session"?"00000000-0000-4000-8000-000000000000":sid,exitCode:mode==="failed-result"?1:0});
`;

async function fixture(work: (f: any) => Promise<void>, config: { mode?: string; enabled?: boolean; version?: string; reattach?: boolean } = {}) {
  await withPeerFixture("copilot-adapter-peer", async scope => {
    const bin = join(scope.root, "copilot.mjs"), callsPath = join(scope.root, "calls.jsonl"), nativeId = randomUUID();
    writeFileSync(bin, "#!" + process.execPath + "\n" + CLI, { mode: 0o700 });
    const events: any[] = [], boundaries: any[] = [], observations: any[] = [];
    let session: AdapterSession | undefined;
    const bridge = new PeerContextBridge({ prepare: async boundary => {
      assert.equal(session?.peerContextCapability?.()?.readiness, "ready");
      assert.equal(boundary.nativeSessionId, session?.peerContextCapability?.()?.nativeSessionId);
      boundaries.push(boundary); return { ...boundary, messages: [{ messageId: randomUUID(), content: "[Untrusted peer observation] synthetic notice" }], deferred: [] };
    }, observe: observation => { observations.push(observation); } });
    scope.defer(() => bridge.close());
    const environment = { ...await bridge.listen(), PHONON_COPILOT_TEST_MODE: config.mode ?? "admitted", PHONON_COPILOT_TEST_CALLS: callsPath,
      PHONON_COPILOT_TEST_SESSION: nativeId, PHONON_COPILOT_TEST_VERSION: config.version ?? "1.0.82" };
    const adapter = new CopilotAdapter({ env: { binPath: bin, peerContext: config.enabled ?? true } });
    session = await adapter.createSession({ sessionId: "owned", agentId: "copilot", model: "default", cwd: scope.root, reattach: config.reattach });
    scope.defer(() => session?.terminate());
    const options: SendOptions = { turnId: "turn", verbosity: "tools", emit: event => events.push(event), environment,
      peerContext: { prepare: async () => { throw new Error("Use owned checkpoint"); }, observe: () => {} } };
    const run = async () => {
      const promise = session!.send("Original assigned task", options);
      scope.watch((session as unknown as { current?: { child: ChildProcess } }).current?.child, true);
      await promise;
    };
    await work({ scope, session, adapter, options, environment, events, boundaries, observations, nativeId, run,
      calls: () => existsSync(callsPath) ? readFileSync(callsPath, "utf8").trim().split("\n").map(line => JSON.parse(line)) : [] });
  });
}

test("Copilot adapter retains pending readiness until its exact native extension joins", () => fixture(async f => {
  await f.session.preparePeerContext(f.environment);
  assert.equal(f.session.peerContextCapability().readiness, "pending");
  assert.equal(f.session.peerContextCapability().nativeSessionId, undefined);
  await f.run();
  assert.equal(f.events.at(-1).status, "completed"); assert.equal(f.events.at(-1).text, "Final original task complete");
  assert.equal(f.boundaries.length, 1); assert.equal(f.observations[0].evidence, "context_hook");
  assert.equal(JSON.stringify(f.events).includes("Child private output"), false);
  assert.equal(f.events.some((event: any) => event.toolCallId === "child-read"), false);
  assert.equal(f.session.peerContextCapability().readiness, "pending");
  const run = f.calls().find((call: any) => !call.args.includes("--version"));
  assert.equal(run.privateEnv, false); assert.equal(run.args.includes("--experimental"), false);
  assert.equal(run.args.some((arg: string) => arg.startsWith("--allow") || arg === "--yolo"), false);
  assert.equal(existsSync(run.args[run.args.indexOf("--plugin-dir") + 1]), false);
}));

test("Copilot version qualification recognizes native offline metadata without accepting arbitrary text", () => {
  assert.equal(parseCopilotVersion("1.0.82\n"), "1.0.82");
  assert.equal(parseCopilotVersion("GitHub Copilot CLI 1.0.82.\nRun 'copilot update' to check for updates."), "1.0.82");
  assert.equal(parseCopilotVersion("1.0.94-3"), "1.0.94-3");
  assert.equal(parseCopilotVersion("GitHub Copilot CLI 1.0.94-3.\nRun 'copilot update' to check for updates."), "1.0.94-3");
  assert.equal(parseCopilotVersion("unknown 1.0.82"), undefined);
  assert.equal(parseCopilotVersion("1.0.82 unexpected"), undefined);
});

test("Copilot native extension denial preserves the original task without claiming readiness", () => fixture(async f => {
  await f.session.preparePeerContext(f.environment); await f.run();
  assert.equal(f.events.at(-1).status, "completed"); assert.equal(f.boundaries.length, 0);
  assert.equal(f.session.peerContextCapability().readiness, "pending");
  assert.equal(f.session.peerContextCapability().nativeSessionId, undefined);
}, { mode: "denied" }));

for (const config of [{ enabled: false }, { version: "1.0.81" }]) {
  test(`Copilot unqualified/disabled receive leaves the native invocation untouched: ${JSON.stringify(config)}`, () => fixture(async f => {
    await f.session.preparePeerContext(f.environment); assert.equal(f.session.peerContextCapability(), undefined);
    await f.run(); assert.equal(f.events.at(-1).status, "completed"); assert.equal(f.boundaries.length, 0);
    const run = f.calls().find((call: any) => !call.args.includes("--version"));
    assert.equal(run.args.includes("--plugin-dir"), false); assert.equal(run.args.includes("--experimental"), false);
    assert.equal(run.privateEnv, false);
  }, config));
}

test("Copilot reattachment never invents a receive identity and later resumes the observed native UUID", () => fixture(async f => {
  await f.session.preparePeerContext(f.environment); assert.equal(f.session.peerContextCapability(), undefined);
  await f.run(); assert.equal(f.events.at(-1).status, "completed");
  assert.ok(f.calls()[0].args.includes("--resume=agent-phonon-owned"));
  await f.session.preparePeerContext(f.environment); assert.equal(f.session.peerContextCapability().readiness, "pending");
  await f.run(); assert.equal(f.events.at(-1).status, "completed");
  const runs = f.calls().filter((call: any) => !call.args.includes("--version"));
  assert.ok(runs[1].args.includes("--resume=" + f.nativeId));
  assert.equal(runs.some((run: any) => run.args.some((arg: string) => arg.startsWith("--name="))), false);
}, { reattach: true }));

for (const mode of ["missing-result", "missing-final", "failed-result", "native-error", "foreign-session"]) {
  test(`Copilot rejects unconfirmed native completion: ${mode}`, () => fixture(async f => {
    await f.session.preparePeerContext(f.environment); await f.run();
    assert.equal(f.events.at(-1).status, "failed"); assert.equal(f.events.filter((event: any) => event.final).length, 1);
  }, { mode }));
}

test("Copilot interruption closes the owned native process and releases its private plugin", () => fixture(async f => {
  await f.session.preparePeerContext(f.environment);
  const controller = new AbortController(); f.options.signal = controller.signal;
  const run = f.run(); const deadline = Date.now() + 3000;
  while (f.session.peerContextCapability().readiness !== "ready" && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(f.session.peerContextCapability().readiness, "ready"); controller.abort(); await run;
  assert.equal(f.events.at(-1).status, "interrupted");
  const invocation = f.calls().find((call: any) => !call.args.includes("--version"));
  assert.equal(existsSync(invocation.args[invocation.args.indexOf("--plugin-dir") + 1]), false);
}, { mode: "hold" }));
