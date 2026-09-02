import { z } from "zod";

export const GRAPH_SCHEMA_VERSION = 2;

export const hostRecordSchema = z.object({
  hostId: z.string().min(1),
  hostName: z.string().min(1),
  scope: z.literal("local"),
  createdAt: z.string().datetime(),
  lastSeenAt: z.string().datetime()
});

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
  hostId: z.string().min(1),
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
  adapterId: z.string().optional(),
  hostId: z.string().optional()
});

export const systemSnapshotSchema = z.object({
  version: z.number().int().positive(),
  host: hostRecordSchema,
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
export type ApiError = z.infer<typeof apiErrorSchema>;
export type ApiMeta = z.infer<typeof apiMetaSchema>;
export type HostRecord = z.infer<typeof hostRecordSchema>;
export type SystemSnapshot = z.infer<typeof systemSnapshotSchema>;

export type ApiEnvelope<T> =
  | { ok: true; data: T; meta: ApiMeta }
  | { ok: false; error: ApiError; meta: ApiMeta };

