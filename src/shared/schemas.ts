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

// ---------------------------------------------------------------------------
// Adapter capability manifests (issue #2)
// ---------------------------------------------------------------------------

/** Shared runtime capability vocabulary. */
export const capabilitySchema = z.enum([
  "discovery",
  "config-read",
  "process-state",
  "endpoint-state",
  "model-inventory",
  "model-load-state",
  "memory-telemetry",
  "token-telemetry",
  "event-stream",
  "health-check",
  "action-start",
  "action-stop",
  "action-restart",
  "action-load-model",
  "action-unload-model",
  "action-configure",
  "action-backup",
  "action-restore"
]);

/** Capability availability: supported by manifest, but maybe unavailable now. */
export const capabilityStatusSchema = z.enum(["supported", "unsupported", "unavailable", "failed"]);

export const capabilityStateSchema = z.object({
  capability: capabilitySchema,
  status: capabilityStatusSchema,
  reason: z.string().optional()
});

export const refreshProfileSchema = z.object({
  /** Seconds between routine background refreshes. */
  intervalSeconds: z.number().int().positive(),
  /** True when the adapter should also run on demand / manual refresh. */
  onDemand: z.boolean().default(true)
});

export const actionTypeSchema = z.enum(["read", "dry-run", "configure"]);

export const adapterManifestSchema = z.object({
  adapterId: z.string().min(1),
  adapterName: z.string().min(1),
  manifestVersion: z.literal(1),
  /** Human-readable description of the adapter's boundary. */
  description: z.string().min(1),
  /** Where discovery evidence comes from. */
  discoverySources: z.array(z.string()).default([]),
  /** OS-level permissions the adapter relies on. */
  permissions: z.array(z.string()).default([]),
  refreshProfile: refreshProfileSchema,
  /** Telemetry coverage vocabulary. */
  telemetryCoverage: z.array(capabilitySchema).default([]),
  /** Capabilities this adapter can ever provide. */
  supportedCapabilities: z.array(capabilitySchema).default([]),
  /** Declared adapter actions (issue #17 uses these). */
  supportedActions: z.array(actionTypeSchema).default([])
});

export type Capability = z.infer<typeof capabilitySchema>;
export type CapabilityStatus = z.infer<typeof capabilityStatusSchema>;
export type CapabilityState = z.infer<typeof capabilityStateSchema>;
export type RefreshProfile = z.infer<typeof refreshProfileSchema>;
export type AdapterManifest = z.infer<typeof adapterManifestSchema>;

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

// ---------------------------------------------------------------------------
// Managed Resource Registry (issue #3)
// ---------------------------------------------------------------------------

export const registryKindSchema = z.enum(["match", "supplement", "ignore"]);

export const registryEntrySchema = z.object({
  id: z.string().min(1),
  hostId: z.string().min(1),
  kind: registryKindSchema,
  /** Adapter id this entry targets; omitted for endpoint-only supplements. */
  adapterId: z.string().optional(),
  resourceType: resourceTypeSchema,
  /** Stable key used to match a discovered resource. */
  stableKey: z.string().min(1),
  label: z.string().min(1),
  /** Custom endpoint contributed by the operator. */
  customEndpoint: z.string().optional(),
  /** Managed resources are the only ones eligible for declared actions. */
  managed: z.boolean().default(false),
  note: z.string().optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
});

/** How a discovered resource relates to registry intent. */
export const mergeStatusSchema = z.enum([
  "discovered",
  "registered",
  "configured",
  "live",
  "managed",
  "unverified",
  "conflict"
]);

export const registryMergeSchema = z.object({
  resourceId: z.string().min(1),
  status: mergeStatusSchema,
  /** Human-readable evidence of how discovery and registry intent merged. */
  evidence: z.array(z.string()).default([])
});

export type RegistryKind = z.infer<typeof registryKindSchema>;
export type RegistryEntry = z.infer<typeof registryEntrySchema>;
export type MergeStatus = z.infer<typeof mergeStatusSchema>;
export type RegistryMerge = z.infer<typeof registryMergeSchema>;

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

