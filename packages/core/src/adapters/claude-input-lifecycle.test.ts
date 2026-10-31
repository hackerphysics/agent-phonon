import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, delimiter, join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { CLAUDE_PEER_RUNNER_SOURCE, qualifyClaudePeerContext } from "./claude-peer-context.js";
import { spawnSupervisedAgent } from "../process-supervisor.js";
import { withPeerFixture, closePeerServer } from "../testing/peer-fixture.js";

const experiment = String.raw`
import {createInterface}from"node:readline";
import{dirname}from"node:path";
import{pathToFileURL}from"node:url";
const[sdkPath,entry,sessionId,helper,mode,marker,external,cliNode]=process.argv.slice(2),sdk=await import(sdkPath),{prepareNativeStartup,prepareExternalStartup}=await import(pathToFileURL(helper).href);
const controller=new AbortController(),lines=createInterface({input:process.stdin});
const prompts=async function*(){
 yield{type:"user",uuid:"00000000-0000-4000-8000-000000000001",session_id:sessionId,parent_tool_use_id:null,message:{role:"user",content:[{type:"text",text:"Read input.txt and finish the original task."}]}};
 for await(const line of lines){const msg=JSON.parse(line);yield{type:"user",uuid:msg.uuid,session_id:sessionId,parent_tool_use_id:null,message:{role:"user",content:[{type:"text",text:msg.text}]}};}
};
const startup=external?prepareExternalStartup({entry,cwd:process.cwd(),cliNode:cliNode||undefined}):prepareNativeStartup({entry,directory:process.cwd()}),options={cwd:process.cwd(),env:{...process.env},pathToClaudeCodeExecutable:entry,
 ...(external?{spawnClaudeCodeProcess:startup.spawnClaudeCodeProcess,...(cliNode?{executable:"node"}:{})}:{executable:"node",executableArgs:startup.executableArgs}),extraArgs:{"session-id":sessionId,"replay-user-messages":null},abortController:controller,includePartialMessages:true,
 hooks:mode==="hook"?{PostToolUse:[{hooks:[async input=>input.session_id===sessionId&&input.tool_name==="Read"?{hookSpecificOutput:{hookEventName:"PostToolUse",additionalContext:marker}}:{}]}]}:{}};
let result;
try{for await(const msg of sdk.query({prompt:mode==="hook"?"Read input.txt and finish the original task.":prompts(),options})){
 if(!msg.parent_tool_use_id&&msg.session_id!==sessionId)throw new Error("Native root changed");
 process.stdout.write(JSON.stringify(msg)+"\n");
 if(msg.type==="result"&&!msg.parent_tool_use_id){result=msg;lines.close();controller.abort();break;}
}}catch(error){if(!result)throw error;}finally{lines.close();controller.abort();}
if(!startup.confirmed()||result?.subtype!=="success"||result?.is_error!==false)process.exitCode=1;
`;

for(const mode of ["stream","hook"] as const)test(mode==="stream"?"installed Claude streaming input observes actual root inference and result boundaries":"installed Claude hook adds current-task context without inventing a native user message", {
  skip: !process.env.PHONON_TEST_CLAUDE_BIN, timeout: 45000,
}, () => withPeerFixture("claude-input-audit", async scope => {
  const binding = await qualifyClaudePeerContext(process.env.PHONON_TEST_CLAUDE_BIN!, process.env.PHONON_TEST_CLAUDE_SDK);
  assert.ok(binding?.node, "the installed CLI and its paired runtime must qualify");
  const marker = "CLAUDE_INSERT_" + randomUUID(), inputId = randomUUID(), sid = randomUUID();
  writeFileSync(join(scope.root, "helpers.mjs"), CLAUDE_PEER_RUNNER_SOURCE, { mode: 0o600 });
  writeFileSync(join(scope.root, "experiment.mjs"), experiment, { mode: 0o600 });
  writeFileSync(join(scope.root, "input.txt"), "Actual native fixture\n");
  mkdirSync(join(scope.root, "claude"));
  const frames: any[] = [], payloads: any[] = [], errors: unknown[] = [];
  let runtime: ReturnType<typeof spawnSupervisedAgent> | undefined;
  const provider = createServer((req, res) => { void (async () => {
    if(req.method!=="POST"){req.resume();res.writeHead(200,{"Content-Type":"application/json"}).end("{}");return;}
    let body = ""; for await (const chunk of req) body += String(chunk);
    const path = new URL(req.url ?? "/", "http://local").pathname;
    if (path.endsWith("/count_tokens")) { res.writeHead(200, { "Content-Type": "application/json" }).end('{"input_tokens":100}'); return; }
    if (!body) { res.writeHead(200, { "Content-Type": "application/json" }).end("{}"); return; }
    const payload = JSON.parse(body), main = payload.tools?.some((tool: any) => tool.name === "Read");
    if (main) payloads.push(payload);
    if (main && payloads.length === 1&&mode==="stream") runtime!.child.stdin.write(JSON.stringify({ uuid: inputId, text: marker }) + "\n");
    assert.ok(payloads.length <= 3, "unexpected native streaming request count");
    const content = main && payloads.length === 1 ? [{ type: "tool_use", id: "read-original", name: "Read", input: { file_path: join(scope.root, "input.txt") } }]
      : [{ type: "text", text: main ? "Original native task complete" : "Fixture helper response" }];
    if (main && payloads.length === 2) {
      assert.equal(frames.some(frame => frame.type === "result"), false, "the original native task must still be active");
      assert.ok(body.includes(marker), "queued input must actually reach the original next model request");
    }
    const stop = content[0]!.type === "tool_use" ? "tool_use" : "end_turn";
    if (!payload.stream) { res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ id: "msg_" + payloads.length, type: "message", role: "assistant", model: payload.model, content,
      stop_reason: stop, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 10 } })); return; }
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const send = (type: string, value: any) => res.write("event: " + type + "\ndata: " + JSON.stringify(value) + "\n\n");
    send("message_start", { type: "message_start", message: { id: "msg_" + payloads.length, type: "message", role: "assistant", model: payload.model, content: [], stop_reason: null, stop_sequence: null,
      usage: { input_tokens: 100, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } });
    content.forEach((part: any, index) => {
      send("content_block_start", { type: "content_block_start", index, content_block: part.type === "tool_use" ? { type: "tool_use", id: part.id, name: part.name, input: {} } : { type: "text", text: "" } });
      send("content_block_delta", { type: "content_block_delta", index, delta: part.type === "tool_use" ? { type: "input_json_delta", partial_json: JSON.stringify(part.input) } : { type: "text_delta", text: part.text } });
      send("content_block_stop", { type: "content_block_stop", index });
    });
    send("message_delta", { type: "message_delta", delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 10 } }); send("message_stop", { type: "message_stop" }); res.end();
  })().catch(error => { errors.push(error); void runtime?.terminate(); res.destroy(); }); });
  scope.defer(() => closePeerServer(provider)); await new Promise<void>(resolve => provider.listen(0, "127.0.0.1", resolve));
  runtime = spawnSupervisedAgent(binding.node, [join(scope.root, "experiment.mjs"), pathToFileURL(binding.sdk).href, binding.entry, sid, join(scope.root, "helpers.mjs"),mode,marker,binding.kind??"",binding.cliNode??""], {
    cwd: scope.root, env: { PATH: dirname(binding.node) + delimiter + process.env.PATH, HOME: scope.root, USERPROFILE: scope.root, CLAUDE_CONFIG_DIR: join(scope.root, "claude"),
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${(provider.address() as { port: number }).port}`, ANTHROPIC_AUTH_TOKEN: "controlled-fixture-key", ANTHROPIC_MODEL: "claude-sonnet-4-5-20250929",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_TELEMETRY: "1", DISABLE_ERROR_REPORTING: "1", HTTP_PROXY: "", HTTPS_PROXY: "", ALL_PROXY: "", PYTHONDONTWRITEBYTECODE: "1" },
  });
  scope.watch(runtime.child, true); scope.defer(() => runtime?.terminate());
  let buffer = "", stderr = "";
  runtime.child.stdout.setEncoding("utf8"); runtime.child.stdout.on("data", chunk => { buffer += chunk; let at; while ((at = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, at); buffer = buffer.slice(at + 1); try { frames.push(JSON.parse(line)); } catch {}
  } });
  runtime.child.stderr.on("data", chunk => { stderr = (stderr + String(chunk)).slice(-6000); });
  const code = await new Promise<number | null>((resolve, reject) => { runtime!.child.once("close", resolve); runtime!.child.once("error", reject); });
  assert.deepEqual(errors, [], JSON.stringify({ frames: frames.map(frame => ({ type: frame.type, uuid: frame.uuid, message: frame.type === "user" ? frame.message : undefined })), stderr }));
  assert.equal(code, 0, stderr); assert.ok(mode==="stream"?payloads.length>=2&&payloads.length<=3:payloads.length===2,JSON.stringify({results:frames.filter(frame=>frame.type==="result"),
    requests:payloads.map(payload=>({model:payload.model,messages:payload.messages.slice(-3)})),types:frames.map(frame=>({type:frame.type,uuid:frame.uuid,parent:frame.parent_tool_use_id,text:frame.type==="assistant"?frame.message.content:undefined}))}));
  assert.equal(frames.filter(frame => frame.type === "result").length, 1);
  if(mode==="hook")assert.equal(frames.some(frame=>frame.type==="user"&&JSON.stringify(frame.message).includes(marker)),false,"native hook context must not be relabelled as a native user message");
}));
