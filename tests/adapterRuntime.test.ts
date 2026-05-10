import { describe, expect, it } from "vitest";
import { AdapterRuntime } from "../src/adapters/runtime";
import type { AdapterContext, StackAdapter } from "../src/adapters/types";
import { GRAPH_SCHEMA_VERSION } from "../src/shared/schemas";

describe("AdapterRuntime", () => {
  it("isolates adapter failures and returns successful adapter resources", async () => {
    const good: StackAdapter = {
      id: "good",
      name: "Good",
      async collect(_context: AdapterContext) {
        return {
          nodes: [
            {
              id: "good:tool:one",
              type: "tool",
              label: "Good Tool",
              state: "ok",
              sourceAdapter: "good",
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

