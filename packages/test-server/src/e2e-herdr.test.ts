/**
 * Herdr adapter 真机 e2e（herdr v0.9.0+ + Claude Code）。
 *
 * 这不是单元测试——它真去 spawn `herdr` CLI、用 `herdr workspace create` 建 pane、
 * `herdr agent start` 拉起 Claude Code、send-keys 处理 trust 对话框、
 * `agent prompt --wait` 拿终态响应。需要机器上装：
 *   - `herdr` (https://herdr.dev)
 *   - `claude` (Claude Code CLI)
 *   - herdr server 在跑（`herdr` 启动后会 fork server；测试自己也会尝试启动）
 *
 * CI 不强依赖：缺 herdr 或 claude 时 skip 而不是 fail，保证普通 CI 能过。
 * 机器人/真机回归时手动跑：pnpm exec node --test dist/e2e-herdr.test.js
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { HerdrAdapter, parseHerdrVersion, HERDR_KINDS } from "@agent-phonon/core";

const HERDR_BIN = process.env.HERDR_BIN ?? join(homedir(), ".local", "bin", "herdr");
const CLAUDE_BIN = process.env.CLAUDE_BIN ?? join(homedir(), ".local", "bin", "claude");
const TEST_KIND = "claude" as const;
const RESPONSE_TOKEN = "herdr-e2e-marker-9842";

// CI skip: 缺 herdr/claude 二进制时不 fail。
function binaryOk(path: string): boolean {
  return existsSync(path) && spawnSync(path, ["--version"], { timeout: 5_000 }).status === 0;
}
const skipReason = !binaryOk(HERDR_BIN)
  ? `herdr binary not at ${HERDR_BIN}`
  : !binaryOk(CLAUDE_BIN)
  ? `claude not at ${CLAUDE_BIN}`
  : null;

let herdrServerProc: ChildProcess | undefined;
let testDir: string | undefined;

before(async () => {
  if (skipReason) return;
  // 起 herdr server（如未起）。herdr 命令自带 server-fork，但 detach 有时失败；
  // 我们显式拉一个 `herdr server`（v0.9.0 用 `herdr` 默认 fork；保险起见跑一遍）。
  try {
    const probe = spawnSync(HERDR_BIN, ["status", "server"], { timeout: 3_000, encoding: "utf8" });
    if (probe.status === 0 && /running/i.test(probe.stdout ?? "")) return;
  } catch { /* fallthrough */ }
  // 后台起 `herdr`，它会 fork server 然后退出；自己保留一个空闲进程防 server 退出。
  herdrServerProc = spawn(HERDR_BIN, ["server"], {
    detached: true, stdio: "ignore", env: { ...process.env, TERM: "xterm-256color" },
  });
  herdrServerProc.unref();
  // 等 server socket 就绪
  for (let i = 0; i < 30; i++) {
    if (existsSync(join(homedir(), ".config", "herdr", "herdr.sock"))) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  // 实在起不来就让 skip 路径接住
});

after(async () => {
  // 清理 test 工作目录（herdr workspace 由 herdr 自己生命周期管理；
  // 我们只清本地 fixture 文件）。
  if (testDir) try { rmSync(testDir, { recursive: true, force: true }); } catch { /* ignore */ }
  // 不主动杀 server：测试间复用，留给系统清理。
  herdrServerProc = undefined;
});

test("herdr --version is parseable", { skip: skipReason ?? undefined }, () => {
  const out = spawnSync(HERDR_BIN, ["--version"], { encoding: "utf8" }).stdout ?? "";
  const version = parseHerdrVersion(out);
  assert.ok(version, `parseHerdrVersion should extract version, got: ${JSON.stringify(out)}`);
  assert.match(version, /^herdr\s+\d/);
});

test("HerdrAdapter.discoverAgents finds installed kinds when herdr is available", { skip: skipReason ?? undefined }, async () => {
  const agents = await new HerdrAdapter().discoverAgents();
  // 装了 herdr：要么发现全 13 个 kind，要么包含 claude（测试用的 kind）。
  if (agents.length === 1 && agents[0]?.available === false) {
    // herdr 装了但 discover 报 unavailable（极少见，e.g. 权限）——允许 skip。
    assert.match(agents[0]?.unavailableReason ?? "", /herdr CLI/);
    return;
  }
  assert.equal(agents.length, HERDR_KINDS.length);
  const claude = agents.find((a) => a.agentId === `herdr:${TEST_KIND}`);
  assert.ok(claude, `expected herdr:${TEST_KIND} in discover`);
  assert.equal(claude?.available, true);
});

test("createSession + send produces a real Claude Code response via Herdr", { skip: skipReason ?? undefined }, async () => {
  testDir = mkdtempSync(join(tmpdir(), "phonon-herdr-e2e-"));
  const cwd = testDir;
  const adapter = new HerdrAdapter({ env: { binPath: HERDR_BIN, defaultKind: TEST_KIND, pollIntervalMs: 200, turnTimeoutSeconds: 120 } });
  const session = await adapter.createSession({ sessionId: `e2e-${Date.now()}`, agentId: `herdr:${TEST_KIND}`, model: "sonnet", cwd });
  const events: Array<{ type: string; text?: string; status?: string; message?: string }> = [];
  let detachTimer: NodeJS.Timeout | undefined;
  const abort = new AbortController();
  detachTimer = setTimeout(() => abort.abort(), 90_000);
  try {
    await session.send(
      `Reply with EXACTLY one line: "${RESPONSE_TOKEN}". No other text.`,
      { turnId: "t1", verbosity: "messages", emit: (e) => events.push(e as { type: string; text?: string; status?: string; message?: string }), signal: abort.signal },
    );
  } finally {
    if (detachTimer) clearTimeout(detachTimer);
  }
  await session.terminate().catch(() => undefined);

  // 断言：必须有一个 terminal result 事件。
  const result = events.find((e) => e.type === "result") as { status: string; text?: string } | undefined;
  assert.ok(result, `expected result event, got: ${JSON.stringify(events.map((e) => e.type))}`);
  assert.equal(result?.status, "completed", `expected status=completed, got status=${result?.status} text=${result?.text?.slice(0, 200)}`);

  // 断言：最终发出的 text 必须包含 marker（trust dialog 通过 + Claude 实际响应）。
  const text = result?.text ?? "";
  assert.ok(text.includes(RESPONSE_TOKEN), `expected response to contain ${RESPONSE_TOKEN}, got: ${text.slice(0, 500)}`);
});

test("HerdrAdapter survives when herdr server is missing — returns unavailable descriptor", async () => {
  // 指向不存在的二进制，模拟 herdr 完全不可用。
  const a = new HerdrAdapter({ env: { binPath: "/nonexistent/herdr" } });
  const agents = await a.discoverAgents();
  assert.equal(agents.length, 1);
  assert.equal(agents[0]?.available, false);
  assert.match(agents[0]?.unavailableReason ?? "", /herdr CLI not found/);
});