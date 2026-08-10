import { z } from "zod";
import { Timestamp } from "./common.js";

/**
 * Deterministic host-maintenance plane.
 *
 * Requests address locally configured target/config/service ids; the server can
 * never supply raw host paths, package names, service names, or shell strings.
 * Device policy remains authoritative for every action.
 */

export const MaintenancePermission = z.object({
  read: z.boolean(),
  configWrite: z.boolean(),
  packageUpdate: z.boolean(),
  serviceRestart: z.boolean(),
});
export type MaintenancePermission = z.infer<typeof MaintenancePermission>;

export const MaintenanceConfigDescriptor = z.object({
  configId: z.string().min(1),
  label: z.string().optional(),
  format: z.literal("json"),
  exists: z.boolean(),
  writable: z.boolean(),
});
export type MaintenanceConfigDescriptor = z.infer<typeof MaintenanceConfigDescriptor>;

export const MaintenanceServiceDescriptor = z.object({
  serviceId: z.string().min(1),
  label: z.string().optional(),
  configured: z.boolean(),
});
export type MaintenanceServiceDescriptor = z.infer<typeof MaintenanceServiceDescriptor>;

export const MaintenanceTargetDescriptor = z.object({
  targetId: z.string().min(1),
  label: z.string(),
  command: z.string().optional(),
  packageUpdateConfigured: z.boolean(),
  configs: z.array(MaintenanceConfigDescriptor),
  services: z.array(MaintenanceServiceDescriptor),
});
export type MaintenanceTargetDescriptor = z.infer<typeof MaintenanceTargetDescriptor>;

export const MaintenanceTargetsParams = z.object({}).strict();
export const MaintenanceTargetsResult = z.object({
  permissions: MaintenancePermission,
  targets: z.array(MaintenanceTargetDescriptor),
});

export const MaintenanceDiagnoseParams = z.object({
  targetId: z.string().min(1).optional(),
}).strict();
export const MaintenanceDiagnostic = z.object({
  targetId: z.string(),
  available: z.boolean(),
  version: z.string().optional(),
  versionError: z.string().optional(),
  configs: z.array(z.object({
    configId: z.string(),
    exists: z.boolean(),
    valid: z.boolean().optional(),
    sha256: z.string().optional(),
    error: z.string().optional(),
  })),
  services: z.array(z.object({
    serviceId: z.string(),
    status: z.enum(["running", "stopped", "unknown", "not_configured"]),
    detail: z.string().optional(),
  })),
});
export const MaintenanceDiagnoseResult = z.object({
  diagnostics: z.array(MaintenanceDiagnostic),
  at: Timestamp,
});

export const MaintenanceConfigGetParams = z.object({
  targetId: z.string().min(1),
  configId: z.string().min(1),
}).strict();
export const MaintenanceConfigGetResult = z.object({
  targetId: z.string(),
  configId: z.string(),
  exists: z.boolean(),
  sha256: z.string().optional(),
  /** Parsed JSON with secret-looking fields recursively redacted. */
  value: z.unknown().optional(),
});

export const MaintenanceConfigPatchParams = z.object({
  targetId: z.string().min(1),
  configId: z.string().min(1),
  /** Optimistic lock from maintenance.config.get. Required to prevent stale overwrite. */
  expectedSha256: z.string().min(1),
  /** RFC 7396-style JSON merge patch. Arrays are replaced as a whole. */
  patch: z.record(z.unknown()),
  reason: z.string().max(500).optional(),
  clientRequestId: z.string().optional(),
}).strict();
export const MaintenanceConfigPatchResult = z.object({
  targetId: z.string(),
  configId: z.string(),
  changed: z.boolean(),
  previousSha256: z.string(),
  sha256: z.string(),
  backupId: z.string().optional(),
});

export const MaintenanceRollbackParams = z.object({
  backupId: z.string().min(1).regex(/^[A-Za-z0-9._-]+$/),
  /** Current config hash, preventing a stale rollback from clobbering later edits. */
  expectedCurrentSha256: z.string().min(1),
  reason: z.string().max(500).optional(),
  clientRequestId: z.string().optional(),
}).strict();
export const MaintenanceRollbackResult = z.object({
  backupId: z.string(),
  targetId: z.string(),
  configId: z.string(),
  restored: z.literal(true),
  sha256: z.string(),
});

export const MaintenancePackageUpdateParams = z.object({
  targetId: z.string().min(1),
  version: z.string().min(1).max(100).optional(),
  clientRequestId: z.string().optional(),
}).strict();
export const MaintenancePackageUpdateResult = z.object({
  targetId: z.string(),
  manager: z.enum(["npm", "pnpm"]),
  packageName: z.string(),
  requestedVersion: z.string(),
  exitCode: z.number().int(),
  stdout: z.string(),
  stderr: z.string(),
  versionAfter: z.string().optional(),
});

export const MaintenanceServiceStatusParams = z.object({
  targetId: z.string().min(1),
  serviceId: z.string().min(1),
}).strict();
export const MaintenanceServiceStatusResult = z.object({
  targetId: z.string(),
  serviceId: z.string(),
  status: z.enum(["running", "stopped", "unknown", "not_configured"]),
  detail: z.string().optional(),
});

export const MaintenanceServiceRestartParams = z.object({
  targetId: z.string().min(1),
  serviceId: z.string().min(1),
  clientRequestId: z.string().optional(),
}).strict();
export const MaintenanceServiceRestartResult = z.object({
  targetId: z.string(),
  serviceId: z.string(),
  restarted: z.boolean(),
  status: z.enum(["running", "stopped", "unknown", "not_configured"]),
  detail: z.string().optional(),
});

export type MaintenanceTargetsParams = z.infer<typeof MaintenanceTargetsParams>;
export type MaintenanceTargetsResult = z.infer<typeof MaintenanceTargetsResult>;
export type MaintenanceDiagnoseParams = z.infer<typeof MaintenanceDiagnoseParams>;
export type MaintenanceDiagnoseResult = z.infer<typeof MaintenanceDiagnoseResult>;
export type MaintenanceConfigGetParams = z.infer<typeof MaintenanceConfigGetParams>;
export type MaintenanceConfigGetResult = z.infer<typeof MaintenanceConfigGetResult>;
export type MaintenanceConfigPatchParams = z.infer<typeof MaintenanceConfigPatchParams>;
export type MaintenanceConfigPatchResult = z.infer<typeof MaintenanceConfigPatchResult>;
export type MaintenanceRollbackParams = z.infer<typeof MaintenanceRollbackParams>;
export type MaintenanceRollbackResult = z.infer<typeof MaintenanceRollbackResult>;
export type MaintenancePackageUpdateParams = z.infer<typeof MaintenancePackageUpdateParams>;
export type MaintenancePackageUpdateResult = z.infer<typeof MaintenancePackageUpdateResult>;
export type MaintenanceServiceStatusParams = z.infer<typeof MaintenanceServiceStatusParams>;
export type MaintenanceServiceStatusResult = z.infer<typeof MaintenanceServiceStatusResult>;
export type MaintenanceServiceRestartParams = z.infer<typeof MaintenanceServiceRestartParams>;
export type MaintenanceServiceRestartResult = z.infer<typeof MaintenanceServiceRestartResult>;
