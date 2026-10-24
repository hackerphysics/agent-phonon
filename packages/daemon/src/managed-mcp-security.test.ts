import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, renameSync, rmSync, symlinkSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {WINDOWS_MCP_SECURITY_SCRIPT,windowsMcpFileOperation} from "./managed-mcp-security.js";

test("Windows MCP paths and content use stdin, never command interpolation or permissive shell startup",()=>{
  const path="literal ' ; $(not-a-command) MCP.json",content="synthetic-private-value";
  windowsMcpFileOperation("create",path,{content},(file,args,options)=>{
    assert.match(file,/powershell\.exe$/i);assert.deepEqual(args.slice(0,3),["-NoProfile","-NonInteractive","-EncodedCommand"]);
    assert.equal(Buffer.from(args[3]!,"base64").toString("utf16le"),WINDOWS_MCP_SECURITY_SCRIPT);
    assert.ok(!args.join(" ").includes(content));assert.ok(!args.join(" ").includes(path));
    const input=JSON.parse(String(options.input));assert.equal(input.content,content);assert.ok(input.path.endsWith(path));assert.equal(input.operation,"create");
    assert.equal(options.windowsHide,true);assert.equal(options.timeout,15000);assert.equal(options.shell,undefined);
    return {stdout:'{"ok":true}',status:0};
  });
});

test("Windows MCP permission failures and malformed/unavailable helpers fail closed without echoing inputs",()=>{
  for(const output of ['null','[]','not-json','{"ok":false,"code":"private input must not be echoed"}','{"ok":false,"code":"mcp_config_private_input"}','{"ok":true}']){
    assert.throws(()=>windowsMcpFileOperation("inspect","private-path",{},()=>({stdout:output,status:output==='{"ok":true}'?1:0})),/mcp_config_security_unavailable/);
  }
  assert.throws(()=>windowsMcpFileOperation("inspect","private-path",{},()=>({stdout:'{"ok":false,"code":"mcp_config_acl_untrusted"}',status:0})),/mcp_config_acl_untrusted/);
  assert.throws(()=>windowsMcpFileOperation("inspect","private-path",{},()=>({stdout:'{"ok":true}',status:0,error:new Error("unavailable")})),/mcp_config_security_unavailable/);
  assert.throws(()=>windowsMcpFileOperation("inspect","private-path",{},()=>{throw new Error("synthetic-private-value");}),/mcp_config_security_unavailable/);
});

test("Windows MCP reads validate and return bounded bytes in one helper invocation", () => {
  const content = "synthetic-private-value\n", encoded = Buffer.from(content).toString("base64");
  let calls = 0;
  assert.equal(windowsMcpFileOperation("read", "private-path", { private: true, limit: 64 }, (_file, _args, options) => {
    calls++;
    const input = JSON.parse(String(options.input));
    assert.equal(input.operation, "read"); assert.equal(input.private, true); assert.equal(input.limit, 64);
    assert.ok(options.maxBuffer! >= Math.ceil(64 / 3) * 4);
    return { stdout: JSON.stringify({ ok: true, content: encoded }), status: 0 };
  }), content);
  assert.equal(calls, 1);
  assert.equal(windowsMcpFileOperation("read", "missing-path", {}, () => ({ stdout: '{"ok":true,"missing":true}', status: 0 })), undefined);
  assert.equal(windowsMcpFileOperation("read", "empty-path", { limit: 0 }, () => ({ stdout: '{"ok":true,"content":""}', status: 0 })), "");
});

test("Windows MCP reads reject ambiguous, malformed, oversized or unbounded responses", () => {
  for (const value of [
    { ok: true }, { ok: true, content: null }, { ok: true, missing: false, content: "" },
    { ok: true, missing: true, content: "" }, { ok: true, content: "not-base64" },
    { ok: true, content: Buffer.from("too large").toString("base64") },
  ]) {
    assert.throws(() => windowsMcpFileOperation("read", "private-path", { limit: 4 }, () => ({ stdout: JSON.stringify(value), status: 0 })), /mcp_config_security_unavailable/);
  }
  for (const limit of [-1, 1.5, Infinity, NaN, 1024 * 1024 + 1]) {
    assert.throws(() => windowsMcpFileOperation("read", "private-path", { limit }, () => { throw new Error("must not spawn"); }), /mcp_config_file_untrusted/);
  }
});

test("Windows MCP replacement preparation compares the exact source without command-line disclosure", () => {
  for (const source of [undefined, "", "synthetic-original-private-value"]) {
    windowsMcpFileOperation("prepare", "private-path", { source, content: "synthetic-next-value", temporary: ".phonon-mcp-11111111-1111-4111-8111-111111111111" }, (_file, args, options) => {
      const input = JSON.parse(String(options.input));
      assert.equal(input.sourceMissing, source === undefined); assert.equal(input.source, source);
      assert.equal(input.content, "synthetic-next-value"); assert.match(input.temporary, /\.phonon-mcp-11111111-1111-4111-8111-111111111111$/);
      assert.ok(!args.join(" ").includes("synthetic-original-private-value"));
      assert.ok(!args.join(" ").includes("synthetic-next-value"));
      return { stdout: '{"ok":true}', status: 0 };
    });
  }
  assert.throws(() => windowsMcpFileOperation("prepare", "private-path", {}), /mcp_config_path_unsupported/);
  assert.throws(() => windowsMcpFileOperation("create", "private-path", { content: "\u4e2d", limit: 2 }, () => { throw new Error("must not spawn"); }), /mcp_config_file_untrusted/);
  assert.throws(() => windowsMcpFileOperation("prepare", "private-path", { temporary: "temporary" }, () => ({ stdout: '{"ok":false,"code":"mcp_config_changed"}', status: 0 })), /mcp_config_changed/);
});

// Run these only on local Windows or CI, never as a deployment-server test suite.
const windowsOnly = { skip: process.platform !== "win32", timeout: 60_000 };
test("Windows real ACL lifecycle pins bounded reads and prepares only an unchanged source", windowsOnly, () => {
  const root = join(homedir(), "phonon-mcp-acl-test-" + randomUUID()), path = join(root, "state.json"), temporary = join(root, ".phonon-mcp-" + randomUUID());
  windowsMcpFileOperation("directory", root);
  try {
    windowsMcpFileOperation("create", path, { content: "original" });
    assert.equal(windowsMcpFileOperation("read", path, { private: true }), "original");
    assert.equal(windowsMcpFileOperation("read", join(root, "missing"), { private: true }), undefined);
    assert.throws(() => windowsMcpFileOperation("read", path, { limit: 1 }), /mcp_config_file_untrusted/);
    assert.throws(() => windowsMcpFileOperation("prepare", path, { source: "changed", content: "next", temporary }), /mcp_config_changed/);
    assert.equal(existsSync(temporary), false);
    windowsMcpFileOperation("prepare", path, { source: "original", content: "next", temporary });
    renameSync(temporary, path);
    assert.equal(windowsMcpFileOperation("read", path, { private: true }), "next");
    assert.throws(() => windowsMcpFileOperation("create", path, { content: "replacement" }), /mcp_config_file_exists/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Windows real ACLs reject foreign readers/writers and junction parents without changing the profile", windowsOnly, () => {
  const root = join(homedir(), "phonon-mcp-acl-test-" + randomUUID()), path = join(root, "state.json"), junction = join(root, "redirect");
  windowsMcpFileOperation("directory", root);
  try {
    windowsMcpFileOperation("create", path, { content: "synthetic-value" });
    const grant = (rights: string) => {
      const result = spawnSync(join(process.env.SystemRoot || "C:\\Windows", "System32", "icacls.exe"), [path, "/grant", `*S-1-1-0:(${rights})`], { encoding: "utf8", windowsHide: true, timeout: 5000 });
      assert.equal(result.status, 0, "isolated synthetic-file ACL setup must succeed");
    };
    grant("R");
    assert.throws(() => windowsMcpFileOperation("read", path, { private: true }), /mcp_config_acl_untrusted/);
    assert.equal(windowsMcpFileOperation("read", path, { private: false }), "synthetic-value");
    grant("W");
    assert.throws(() => windowsMcpFileOperation("read", path, { private: false }), /mcp_config_acl_untrusted/);
    symlinkSync(root, junction, "junction");
    assert.throws(() => windowsMcpFileOperation("read", join(junction, "state.json"), {}), /mcp_config_symlink_refused/);
    unlinkSync(junction);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
