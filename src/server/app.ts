import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import { nanoid } from "nanoid";
import { createDisabledControlPlan, createReadPlan } from "../domain/actionGateway";
import { evaluateDrift } from "../domain/drift";
import { redactValue } from "../domain/redaction";
import { isStamped, stampHostId } from "../domain/scope";
import { mergeRegistry } from "../domain/registryMerge";
import { Scheduler } from "../domain/scheduler";
import { createAdapters } from "../adapters";
import { AdapterRuntime } from "../adapters/runtime";
import { resolveCapabilityStates, type StackAdapter } from "../adapters/types";
import { fail, ok } from "../shared/api";
import { adapterManifestSchema, registryEntrySchema, type ApiEnvelope, type HostRecord, type RegistryEntry, type SystemSnapshot } from "../shared/schemas";
import { ensureStorage, type InitializedStorage } from "../storage/init";
import { getAppPaths } from "../storage/paths";
import { getOrCreateHost } from "../storage/host";
import { RegistryRepository } from "../storage/registry";
import { SnapshotStore } from "../storage/snapshots";
import { closeDatabase } from "../storage/db";

export interface AppOptions {
  /** Overrides LMS_AIPANEL_DATA_DIR. Defaults to the env var or the platform path. */
  dataDir?: string;
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
  close: () => Promise<void>;
}

export async function buildApp(options: AppOptions = {}): Promise<BuiltApp> {
  if (options.dataDir) {
    process.env.LMS_AIPANEL_DATA_DIR = options.dataDir;
  }
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

  /** Manual refresh: returns immediately with the run id; issue #5 streams progress. */
  app.post("/api/refresh", async () => {
    const runId = `refresh:${nanoid()}`;
    void scheduler.collect("all").then(() => {
      auditLog.push({
        id: `audit:${nanoid()}`,
        timestamp: new Date().toISOString(),
        actor: "local-user",
        action: "refresh",
        resourceId: runId,
        result: "completed"
      });
    });
    return envelope(ok({ runId, status: "started" }));
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

  app.post<{
    Body: { resourceId?: string; action?: string };
  }>("/api/actions/plan", async (request) => {
    const resourceId = request.body.resourceId ?? "unknown";
    const action = request.body.action ?? "read";
    const plan = action === "read" ? createReadPlan(resourceId) : createDisabledControlPlan(resourceId, action);
    auditLog.push({
      id: `audit:${nanoid()}`,
      timestamp: new Date().toISOString(),
      actor: "local-user",
      action: `plan:${action}`,
      resourceId,
      result: "planned"
    });
    return envelope(ok(plan));
  });

  app.post("/api/actions/execute", async () =>
    envelope(
      fail({
        code: "ACTION_EXECUTION_DISABLED",
        message: "Real action execution is disabled in MVP. Generate an action plan instead.",
        evidence: ["MVP supports read, dry-run, and configure contracts only."]
      })
    )
  );

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
    close: async () => {
      scheduler.stop();
      await app.close();
      closeDatabase(storage.db);
    }
  };
}