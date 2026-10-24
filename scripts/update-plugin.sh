#!/usr/bin/env bash
# Install an already prepared local plugin artifact. No builds or dependency installs.
# Usage: bash scripts/update-plugin.sh /absolute/path/to/prepared-plugin
set -euo pipefail
if [[ $# -ne 1 || "$1" != /* || ! -f "$1/dist/index.js" || ! -f "$1/openclaw.plugin.json" || ! -f "$1/package.json" ]]; then
  printf '%s\n' 'Provide one absolute path to a prepared plugin artifact.' >&2
  exit 1
fi
node --input-type=module - "$1" <<'JS'
import { readFileSync, readdirSync, lstatSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, join } from "node:path";
import assert from "node:assert/strict";
const root = process.argv[2];
const entries = ["LICENSE", "THIRD_PARTY_NOTICES.txt", "dist", "openclaw.plugin.json", "package.json"];
assert.ok(lstatSync(root).isDirectory() && !lstatSync(root).isSymbolicLink(), "Artifact must be a real directory");
assert.deepEqual(readdirSync(root).sort(), entries, "Unexpected runtime files");
assert.ok(lstatSync(join(root, "dist")).isDirectory() && !lstatSync(join(root, "dist")).isSymbolicLink());
assert.deepEqual(readdirSync(join(root, "dist")), ["index.js"]);
const checksums = JSON.parse(readFileSync(join(dirname(root), basename(root) + ".sha256.json"), "utf8"));
const files = ["LICENSE", "THIRD_PARTY_NOTICES.txt", "dist/index.js", "openclaw.plugin.json", "package.json"];
assert.deepEqual(Object.keys(checksums).sort(), files);
for (const name of files) {
  const path = join(root, name), info = lstatSync(path);
  assert.ok(info.isFile() && !info.isSymbolicLink() && info.size <= 2 * 1024 * 1024, "Invalid artifact file");
  assert.equal(createHash("sha256").update(readFileSync(path)).digest("hex"), checksums[name], "Artifact checksum mismatch");
}
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
assert.equal(pkg.name, "@agent-phonon/openclaw-plugin");
for (const key of ["dependencies", "optionalDependencies", "peerDependencies", "devDependencies", "scripts", "workspaces"]) assert.ok(!pkg[key], "Artifact must not trigger dependency installation or scripts");
assert.equal(pkg.main, "./dist/index.js");
assert.deepEqual(pkg.openclaw?.extensions, ["./dist/index.js"]);
JS
openclaw plugins install --force "$1"
printf '%s\n' 'Plugin installed. Restart the Gateway explicitly when ready.'
