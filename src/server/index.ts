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
import type { ApiEnvelope, SystemSnapshot } from "../shared/schemas";

const host = process.env.LMS_AIPANEL_HOST ?? "127.0.0.1";
const port = Number(process.env.LMS_AIPANEL_PORT ?? 3777);
const adapters = createAdapters();
const runtime = new AdapterRuntime(adapters, 5_000);
const auditLog: Array<Record<string, unknown>> = [];

async function collectSnapshot(): Promise<SystemSnapshot> {
  const collected = await runtime.collectAll();
  const driftRecords = evaluateDrift(collected.result.nodes);
  return {
    nodes: collected.result.nodes,
    edges: collected.result.edges,
    adapterRuns: collected.runs,
    driftRecords
  };
}

function envelope<T>(payload: ApiEnvelope<T>): ApiEnvelope<T> {
  return redactValue(payload) as ApiEnvelope<T>;
}

async function main() {
  await ensureStorage();

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
        appPaths: getAppPaths()
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

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
