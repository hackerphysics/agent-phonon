/**
 * Environment variables controlled by a remote tenant that can change command
 * lookup, preload executable code, or redirect runtime/configuration loading.
 */
export const DANGEROUS_CHILD_ENV_NAMES = new Set([
  "PATH",
  "NODE_OPTIONS",
  "NODE_PATH",
  "BASH_ENV",
  "ENV",
  "PYTHONSTARTUP",
  "PYTHONPATH",
  "PYTHONHOME",
  "PERL5OPT",
  "PERL5LIB",
  "RUBYOPT",
  "RUBYLIB",
  "JAVA_TOOL_OPTIONS",
  "_JAVA_OPTIONS",
  "JDK_JAVA_OPTIONS",
  "CLASSPATH",
  "GIT_SSH",
  "GIT_SSH_COMMAND",
  "GIT_EXEC_PATH",
  "HOME",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "SHELL",
  "COMSPEC",
  "PATHEXT",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
]);

// These values describe the trusted device environment and are needed by many
// CLIs. Preserve the inherited value, but never accept a remote replacement.
const PRESERVED_INHERITED_NAMES = new Set([
  "PATH",
  "HOME",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "SHELL",
  "COMSPEC",
  "PATHEXT",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
]);

function comparableName(name: string, platform: NodeJS.Platform): string {
  return platform === "win32" ? name.toUpperCase() : name;
}

/** LD_* and DYLD_* are blocked as families; Windows matching is case-insensitive. */
export function isDangerousChildEnvName(name: string, platform: NodeJS.Platform = process.platform): boolean {
  const candidate = comparableName(name, platform);
  return DANGEROUS_CHILD_ENV_NAMES.has(candidate)
    || candidate.startsWith("LD_")
    || candidate.startsWith("DYLD_")
    || candidate.startsWith("GIT_CONFIG_");
}

/** Remove unsafe keys from an untrusted/remote environment overlay. */
export function sanitizeRemoteEnvironment(
  environment?: Record<string, string>,
  platform: NodeJS.Platform = process.platform,
): Record<string, string> {
  const safe: Record<string, string> = {};
  for (const [name, value] of Object.entries(environment ?? {})) {
    if (!isDangerousChildEnvName(name, platform)) safe[name] = value;
  }
  return safe;
}

/**
 * Build the environment for an adapter/project child process.
 *
 * Execution hooks/load paths are stripped even when present in the daemon's
 * inherited environment. Device PATH/HOME and related platform identity values
 * remain available, while the remote overlay can only add ordinary variables.
 */
export function buildChildProcessEnvironment(
  remoteOverlay?: Record<string, string>,
  inherited: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const child: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(inherited)) {
    if (value === undefined) continue;
    const comparable = comparableName(name, platform);
    if (isDangerousChildEnvName(name, platform) && !PRESERVED_INHERITED_NAMES.has(comparable)) continue;
    child[name] = value;
  }
  Object.assign(child, sanitizeRemoteEnvironment(remoteOverlay, platform));
  return child;
}
