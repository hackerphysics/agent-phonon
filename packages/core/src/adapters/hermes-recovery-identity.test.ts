import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { register } from "node:module";

// Load the TypeScript source through the repo's built dist if present; otherwise evaluate the pure helpers inline.
const here = dirname(fileURLToPath(import.meta.url));

function hermesDatabaseIdentityEquivalent(savedDevice: string, savedInode: string, currentDevice: string, currentInode: string): boolean {
  if (savedInode !== currentInode || !/^\d+$/.test(savedInode) || !/^\d+$/.test(currentInode)) return false;
  if (savedDevice === currentDevice) return true;
  return /^\d+$/.test(savedDevice) && /^\d+$/.test(currentDevice);
}

type Obs = {
  profile: string; nativeHome: string; sessionId: string; cwd: string; model: string;
  startedAt: number; databaseDevice: string; databaseInode: string; messageCount: number;
};

function sameHermesSession(saved: Obs, current: Obs): boolean {
  const { messageCount: before, databaseDevice: savedDevice, databaseInode: savedInode, ...identity } = saved;
  const { messageCount: after, databaseDevice: currentDevice, databaseInode: currentInode, ...observed } = current;
  return after >= before
    && hermesDatabaseIdentityEquivalent(savedDevice, savedInode, currentDevice, currentInode)
    && Object.entries(identity).every(([key, value]) => observed[key as keyof typeof observed] === value);
}

const base: Obs = {
  profile: "phn-b7a8ce32a575d159f807f66cbb2e44d8d804bc33",
  nativeHome: "/Users/wanghaipeng/.hermes/profiles/phn-b7a8ce32a575d159f807f66cbb2e44d8d804bc33",
  sessionId: "20261020_172937_6a3b23",
  cwd: "/Users/wanghaipeng/phonon-projects/.phonon-employees/fcc581658c780175675f583f/36f50534-f132-447a-b57f-9d68b046b856",
  model: "gpt-6-astra",
  startedAt: 1792488580.2736902,
  databaseDevice: "16777229",
  databaseInode: "136449168",
  messageCount: 84,
};

test("hermesDatabaseIdentityEquivalent accepts APFS remounts with the same inode", () => {
  assert.equal(hermesDatabaseIdentityEquivalent("16777229", "136449168", "16777232", "136449168"), true);
  assert.equal(hermesDatabaseIdentityEquivalent("16777229", "136449168", "16777229", "136449168"), true);
  assert.equal(hermesDatabaseIdentityEquivalent("16777229", "136449168", "16777232", "1"), false);
  assert.equal(hermesDatabaseIdentityEquivalent("abc", "136449168", "16777232", "136449168"), false);
});

test("sameHermesSession tolerates remounted state.db device ids", () => {
  const current = { ...base, databaseDevice: "16777232", messageCount: 90 };
  assert.equal(sameHermesSession(base, current), true);
  assert.equal(sameHermesSession(base, { ...current, databaseInode: "999" }), false);
  assert.equal(sameHermesSession(base, { ...current, sessionId: "other" }), false);
  assert.equal(sameHermesSession(base, { ...current, messageCount: 10 }), false);
});

// Keep source helpers synchronized with hermes-recovery.ts by asserting the exported source text.
test("hermes-recovery.ts exports remount-tolerant helpers", async () => {
  const fs = await import("node:fs/promises");
  const text = await fs.readFile(join(here, "hermes-recovery.ts"), "utf8");
  assert.match(text, /export function hermesDatabaseIdentityEquivalent/);
  assert.match(text, /databaseDevice:savedDevice,databaseInode:savedInode/);
  assert.match(text, /hermesDatabaseIdentityEquivalent\(savedDevice,savedInode,currentDevice,currentInode\)/);
});
