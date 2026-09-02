import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/server/app";
import { MetricStore } from "../src/storage/metrics";
import { applyMigrations, openDatabase } from "../src/storage/db";

let tmpDir: string;
let dbPath: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "lms-metrics-test-"));
  dbPath = path.join(tmpDir, "metrics.sqlite");
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

async function openMigrated(): Promise<ReturnType<typeof openDatabase>> {
  const db = openDatabase(dbPath);
  await applyMigrations(db, path.join(process.cwd(), "migrations"));
  return db;
}

function sample(overrides: Partial<Parameters<MetricStore["record"]>[0]> = {}) {
  return {
    hostId: "host-test",
    scope: "omlx:endpoint:8000",
    layer: "endpoint" as const,
    metric: "tokens_in",
    source: "omlx",
    coverage: "endpoint-total",
    kind: "counter" as const,
    value: 100,
    sampleAt: new Date().toISOString(),
    ...overrides
  };
}

describe("MetricStore counter epochs", () => {
  it("a counter rollback opens a new epoch and never produces a negative delta", async () => {
    const db = await openMigrated();
    const store = new MetricStore(db);

    const t0 = Date.now();
    store.record(sample({ value: 100, sampleAt: new Date(t0).toISOString() }));
    store.record(sample({ value: 250, sampleAt: new Date(t0 + 60_000).toISOString() }));
    store.record(sample({ value: 40, sampleAt: new Date(t0 + 120_000).toISOString() })); // rollback
    store.record(sample({ value: 90, sampleAt: new Date(t0 + 180_000).toISOString() }));

    const series = store.series("host-test", "omlx:endpoint:8000", "tokens_in", "endpoint", 3600);
    expect(series.current).toBe(90);
    expect(series.currentEpoch).toBe(2);
    // Delta within epoch 2: 90 - 40 = 50 (positive), not -160.
    expect(series.delta).toBe(50);
    expect(series.resets).toBe(1);
    db.close();
  });

  it("monotonic counters stay in one epoch with a positive delta", async () => {
    const db = await openMigrated();
    const store = new MetricStore(db);
    const t0 = Date.now();
    store.record(sample({ value: 10, sampleAt: new Date(t0).toISOString() }));
    store.record(sample({ value: 20, sampleAt: new Date(t0 + 60_000).toISOString() }));
    store.record(sample({ value: 35, sampleAt: new Date(t0 + 120_000).toISOString() }));
    const series = store.series("host-test", "omlx:endpoint:8000", "tokens_in", "endpoint", 3600);
    expect(series.currentEpoch).toBe(1);
    expect(series.delta).toBe(25);
    expect(series.resets).toBe(0);
    db.close();
  });

  it("gauges never trigger epochs", async () => {
    const db = await openMigrated();
    const store = new MetricStore(db);
    const t0 = Date.now();
    store.record(sample({ metric: "memory_kb", kind: "gauge", value: 1000, sampleAt: new Date(t0).toISOString() }));
    store.record(sample({ metric: "memory_kb", kind: "gauge", value: 500, sampleAt: new Date(t0 + 60_000).toISOString() }));
    const series = store.series("host-test", "omlx:endpoint:8000", "memory_kb", "endpoint", 3600);
    expect(series.currentEpoch).toBe(1);
    expect(series.resets).toBe(0);
    db.close();
  });

  it("samples are host- and resource-scoped with source and coverage metadata", async () => {
    const db = await openMigrated();
    const store = new MetricStore(db);
    store.record(
      sample({
        hostId: "host-a",
        scope: "ollama:endpoint:11434",
        layer: "model",
        metric: "tokens_out",
        source: "ollama",
        coverage: "endpoint-total"
      })
    );
    const scopes = store.listScopes("host-a");
    expect(scopes).toEqual([{ scope: "ollama:endpoint:11434", metric: "tokens_out", layer: "model" }]);
    expect(store.listScopes("host-b")).toEqual([]);
    db.close();
  });
});

describe("metrics API", () => {
  it("records samples and returns current values with window deltas", async () => {
    const built = await buildApp({ dataDir: path.join(tmpDir, "api"), adapters: [], schedulerAutoStart: false });
    for (const value of [10, 25, 55]) {
      await built.app.inject({
        method: "POST",
        url: "/api/metrics",
        payload: {
          scope: "omlx:endpoint:8000",
          layer: "endpoint",
          metric: "tokens_in",
          source: "omlx",
          coverage: "endpoint-total",
          kind: "counter",
          value
        }
      });
    }
    const res = await built.app.inject({
      method: "GET",
      url: "/api/metrics/series?scope=omlx:endpoint:8000&metric=tokens_in&layer=endpoint&window=3600"
    });
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.data.current).toBe(55);
    expect(body.data.delta).toBe(45);
    expect(body.data.points).toHaveLength(3);
    await built.close();
  });

  it("rejects invalid metric samples with a contract error", async () => {
    const built = await buildApp({ dataDir: path.join(tmpDir, "api2"), adapters: [], schedulerAutoStart: false });
    const res = await built.app.inject({
      method: "POST",
      url: "/api/metrics",
      payload: { scope: "", layer: "nonsense", metric: "", source: "", coverage: "", kind: "counter", value: "x" }
    });
    expect(res.json().ok).toBe(false);
    expect(res.json().error.code).toBe("INVALID_METRIC_SAMPLE");
    await built.close();
  });
});