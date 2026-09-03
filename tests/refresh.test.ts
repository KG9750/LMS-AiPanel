import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/server/app";
import { GRAPH_SCHEMA_VERSION, type AdapterManifest, type ResourceNode } from "../src/shared/schemas";
import type { AdapterContext, StackAdapter } from "../src/adapters/types";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "lms-refresh-test-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function makeAdapter(id: string, delayMs: number): StackAdapter {
  const manifest: AdapterManifest = {
    adapterId: id,
    adapterName: id,
    manifestVersion: 1,
    description: "test",
    discoverySources: [],
    permissions: [],
    refreshProfile: { intervalSeconds: 60, onDemand: true },
    telemetryCoverage: [],
    supportedCapabilities: [],
    supportedActions: []
  };
  const node: ResourceNode = {
    id: `${id}:runtime:one`,
    type: "runtime",
    label: id,
    state: "running",
    sourceAdapter: id,
    hostId: "pending",
    properties: { stableKey: "one" },
    lastSeenAt: new Date().toISOString(),
    graphSchemaVersion: GRAPH_SCHEMA_VERSION
  };
  return {
    id,
    name: id,
    manifest,
    async collect(_context: AdapterContext) {
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
      return { nodes: [node], edges: [], redactionHints: [] };
    },
    async health() {
      return { adapterId: id, alive: true };
    }
  };
}

describe("RefreshRun + SSE", () => {
  async function sessionHeader(built: { app: import("fastify").FastifyInstance }): Promise<Record<string, string>> {
    const issue = await built.app.inject({ method: "POST", url: "/api/session" });
    return { "x-lms-session": issue.json().data.token as string };
  }

  it("refresh returns a run id immediately and completes with a snapshot version", async () => {
    const built = await buildApp({
      dataDir: path.join(tmpDir, "basic"),
      adapters: [makeAdapter("alpha", 20)],
      schedulerAutoStart: false
    });
    const auth = await sessionHeader(built);

    const started = await built.app.inject({ method: "POST", url: "/api/refresh", headers: auth });
    expect(started.statusCode).toBe(200);
    const body = started.json();
    expect(body.ok).toBe(true);
    expect(body.data.status).toBe("running");
    expect(body.data.runId).toMatch(/^refresh:/);

    // Poll until completion.
    let run: { status: string; snapshotVersion?: number; adapterEvents?: Array<{ adapterId: string }> } | undefined;
    for (let i = 0; i < 50; i++) {
      const poll = await built.app.inject({ method: "GET", url: `/api/refresh/${body.data.runId}` });
      run = poll.json().data;
      if (run?.status === "completed" || run?.status === "failed") break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(run?.status).toBe("completed");
    expect(run?.snapshotVersion).toBeGreaterThan(0);
    expect(run?.adapterEvents).toHaveLength(1);
    expect(run?.adapterEvents?.[0].adapterId).toBe("alpha");
    await built.close();
  });

  it("SSE stream delivers run, adapter, and snapshot events in order", async () => {
    const built = await buildApp({
      dataDir: path.join(tmpDir, "sse"),
      adapters: [makeAdapter("beta", 10)],
      schedulerAutoStart: false
    });

    const received: string[] = [];
    const unsubscribe = built.sseHub.subscribe((event) => {
      received.push(event.type);
    });
    const auth = await sessionHeader(built);

    await built.app.inject({ method: "POST", url: "/api/refresh", headers: auth });
    for (let i = 0; i < 50; i++) {
      if (received.includes("snapshot")) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    unsubscribe();

    expect(received[0]).toBe("run");
    expect(received).toContain("adapter");
    expect(received[received.length - 1]).toBe("snapshot");
    // Order: run → adapter(s) → snapshot
    const runIdx = received.indexOf("run");
    const adapterIdx = received.indexOf("adapter");
    const snapshotIdx = received.indexOf("snapshot");
    expect(runIdx).toBeLessThan(adapterIdx);
    expect(adapterIdx).toBeLessThan(snapshotIdx);
    await built.close();
  });

  it("a disconnected browser recovers by polling the persisted run", async () => {
    const built = await buildApp({
      dataDir: path.join(tmpDir, "recover"),
      adapters: [makeAdapter("gamma", 15)],
      schedulerAutoStart: false
    });

    const auth = await sessionHeader(built);
    const started = await built.app.inject({ method: "POST", url: "/api/refresh", headers: auth });
    const runId = started.json().data.runId;

    // Simulate a reconnect: a brand-new store read (same DB) still sees the run.
    const second = await buildApp({
      dataDir: path.join(tmpDir, "recover"),
      adapters: [makeAdapter("gamma", 0)],
      schedulerAutoStart: false
    });
    const poll = await second.app.inject({ method: "GET", url: `/api/refresh/${runId}` });
    const run = poll.json().data;
    expect(run.runId).toBe(runId);
    expect(["pending", "running", "completed"]).toContain(run.status);
    await second.close();
    await built.close();
  });

  it("concurrent refresh requests reuse the active run (single-flight)", async () => {
    const built = await buildApp({
      dataDir: path.join(tmpDir, "concurrent"),
      adapters: [makeAdapter("delta", 40)],
      schedulerAutoStart: false
    });

    const auth = await sessionHeader(built);
    const [a, b, c] = await Promise.all([
      built.app.inject({ method: "POST", url: "/api/refresh", headers: auth }),
      built.app.inject({ method: "POST", url: "/api/refresh", headers: auth }),
      built.app.inject({ method: "POST", url: "/api/refresh", headers: auth })
    ]);
    const runIds = [a.json().data.runId, b.json().data.runId, c.json().data.runId];
    expect(new Set(runIds).size).toBe(1);
    await built.close();
  });

  it("cancel marks the run cancelled and stops the active run", async () => {
    const built = await buildApp({
      dataDir: path.join(tmpDir, "cancel"),
      adapters: [makeAdapter("epsilon", 5_000)],
      schedulerAutoStart: false
    });

    const auth = await sessionHeader(built);
    const started = await built.app.inject({ method: "POST", url: "/api/refresh", headers: auth });
    const runId = started.json().data.runId;
    const cancelled = await built.app.inject({ method: "POST", url: `/api/refresh/${runId}/cancel`, headers: auth });
    expect(cancelled.json().data.status).toBe("cancelled");
    await built.close();
  });

  it("a late SSE subscriber receives replayed history for the active run (M6)", async () => {
    const built = await buildApp({
      dataDir: path.join(tmpDir, "replay"),
      adapters: [makeAdapter("theta", 30)],
      schedulerAutoStart: false
    });
    const auth = await sessionHeader(built);
    await built.app.inject({ method: "POST", url: "/api/refresh", headers: auth });

    // Subscribe AFTER the run started (late/reconnecting client).
    const received: string[] = [];
    const unsubscribe = built.sseHub.subscribe((event) => {
      received.push(event.type);
    });

    // The replayed history must include the run event and, once the run
    // completes, the adapter + snapshot events.
    expect(received[0]).toBe("run");
    for (let i = 0; i < 50; i++) {
      if (received.includes("snapshot")) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    unsubscribe();
    expect(received).toContain("adapter");
    expect(received[received.length - 1]).toBe("snapshot");
    await built.close();
  });

  it("refresh history lists recent runs", async () => {
    const built = await buildApp({
      dataDir: path.join(tmpDir, "history"),
      adapters: [makeAdapter("zeta", 0)],
      schedulerAutoStart: false
    });
    const auth = await sessionHeader(built);
    await built.app.inject({ method: "POST", url: "/api/refresh", headers: auth });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const res = await built.app.inject({ method: "GET", url: "/api/refresh" });
    const runs = res.json().data;
    expect(Array.isArray(runs)).toBe(true);
    expect(runs.length).toBeGreaterThanOrEqual(1);
    await built.close();
  });
});