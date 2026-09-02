import path from "node:path";
import Fastify from "fastify";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import { nanoid } from "nanoid";
import { createDisabledControlPlan, createReadPlan } from "../domain/actionGateway";
import { evaluateDrift } from "../domain/drift";
import { redactValue } from "../domain/redaction";
import { createAdapters } from "../adapters";
import { AdapterRuntime } from "../adapters/runtime";
import { fail, ok } from "../shared/api";
import { ensureStorage } from "../storage/init";
import { getAppPaths } from "../storage/paths";
import { skillManagerModuleSnapshotSchema, type ApiEnvelope, type SystemSnapshot } from "../shared/schemas";
import { collectSkillManagerModule } from "../modules/skillManagerModule";
import { resolveServerHost } from "./config";
import { StorageRepository, type AuditEntry } from "../storage/repository";
import type { StorageStatus } from "../storage/init";
import { parseActionPlanRequest } from "./actions";

const host = resolveServerHost(process.env.LMS_AIPANEL_HOST, process.env.LMS_AIPANEL_ALLOW_REMOTE);
const port = Number(process.env.LMS_AIPANEL_PORT ?? 3777);
const adapters = createAdapters();
const runtime = new AdapterRuntime(adapters, 5_000);
const auditLog: AuditEntry[] = [];
let repository: StorageRepository | undefined;
let storageStatus: StorageStatus = { ready: false, error: "Storage has not been initialized." };

async function collectSnapshot(): Promise<SystemSnapshot> {
  const collected = await runtime.collectAll();
  const driftRecords = evaluateDrift(collected.result.nodes);
  const snapshot = {
    nodes: collected.result.nodes,
    edges: collected.result.edges,
    adapterRuns: collected.runs,
    driftRecords
  };
  if (repository) {
    try {
      await repository.saveSnapshot(snapshot);
    } catch (error) {
      storageStatus = { ready: false, error: error instanceof Error ? error.message : String(error) };
      repository = undefined;
    }
  }
  return snapshot;
}

function envelope<T>(payload: ApiEnvelope<T>): ApiEnvelope<T> {
  return redactValue(payload) as ApiEnvelope<T>;
}

async function main() {
  storageStatus = await ensureStorage();
  if (storageStatus.ready) {
    try {
      repository = new StorageRepository(getAppPaths().databasePath);
      const previous = await repository.loadLatestSnapshot();
      if (previous) runtime.seedFromSnapshot(previous);
    } catch (error) {
      storageStatus = { ready: false, error: error instanceof Error ? error.message : String(error) };
      repository = undefined;
    }
  }

  const app = Fastify({
    logger: {
      level: "info"
    }
  });

  await app.register(cors, {
    origin: ["http://127.0.0.1:5173", "http://localhost:5173"]
  });

  app.get("/api/health", async () =>
    envelope(
      ok({
        service: "LMS-AiPanel",
        host,
        storage: storageStatus.ready ? "ready" : "degraded",
        storageError: storageStatus.ready ? undefined : "SQLite storage unavailable"
      })
    )
  );

  app.get("/api/graph", async () => {
    try {
      return envelope(ok(await collectSnapshot()));
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
    try {
      const snapshot = await collectSnapshot();
      return envelope(ok(snapshot.nodes));
    } catch (error) {
      return envelope(fail({ code: "RESOURCE_COLLECT_FAILED", message: errorMessage(error) }));
    }
  });

  app.get("/api/drift", async () => {
    try {
      const snapshot = await collectSnapshot();
      return envelope(ok(snapshot.driftRecords));
    } catch (error) {
      return envelope(fail({ code: "DRIFT_COLLECT_FAILED", message: errorMessage(error) }));
    }
  });

  app.get("/api/adapters", async () => {
    const lastRuns = runtime.getLastRuns();
    const health = await Promise.all(
      adapters.map(async (adapter) => ({
        ...(await adapter.health()),
        lastRun: lastRuns.find((run) => run.adapterId === adapter.id)
      }))
    );
    return envelope(
      ok({
        registered: adapters.map((adapter) => ({ id: adapter.id, name: adapter.name })),
        health
      })
    );
  });

  app.get("/api/modules/skill-manager", async (request) => {
    const controller = new AbortController();
    const abort = () => controller.abort();
    request.raw.once("aborted", abort);
    try {
      const snapshot = await collectSkillManagerModule({ signal: controller.signal, timeoutMs: 5_000 });
      return envelope(ok(skillManagerModuleSnapshotSchema.parse(snapshot)));
    } catch (error) {
      return envelope(fail({ code: "SKILL_MANAGER_MODULE_FAILED", message: errorMessage(error) }));
    } finally {
      request.raw.removeListener("aborted", abort);
    }
  });

  app.post<{ Body: unknown }>("/api/actions/plan", async (request, reply) => {
    let input;
    try {
      input = parseActionPlanRequest(request.body);
    } catch (error) {
      reply.code(400);
      return envelope(
        fail({
          code: "INVALID_ACTION_PLAN_REQUEST",
          message: errorMessage(error)
        })
      );
    }
    const { resourceId, action } = input;
    const plan = action === "read" ? createReadPlan(resourceId) : createDisabledControlPlan(resourceId, action);
    const entry: AuditEntry = {
      id: `audit:${nanoid()}`,
      timestamp: new Date().toISOString(),
      actor: "local-user",
      action: `plan:${action}`,
      resourceId,
      result: "planned"
    };
    if (repository) {
      try {
        await repository.appendAudit(entry);
      } catch (error) {
        storageStatus = { ready: false, error: errorMessage(error) };
        repository = undefined;
        auditLog.push(entry);
      }
    } else auditLog.push(entry);
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

  app.get("/api/audit", async () => envelope(ok(repository ? await repository.listAudit() : auditLog)));

  const clientDist = path.join(process.cwd(), "dist", "client");
  await app.register(fastifyStatic, {
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

  await app.listen({ host, port });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
