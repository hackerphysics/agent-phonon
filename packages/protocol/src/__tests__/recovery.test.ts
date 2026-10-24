import test from "node:test";
import assert from "node:assert/strict";
import { parseParams, SessionMeta } from "../index.js";

test("Session recovery requires frozen identity and accepts no task or native path", () => {
  const params = {sessionId:"retained", project:"owned", agent:"codex", model:"model"};
  assert.deepEqual(parseParams("session.recover", params), params);
  for (const field of ["sessionId", "project", "agent", "model"]) {
    const missing:Record<string,unknown> = {...params}; delete missing[field];
    assert.throws(() => parseParams("session.recover", missing));
  }
  assert.throws(() => parseParams("session.recover", {...params, input:"repeat task"}));
  assert.throws(() => parseParams("session.recover", {...params, nativePath:"/arbitrary"}));
  const result = SessionMeta.parse({...params, worktreeId:"original-worktree", status:"paused", verbosity:"tools", createdAt:new Date().toISOString(), recovery:{detached:true,canAttempt:false,reason:"interrupted_turn"}});
  assert.equal(result.recovery?.canAttempt, false);
  assert.equal(result.worktreeId,"original-worktree");
});
