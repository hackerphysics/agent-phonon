import test from "node:test";
import assert from "node:assert/strict";
import { METHODS, ScheduleTarget, RunResolveParams } from "../index.js";

const dispatch = { key: "automation", revision: 1, contentHash: "a".repeat(64) };
test("dispatch targets require identity and reject embedded executable configuration", () => {
  assert.equal(ScheduleTarget.safeParse({ project: "p", runKind: "dispatch", dispatch }).success, true);
  for (const patch of [{ dispatch: undefined }, { agent: "codex" }, { agentConfig: { token: "do-not-save" } }]) {
    assert.equal(ScheduleTarget.safeParse({ project: "p", runKind: "dispatch", dispatch, ...patch }).success, false);
  }
  assert.equal(ScheduleTarget.safeParse({ project: "p", runKind: "session", dispatch }).success, false);
});
test("run.resolve validates terminal outcomes and frozen dispatch identity", () => {
  assert.equal(METHODS["run.resolve"].direction, "s2p");
  assert.equal(RunResolveParams.safeParse({ runId: "r", dispatch, status: "success" }).success, true);
  assert.equal(RunResolveParams.safeParse({ runId: "r", dispatch, status: "running" }).success, false);
  assert.equal(RunResolveParams.safeParse({ runId: "r", dispatch: { ...dispatch, revision: 0 }, status: "success" }).success, false);
});
