import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/server/app";
import { Scheduler } from "../src/domain/scheduler";
import { AdapterRuntime } from "../src/adapters/runtime";
import { RegistryRepository } from "../src/storage/registry";
import { SnapshotStore } from "../src/storage/snapshots";
import { ensureStorage } from "../src/storage/init";
import { getOrCreateHost } from "../src/storage/host";
import { GRAPH_SCHEMA_VERSION, type AdapterManifest, type ResourceNode } from "../src/shared/schemas";
import type { AdapterContext, StackAdapter } from "../src/adapters/types";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "lms-scheduler-test-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function makeAdapter(id: string, intervalSeconds: number, nodes: ResourceNode[]): StackAdapter {
  const manifest: AdapterManifest = {
    adapterId: id,
    adapterName: id,
    manifestVersion: 1,
    description: "test",
    discoverySources: [],
    permissions: [],
    refreshProfile: { intervalSeconds, onDemand: true },
    telemetryCoverage: [],
    supportedCapabilities: [],
    supportedActions: []
  };
  return {
    id,
    name: id,
    manifest,
    async collect(_context: AdapterContext) {
      return { nodes, edges: [], redactionHints: [] };
    },
    async health() {
      return { adapterId: id, alive: true };
    }
  };
}

function testNode(id: string): ResourceNode {
  return {
    id,
    type: "runtime",
    label: id,
    state: "running",
    sourceAdapter: id.split(":")[0],
    hostId: "pending",
    properties: { stableKey: id },
    lastSeenAt: new Date().toISOString(),
    graphSchemaVersion: GRAPH_SCHEMA_VERSION
  };
}

describe("Scheduler", () => {
  it("GET requests do not initiate collection; they read the latest snapshot", async () => {
    let collects = 0;
    const adapter: StackAdapter = {
      ...makeAdapter("fast", 10, [testNode("fast:runtime:one")]),
      async collect(c) {
        collects++;
        return { nodes: [testNode("fast:runtime:one")], edges: [], redactionHints: [] };
      }
    };

    const built = await buildApp({
      dataDir: path.join(tmpDir, "nocollect"),
      adapters: [adapter],
      schedulerAutoStart: false
    });

    // First call seeds the scheduler once.
    await built.scheduler.collect("all");
    const before = collects;
    for (let i = 0; i < 5; i++) {
      await built.app.inject({ method: "GET", url: "/api/graph" });
    }
    expect(collects).toBe(before);
    await built.close();
  });

  it("snapshot versions are monotonic and persist across restart", async () => {
    const dataDir = path.join(tmpDir, "versions");
    const adapter = makeAdapter("v", 10, [testNode("v:runtime:one")]);

    const first = await buildApp({ dataDir, adapters: [adapter], schedulerAutoStart: false });
    await first.scheduler.collect("all");
    const v1 = first.scheduler.getLatest()!.snapshot.version;
    await first.scheduler.collect("all");
    const v2 = first.scheduler.getLatest()!.snapshot.version;
    expect(v2).toBe(v1 + 1);
    await first.close();

    // Restart: the restored snapshot continues the monotonic sequence.
    const second = await buildApp({ dataDir, adapters: [adapter], schedulerAutoStart: false });
    expect(second.scheduler.getLatest()!.restored).toBe(true);
    expect(second.scheduler.getLatest()!.snapshot.version).toBe(v2);
    await second.scheduler.collect("all");
    expect(second.scheduler.getLatest()!.snapshot.version).toBe(v2 + 1);
    await second.close();
  });

  it("refresh profiles select fast vs slow adapters", async () => {
    const fast = makeAdapter("fast", 10, [testNode("fast:runtime:f")]);
    const slow = makeAdapter("slow", 300, [testNode("slow:runtime:s")]);
    const runtime = new AdapterRuntime([fast, slow], 100, "host-test");
    const storage = await ensureStorage();
    process.env.LMS_AIPANEL_DATA_DIR = path.join(tmpDir, "profiles");
    const host = getOrCreateHost(storage.db);
    const registry = new RegistryRepository(storage.db, host.hostId);
    const store = new SnapshotStore(storage.db);
    const scheduler = new Scheduler(runtime, registry, store, host, [fast, slow], {
      fastIntervalMs: 1000,
      slowIntervalMs: 1000,
      autoStart: false
    });

    await scheduler.collect("fast");
    const runs = scheduler.getLatest()!.snapshot.adapterRuns.map((r) => r.adapterId);
    expect(runs).toEqual(["fast"]);

    await scheduler.collect("slow");
    expect(scheduler.getLatest()!.snapshot.adapterRuns.map((r) => r.adapterId)).toEqual(["slow"]);

    await scheduler.collect("all");
    expect(scheduler.getLatest()!.snapshot.adapterRuns.map((r) => r.adapterId).sort()).toEqual(["fast", "slow"]);
  });

  it("concurrent refresh requests reuse in-flight work (single-flight)", async () => {
    let active = 0;
    let maxActive = 0;
    let calls = 0;
    const adapter: StackAdapter = {
      ...makeAdapter("sf", 10, [testNode("sf:runtime:one")]),
      async collect(c) {
        calls++;
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 30));
        active--;
        return { nodes: [testNode("sf:runtime:one")], edges: [], redactionHints: [] };
      }
    };

    const built = await buildApp({
      dataDir: path.join(tmpDir, "singleflight"),
      adapters: [adapter],
      schedulerAutoStart: false
    });

    const [a, b, c] = await Promise.all([
      built.scheduler.collect("all"),
      built.scheduler.collect("all"),
      built.scheduler.collect("all")
    ]);
    expect(a.snapshot.version).toBe(b.snapshot.version);
    expect(b.snapshot.version).toBe(c.snapshot.version);
    expect(calls).toBe(1);
    expect(maxActive).toBe(1);
    await built.close();
  });

  it("adapter failure is isolated with stale fallback evidence", async () => {
    let fail = false;
    const flaky: StackAdapter = {
      ...makeAdapter("flaky", 10, [testNode("flaky:runtime:one")]),
      async collect(c) {
        if (fail) throw new Error("boom");
        return { nodes: [testNode("flaky:runtime:one")], edges: [], redactionHints: [] };
      }
    };

    const built = await buildApp({
      dataDir: path.join(tmpDir, "stale"),
      adapters: [flaky],
      schedulerAutoStart: false
    });

    await built.scheduler.collect("all");
    expect(built.scheduler.getLatest()!.stale).toBe(false);

    fail = true;
    await built.scheduler.collect("all");
    const snapshot = built.scheduler.getLatest()!;
    expect(snapshot.stale).toBe(true);
    expect(snapshot.snapshot.adapterRuns[0].status).toBe("failed");
    // Stale fallback still serves the previous successful node.
    expect(snapshot.snapshot.nodes.some((n) => n.id === "flaky:runtime:one")).toBe(true);
    await built.close();
  });

  it("manual refresh endpoint returns a run id without blocking", async () => {
    let slowCollect: (() => void) | undefined;
    const adapter: StackAdapter = {
      ...makeAdapter("slowpoke", 10, [testNode("slowpoke:runtime:one")]),
      async collect(c) {
        await new Promise<void>((resolve) => {
          slowCollect = resolve;
        });
        return { nodes: [testNode("slowpoke:runtime:one")], edges: [], redactionHints: [] };
      }
    };
    const built = await buildApp({
      dataDir: path.join(tmpDir, "manual"),
      adapters: [adapter],
      schedulerAutoStart: false
    });

    const issue = await built.app.inject({ method: "POST", url: "/api/session" });
    const auth = { "x-lms-session": issue.json().data.token as string };
    const res = await built.app.inject({ method: "POST", url: "/api/refresh", headers: auth });
    expect(res.json().ok).toBe(true);
    expect(res.json().data.status).toBe("running");
    expect(res.json().data.runId).toMatch(/^refresh:/);
    slowCollect?.();
    await built.close();
  });
});

describe("Scheduler fake timers", () => {
  it("auto-runs fast and slow loops on their intervals", async () => {
    vi.useFakeTimers();
    try {
      const fastCalls = { n: 0 };
      const slowCalls = { n: 0 };
      const fast: StackAdapter = {
        ...makeAdapter("fast", 10, [testNode("fast:runtime:f")]),
        async collect(c) {
          fastCalls.n++;
          return { nodes: [testNode("fast:runtime:f")], edges: [], redactionHints: [] };
        }
      };
      const slow: StackAdapter = {
        ...makeAdapter("slow", 300, [testNode("slow:runtime:s")]),
        async collect(c) {
          slowCalls.n++;
          return { nodes: [testNode("slow:runtime:s")], edges: [], redactionHints: [] };
        }
      };
      const runtime = new AdapterRuntime([fast, slow], 100, "host-test");
      const storage = await ensureStorage();
      const host = getOrCreateHost(storage.db);
      const registry = new RegistryRepository(storage.db, host.hostId);
      const store = new SnapshotStore(storage.db);
      const scheduler = new Scheduler(runtime, registry, store, host, [fast, slow], {
        fastIntervalMs: 10_000,
        slowIntervalMs: 40_000,
        autoStart: true
      });
      scheduler.start();

      // start() fires one initial background collect ("all") immediately.
      await vi.advanceTimersByTimeAsync(0);
      expect(fastCalls.n + slowCalls.n).toBe(2);

      await vi.advanceTimersByTimeAsync(10_000);
      expect(fastCalls.n).toBe(2);
      expect(slowCalls.n).toBe(1);

      await vi.advanceTimersByTimeAsync(30_000);
      expect(fastCalls.n).toBe(5);
      expect(slowCalls.n).toBe(2);

      await vi.advanceTimersByTimeAsync(40_000);
      expect(fastCalls.n).toBe(9);
      expect(slowCalls.n).toBe(3);

      scheduler.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
describe("Scheduler cold start (M5)", () => {
  it("GET /api/graph never blocks on a full collection and reports collecting", async () => {
    let collectStarted: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      collectStarted = resolve;
    });
    let calls = 0;
    const slow: StackAdapter = {
      ...makeAdapter("slowpoke", 10, [testNode("slowpoke:runtime:one")]),
      async collect(c) {
        calls++;
        collectStarted?.();
        await new Promise((r) => setTimeout(r, 50));
        return { nodes: [testNode("slowpoke:runtime:one")], edges: [], redactionHints: [] };
      }
    };
    const built = await buildApp({
      dataDir: path.join(tmpDir, "cold"),
      adapters: [slow],
      schedulerAutoStart: false
    });

    // Cold: no snapshot yet; the GET must return immediately without
    // triggering collection (calls stays 0), flagged collecting in meta.
    const cold = await built.app.inject({ method: "GET", url: "/api/graph" });
    expect(cold.json().ok).toBe(true);
    expect(cold.json().data.version).toBe(0);
    expect(cold.json().meta.collecting).toBe(true);
    expect(calls).toBe(0);

    // The background collection still happens on demand.
    await built.scheduler.collect("all");
    expect(calls).toBe(1);
    void gate;
    await built.close();
  });
});
