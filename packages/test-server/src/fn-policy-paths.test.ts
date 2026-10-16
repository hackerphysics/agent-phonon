import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PolicyEnforcer } from "@agent-phonon/core";

function fixture(t: TestContext) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "phonon-policy-path-")));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const root = join(base, "allowed"), outside = join(base, "outside"), alias = join(base, "alias");
  mkdirSync(root); mkdirSync(outside);
  symlinkSync(root, alias, "junction");
  return { base, root, outside, alias };
}

test("project policy accepts canonical and aliased workspace paths, including new suffixes", t => {
  const { root, alias } = fixture(t);
  const policy = new PolicyEnforcer({ workspaceRoot: alias, trustLocal: true });
  assert.equal(policy.workspaceRoot, root);
  policy.assertProjectPath(join(alias, "new", "project"));
  policy.assertProjectPath(join(root, "new", "project"));
  mkdirSync(join(root, "new"));
  policy.assertProjectPath(join(alias, "new", "project"));
});

test("project policy resolves explicit allowed roots without granting sibling or symlink escapes", t => {
  const { base, root, outside, alias } = fixture(t);
  const policy = new PolicyEnforcer({ workspaceRoot: join(base, "workspace"), policy: { allowedProjectRoots: [alias] } });
  policy.assertProjectPath(join(root, "project"));
  policy.assertProjectPath(join(alias, "project"));
  assert.throws(() => policy.assertProjectPath(join(base, "allowed-sibling", "project")), /outside allowed roots/);
  symlinkSync(outside, join(root, "escape"), "junction");
  assert.throws(() => policy.assertProjectPath(join(root, "escape", "project")), /outside allowed roots/);
});

test("project policy pins root identity rather than following later alias retargets", t => {
  const { base, root, outside, alias } = fixture(t);
  const policy = new PolicyEnforcer({ workspaceRoot: join(base, "workspace"), policy: { allowedProjectRoots: [alias] } });
  unlinkSync(alias); symlinkSync(outside, alias, "junction");
  assert.throws(() => policy.assertProjectPath(join(alias, "project")), /outside allowed roots/);
  policy.assertProjectPath(join(root, "project"));
});

test("project policy canonicalizes not-yet-created roots through existing ancestors", t => {
  const { root, alias } = fixture(t);
  const policy = new PolicyEnforcer({ workspaceRoot: join(alias, "future") });
  assert.equal(policy.workspaceRoot, join(root, "future"));
  policy.assertProjectPath(join(alias, "future", "project"));
  mkdirSync(join(root, "future"));
  policy.assertProjectPath(join(root, "future", "project"));
});
