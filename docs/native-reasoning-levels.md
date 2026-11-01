# Native Reasoning Levels

Phonon retains every advertised native effort identifier, not a shared three- or
five-level whitelist. Identifiers are lowercase ASCII names of 1-64 characters
(`^[a-z][a-z0-9_-]{0,63}$`); a model catalog contains at most 64 distinct levels.
This is a bounded vocabulary contract, not a declaration that every model
supports every name.

The historical `standard` preference maps to native `medium`. Other values,
including `off`, `none`, `minimal`, `xhigh`, `max`, `ultra`, `auto`, `adaptive`,
`ultracode` and future advertised identifiers, remain distinct. A null level
removes Phonon's override and restores native default resolution; it does not
request `off` or `none`.

`native_reasoning_levels_v1` in device capabilities identifies a controller that
can accept the extensible vocabulary. `turn_reasoning_v1`,
`best_effort_reasoning_v1` and the adapter's `reasoningControl` are still required.
Catalog absence, native clamping and missing confirmation never reject the
original input or replay an execution to obtain setting evidence.

## Native Adapters

- Codex and Copilot retain native per-model effort metadata and pass the selected
  value on the original invocation. Confirmation must match the native model,
  Session and original turn evidence.
- Pi mirrors its installed native thinking contract: `off` for nonreasoning
  models; `off`, `minimal`, `low`, `medium`, `high`, and explicitly mapped
  `xhigh`/`max` for reasoning models. Null model mappings exclude levels. The
  native RPC state determines confirmation, never the requested CLI flag.
- Hermes derives CLI-accepted values from native help, without overwriting
  explicit per-model evidence. CLI acceptance does not prove downstream provider
  semantics. The structured bridge retains actual bounded native effort values.
- OpenClaw Gateway retains native model thinking lists and session-patch
  confirmation. The retired local one-shot execution path remains unavailable;
  reasoning is not a way around native tool-policy qualification.
- OpenCode maps enabled, unambiguous native effort variants to their actual
  variant names. Duplicate conflicting variants remain unselectable instead of
  silently choosing one. Flags are not setting-application proof.
- Claude Code uses an installed `--effort` option when available, deriving its
  listed choices from native help or respecting explicit owner model metadata.
  CLI and SDK peer-runner paths preserve the value. Versions without the flag
  do not advertise a fabricated menu. No application receipt is inferred from
  a flag or successful execution.

## Verification

The protocol, SDK, adapter, original-turn and optional-confirmation tests cover
extended values and retain permission/cancellation checks. Python SDK forwards
the same per-turn dictionary. No owner settings are modified by the real
metadata probe, and no prompt or model execution is sent by discovery.

Phonon Work implements server persistence, legacy-reader protection, MCP tool
schemas and native mobile selectors. See that repository's
`docs/native-reasoning-levels.md` for its migration and client contract.
