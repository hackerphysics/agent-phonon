import assert from "node:assert/strict";
import test from "node:test";
import { employeeIdentityEquivalent } from "./employee-profiles.js";

test("employeeIdentityEquivalent accepts APFS remounts with the same inode", () => {
  assert.equal(employeeIdentityEquivalent("p:100000d:8220b1f", "p:1000010:8220b1f"), true);
  assert.equal(employeeIdentityEquivalent("p:100000d:8220b1f", "p:100000d:8220b1f"), true);
  assert.equal(employeeIdentityEquivalent("p:100000d:8220b1f", "p:1000010:9999999"), false);
  assert.equal(employeeIdentityEquivalent("16777229:136448799", "16777232:136448799"), true);
  assert.equal(employeeIdentityEquivalent("16777229:136448799", "16777232:1"), false);
  assert.equal(employeeIdentityEquivalent("p:100000d:8220b1f", "16777232:136448799"), false);
});
