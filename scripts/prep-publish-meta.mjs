#!/usr/bin/env node
// One-shot: normalize package.json metadata for open-source publishing.
// Publishable packages get license/repository/author/publishConfig.
// test-server stays private. Run from repo root: node scripts/prep-publish-meta.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const REPO = "https://github.com/hackerphysics/agent-phonon";
const AUTHOR = "agent-phonon contributors";
const LICENSE = "MIT";

// dir -> { publish: bool, scoped: bool }
// 3 published packages: protocol, daemon (bundles core), server-sdk.
// core/console/openclaw-plugin stay private (core is bundled into the daemon;
// console/plugin are repo-internal / installed via OpenClaw, not via npm).
const PKGS = {
  "packages/protocol": { publish: true, scoped: true },
  "packages/core": { publish: false, scoped: true }, // bundled into agent-phonon
  "packages/daemon": { publish: true, scoped: false }, // unscoped: agent-phonon
  "packages/sdk-server-ts": { publish: true, scoped: true },
  "packages/console": { publish: false, scoped: true }, // repo-internal demo
  "packages/openclaw-plugin": { publish: false, scoped: true }, // installed via OpenClaw
  "packages/test-server": { publish: false, scoped: true }, // reference only
};

for (const [dir, cfg] of Object.entries(PKGS)) {
  const p = join(dir, "package.json");
  const pkg = JSON.parse(readFileSync(p, "utf8"));

  pkg.license = LICENSE;
  pkg.author = AUTHOR;
  pkg.repository = { type: "git", url: `git+${REPO}.git`, directory: dir };
  pkg.homepage = `${REPO}#readme`;
  pkg.bugs = { url: `${REPO}/issues` };

  if (cfg.publish) {
    delete pkg.private;
    // scoped packages default to restricted on npm; force public
    if (cfg.scoped) pkg.publishConfig = { access: "public" };
  } else {
    pkg.private = true;
  }

  writeFileSync(p, JSON.stringify(pkg, null, 2) + "\n");
  console.log(`${cfg.publish ? "publish " : "private "} ${pkg.name}`);
}
console.log("done");
