import test from "node:test";
import assert from "node:assert/strict";
import {nativeVersionAtLeast} from "../native-version.js";

test("native minimum versions admit later patch, minor and major releases", () => {
  for (const [minimum, versions] of [
    ["1.14.20", ["1.14.20", "1.14.21", "1.15.10", "2.0.0", "1.14.20+native.1"]],
    ["1.0.82", ["1.0.82", "1.0.94", "1.1.0", "2.0.0"]],
    ["2.0.1", ["2.0.1", "2.0.2", "2.1.0", "3.0.0"]],
    ["0.21.1", ["0.21.1", "0.21.2", "0.22.0", "1.0.0"]],
    ["0.84.1", ["0.84.1", "0.85.0", "1.0.0"]],
    ["2026.10.7", ["2026.10.7", "2026.10.8", "2026.11.1", "2027.1.1"]],
  ] as const) for (const version of versions) assert.equal(nativeVersionAtLeast(version, minimum), true, `${version} >= ${minimum}`);
});

test("native minimum comparison rejects old, malformed and unselected preview versions", () => {
  for (const version of [undefined, null, {}, "", "unknown", "1.14.19", "1.9.100", "0.99.99", "01.14.20", "1.014.20", "1.14", "1.14.20.1", "1.14.20\n", " 1.14.20", "1.14.20-preview", "2.0.0-preview", "1.14.20+", "1.14.20-alpha.01", "9007199254740992.0.0"]) {
    assert.equal(nativeVersionAtLeast(version, "1.14.20"), false, String(version));
  }
  assert.equal(nativeVersionAtLeast("1.14.20", "unknown"), false);
});

test("Codex prerelease floor uses numeric prerelease precedence, not lexical order", () => {
  const floor = "0.165.0-alpha.1.2";
  for (const version of [floor, "0.165.0-alpha.1.10", "0.165.0-beta.1", "0.165.0", "0.166.0-alpha.1", "1.0.0"]) {
    assert.equal(nativeVersionAtLeast(version, floor), true, version);
  }
  for (const version of ["0.164.9", "0.165.0-alpha", "0.165.0-alpha.1.1", "0.165.0-1", "0.165.0-alpha.1.02"]) {
    assert.equal(nativeVersionAtLeast(version, floor), false, version);
  }
  const embedded = Function(`return (${nativeVersionAtLeast.toString()})`)();
  assert.equal(embedded("0.165.0-alpha.1.10", floor), true);
  assert.equal(embedded("1.15.10", "1.14.20"), true);
});
