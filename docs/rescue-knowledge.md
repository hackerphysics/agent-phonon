# Rescue repair knowledge pack

Rescue has a **bundled, read-only, structured knowledge index**, not conversation memory or a vector database. Every new session receives the short lookup instruction and the existing official AI SDK `tool` interface. It retrieves only the applicable procedures, not whole acceptance reports in the system prompt.

## Product integration and distribution

- Authored source: `packages/core/src/rescue-knowledge-source.md`.
- Structured applicability/evidence manifest: `packages/core/src/rescue-knowledge-manifest.json`.
- Generated typed registry: `packages/core/src/rescue-knowledge-data.ts`.
- Pure query/validation: `packages/core/src/rescue-knowledge.ts`.
- Rescue adapter: `packages/core/src/adapters/rescue.ts`.
- Integration generator/check: `scripts/generate-rescue-knowledge.mjs`; `pnpm run knowledge:check` is also part of the consistency gate.

The source was authored with `skill_workshop`, proposal `phonon-rescue-repairs-20260909-c7f535f960`, revised version v4. That **OpenClaw proposal remains pending, not applied/installed**. The user separately authorized product integration: the tool-authored body is imported as product data with its SHA256 in the manifest. This does not alter the assistant's prompts, global skills, or OpenClaw installation. Product knowledge works without that proposal directory or authoring tool at runtime.

The existing Phonon SkillManager installs project/global agent skills, but Rescue declares no skill management and did not load installed skill files. It is therefore not used as an implicit runtime dependency. Existing `ai`/`zod` tools suffice; no new dependency, external retrieval service, embedding model, vector database or arbitrary file loader was added.

`tsup` statically imports and inlines the typed registry into both daemon/CLI bundles. `agent-phonon` publishes `dist`; no read from cwd, HOME, this assistant's workspace, or historical acceptance paths is needed. Historical evidence links and hashes are provenance, not runtime fetch instructions. The optional Python GPT sidecar itself is **not** shipped/installed by this pack.

## Internal tool, not new wire RPC

`query_knowledge` is a Rescue-only tool with `action: list | search | get` and optional `id`, `agent`, `version`, `platform`, `protocol`, `text`, `limit` (1–10). Extra fields, paths, writes and oversized text are rejected. Search is deterministic bounded keyword matching, with metadata only; get returns procedure steps only when context matches. Known native version display strings are exact aliases in the manifest; unknown build/prerelease suffixes are not stripped. Linux is the only verified native platform.

The adapter instructs Rescue to list targets/diagnose, search by native agent/version/platform/protocol, retrieve the applicable entry and `common-config-safety`, then use existing checksum-gated maintenance tools. Queries/results flow through the existing `tool_call`/`tool_result` stream with a real toolCallId; the returned pack version, entry ID and SHA256 revision provide an auditable record. The model is instructed to cite used IDs/revisions in its final answer.

No server→phonon method was added. The protocol method registry and TS/Python public SDK surface are unchanged; both SDKs can already observe the normal session tool events. This tool is not exposed as `device.queryKnowledge()` or an invented RPC.

## Pack 2026.09.14.1 (public provenance; procedures unchanged)

| Stable ID | Verified applicability | Evidence boundary |
| --- | --- | --- |
| `common-config-safety` | Linux product maintenance, JSON/JSONC/YAML/TOML/text | Live five-format edits/rollback; grants no target-agent schema knowledge |
| `opencode-custom-provider` | OpenCode 1.14.48, Chat | Native custom provider/default/small model, actual Read and final text |
| `claude-native-messages` | Claude Code 2.1.123, Messages | Live isolated daemon owner `claudeSettingsPath` (unreleased adapter-fixes revision), roles; not production/default migration |
| `claude-responses-final-items` | Claude Code 2.1.123; conditional LiteLLM 1.100.0/Python 3.13.12 and exact source hashes | Real two-dependent-Read/final text; requires separately verified running sidecar |
| `hermes-named-provider` | Hermes 0.16.0, Chat | Live isolated daemon native YAML routing, buffered same-ID tools, resume and structured failure/retry (unreleased adapter-fixes revision) |
| `codex-copilot-boundaries` | Limited discovery/format facts, not version-specific provider writes | Boundary-only: missing recipe cannot authorize a guessed patch |
| `rescue-wire-protocols` | Explicit product chat/responses/anthropic/gemini | Live Responses mutations; limited live Anthropic read; Gemini simulated only with prior native 404 |

Entries contain ID/revision, agent/version/platform/protocol, symptoms, prerequisites, ordered steps, verification, rollback and repository-relative evidence with hash/level. They contain no actual credentials, host-specific absolute paths, fixed local endpoint or model-specific default. The current application code is tied to the shipped product revision; runtime-safety entries with no agent version list are **not** claims that every native agent version supports a repair.

## Safety and extension

Knowledge lookup is informational and read-only even if maintenance read/write is denied. It does not change maintenance policy, registered files/root keys, service/package permissions, authorization, secret redaction, or D03/D08 behavior. Unknown agents return no match; unknown versions/platforms/protocols withhold repair bodies. The knowledge tool is not a new enforcement layer replacing the maintenance broker: actual mutations remain broker-gated. System guidance requires retrieval before repair; it is not a deterministic guarantee that every model turn follows the instruction.

Config data cannot overwrite the trusted registry. No runtime upload, learning, self-edit, skill-install or shell operation exists. New user-requested knowledge requires explicit authoring/review, source revision import, manifest/evidence update, registry generation, regression and cold-start acceptance. The consistency check rejects source/public-evidence hash drift, inconsistent historical provenance and stale generated resources. It does not silently bless a changed source hash.

Config readback/parse diagnosis is not native functional success. Required native tools may be outside Rescue's maintenance capabilities; in that case it must report the limit. Transport ACK, exit 0, or a stopped sidecar's settings file is never success evidence. GPT service setup/installation remains owner-managed; Rescue may inspect only pre-registered service status and cannot create a service or launch arbitrary shell commands.

## Acceptance

Evidence and Chinese report: `acceptance/rescue-knowledge-20260909-180412/`. The standalone package acceptance installs a `pnpm pack` tarball in a fresh temporary directory and uses its daemon bundle from a different cwd. Real model cold starts use separate daemon/database/WS/SDK/session instances and symptom-level prompts with user endpoint/model only. Native CLI verification is host-run, isolated and separately labeled, not falsely attributed to Rescue's tool permissions. No production deployment, commit, push or release is performed by this acceptance.

### 2026.09.09.3 implementation boundary

Only `claude-native-messages` and `hermes-named-provider` procedures were refreshed via the original pending proposal v4. The original manifest hashed `acceptance/adapter-fixes-20260909-192727/{REPORT.zh-CN.md,incremental.diff}`; pack 2026.09.14.1 now hashes bundled public projections and retains those original hashes as provenance. This is a source implementation revision, **not a new release and not a claim about all npm 0.9.1 installations**. Native Claude 2.1.123/Hermes 0.16.0 versions cannot identify the Phonon implementation. Before using these daemon-specific fixes, require owner deployment/build evidence containing that patch (or a verified descendant). An unknown application revision is a verification blocker, not permission to change configuration. Lookup applicability still gates the native version/platform/protocol; implementation verification is an explicit procedure precondition, not a new wire or runtime deployment-attestation API.

Pre-patch Claude lacks independent settings selection; patched owner `claudeSettingsPath` selects standalone settings without old endpoint/token mixing. Working Hermes YAML must not be rewritten to compensate for the old `-z/-m` routing defect: patched `hermes-bridge` retains native provider/profile loading, observes structured errors/tools and native resume ID, and advertises buffered delivery (`streaming:false`). Historical sidecars remain stopped; this pack neither deploys code nor starts services. Authoring evaluator returned zero evaluator results; hash/generator tests and cold-session acceptance are separate evidence, not an invented independent review.
