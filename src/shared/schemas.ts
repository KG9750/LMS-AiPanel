import { z } from "zod";

export const GRAPH_SCHEMA_VERSION = 1;

export const resourceTypeSchema = z.enum([
  "tool",
  "assistant",
  "model",
  "runtime",
  "config",
  "skill",
  "mcp",
  "process",
  "container",
  "channel",
  "port",
  "volume"
]);

export const resourceStateSchema = z.enum([
  "ok",
  "warning",
  "error",
  "unknown",
  "stopped",
  "running"
]);

export const edgeRelationSchema = z.enum([
  "uses",
  "configured_by",
  "runs_on",
  "exposes",
  "binds_to",
  "depends_on",
  "owns",
  "watches"
]);

export const jsonRecordSchema = z.record(z.string(), z.unknown());

export const resourceNodeSchema = z.object({
  id: z.string().min(1),
  type: resourceTypeSchema,
  label: z.string().min(1),
  state: resourceStateSchema,
  sourceAdapter: z.string().min(1),
  properties: jsonRecordSchema.default({}),
  lastSeenAt: z.string().datetime(),
  graphSchemaVersion: z.literal(GRAPH_SCHEMA_VERSION)
});

export const resourceEdgeSchema = z.object({
  id: z.string().min(1),
  source: z.string().min(1),
  target: z.string().min(1),
  relation: edgeRelationSchema,
  properties: jsonRecordSchema.default({}),
  graphSchemaVersion: z.literal(GRAPH_SCHEMA_VERSION)
});

export const adapterRunStatusSchema = z.enum([
  "pending",
  "running",
  "success",
  "failed",
  "timeout",
  "stale"
]);

export const adapterRunSchema = z.object({
  runId: z.string().min(1),
  adapterId: z.string().min(1),
  startedAt: z.string().datetime(),
  finishedAt: z.string().datetime().optional(),
  status: adapterRunStatusSchema,
  durationMs: z.number().int().nonnegative().optional(),
  error: z.string().optional(),
  stale: z.boolean()
});

export const redactionHintSchema = z.object({
  resourceId: z.string().optional(),
  path: z.array(z.string()),
  reason: z.string().default("sensitive")
});

export const adapterResultSchema = z.object({
  nodes: z.array(resourceNodeSchema),
  edges: z.array(resourceEdgeSchema),
  redactionHints: z.array(redactionHintSchema).default([])
});

export const driftStatusSchema = z.enum([
  "ok",
  "drift-config",
  "drift-runtime",
  "unreachable",
  "unknown"
]);

export const severitySchema = z.enum(["info", "warning", "critical"]);

export const driftRecordSchema = z.object({
  id: z.string().min(1),
  resourceId: z.string().min(1),
  status: driftStatusSchema,
  configured: jsonRecordSchema.default({}),
  live: jsonRecordSchema.default({}),
  evidence: z.array(z.string()).default([]),
  severity: severitySchema,
  createdAt: z.string().datetime()
});

export const actionTypeSchema = z.enum(["read", "dry-run", "configure"]);

export const actionPlanRequestSchema = z
  .object({
    resourceId: z.string().min(1),
    action: actionTypeSchema
  })
  .strict();

export const actionPlanSchema = z.object({
  actionId: z.string().min(1),
  resourceId: z.string().min(1),
  type: actionTypeSchema,
  dryRunCommands: z.array(z.string()).default([]),
  affectedResources: z.array(z.string()).default([]),
  requiresConfirm: z.boolean(),
  requiresBackup: z.boolean(),
  reversible: z.boolean(),
  riskLevel: z.enum(["low", "medium", "high"]),
  disabledReason: z.string().optional()
});

export const apiErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
  evidence: z.array(z.string()).optional(),
  adapterId: z.string().optional()
});

export const apiMetaSchema = z.object({
  timestamp: z.string().datetime(),
  requestId: z.string().optional(),
  adapterId: z.string().optional()
});

export const systemSnapshotSchema = z.object({
  nodes: z.array(resourceNodeSchema),
  edges: z.array(resourceEdgeSchema),
  adapterRuns: z.array(adapterRunSchema),
  driftRecords: z.array(driftRecordSchema)
});

export type ResourceType = z.infer<typeof resourceTypeSchema>;
export type ResourceState = z.infer<typeof resourceStateSchema>;
export type EdgeRelation = z.infer<typeof edgeRelationSchema>;
export type ResourceNode = z.infer<typeof resourceNodeSchema>;
export type ResourceEdge = z.infer<typeof resourceEdgeSchema>;
export type AdapterRun = z.infer<typeof adapterRunSchema>;
export type AdapterRunStatus = z.infer<typeof adapterRunStatusSchema>;
export type RedactionHint = z.infer<typeof redactionHintSchema>;
export type AdapterResult = z.infer<typeof adapterResultSchema>;
export type DriftRecord = z.infer<typeof driftRecordSchema>;
export type ActionPlan = z.infer<typeof actionPlanSchema>;
export type ActionPlanRequest = z.infer<typeof actionPlanRequestSchema>;
export type ApiError = z.infer<typeof apiErrorSchema>;
export type ApiMeta = z.infer<typeof apiMetaSchema>;
export type SystemSnapshot = z.infer<typeof systemSnapshotSchema>;

export type ApiEnvelope<T> =
  | { ok: true; data: T; meta: ApiMeta }
  | { ok: false; error: ApiError; meta: ApiMeta };

export type SkillManagerPlatform = "codex" | "claude";
export type SkillManagerScope = "user" | "project";
export type SkillManagerStatus =
  | "enabled"
  | "disabled"
  | "readonly"
  | "manual_restore_candidate"
  | "conflict_disabled_duplicate";
export type SkillManagerValidationState = "OK" | "WARN" | "ERROR" | "UNKNOWN";

export interface SkillManagerIssue {
  severity: "INFO" | "WARN" | "ERROR" | "UNKNOWN";
  code: string;
  message: string;
  paths?: string[];
}

export interface SkillManagerSkill {
  id: string;
  name: string;
  description: string;
  platform: SkillManagerPlatform;
  scope: SkillManagerScope;
  status: SkillManagerStatus;
  validationState: SkillManagerValidationState;
  issues: SkillManagerIssue[];
  skillMdPath: string;
  updatedAt: string | null;
}

export interface SkillManagerSummary {
  total: number;
  byPlatform: Record<SkillManagerPlatform, number>;
  byScope: Record<SkillManagerScope, number>;
  byStatus: Record<SkillManagerStatus, number>;
  byValidation: Record<SkillManagerValidationState, number>;
}

export interface SkillManagerPanelStatus {
  running: boolean;
  port: number;
  portOccupied: boolean;
  identityVerified: boolean;
  url: string | null;
  accessMessage: string;
  readonlyCommand: string;
}

export interface SkillManagerModuleSnapshot {
  configured: boolean;
  available: boolean;
  projectPath: string;
  cliPath: string;
  scannedAt: string;
  summary: SkillManagerSummary;
  skills: SkillManagerSkill[];
  rootWarnings: SkillManagerIssue[];
  recentSkills: SkillManagerSkill[];
  panel: SkillManagerPanelStatus;
  error?: string;
}

const skillManagerIssueSchema = z.object({
  severity: z.enum(["INFO", "WARN", "ERROR", "UNKNOWN"]),
  code: z.string().min(1),
  message: z.string().min(1),
  paths: z.array(z.string()).optional()
});

const skillManagerSkillSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string(),
  platform: z.enum(["codex", "claude"]),
  scope: z.enum(["user", "project"]),
  status: z.enum(["enabled", "disabled", "readonly", "manual_restore_candidate", "conflict_disabled_duplicate"]),
  validationState: z.enum(["OK", "WARN", "ERROR", "UNKNOWN"]),
  issues: z.array(skillManagerIssueSchema),
  skillMdPath: z.string(),
  updatedAt: z.string().nullable()
});

const skillManagerSummarySchema = z.object({
  total: z.number().int().nonnegative(),
  byPlatform: z.object({ codex: z.number().int().nonnegative(), claude: z.number().int().nonnegative() }),
  byScope: z.object({ user: z.number().int().nonnegative(), project: z.number().int().nonnegative() }),
  byStatus: z.object({
    enabled: z.number().int().nonnegative(),
    disabled: z.number().int().nonnegative(),
    readonly: z.number().int().nonnegative(),
    manual_restore_candidate: z.number().int().nonnegative(),
    conflict_disabled_duplicate: z.number().int().nonnegative()
  }),
  byValidation: z.object({
    OK: z.number().int().nonnegative(),
    WARN: z.number().int().nonnegative(),
    ERROR: z.number().int().nonnegative(),
    UNKNOWN: z.number().int().nonnegative()
  })
});

export const skillManagerModuleSnapshotSchema = z.object({
  configured: z.boolean(),
  available: z.boolean(),
  projectPath: z.string(),
  cliPath: z.string(),
  scannedAt: z.string().datetime(),
  summary: skillManagerSummarySchema,
  skills: z.array(skillManagerSkillSchema),
  rootWarnings: z.array(skillManagerIssueSchema),
  recentSkills: z.array(skillManagerSkillSchema),
  panel: z.object({
    running: z.boolean(),
    port: z.number().int().min(1).max(65_535),
    portOccupied: z.boolean(),
    identityVerified: z.boolean(),
    url: z.string().url().nullable(),
    accessMessage: z.string().min(1),
    readonlyCommand: z.string()
  }),
  error: z.string().optional()
});
