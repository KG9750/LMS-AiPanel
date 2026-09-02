import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/server/app";
import { GRAPH_SCHEMA_VERSION, type ResourceNode } from "../src/shared/schemas";
import type { AdapterContext, StackAdapter } from "../src/adapters/types";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "lms-detail-test-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function node(id: string, type: ResourceNode["type"], extra: Partial<ResourceNode> = {}): ResourceNode {
  return {
    id,
    type,
    label: `${type}-${id}`,
    state: "running",
    sourceAdapter: "omlx",
    hostId: "pending",
    properties: { evidence: [`evidence for ${id}`], stableKey: id },
    lastSeenAt: new Date().toISOString(),
    graphSchemaVersion: GRAPH_SCHEMA_VERSION,
    ...extra
  };
}

const RESOURCES = [
  node("omlx:runtime:server", "runtime"),
  node("omlx:model:path-abc", "model", { state: "stopped" }),
  node("openclaw:assistant:hermes", "assistant", { sourceAdapter: "openclaw" }),
  node("codex:config:config.toml", "config", { sourceAdapter: "codex", state: "ok" })
];

const adapter: StackAdapter = {
  id: "omlx",
  name: "oMLX",
  manifest: {
    adapterId: "omlx",
    adapterName: "oMLX",
    manifestVersion: 1,
    description: "t",
    discoverySources: [],
    permissions: [],
    refreshProfile: { intervalSeconds: 15, onDemand: true },
    telemetryCoverage: [],
    supportedCapabilities: ["discovery", "action-start", "action-stop"],
    supportedActions: ["read", "dry-run"]
  },
  async collect(_context: AdapterContext) {
    return { nodes: RESOURCES, edges: [], redactionHints: [] };
  },
  async health() {
    return { adapterId: "omlx", alive: true };
  }
};

describe("resource detail API", () => {
  it("deep-links to a stable resource id and returns the correct detail", async () => {
    const built = await buildApp({ dataDir: path.join(tmpDir, "api"), adapters: [adapter], schedulerAutoStart: false });
    await built.scheduler.collect("all");

    const res = await built.app.inject({ method: "GET", url: `/api/resources/${encodeURIComponent("omlx:runtime:server")}` });
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.data.resource.id).toBe("omlx:runtime:server");
    expect(body.data.resource.type).toBe("runtime");
    expect(body.data.host.hostId).toBe(built.host.hostId);

    // Evidence includes source and observation time.
    expect(body.data.evidence[0].source).toBe("omlx");
    expect(body.data.evidence[0].observedAt).toBeTruthy();

    // Capabilities distinguish supported vs unsupported.
    const start = body.data.capabilities.find((c: { capability: string }) => c.capability === "action-start");
    expect(start.status).toBe("supported");
    expect(body.data.capabilities.some((c: { capability: string }) => c.capability === "discovery")).toBe(true);

    // Managed status + available actions are visible but not bypassable.
    expect(typeof body.data.managed).toBe("boolean");
    expect(body.data.availableActions).toContain("start");
    await built.close();
  });

  it("covers runtime, model, assistant, and config resource types", async () => {
    const built = await buildApp({ dataDir: path.join(tmpDir, "api2"), adapters: [adapter], schedulerAutoStart: false });
    await built.scheduler.collect("all");

    for (const id of ["omlx:runtime:server", "omlx:model:path-abc", "openclaw:assistant:hermes", "codex:config:config.toml"]) {
      const res = await built.app.inject({ method: "GET", url: `/api/resources/${encodeURIComponent(id)}` });
      expect(res.json().ok, `detail for ${id} failed`).toBe(true);
      expect(res.json().data.resource.id).toBe(id);
    }
    await built.close();
  });

  it("unknown resource ids return a clean not-found error", async () => {
    const built = await buildApp({ dataDir: path.join(tmpDir, "api3"), adapters: [adapter], schedulerAutoStart: false });
    await built.scheduler.collect("all");
    const res = await built.app.inject({ method: "GET", url: "/api/resources/nope%3Aruntime%3Ax" });
    expect(res.json().ok).toBe(false);
    expect(res.json().error.code).toBe("RESOURCE_NOT_FOUND");
    await built.close();
  });

  it("exposes relations, telemetry, drift, and action history sections", async () => {
    const built = await buildApp({ dataDir: path.join(tmpDir, "api4"), adapters: [adapter], schedulerAutoStart: false });
    await built.scheduler.collect("all");
    await built.app.inject({
      method: "POST",
      url: "/api/metrics",
      payload: { scope: "omlx:runtime:server", layer: "runtime", metric: "memory_kb", source: "omlx", coverage: "runtime-level", kind: "gauge", value: 2048 }
    });

    const res = await built.app.inject({ method: "GET", url: "/api/resources/omlx%3Aruntime%3Aserver" });
    const data = res.json().data;
    expect(Array.isArray(data.relations)).toBe(true);
    expect(Array.isArray(data.telemetry)).toBe(true);
    expect(Array.isArray(data.drift)).toBe(true);
    expect(Array.isArray(data.actionHistory)).toBe(true);
    await built.close();
  });
});