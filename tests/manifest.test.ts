import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAdapters } from "../src/adapters";
import { resolveCapabilityStates, type StackAdapter } from "../src/adapters/types";
import { buildApp } from "../src/server/app";
import { adapterManifestSchema, type AdapterManifest, type AdapterRun } from "../src/shared/schemas";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "lms-manifest-test-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("adapter capability manifests", () => {
  it("every registered adapter provides a valid versioned manifest", () => {
    const adapters = createAdapters();
    expect(adapters.length).toBeGreaterThanOrEqual(8);
    for (const adapter of adapters) {
      const parsed = adapterManifestSchema.safeParse(adapter.manifest);
      expect(parsed.success, `${adapter.id} manifest invalid: ${JSON.stringify(parsed.error?.issues)}`).toBe(true);
      expect(parsed.data?.adapterId).toBe(adapter.id);
      expect(parsed.data?.manifestVersion).toBe(1);
    }
  });

  it("manifests are exposed through the API", async () => {
    const built = await buildApp({ dataDir: path.join(tmpDir, "api") });
    const res = await built.app.inject({ method: "GET", url: "/api/adapters" });
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.data.registered.length).toBeGreaterThanOrEqual(8);
    for (const entry of body.data.registered) {
      expect(entry.manifest.adapterId).toBe(entry.id);
      expect(entry.manifest.manifestVersion).toBe(1);
      expect(Array.isArray(entry.capabilities)).toBe(true);
    }
    await built.close();
  });

  it("an invalid manifest is isolated without breaking other adapters", async () => {
    const broken: StackAdapter = {
      id: "broken",
      name: "Broken",
      manifest: {
        adapterId: "broken",
        adapterName: "Broken",
        manifestVersion: 1,
        description: "x",
        discoverySources: [],
        permissions: [],
        refreshProfile: { intervalSeconds: 60, onDemand: true },
        telemetryCoverage: [],
        supportedCapabilities: [],
        supportedActions: []
      } as never,
      async collect() {
        throw new Error("should never run");
      },
      async health() {
        return { adapterId: "broken", alive: false };
      }
    };
    // Deliberately corrupt the manifest.
    (broken as unknown as { manifest: unknown }).manifest = {
      adapterId: 123,
      adapterName: "",
      manifestVersion: 99
    };

    const good = createAdapters()[0];
    const built = await buildApp({
      dataDir: path.join(tmpDir, "isolate"),
      adapters: [good, broken]
    });

    const res = await built.app.inject({ method: "GET", url: "/api/adapters" });
    const body = res.json();
    expect(body.ok).toBe(true);
    const failures = body.data.manifestFailures as Array<{ adapterId: string }>;
    expect(failures.some((f) => f.adapterId === "broken")).toBe(true);
    expect(body.data.registered.find((e: { id: string }) => e.id === "broken").manifest).toBeNull();

    // The healthy adapter still collects and reports capabilities.
    const graph = await built.app.inject({ method: "GET", url: "/api/graph" });
    expect(graph.json().ok).toBe(true);
    const after = await built.app.inject({ method: "GET", url: "/api/adapters" });
    const afterBody = after.json();
    const run = afterBody.data.lastRuns.find((r: AdapterRun) => r.adapterId === good.id);
    expect(run?.status).toBe("success");
    expect(afterBody.data.lastRuns.some((r: AdapterRun) => r.adapterId === "broken")).toBe(false);
    await built.close();
  });

  it("capability states distinguish supported, unavailable, and failed", () => {
    const manifest: AdapterManifest = {
      adapterId: "x",
      adapterName: "X",
      manifestVersion: 1,
      description: "x",
      discoverySources: [],
      permissions: [],
      refreshProfile: { intervalSeconds: 60, onDemand: true },
      telemetryCoverage: [],
      supportedCapabilities: ["discovery", "token-telemetry"],
      supportedActions: []
    };

    expect(resolveCapabilityStates(manifest, undefined)).toEqual([
      { capability: "discovery", status: "unavailable", reason: "no run evidence yet" },
      { capability: "token-telemetry", status: "unavailable", reason: "no run evidence yet" }
    ]);

    const okRun: AdapterRun = {
      runId: "r1",
      adapterId: "x",
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      status: "success",
      durationMs: 5,
      stale: false
    };
    expect(resolveCapabilityStates(manifest, okRun)).toEqual([
      { capability: "discovery", status: "supported" },
      { capability: "token-telemetry", status: "supported" }
    ]);

    const failedRun: AdapterRun = { ...okRun, status: "failed" };
    expect(resolveCapabilityStates(manifest, failedRun).every((c) => c.status === "failed")).toBe(true);
  });
});