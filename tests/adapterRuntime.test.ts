import { describe, expect, it, vi } from "vitest";
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

  it("aborts timed out collection and never caches a late result", async () => {
    vi.useFakeTimers();
    let observedAbort = false;
    const slow: StackAdapter = {
      id: "slow",
      name: "Slow",
      async collect(context) {
        return await new Promise((resolve) => {
          context.signal.addEventListener("abort", () => {
            observedAbort = true;
          });
          setTimeout(
            () =>
              resolve({
                nodes: [
                  {
                    id: "slow:tool:late",
                    type: "tool",
                    label: "Late",
                    state: "ok",
                    sourceAdapter: "slow",
                    properties: {},
                    lastSeenAt: new Date().toISOString(),
                    graphSchemaVersion: GRAPH_SCHEMA_VERSION
                  }
                ],
                edges: [],
                redactionHints: []
              }),
            100
          );
        });
      },
      async health() {
        return { adapterId: "slow", alive: true };
      }
    };

    const runtime = new AdapterRuntime([slow], 20);
    const pending = runtime.collectAll();
    await vi.advanceTimersByTimeAsync(20);
    const timedOut = await pending;
    expect(observedAbort).toBe(true);
    expect(timedOut.runs[0].status).toBe("timeout");
    expect(timedOut.result.nodes).toEqual([]);

    await vi.advanceTimersByTimeAsync(100);
    expect(runtime.getLastRuns()[0].status).toBe("timeout");
    vi.useRealTimers();
  });

  it("shares concurrent collection and marks fallback nodes stale", async () => {
    let calls = 0;
    let fail = false;
    const adapter: StackAdapter = {
      id: "single",
      name: "Single",
      async collect() {
        calls += 1;
        if (fail) throw new Error("offline");
        return {
          nodes: [
            {
              id: "single:tool:one",
              type: "tool",
              label: "Single",
              state: "ok",
              sourceAdapter: "single",
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
        return { adapterId: "single", alive: !fail };
      }
    };

    const runtime = new AdapterRuntime([adapter], 100);
    await Promise.all([runtime.collectAll(), runtime.collectAll()]);
    expect(calls).toBe(1);

    fail = true;
    const fallback = await runtime.collectAll();
    expect(fallback.runs[0].stale).toBe(true);
    expect(fallback.result.nodes[0].properties.stale).toBe(true);
  });

  it("uses a persisted snapshot seed when the first live collection fails", async () => {
    const failing: StackAdapter = {
      id: "persisted",
      name: "Persisted",
      async collect() {
        throw new Error("offline after restart");
      },
      async health() {
        return { adapterId: "persisted", alive: false };
      }
    };
    const runtime = new AdapterRuntime([failing], 100);
    runtime.seedFromSnapshot({
      nodes: [
        {
          id: "persisted:tool:one",
          type: "tool",
          label: "Persisted Tool",
          state: "ok",
          sourceAdapter: "persisted",
          properties: {},
          lastSeenAt: new Date().toISOString(),
          graphSchemaVersion: GRAPH_SCHEMA_VERSION
        }
      ],
      edges: [],
      adapterRuns: [],
      driftRecords: []
    });

    const result = await runtime.collectAll();
    expect(result.runs[0].stale).toBe(true);
    expect(result.result.nodes[0].id).toBe("persisted:tool:one");
    expect(result.result.nodes[0].properties.stale).toBe(true);
  });
});
