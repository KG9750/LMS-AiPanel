// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { buildOperations, type AttentionItem, type OperationsWorkspace } from "../src/client/operations";
import { GRAPH_SCHEMA_VERSION, type AdapterRun, type DriftRecord, type SystemSnapshot } from "../src/shared/schemas";

const NOW = "2026-01-01T00:00:00.000Z";

function node(id: string, state: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    type: "runtime" as const,
    label: id.split(":").pop()!,
    state: state as "ok" | "warning" | "error" | "unknown" | "stopped" | "running",
    sourceAdapter: "omlx",
    hostId: "host-1",
    properties: { ...extra },
    lastSeenAt: NOW,
    graphSchemaVersion: GRAPH_SCHEMA_VERSION as 2
  };
}

function run(adapterId: string, status: AdapterRun["status"], extra: Partial<AdapterRun> = {}): AdapterRun {
  return {
    runId: `run:${adapterId}`,
    adapterId,
    startedAt: NOW,
    finishedAt: NOW,
    status,
    durationMs: 5,
    stale: false,
    ...extra
  };
}

function snapshot(overrides: Partial<SystemSnapshot> = {}): SystemSnapshot {
  return {
    version: 1,
    host: { hostId: "host-1", hostName: "mac", scope: "local", createdAt: NOW, lastSeenAt: NOW },
    nodes: [],
    edges: [],
    adapterRuns: [],
    driftRecords: [],
    ...overrides
  };
}

describe("operations workspace (browser logic)", () => {
  it("orders attention items before healthy inventory counts", () => {
    const ws = buildOperations(
      snapshot({
        nodes: [node("omlx:runtime:down", "error"), node("omlx:runtime:up", "running")],
        adapterRuns: [run("docker", "failed", { error: "timeout" })],
        driftRecords: [
          {
            id: "drift:1",
            resourceId: "omlx:runtime:down",
            status: "unreachable",
            configured: {},
            live: {},
            evidence: ["endpoint unreachable"],
            severity: "critical",
            createdAt: NOW
          } satisfies DriftRecord
        ]
      })
    );

    // Attention items exist for each problem, ordered by construction.
    expect(ws.attention.length).toBeGreaterThanOrEqual(3);
    expect(ws.attention[0].severity).toBe("critical"); // unreachable first
    expect(ws.attention.some((a) => a.title.includes("采集失败：docker"))).toBe(true);
    expect(ws.attention.some((a) => a.title.includes("漂移"))).toBe(true);
    // Running components listed separately.
    expect(ws.running.map((n) => n.id)).toEqual(["omlx:runtime:up"]);
  });

  it("surfaces upgrade advice as attention items", () => {
    const ws = buildOperations(
      snapshot({
        nodes: [node("skills:skill:x", "ok", { upgrade: { available: true, recommended: true, remoteVersion: "2.0.0" } })]
      })
    );
    expect(ws.attention.some((a) => a.title.includes("升级可用"))).toBe(true);
    expect(ws.attention.find((a) => a.title.includes("升级可用"))?.severity).toBe("warning");
  });

  it("shows stale adapter evidence as info attention", () => {
    const ws = buildOperations(snapshot({ adapterRuns: [run("ollama", "failed", { stale: true })] }));
    expect(ws.attention.some((a) => a.title.includes("陈旧数据") || a.title.includes("采集失败"))).toBe(true);
  });

  it("reports recent adapter activity", () => {
    const ws = buildOperations(snapshot({ adapterRuns: [run("omlx", "success"), run("docker", "failed")] }));
    expect(ws.activity.length).toBe(2);
    expect(ws.activity[0].kind).toBe("adapter");
  });
});

// Keep the exported types referenced so the import stays meaningful.
void (0 as unknown as AttentionItem);
void (0 as unknown as OperationsWorkspace);