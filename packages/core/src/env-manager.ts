import { PhononError } from "./rpc.js";
import type { PhononStore } from "./store.js";
import { isDangerousChildEnvName, sanitizeRemoteEnvironment } from "./child-env.js";

type Scope = "global" | "project" | "skill";

export interface EnvTarget {
  scope: Scope;
  projectId?: string;
  agent?: string;
  skillName?: string;
}

function redact(value: string): string {
  if (value.length <= 4) return "****";
  return `****${value.slice(-4)}`;
}

function validateName(name: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new PhononError("errInvalidParams", `invalid env var name: ${name}`);
}

export class EnvManager {
  constructor(private tenantId: string, private store: PhononStore, private opts: { allowReveal: () => boolean }) {}

  set(params: EnvTarget & { name: string; value: string; secret?: boolean }) {
    validateName(params.name);
    if (isDangerousChildEnvName(params.name)) {
      throw new PhononError("errInvalidParams", `dangerous env var is not allowed: ${params.name}`);
    }
    const updatedAt = new Date().toISOString();
    this.store.envSet({ tenantId: this.tenantId, ...params, updatedAt });
    return { variable: this.describe({ ...params, updatedAt, secret: params.secret !== false }, false) };
  }

  delete(params: EnvTarget & { name: string }) {
    validateName(params.name);
    this.store.envDelete({ tenantId: this.tenantId, ...params });
    return { deleted: true as const, name: params.name };
  }

  list(filter: Partial<EnvTarget> & { reveal?: boolean }) {
    const reveal = !!filter.reveal;
    if (reveal && !this.opts.allowReveal()) throw new PhononError("errPolicyDenied", "env reveal disabled by policy");
    const rows = this.store.envList(this.tenantId, filter);
    return { variables: rows.map((r) => this.describe(r, reveal)) };
  }

  /** 返回本次执行应该注入的环境变量：global < project < skill。 */
  resolveForExecution(params: { projectId?: string; agent?: string; skills?: string[] }): Record<string, string> {
    const env: Record<string, string> = {};
    for (const r of this.store.envList(this.tenantId, { scope: "global" })) env[r.name] = r.value;
    if (params.projectId) for (const r of this.store.envList(this.tenantId, { scope: "project", projectId: params.projectId })) env[r.name] = r.value;
    if (params.projectId && params.agent && params.skills) {
      for (const skillName of params.skills) {
        for (const r of this.store.envList(this.tenantId, { scope: "skill", projectId: params.projectId, agent: params.agent, skillName })) env[r.name] = r.value;
      }
    }
    // Defense in depth for tenant rows written by old code or direct DB tools.
    return sanitizeRemoteEnvironment(env);
  }

  private describe(r: { scope: string; projectId?: string; agent?: string; skillName?: string; name: string; value: string; secret?: boolean; updatedAt?: string }, reveal: boolean) {
    return {
      scope: r.scope,
      projectId: r.projectId,
      agent: r.agent,
      skillName: r.skillName,
      name: r.name,
      value: reveal ? r.value : redact(r.value),
      redacted: !reveal,
      updatedAt: r.updatedAt,
    };
  }
}
