import fs from "node:fs/promises";
import path from "node:path";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import cors from "@fastify/cors";
import { nanoid } from "nanoid";
import { createDisabledControlPlan, createReadPlan, gateActionPlan } from "../domain/actionGateway";
import { ActionRunDriver, type AdapterActionExecutor } from "../domain/actionRun";
import { evaluateDrift } from "../domain/drift";
import { redactValue } from "../domain/redaction";
import { isStamped, stampHostId } from "../domain/scope";
import { mergeRegistry } from "../domain/registryMerge";
import { Scheduler } from "../domain/scheduler";
import { RefreshOrchestrator } from "../domain/refreshOrchestrator";
import { SseHub, type RefreshEvent } from "../domain/sseHub";
import { createAdapters } from "../adapters";
import { AdapterRuntime } from "../adapters/runtime";
import { resolveCapabilityStates, type StackAdapter } from "../adapters/types";
import { fail, ok } from "../shared/api";
import { adapterManifestSchema, metricSampleInputSchema, registryEntrySchema, type ApiEnvelope, type HostRecord, type RegistryEntry, type SystemSnapshot } from "../shared/schemas";
import { ensureStorage, type InitializedStorage } from "../storage/init";
import { getAppPaths } from "../storage/paths";
import { getOrCreateHost } from "../storage/host";
import { RegistryRepository } from "../storage/registry";
import { SnapshotStore } from "../storage/snapshots";
import { RefreshRunStore } from "../storage/refreshRuns";
import { MetricStore, type MetricLayer } from "../storage/metrics";
import { SessionStore, type LocalSession } from "../storage/sessions";
import { ActionRunStore } from "../storage/actionRuns";
import { ConfigCenter } from "../domain/configCenter";
import { closeDatabase } from "../storage/db";

export interface AppOptions {
  /** Overrides LMS_AIPANEL_DATA_DIR. Defaults to the env var or the platform path. */
  dataDir?: string;
  /** Port used to build allowed local origins. Defaults to LMS_AIPANEL_PORT. */
  port?: number;
  /** Session TTL in ms for tests (default 5 minutes). */
  sessionTtlMs?: number;
  /** Default config file path for the Config Center preview. */
  configPath?: string;
  /** Injectable adapters for tests. Defaults to the real read-only adapters. */
  adapters?: StackAdapter[];
  /** Per-adapter collection timeout in ms. */
  timeoutMs?: number;
  /** When false the background scheduler never auto-runs (tests). */
  schedulerAutoStart?: boolean;
  logger?: boolean;
}

export interface BuiltApp {
  app: FastifyInstance;
  storage: InitializedStorage;
  host: HostRecord;
  runtime: AdapterRuntime;
  registry: RegistryRepository;
  scheduler: Scheduler;
  sseHub: SseHub;
  refresher: RefreshOrchestrator;
  close: () => Promise<void>;
}

export async function buildApp(options: AppOptions = {}): Promise<BuiltApp> {
  if (options.dataDir) {
    process.env.LMS_AIPANEL_DATA_DIR = options.dataDir;
  }
  const port = options.port ?? Number(process.env.LMS_AIPANEL_PORT ?? 3777);
  const storage = await ensureStorage();
  const host = getOrCreateHost(storage.db);

  const adapters = options.adapters ?? createAdapters();

  // Manifest contract: every registered adapter must provide a valid,
  // versioned capability manifest. An invalid manifest is isolated (the
  // adapter is excluded with a recorded reason) instead of breaking the app.
  const manifestFailures: Array<{ adapterId: string; reason: string }> = [];
  const validAdapters: StackAdapter[] = [];
  for (const adapter of adapters) {
    const parsed = adapterManifestSchema.safeParse(adapter.manifest);
    if (!parsed.success) {
      manifestFailures.push({
        adapterId: adapter.id,
        reason: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")
      });
      continue;
    }
    if (parsed.data.adapterId !== adapter.id) {
      manifestFailures.push({ adapterId: adapter.id, reason: "manifest adapterId does not match adapter id" });
      continue;
    }
    validAdapters.push(adapter);
  }

  const runtime = new AdapterRuntime(validAdapters, options.timeoutMs ?? 5_000, host.hostId);
  const registry = new RegistryRepository(storage.db, host.hostId);
  const snapshotStore = new SnapshotStore(storage.db);
  const scheduler = new Scheduler(runtime, registry, snapshotStore, host, validAdapters, {
    fastIntervalMs: 30_000,
    slowIntervalMs: 120_000,
    autoStart: options.schedulerAutoStart ?? true
  });

  // Restore the latest persisted snapshot, then start background collection.
  scheduler.restore();
  scheduler.start();

  const refreshStore = new RefreshRunStore(storage.db);
  const sseHub = new SseHub();
  const refresher = new RefreshOrchestrator(refreshStore, scheduler, sseHub, host.hostId);
  const metrics = new MetricStore(storage.db);
  const sessions = new SessionStore(storage.db, host.hostId, options.sessionTtlMs);

  /** Allowed browser origins for write requests (issue #16). */
  const allowedOrigins = new Set([
    "http://127.0.0.1:5173",
    "http://localhost:5173",
    `http://127.0.0.1:${port}`,
    `http://localhost:${port}`
  ]);

  /** Origin Guard: rejects writes from disallowed origins (CSRF boundary). */
  const originGuard = (request: FastifyRequest): string | null => {
    const origin = request.headers.origin;
    if (!origin) return null; // CLI / non-browser clients carry no Origin header
    if (allowedOrigins.has(origin)) return null;
    return origin;
  };

  /** Session Guard: write endpoints require a valid short-lived session. */
  const sessionGuard = (request: FastifyRequest): LocalSession | null => {
    const token = request.headers["x-lms-session"] as string | undefined;
    return sessions.verify(token);
  };

  const auditLog: Array<Record<string, unknown>> = [];
  const appPaths = getAppPaths();

  /** Query path: returns the most recent COMPLETED snapshot without collecting. */
  const latestSnapshot = (): SystemSnapshot | null => scheduler.getLatest()?.snapshot ?? null;

  const app = Fastify({ logger: options.logger ?? false });

  const envelope = <T>(payload: ApiEnvelope<T>): ApiEnvelope<T> => {
    const withHost: ApiEnvelope<T> = {
      ...payload,
      meta: { ...payload.meta, hostId: host.hostId }
    };
    return redactValue(withHost) as ApiEnvelope<T>;
  };

  await app.register(cors, {
    origin: ["http://127.0.0.1:5173", "http://localhost:5173"]
  });

  app.get("/api/health", async () =>
    envelope(
      ok({
        service: "LMS-AiPanel",
        host: host.hostName,
        hostId: host.hostId,
        scope: host.scope,
        appPaths: {
          root: appPaths.root,
          storage: appPaths.storage,
          backups: appPaths.backups,
          logs: appPaths.logs
        }
      })
    )
  );

  app.get("/api/host", async () =>
    envelope(
      ok({
        host,
        scope: "local",
        storageRoot: appPaths.root
      })
    )
  );

  // ---- Local write session + Origin Guard (issue #16) ----

  /** Issues a short-lived local write session for browser writes. */
  app.post("/api/session", async (request) => {
    const badOrigin = originGuard(request);
    if (badOrigin) {
      return envelope(
        fail({
          code: "ORIGIN_DISALLOWED",
          message: `Origin ${badOrigin} is not allowed to issue sessions`
        })
      );
    }
    const session = sessions.issue("write");
    auditLog.push({
      id: `audit:${nanoid()}`,
      timestamp: new Date().toISOString(),
      actor: "local-user",
      action: "session:issue",
      resourceId: session.token.slice(0, 12),
      result: "issued"
    });
    // The issued session credential must reach the caller intact: it is the
    // one secret that is intentionally NOT redacted at this boundary.
    const raw: ApiEnvelope<{ token: string; expiresAt: string; purpose: string }> = ok({
      token: session.token,
      expiresAt: session.expiresAt,
      purpose: session.purpose
    });
    return { ...raw, meta: { ...raw.meta, hostId: host.hostId } };
  });

  app.post("/api/session/revoke", async (request) => {
    const token = (request.headers["x-lms-session"] as string | undefined) ?? "";
    sessions.revoke(token);
    return envelope(ok({ revoked: true }));
  });

  app.get("/api/session/status", async (request) => {
    const session = sessionGuard(request);
    return envelope(ok({ valid: Boolean(session), expiresAt: session?.expiresAt ?? null }));
  });

  /** Guards a write-capable route: session + origin checks. */
  const requireWrite = (request: FastifyRequest): LocalSession | null => {
    const badOrigin = originGuard(request);
    if (badOrigin) {
      return null;
    }
    return sessionGuard(request);
  };

  app.get("/api/graph", async () => {
    const snapshot = latestSnapshot();
    if (!snapshot) {
      // First run before any collection finished: kick off one collection.
      const collected = await scheduler.collect("all");
      return envelope(ok(collected.snapshot));
    }
    const unstamped = snapshot.nodes.filter((node) => !isStamped(node));
    if (unstamped.length > 0) {
      return envelope(
        fail({
          code: "UNSCOPED_RESOURCE",
          message: `${unstamped.length} resource(s) left the runtime without host scope`
        })
      );
    }
    return envelope(ok(snapshot));
  });

  app.get("/api/resources", async () => {
    const snapshot = latestSnapshot();
    return envelope(ok(snapshot ? snapshot.nodes : []));
  });

  app.get("/api/drift", async () => {
    const snapshot = latestSnapshot();
    return envelope(ok(snapshot ? snapshot.driftRecords : []));
  });

  // ---- Manual refresh with RefreshRun + SSE (issue #5) ----

  /** Starts a refresh and returns the run id immediately (non-blocking). */
  app.post("/api/refresh", async () => {
    const run = refresher.start();
    auditLog.push({
      id: `audit:${nanoid()}`,
      timestamp: new Date().toISOString(),
      actor: "local-user",
      action: "refresh:start",
      resourceId: run.runId,
      result: "started"
    });
    return envelope(ok({ runId: run.runId, status: "running", startedAt: run.startedAt }));
  });

  /** Poll a persisted refresh run (disconnect recovery). */
  app.get<{ Params: { id: string } }>("/api/refresh/:id", async (request) => {
    const run = refresher.get(request.params.id);
    if (!run) {
      return envelope(fail({ code: "NOT_FOUND", message: `No refresh run ${request.params.id}` }));
    }
    return envelope(ok(run));
  });

  /** Recent refresh run history. */
  app.get("/api/refresh", async () => envelope(ok(refreshStore.list(host.hostId, 20))));

  /** Cancels a running refresh. */
  app.post<{ Params: { id: string } }>("/api/refresh/:id/cancel", async (request) => {
    const run = refresher.cancel(request.params.id);
    if (!run) {
      return envelope(fail({ code: "NOT_FOUND", message: `No refresh run ${request.params.id}` }));
    }
    auditLog.push({
      id: `audit:${nanoid()}`,
      timestamp: new Date().toISOString(),
      actor: "local-user",
      action: "refresh:cancel",
      resourceId: run.runId,
      result: "cancelled"
    });
    return envelope(ok(run));
  });

  /** Server-sent events: live refresh progress. */
  app.get("/api/refresh/events", async (request, reply) => {
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no"
    });
    reply.raw.write("retry: 2000\n\n");

    const send = (event: RefreshEvent) => {
      const payload = `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
      reply.raw.write(payload);
    };
    const unsubscribe = sseHub.subscribe(send);
    const keepAlive = setInterval(() => {
      reply.raw.write(": ping\n\n");
    }, 15_000);

    request.raw.on("close", () => {
      clearInterval(keepAlive);
      unsubscribe();
    });
    return reply;
  });

  // ---- Token / memory time series with counter epochs (issue #11) ----

  /** Record one metric sample (gateway / adapters call this). */
  app.post<{
    Body: {
      scope: string;
      layer: string;
      metric: string;
      source: string;
      coverage: string;
      kind: "counter" | "gauge";
      value: number;
    };
  }>("/api/metrics", async (request) => {
    const parsed = metricSampleInputSchema.safeParse(request.body);
    if (!parsed.success) {
      return envelope(
        fail({
          code: "INVALID_METRIC_SAMPLE",
          message: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")
        })
      );
    }
    metrics.record({ hostId: host.hostId, sampleAt: new Date().toISOString(), ...parsed.data });
    return envelope(ok({ recorded: true }));
  });

  /** Current values and window deltas for a scope/metric. */
  app.get<{
    Querystring: { scope?: string; metric?: string; layer?: string; window?: string };
  }>("/api/metrics/series", async (request) => {
    const layer = (request.query.layer ?? "endpoint") as MetricLayer;
    const windowSeconds = Math.min(Number(request.query.window ?? 3600), 7 * 24 * 3600);
    if (!request.query.scope || !request.query.metric) {
      return envelope(ok({ scopes: metrics.listScopes(host.hostId) }));
    }
    const series = metrics.series(host.hostId, request.query.scope, request.query.metric, layer, windowSeconds);
    return envelope(ok(series));
  });

  // ---- Managed Resource Registry (issue #3) ----

  app.get("/api/registry", async () => {
    const snapshot = latestSnapshot();
    const nodes = snapshot ? snapshot.nodes : [];
    const merged = mergeRegistry(nodes, registry.list());
    return envelope(
      ok({
        entries: registry.list(),
        merges: merged.merges,
        attention: merged.attention
      })
    );
  });

  app.post<{ Body: Partial<RegistryEntry> }>("/api/registry", async (request) => {
    if (!requireWrite(request)) {
      return envelope(
        fail({
          code: "WRITE_GUARD_REJECTED",
          message: "Registry writes require a valid local session from an allowed origin"
        })
      );
    }
    const parsed = registryEntrySchema.omit({ id: true, hostId: true, createdAt: true, updatedAt: true }).safeParse(request.body);
    if (!parsed.success) {
      return envelope(
        fail({
          code: "INVALID_REGISTRY_ENTRY",
          message: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")
        })
      );
    }
    const entry = registry.create({ ...parsed.data, hostId: host.hostId } as never);
    auditLog.push({
      id: `audit:${nanoid()}`,
      timestamp: new Date().toISOString(),
      actor: "local-user",
      action: `registry:create:${entry.kind}`,
      resourceId: entry.id,
      result: "created"
    });
    return envelope(ok(entry));
  });

  app.put<{ Params: { id: string }; Body: Partial<RegistryEntry> }>("/api/registry/:id", async (request) => {
    if (!requireWrite(request)) {
      return envelope(
        fail({
          code: "WRITE_GUARD_REJECTED",
          message: "Registry writes require a valid local session from an allowed origin"
        })
      );
    }
    const parsed = registryEntrySchema
      .omit({ id: true, hostId: true, createdAt: true, updatedAt: true })
      .partial()
      .safeParse(request.body);
    if (!parsed.success) {
      return envelope(
        fail({
          code: "INVALID_REGISTRY_ENTRY",
          message: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")
        })
      );
    }
    const entry = registry.update(request.params.id, parsed.data);
    if (!entry) {
      return envelope(fail({ code: "NOT_FOUND", message: `No registry entry ${request.params.id}` }));
    }
    auditLog.push({
      id: `audit:${nanoid()}`,
      timestamp: new Date().toISOString(),
      actor: "local-user",
      action: `registry:update:${entry.id}`,
      resourceId: entry.id,
      result: "updated"
    });
    return envelope(ok(entry));
  });

  app.delete<{ Params: { id: string } }>("/api/registry/:id", async (request) => {
    if (!requireWrite(request)) {
      return envelope(
        fail({
          code: "WRITE_GUARD_REJECTED",
          message: "Registry writes require a valid local session from an allowed origin"
        })
      );
    }
    const removed = registry.remove(request.params.id);
    if (!removed) {
      return envelope(fail({ code: "NOT_FOUND", message: `No registry entry ${request.params.id}` }));
    }
    auditLog.push({
      id: `audit:${nanoid()}`,
      timestamp: new Date().toISOString(),
      actor: "local-user",
      action: "registry:delete",
      resourceId: request.params.id,
      result: "deleted"
    });
    return envelope(ok({ deleted: true, id: request.params.id }));
  });

  app.get("/api/adapters", async () => {
    const lastRuns = new Map(runtime.getLastRuns().map((run) => [run.adapterId, run]));
    const failedIds = new Set(manifestFailures.map((f) => f.adapterId));
    return envelope(
      ok({
        registered: adapters.map((adapter) => {
          if (failedIds.has(adapter.id)) {
            return {
              id: adapter.id,
              name: adapter.name,
              manifest: null,
              capabilities: [],
              health: null,
              manifestError: manifestFailures.find((f) => f.adapterId === adapter.id)?.reason
            };
          }
          const run = lastRuns.get(adapter.id);
          return {
            id: adapter.id,
            name: adapter.name,
            manifest: adapter.manifest,
            capabilities: resolveCapabilityStates(adapter.manifest, run),
            health: run ? { status: run.status, error: run.error, lastRunAt: run.finishedAt } : null
          };
        }),
        manifestFailures,
        lastRuns: runtime.getLastRuns()
      })
    );
  });

  // ---- Action Gateway with ActionRun state machine (issue #17) ----

  const actionRuns = new ActionRunStore(storage.db);
  const actionDriver = new ActionRunDriver(actionRuns);
  /** Executor bound to the current isolated runtime for a declared action. */
  const executorForAction = (adapterId: string, action: string): AdapterActionExecutor | null => {
    const adapter = validAdapters.find((item) => item.id === adapterId);
    if (!adapter?.executor) return null;
    return adapter.executor(action);
  };

  /** Plans an action. Executable ONLY for managed resources with declared actions. */
  app.post<{
    Body: { resourceId?: string; action?: string; adapterId?: string };
  }>("/api/actions/plan", async (request) => {
    const resourceId = request.body.resourceId ?? "unknown";
    const action = request.body.action ?? "read";

    if (action === "read") {
      const plan = createReadPlan(resourceId);
      auditLog.push({
        id: `audit:${nanoid()}`,
        timestamp: new Date().toISOString(),
        actor: "local-user",
        action: "plan:read",
        resourceId,
        result: "planned"
      });
      return envelope(ok(plan));
    }

    const snapshot = latestSnapshot();
    const resource = snapshot?.nodes.find((node) => node.id === resourceId);
    const adapterId = resource?.sourceAdapter ?? request.body.adapterId ?? "unknown";
    const manifest = validAdapters.find((item) => item.id === adapterId)?.manifest;
    const gated = gateActionPlan({ resource, manifest, action });

    auditLog.push({
      id: `audit:${nanoid()}`,
      timestamp: new Date().toISOString(),
      actor: "local-user",
      action: `plan:${action}`,
      resourceId,
      result: gated.plan ? "planned" : "rejected",
      evidence: gated.reason ? [gated.reason] : []
    });

    if (!gated.plan) {
      return envelope(fail({ code: "ACTION_NOT_PLANNABLE", message: gated.reason ?? "cannot plan" }));
    }
    if (gated.reason) {
      return envelope(ok({ ...gated.plan, disabledReason: gated.reason }));
    }
    return envelope(ok(gated.plan));
  });

  /** Creates the persisted ActionRun from an executable plan (session-guarded). */
  app.post<{ Body: { resourceId?: string; action?: string; planId?: string } }>("/api/actions/runs", async (request) => {
    if (!requireWrite(request)) {
      return envelope(
        fail({
          code: "WRITE_GUARD_REJECTED",
          message: "Action runs require a valid local session from an allowed origin"
        })
      );
    }
    const resourceId = request.body.resourceId ?? "";
    const action = request.body.action ?? "";
    const snapshot = latestSnapshot();
    const resource = snapshot?.nodes.find((node) => node.id === resourceId);
    const adapterId = resource?.sourceAdapter ?? "";
    const manifest = validAdapters.find((item) => item.id === adapterId)?.manifest;
    const gated = gateActionPlan({ resource, manifest, action });
    if (!gated.plan || gated.reason) {
      return envelope(
        fail({
          code: "ACTION_NOT_EXECUTABLE",
          message: gated.reason ?? "action is not executable"
        })
      );
    }
    const run = actionRuns.create({
      actionPlanId: request.body.planId ?? gated.plan.actionId,
      resourceId,
      adapterId,
      action,
      evidence: [`planned via ${gated.plan.actionId}`],
      requiresRollback: false
    });
    auditLog.push({
      id: `audit:${nanoid()}`,
      timestamp: new Date().toISOString(),
      actor: "local-user",
      action: `run:create:${action}`,
      resourceId,
      result: "created"
    });
    return envelope(ok(run));
  });

  /** Confirms or rejects a planned run (operator consent, session-guarded). */
  app.post<{ Params: { id: string }; Body: { decision?: string } }>("/api/actions/runs/:id/confirm", async (request) => {
    if (!requireWrite(request)) {
      return envelope(
        fail({
          code: "WRITE_GUARD_REJECTED",
          message: "Action confirmation requires a valid local session"
        })
      );
    }
    try {
      const run =
        request.body.decision === "reject"
          ? actionDriver.reject(request.params.id)
          : actionDriver.confirm(request.params.id);
      if (!run) return envelope(fail({ code: "NOT_FOUND", message: `No action run ${request.params.id}` }));
      return envelope(ok(run));
    } catch (error) {
      return envelope(fail({ code: "INVALID_TRANSITION", message: error instanceof Error ? error.message : String(error) }));
    }
  });

  /** Executes a confirmed run and verifies the final state (session-guarded). */
  app.post<{ Params: { id: string } }>("/api/actions/runs/:id/execute", async (request) => {
    if (!requireWrite(request)) {
      return envelope(
        fail({
          code: "WRITE_GUARD_REJECTED",
          message: "Action execution requires a valid local session"
        })
      );
    }
    const run = actionRuns.get(request.params.id);
    if (!run) return envelope(fail({ code: "NOT_FOUND", message: `No action run ${request.params.id}` }));
    const executor = executorForAction(run.adapterId, run.action);
    if (!executor) {
      return envelope(
        fail({
          code: "NO_EXECUTOR",
          message: `No executor for ${run.adapterId}:${run.action} on this isolated runtime`
        })
      );
    }
    try {
      const outcome = await actionDriver.execute(run.runId, executor);
      auditLog.push({
        id: `audit:${nanoid()}`,
        timestamp: new Date().toISOString(),
        actor: "local-user",
        action: `run:execute:${run.action}`,
        resourceId: run.resourceId,
        result: outcome.ok ? "succeeded" : "failed",
        evidence: outcome.evidence.slice(0, 10)
      });
      return envelope(ok(outcome.run));
    } catch (error) {
      return envelope(fail({ code: "EXECUTION_FAILED", message: error instanceof Error ? error.message : String(error) }));
    }
  });

  /** Rolls a failed run back (session-guarded). */
  app.post<{ Params: { id: string } }>("/api/actions/runs/:id/rollback", async (request) => {
    if (!requireWrite(request)) {
      return envelope(
        fail({
          code: "WRITE_GUARD_REJECTED",
          message: "Action rollback requires a valid local session"
        })
      );
    }
    const run = actionRuns.get(request.params.id);
    if (!run) return envelope(fail({ code: "NOT_FOUND", message: `No action run ${request.params.id}` }));
    const executor = executorForAction(run.adapterId, run.action);
    try {
      const rolled = actionDriver.rollback(run.runId, executor ?? ({ action: run.action, execute: async () => ({ ok: false, evidence: [] }), verify: async () => ({ ok: false, evidence: [] }) } as AdapterActionExecutor));
      if (!rolled) return envelope(fail({ code: "NOT_FOUND", message: `No action run ${request.params.id}` }));
      return envelope(ok(rolled));
    } catch (error) {
      return envelope(fail({ code: "INVALID_TRANSITION", message: error instanceof Error ? error.message : String(error) }));
    }
  });

  /** ActionRun history and single-run lookup. */
  app.get("/api/actions/runs", async () => envelope(ok(actionRuns.list(50))));
  app.get<{ Params: { id: string } }>("/api/actions/runs/:id", async (request) => {
    const run = actionRuns.get(request.params.id);
    if (!run) return envelope(fail({ code: "NOT_FOUND", message: `No action run ${request.params.id}` }));
    return envelope(ok(run));
  });

  /** Restart recovery: re-verifies unfinished runs. */
  app.post("/api/actions/reverify", async (request) => {
    if (!requireWrite(request)) {
      return envelope(
        fail({
          code: "WRITE_GUARD_REJECTED",
          message: "Re-verification requires a valid local session"
        })
      );
    }
    const incomplete = actionRuns.incomplete();
    const results = [];
    for (const run of incomplete) {
      const executor = executorForAction(run.adapterId, run.action);
      if (!executor) {
        results.push({ runId: run.runId, status: run.status, outcome: "no-executor" });
        continue;
      }
      const verified = await executor.verify(run.resourceId);
      if (verified.ok) {
        const updated = actionRuns.update(run.runId, {
          status: "succeeded",
          finishedAt: new Date().toISOString(),
          evidence: [...run.evidence, ...verified.evidence, "re-verified after restart"]
        })!;
        results.push({ runId: run.runId, status: updated.status, outcome: "re-verified" });
      } else {
        const updated = actionRuns.update(run.runId, {
          status: "failed",
          finishedAt: new Date().toISOString(),
          error: "re-verification after restart failed",
          evidence: [...run.evidence, ...verified.evidence]
        })!;
        results.push({ runId: run.runId, status: updated.status, outcome: "failed" });
      }
    }
    return envelope(ok({ reverified: results.length, results }));
  });

  // ---- Config Center (issue #19): preview / diff / apply / verify ----

  const configCenter = new ConfigCenter(storage.db, host.hostId);

  /** Reads a structured preview of the supported config file. */
  app.get<{ Querystring: { path?: string } }>("/api/config/preview", async (request) => {
    const filePath = request.query.path ?? options.configPath ?? "";
    if (!filePath) {
      return envelope(fail({ code: "CONFIG_PATH_REQUIRED", message: "config path is required" }));
    }
    try {
      const preview = await configCenter.readPreview(filePath);
      return envelope(ok(preview));
    } catch (error) {
      return envelope(
        fail({
          code: "CONFIG_READ_FAILED",
          message: error instanceof Error ? error.message : String(error)
        })
      );
    }
  });

  /** Raw diff between the current file and the proposed edit. */
  app.post<{ Body: { path?: string; content?: string } }>("/api/config/diff", async (request) => {
    const filePath = request.body.path ?? "";
    const content = request.body.content ?? "";
    try {
      const current = await fs.readFile(filePath, "utf8");
      const preview = await configCenter.readPreview(filePath);
      const diff = configCenter.diff(current, content);
      return envelope(ok({ diff, previewHash: preview.previewHash, fresh: await configCenter.previewIsFresh(preview) }));
    } catch (error) {
      return envelope(fail({ code: "CONFIG_DIFF_FAILED", message: error instanceof Error ? error.message : String(error) }));
    }
  });

  /** Applies the edit: external-change guard, backup, atomic replace, verify. */
  app.post<{ Body: { path?: string; content?: string; previewHash?: string } }>("/api/config/apply", async (request) => {
    if (!requireWrite(request)) {
      return envelope(
        fail({
          code: "WRITE_GUARD_REJECTED",
          message: "Config apply requires a valid local session from an allowed origin"
        })
      );
    }
    const filePath = request.body.path ?? "";
    const content = request.body.content ?? "";
    const previewHash = request.body.previewHash ?? "";
    try {
      const preview = await configCenter.readPreview(filePath);
      if (preview.previewHash !== previewHash) {
        return envelope(
          fail({
            code: "PREVIEW_STALE",
            message: "preview hash mismatch; the file changed since preview"
          })
        );
      }
      // Every apply creates ActionRun + audit evidence.
      const run = actionRuns.create({
        actionPlanId: `config:apply:${nanoid(6)}`,
        resourceId: filePath,
        adapterId: "config-center",
        action: "configure",
        evidence: ["config apply requested"],
        requiresRollback: true
      });
      const outcome = await configCenter.apply(preview, content, run.runId);
      const updated = actionRuns.update(run.runId, {
        status: outcome.ok ? "succeeded" : "failed",
        finishedAt: new Date().toISOString(),
        evidence: [...run.evidence, ...outcome.evidence],
        error: outcome.error,
        requiresRollback: !outcome.ok
      })!;
      auditLog.push({
        id: `audit:${nanoid()}`,
        timestamp: new Date().toISOString(),
        actor: "local-user",
        action: "config:apply",
        resourceId: filePath,
        result: outcome.ok ? "succeeded" : "failed",
        evidence: outcome.evidence,
        backupId: outcome.backup.id
      });
      return envelope(ok({ ok: outcome.ok, run: updated, evidence: outcome.evidence, backupId: outcome.backup.id }));
    } catch (error) {
      return envelope(
        fail({
          code: "CONFIG_APPLY_FAILED",
          message: error instanceof Error ? error.message : String(error)
        })
      );
    }
  });

  /** Backup history and restore (rollback path). */
  app.get("/api/config/backups", async () => envelope(ok(configCenter.listBackups(20))));
  app.post<{ Params: { id: string } }>("/api/config/backups/:id/restore", async (request) => {
    if (!requireWrite(request)) {
      return envelope(
        fail({
          code: "WRITE_GUARD_REJECTED",
          message: "Config restore requires a valid local session"
        })
      );
    }
    const restored = await configCenter.restore(request.params.id);
    if (!restored) return envelope(fail({ code: "NOT_FOUND", message: `No backup ${request.params.id}` }));
    auditLog.push({
      id: `audit:${nanoid()}`,
      timestamp: new Date().toISOString(),
      actor: "local-user",
      action: "config:restore",
      resourceId: restored.filePath,
      result: "restored",
      backupId: restored.id
    });
    return envelope(ok({ restored: true, filePath: restored.filePath }));
  });

  app.get("/api/audit", async () => envelope(ok(auditLog)));

  const clientDist = path.join(process.cwd(), "dist", "client");
  await app.register(import("@fastify/static"), {
    root: clientDist,
    prefix: "/"
  });

  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith("/api/")) {
      reply.code(404).send(
        envelope(
          fail({
            code: "NOT_FOUND",
            message: `No API route for ${request.method} ${request.url}`
          })
        )
      );
      return;
    }
    if (request.url.includes(".")) {
      reply.code(404).send("Not found");
      return;
    }
    reply.sendFile("index.html");
  });

  return {
    app,
    storage,
    host,
    runtime,
    registry,
    scheduler,
    sseHub,
    refresher,
    close: async () => {
      scheduler.stop();
      refresher.dispose();
      await app.close();
      closeDatabase(storage.db);
    }
  };
}