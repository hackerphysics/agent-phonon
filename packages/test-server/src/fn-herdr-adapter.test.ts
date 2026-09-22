import { test } from "node:test";
import assert from "node:assert/strict";
import { HerdrAdapter, parseHerdrKind, parseHerdrVersion, HERDR_KINDS, probeHerdrSync } from "@agent-phonon/core";

test("herdr adapter parses agent kind from composite agentId", () => {
  for (const k of HERDR_KINDS) {
    assert.equal(parseHerdrKind(`herdr:${k}`), k);
  }
  assert.equal(parseHerdrKind("herdr:codex"), "codex");
  assert.equal(parseHerdrKind("openclaw:main"), undefined);
  assert.equal(parseHerdrKind("herdr:"), undefined);
  assert.equal(parseHerdrKind("herdr:not-a-real-kind"), undefined);
});

test("herdr adapter version parser strips ANSI and returns first line", () => {
  const ansiText = "\u001b[32mherdr 0.9.1\u001b[0m (rev abc123)";
  assert.equal(parseHerdrVersion(ansiText), "herdr 0.9.1 (rev abc123)");
  assert.equal(parseHerdrVersion(""), undefined);
  assert.equal(parseHerdrVersion("\n\nherdr 1.0\n"), "herdr 1.0");
});

test("herdr adapter honestly declares no streaming and no protocol-level hooks", () => {
  const a = new HerdrAdapter();
  assert.equal(a.name, "herdr");
  assert.equal(a.capabilities.streaming, false);
  assert.deepEqual(a.capabilities.hooks, []);
  assert.equal(a.capabilities.nativeSession, true); // Herdr agent name is durable
  assert.equal(a.capabilities.interrupt, true);
  // 跨设备/HITL/streaming 这些 phonon 强项，herdr adapter 主动放弃；
  // 走 herdr 就意味着接受 polling + screen-scrape 的弱保真。
  assert.equal(a.capabilities.modelSwitch, false);
});

test("herdr adapter returns unavailable descriptor when CLI not on PATH", async () => {
  // Adapter 默认 binPath="herdr"，本地若未装会返回 unavailable。
  // 我们不假设 CI 装 herdr——失败容错：要么 available=false（herdr 不在 PATH），
  // 要么 available=true 且至少 13 个 kind。
  const agents = await new HerdrAdapter().discoverAgents();
  assert.ok(agents.length === 1 || agents.length >= HERDR_KINDS.length);
  if (agents.length === 1) {
    assert.equal(agents[0]?.available, false);
    assert.match(agents[0]?.unavailableReason ?? "", /herdr CLI not found/);
    return;
  }
  // 若 herdr 实际可用，至少 13 个 kind
  assert.equal(agents.length, HERDR_KINDS.length);
  for (const k of HERDR_KINDS) {
    assert.ok(agents.some((a) => a.agentId === `herdr:${k}`));
  }
});

test("herdr adapter createSession rejects unknown kind and accepts configured defaultKind", async () => {
  const adapter = new HerdrAdapter({ env: { defaultKind: "codex" } });
  // 配 defaultKind 时允许简单 "herdr" agentId（自动 fallback 到 defaultKind）。
  const s = await adapter.createSession({
    sessionId: "s-default-kind",
    agentId: "herdr",
    model: "gpt-5.4",
    cwd: "/tmp",
  });
  assert.equal(s.sessionId, "s-default-kind");
  assert.equal(s.model, "gpt-5.4");

  // 未配 defaultKind 且 agentId 不带 kind 时报错。
  await assert.rejects(() =>
    new HerdrAdapter().createSession({ sessionId: "s-bad", agentId: "herdr", model: "gpt-5.4", cwd: "/tmp" }),
    /expected 'herdr:<kind>'/,
  );

  // 未知 kind 报清楚
  await assert.rejects(() =>
    new HerdrAdapter().createSession({ sessionId: "s-bad", agentId: "herdr:not-real", model: "gpt-5.4", cwd: "/tmp" }),
    /expected 'herdr:<kind>'/,
  );
});

test("herdr sync probe returns deterministic shape", () => {
  // 同步 probe 永远返回 { available, version? }，不影响 ABI。
  const r = probeHerdrSync("/nonexistent/herdr-binary");
  // 二选一：available=false，或（意外装在 PATH 上时）available=true。
  assert.ok(typeof r.available === "boolean");
  if (r.available) assert.equal(typeof r.version, "string");
});

test("herdr adapter exposes kinds list for downstream callers", () => {
  assert.ok(HERDR_KINDS.length >= 5);
  for (const k of ["claude", "codex", "copilot"]) assert.ok(HERDR_KINDS.includes(k as never));
});