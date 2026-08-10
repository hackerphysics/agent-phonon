import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeConfig, redactConfig, defaultConfig, configureRescueAgent } from "./config.js";

/** config 安全回归测试（bug-bash#2 B4：chmod 600 + 脱敏）。 */

test("config: writeConfig sets 0600 permissions", () => {
  const path = join(mkdtempSync(join(tmpdir(), "phonon-cfg-")), "config.json");
  const cfg = defaultConfig();
  cfg.adapters = [{ type: "openclaw-gateway", gatewayToken: "secret-gw-token" }];
  writeConfig(cfg, path);
  const mode = statSync(path).mode & 0o777;
  assert.equal(mode, 0o600, `expected 0600, got ${mode.toString(8)}`);
});

test("config: rescue API key is redacted and file/env references remain usable", () => {
  const cfg = configureRescueAgent(defaultConfig(), {
    baseUrl: "https://example.test/v1/", model: "rescue-model", apiKey: "rescue-secret-1234",
  });
  assert.equal(cfg.rescueAgent?.baseUrl, "https://example.test/v1");
  assert.equal(cfg.rescueAgent?.model, "rescue-model");
  const redacted = redactConfig(cfg);
  assert.equal(redacted.rescueAgent?.apiKey, "***1234");
});

test("config: redactConfig masks all secrets but keeps last4", () => {
  const cfg = defaultConfig();
  cfg.adapters = [
    { type: "openclaw-gateway", gatewayToken: "gw-secret-1234" },
    { type: "claude-code", claudeAuthToken: "claude-secret-5678" },
    { type: "codex", codexApiKey: "codex-secret-9012" },
  ];
  cfg.rescueAgent = { enabled: true, baseUrl: "https://example.test/v1", model: "rescue", apiKey: "rescue-secret-6789" };
  cfg.servers = [{ url: "ws://x", deviceKey: "dev-secret-3456" }];
  cfg.hookBridge = { token: "hook-secret-7890" };
  cfg.obs = { token: "obs-secret-2345" };
  const json = JSON.stringify(redactConfig(cfg));
  for (const s of ["gw-secret-1234", "claude-secret-5678", "codex-secret-9012", "rescue-secret-6789", "dev-secret-3456", "hook-secret-7890", "obs-secret-2345"]) {
    assert.equal(json.includes(s), false, `secret leaked: ${s}`);
  }
  assert.ok(json.includes("1234"), "should keep last4 for identification");
});
