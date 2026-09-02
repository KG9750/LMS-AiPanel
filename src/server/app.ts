import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import { nanoid } from "nanoid";
import { createDisabledControlPlan, createReadPlan } from "../domain/actionGateway";
import { evaluateDrift } from "../domain/drift";
import { redactValue } from "../domain/redaction";
import { isStamped, stampHostId } from "../domain/scope";
import { createAdapters } from "../adapters";
import { AdapterRuntime } from "../adapters/runtime";
import type { StackAdapter } from "../adapters/types";
import { fail, ok } from "../shared/api";
import type { ApiEnvelope, HostRecord, SystemSnapshot } from "../shared/schemas";
import { ensureStorage, type InitializedStorage } from "../storage/init";
import { getAppPaths } from "../storage/paths";
import { getOrCreateHost } from "../storage/host";
import { closeDatabase } from "../storage/db";

export interface AppOptions {
  /** Overrides LMS_AIPANEL_DATA_DIR. Defaults to the env var or the platform path. */
  dataDir?: string;
  /** Injectable adapters for tests. Defaults to the real read-only adapters. */
  adapters?: StackAdapter[];
  /** Per-adapter collection timeout in ms. */
  timeoutMs?: number;
  logger?: boolean;
}

export interface BuiltApp {
  app: FastifyInstance;
  storage: InitializedStorage;
  host: HostRecord;
  runtime: AdapterRuntime;
  close: () => Promise<void>;
}

export async function buildApp(options: AppOptions = {}): Promise<BuiltApp> {
  if (options.dataDir) {
    process.env.LMS_AIPANEL_DATA_DIR = options.dataDir;
  }
  const storage = await ensureStorage();
  const host = getOrCreateHost(storage.db);

  const adapters = options.adapters ?? createAdapters();
  const runtime = new AdapterRuntime(adapters, options.timeoutMs ?? 5_000, host.hostId);

  let snapshotVersion = 1;
  const auditLog: Array<Record<string, unknown>> = [];
  const appPaths = getAppPaths();

  const collectSnapshot = async (): Promise<SystemSnapshot> => {
    const collected = await runtime.collectAll();
    const driftRecords = evaluateDrift(collected.result.nodes);
    const version = snapshotVersion++;
    return {
      version,
      host,
      nodes: stampHostId(collected.result.nodes, host.hostId),
      edges: collected.result.edges,
      adapterRuns: collected.runs,
      driftRecords
    };
  };

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
    try {
      const snapshot = await collectSnapshot();
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
    } catch (error) {
      return envelope(
        fail({
          code: "GRAPH_COLLECT_FAILED",
          message: error instanceof Error ? error.message : String(error)
        })
      );
    }
  });

  app.get("/api/resources", async () => {
    const snapshot = await collectSnapshot();
    return envelope(ok(snapshot.nodes));
  });

  app.get("/api/drift", async () => {
    const snapshot = await collectSnapshot();
    return envelope(ok(snapshot.driftRecords));
  });

  app.get("/api/adapters", async () => {
    return envelope(
      ok({
        registered: adapters.map((adapter) => ({ id: adapter.id, name: adapter.name })),
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
    close: async () => {
      await app.close();
      closeDatabase(storage.db);
    }
  };
}