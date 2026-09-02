import { describe, expect, it } from "vitest";
import { summarizeModelTokenUsage } from "../src/client/main";
import { GRAPH_SCHEMA_VERSION, type ResourceNode } from "../src/shared/schemas";

describe("local model token summary", () => {
  it("sums only models with real usage records", () => {
    const nodes: ResourceNode[] = [
      modelNode("one", { inputTokens: 100, outputTokens: 40, totalTokens: 140, requestCount: 2, lastUsedAt: "2026-09-02T00:00:00.000Z" }),
      modelNode("two", { inputTokens: 20, outputTokens: 10, totalTokens: 30, requestCount: 1, lastUsedAt: "2026-09-02T01:00:00.000Z" }),
      modelNode("no-data", undefined)
    ];

    const summary = summarizeModelTokenUsage(nodes);
    expect(summary.models).toHaveLength(2);
    expect(summary).toMatchObject({ inputTokens: 120, outputTokens: 50, totalTokens: 170, requestCount: 3 });
  });
});

function modelNode(key: string, tokenUsage: Record<string, unknown> | undefined): ResourceNode {
  return {
    id: `openwebui:model:${key}`,
    type: "model",
    label: key,
    state: "ok",
    sourceAdapter: "openwebui",
    properties: { tokenUsage },
    lastSeenAt: new Date().toISOString(),
    graphSchemaVersion: GRAPH_SCHEMA_VERSION
  };
}
