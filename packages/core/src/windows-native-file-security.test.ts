import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {createHash} from "node:crypto";
import {mkdirSync, writeFileSync} from "node:fs";
import {join} from "node:path";
import test from "node:test";
import {withPeerFixture} from "./testing/peer-fixture.js";
import {inspectWindowsNativeSecurity, WINDOWS_NATIVE_SECURITY_SCRIPT} from "./windows-native-file-security.js";

test("Windows native file security never executes on a foreign platform", {skip: process.platform === "win32"}, () => {
  assert.throws(() => inspectWindowsNativeSecurity("/must-not-read", false), /Windows identity/);
  assert(WINDOWS_NATIVE_SECURITY_SCRIPT.includes("[Console]::In.ReadLine()"));
  assert(!WINDOWS_NATIVE_SECURITY_SCRIPT.includes("[Console]::In.ReadToEnd()"));
  assert(WINDOWS_NATIVE_SECURITY_SCRIPT.includes("ReparsePoint"));
  assert(WINDOWS_NATIVE_SECURITY_SCRIPT.includes("DiscretionaryAcl"));
});

test("Windows native ACL gate checks exact bytes, rejects foreign access and never repairs an existing profile", {
  skip: process.platform !== "win32", timeout: 60000,
}, () => withPeerFixture("windows-native-acl", async scope => {
  const root = join(scope.root, "private"); mkdirSync(root);
  inspectWindowsNativeSecurity(root, true, undefined, true, true);
  const file = join(root, "native.json"); writeFileSync(file, "Native owned history");
  const sha = createHash("sha256").update("Native owned history").digest("hex");
  const owner = inspectWindowsNativeSecurity(file, false, sha, true);
  assert.match(owner, /^S-1-\d+(?:-\d+)+$/);
  assert.equal(inspectWindowsNativeSecurity(file, false, sha, true), owner);
  assert.throws(() => inspectWindowsNativeSecurity(file, false, "0".repeat(64), true));
  assert.throws(() => inspectWindowsNativeSecurity(root, true, undefined, true, true), /ACL could not be verified/);
  const program = String.raw`$ErrorActionPreference='Stop';$p=[Console]::In.ReadLine();$acl=[IO.File]::GetAccessControl($p);$sid=[Security.Principal.SecurityIdentifier]::new('S-1-1-0');$rule=[Security.AccessControl.FileSystemAccessRule]::new($sid,[Security.AccessControl.FileSystemRights]::Modify,[Security.AccessControl.AccessControlType]::Allow);[void]$acl.AddAccessRule($rule);[IO.File]::SetAccessControl($p,$acl)`;
  execFileSync(join(process.env.SystemRoot!, "System32/WindowsPowerShell/v1.0/powershell.exe"), ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(program, "utf16le").toString("base64")], {input: file + "\n", windowsHide: true, timeout: 10000});
  assert.throws(() => inspectWindowsNativeSecurity(file, false, sha, true));
}));
