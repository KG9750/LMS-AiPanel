import { describe, expect, it } from "vitest";
import { AdapterRuntime } from "../src/adapters/runtime";
import type { AdapterContext, StackAdapter } from "../src/adapters/types";
import { GRAPH_SCHEMA_VERSION, type AdapterManifest } from "../src/shared/schemas";

const TEST_MANIFEST: AdapterManifest = {
  adapterId: "good",
  adapterName: "Good",
  manifestVersion: 1,
  description: "test",
  discoverySources: [],
  permissions: [],
  refreshProfile: { intervalSeconds: 60, onDemand: true },
  telemetryCoverage: [],
  supportedCapabilities: [],
  supportedActions: []
};

describe("AdapterRuntime", () => {
  it("isolates adapter failures and returns successful adapter resources", async () => {
    const good: StackAdapter = {
      id: "good",
      name: "Good",
      manifest: TEST_MANIFEST,
      async collect(_context: AdapterContext) {
        return {
          nodes: [
            {
              id: "good:tool:one",
              type: "tool",
              label: "Good Tool",
              state: "ok",
              sourceAdapter: "good",
              hostId: "pending",
              properties: {},
              lastSeenAt: new Date().toISOString(),
              graphSchemaVersion: GRAPH_SCHEMA_VERSION
            }
          ],
          edges: [],
          redactionHints: []
        };
      },
      async health() {
        return { adapterId: "good", alive: true };
      }
    };

    const bad: StackAdapter = {
      id: "bad",
      name: "Bad",
      manifest: { ...TEST_MANIFEST, adapterId: "bad", adapterName: "Bad" },
      async collect() {
        throw new Error("boom");
      },
      async health() {
        return { adapterId: "bad", alive: false, lastError: "boom" };
      }
    };

    const runtime = new AdapterRuntime([good, bad], 100);
    const result = await runtime.collectAll();
    expect(result.result.nodes.map((node) => node.id)).toEqual(["good:tool:one"]);
    expect(result.runs).toHaveLength(2);
    expect(result.runs.find((run) => run.adapterId === "bad")?.status).toBe("failed");
  });
});

