import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parsePiSessionFlags, probePiSessionFlags, PiAdapter } from "@agent-phonon/core";

/**
 * Regression guard for a real Pi incompatibility (2026-10-15).
 *
 * The adapter was written from pi-mono `main` docs, which document
 * `--session-id` (create-if-absent) and `--name`. The installed Pi 0.70.6 has
 * neither and aborts with `Error: Unknown option: --session-id`, so every Pi
 * session failed on this machine despite unit tests passing — the fixtures came
 * from the same docs that were wrong.
 *
 * The fix probes `pi --help` instead of assuming. These fixtures use help text
 * captured from real installs, not from documentation.
 */

const REAL_0706_HELP = `Usage:
  pi [options] [--] [@files...] [messages...]

Options:
  -p, --print                     Run the supplied prompts, print the final assistant
                                  text, then exit
      --mode text                 Select text output
      --mode json                 Run the supplied prompts, write JSONL events to
                                  stdout, then exit
      --mode rpc                  Read JSONL commands from stdin
  -c, --continue                  Continue previous session
  -r, --resume                    Select a session to resume
      --session <path|id>         Use specific session file or partial UUID
      --fork <path|id>            Fork specific session file or partial UUID
      --session-dir <dir>         Directory for session storage and lookup
      --no-session                Don't save session (ephemeral)
  -v, --version                   Shows the Pi version, then exits
`;

const NEWER_HELP = `Options:
      --session-id <id>           Opens the exact project session ID or creates it if absent
  -n, --name <name>               Sets the session display name
  -c, --continue                  Continue previous session
      --session <path|id>         Opens by file path, exact ID, or partial ID
`;

test("Pi 0.70.6 help exposes no create-if-absent session selector", () => {
  const flags = parsePiSessionFlags(REAL_0706_HELP);
  assert.equal(flags.sessionId, false, "0.70.6 has no --session-id; passing it aborts the process");
  assert.equal(flags.name, false, "0.70.6 has no --name");
  // These two do exist, so the adapter may still chain turns via them.
  assert.equal(flags.session, true);
  assert.equal(flags.continueFlag, true);
});

test("newer Pi help is detected as deterministic-session capable", () => {
  const flags = parsePiSessionFlags(NEWER_HELP);
  assert.equal(flags.sessionId, true);
  assert.equal(flags.name, true);
  assert.equal(flags.continueFlag, true);
});

test("adapter does not claim nativeSession when the installed Pi cannot select a session", () => {
  // Point at a binary that is not Pi at all: probe finds nothing, so the adapter
  // must not advertise deterministic native sessions it cannot deliver.
  const adapter = new PiAdapter({ env: { binPath: "/nonexistent/pi" } });
  assert.equal(adapter.capabilities.nativeSession, false,
    "must not claim nativeSession when no create-if-absent selector exists");
});

test("real installed Pi help (on PATH) is classified without crashing", () => {
  // Non-fatal by design: on a machine without Pi the probe yields all-false.
  const flags = probePiSessionFlags("pi");
  assert.equal(typeof flags.sessionId, "boolean");
  assert.equal(typeof flags.name, "boolean");
  // Whatever this machine has, the adapter must agree with the probe rather than
  // with hard-coded optimism.
  const adapter = new PiAdapter();
  assert.equal(adapter.capabilities.nativeSession, flags.sessionId || flags.name);
});
