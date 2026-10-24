import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from "node:fs";
import { basename, isAbsolute, matchesGlob, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const PLUGIN_ID = "agent-phonon-hitl";
export const NATIVE_TOOLS = ["phonon_request_interaction", "phonon_acknowledge_interaction", "phonon_conversation_board", "phonon_workflow", "phonon_conversation_message", "phonon_publish_document"];
const hash = value => createHash("sha256").update(value).digest("hex");
const object = value => value && typeof value === "object" && !Array.isArray(value);
const patterns = value => {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some(item => typeof item !== "string")) throw new Error("Unrecognized tool policy; no plan produced");
  return value;
};
const covers = (list, name) => patterns(list).some(pattern => pattern === PLUGIN_ID || pattern === "group:plugins" || matchesGlob(name.toLowerCase(), pattern.toLowerCase()));
const exposesNative = tools => NATIVE_TOOLS.some(name => covers(tools?.allow, name) || covers(tools?.alsoAllow, name));

/** Pure, intentionally narrow merge-patch planner. It never writes or calls a Gateway. */
export function planNativeEnable(config, scope) {
  if (!/^phn-[a-f0-9]{40}$/.test(scope.agentId) || !/^[a-f0-9-]{36}$/.test(scope.employeeId)
    || !isAbsolute(scope.workspace) || basename(scope.workspace) !== scope.employeeId) throw new Error("Invalid owned DE scope");
  if (!object(config.agents?.entries) || !object(config.agents.entries[scope.agentId])) throw new Error("Owned native agent does not exist in agents.entries");
  const agent = config.agents.entries[scope.agentId];
  if (agent.workspace !== scope.workspace) throw new Error("Owned native workspace changed");
  const plugin = config.plugins?.entries?.[PLUGIN_ID];
  if (config.plugins?.enabled === false || !object(plugin) || plugin.enabled !== true || !config.plugins?.allow?.includes(PLUGIN_ID)) throw new Error("Existing plugin enablement requires separate authorization");
  if (exposesNative(config.tools)) throw new Error("Global policy would expose native tools beyond the owned DE");
  if (config.tools?.allow !== undefined) throw new Error("Global allowlist needs a separate native policy review");
  for (const [id, entry] of Object.entries(config.agents.entries)) {
    if (id !== scope.agentId && exposesNative(entry.tools)) throw new Error("An unrelated agent already grants native plugin tools; review exposure separately");
  }
  if (NATIVE_TOOLS.some(name => covers(config.tools?.deny, name) || covers(agent.tools?.deny, name))) throw new Error("Native tools are explicitly denied; denials were not removed");
  const tools = agent.tools ?? {};
  if (!object(tools) || tools.allow !== undefined && tools.alsoAllow !== undefined) throw new Error("Unrecognized owned tool policy");
  const field = tools.allow !== undefined ? "allow" : "alsoAllow";
  const merged = [...new Set([...patterns(tools[field]), ...NATIVE_TOOLS])];
  return {
    mode: "plan-only", authorizationRequired: true, pluginId: PLUGIN_ID,
    employeeId: scope.employeeId, nativeAgentId: scope.agentId, workspace: scope.workspace,
    mergePatch: { plugins: { entries: { [PLUGIN_ID]: { config: { nativeInteractions: true } } } }, agents: { entries: { [scope.agentId]: { tools: { [field]: merged } } } } },
    preserved: { otherAgentIds: Object.keys(config.agents.entries).filter(id => id !== scope.agentId),
      globalToolsSha256: hash(JSON.stringify(config.tools ?? null)),
      otherAgentsSha256: hash(JSON.stringify(Object.fromEntries(Object.entries(config.agents.entries).filter(([id]) => id !== scope.agentId)))),
      pluginLoadPathsSha256: hash(JSON.stringify(config.plugins.load ?? null)),
      otherPluginsSha256: hash(JSON.stringify(Object.fromEntries(Object.entries(config.plugins.entries).filter(([id]) => id !== PLUGIN_ID)))),
      legacyPluginSettingsPreserved: true },
    next: "After explicit authorization only: install the prepared artifact, obtain current config.get baseHash, submit this mergePatch through config.patch, and inspect the native plugin lifecycle receipt. This helper does not activate anything.",
  };
}

function readOwnedFile(path, maximum) {
  if (!isAbsolute(path) || realpathSync(path) !== path) throw new Error("Expected canonical absolute path");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.nlink !== 1 || before.uid !== process.getuid() || before.size > maximum || (before.mode & 0o022) !== 0) throw new Error("Unsafe owned file");
    const bytes = readFileSync(fd), after = fstatSync(fd), current = lstatSync(path);
    if (before.dev !== current.dev || before.ino !== current.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error("Owned file changed during inspection");
    return bytes;
  } finally { closeSync(fd); }
}

export function inspectPlan(args) {
  const allowed = new Set(["--config", "--agent", "--employee", "--workspace", "--expected-config-sha256"]), values = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i], value = args[i + 1];
    if (!allowed.has(key) || values[key] !== undefined || !value) throw new Error("Planning-only arguments required; no apply/install/restart mode exists");
    values[key] = value;
  }
  for (const key of ["--config", "--agent", "--employee", "--workspace"]) if (!values[key]) throw new Error("Missing owned DE planning argument");
  const scope = { agentId: values["--agent"], employeeId: values["--employee"], workspace: values["--workspace"] };
  if (realpathSync(scope.workspace) !== scope.workspace) throw new Error("Workspace is not canonical");
  const directory = lstatSync(scope.workspace);
  if (!directory.isDirectory() || directory.uid !== process.getuid() || (directory.mode & 0o022) !== 0) throw new Error("Unsafe owned workspace");
  const marker = readOwnedFile(resolve(scope.workspace, "IDENTITY.md"), 65_536).toString("utf8").match(/<!-- phonon-employee:([a-f0-9-]{36}):([a-f0-9-]+) -->/);
  if (!marker || marker[1] !== scope.employeeId || marker[2].length < 16) throw new Error("Owned employee marker could not be verified");
  if (readOwnedFile(resolve(scope.workspace, ".phonon-employee"), 256).toString("utf8") !== marker[2]) throw new Error("Local employee nonce differs from native ownership");
  const bytes = readOwnedFile(values["--config"], 2 * 1024 * 1024), sha256 = hash(bytes);
  if (values["--expected-config-sha256"] && values["--expected-config-sha256"] !== sha256) throw new Error("Configuration changed; re-inspect before authorization");
  let config;
  try { config = JSON.parse(bytes); } catch { throw new Error("Configuration is invalid JSON; no plan produced"); }
  return { ...planNativeEnable(config, scope), sourceConfig: { path: values["--config"], sha256 }, employeeMarkerVerified: true };
}

const invoked = process.argv[1]?.startsWith("--") || process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  try { process.stdout.write(JSON.stringify(inspectPlan(process.argv.slice(process.argv[1]?.startsWith("--") ? 1 : 2)), null, 2) + "\n"); }
  catch (error) { process.stderr.write((error instanceof Error ? error.message : "Planning failed") + "\n"); process.exitCode = 1; }
}
