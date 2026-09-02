import { describe, expect, it } from "vitest";
import { resourceId, stableKey } from "../src/domain/ids";
import { redactAdapterResult, redactValue } from "../src/domain/redaction";
import { evaluateDrift } from "../src/domain/drift";
import { GRAPH_SCHEMA_VERSION, type ResourceNode } from "../src/shared/schemas";

describe("resource ids", () => {
  it("creates stable adapter-scoped ids", () => {
    expect(resourceId("claude", "config", "user-settings")).toBe("claude:config:user-settings");
    expect(stableKey("/some/local/path")).toBe(stableKey("/some/local/path"));
  });
});

describe("redaction", () => {
  it("redacts sensitive key paths recursively", () => {
    const redacted = redactValue({
      env: {
        ANTHROPIC_API_KEY: "placeholder-value",
        model: "deepseek"
      },
      nested: [{ token: "placeholder-value" }]
    });

    expect(redacted).toEqual({
      env: {
        ANTHROPIC_API_KEY: "<redacted>",
        model: "deepseek"
      },
      nested: [{ token: "<redacted>" }]
    });
  });

  it("keeps token counters while redacting access tokens", () => {
    expect(
      redactValue({
        access_token: "secret-value",
        token: "secret-value",
        tokenUsage: {
          inputTokens: 120,
          outputTokens: 80,
          totalTokens: 200
        }
      })
    ).toEqual({
      access_token: "<redacted>",
      token: "<redacted>",
      tokenUsage: {
        inputTokens: 120,
        outputTokens: 80,
        totalTokens: 200
      }
    });
  });

  it("redacts sensitive values inside JSON strings and applies adapter hints", () => {
    expect(redactValue('{"api_key":"secret-value","description":"Local model"}')).toBe(
      '{"api_key":"<redacted>","description":"Local model"}'
    );

    const result = redactAdapterResult({
      nodes: [
        {
          id: "test:model:one",
          type: "model",
          label: "Test",
          state: "ok",
          sourceAdapter: "test",
          properties: { endpoint: "http://localhost:1234" },
          lastSeenAt: new Date().toISOString(),
          graphSchemaVersion: GRAPH_SCHEMA_VERSION
        }
      ],
      edges: [],
      redactionHints: [{ resourceId: "test:model:one", path: ["properties", "endpoint"], reason: "endpoint" }]
    });

    expect(result.nodes[0].properties.endpoint).toBe("<redacted>");
  });
});

describe("drift engine", () => {
  it("does not infer drift from a stopped resource without configured evidence", () => {
    const stoppedContainer: ResourceNode = {
      id: "docker:container:test",
      type: "container",
      label: "test",
      state: "stopped",
      sourceAdapter: "docker",
      properties: { evidence: ["docker state=exited"] },
      lastSeenAt: new Date().toISOString(),
      graphSchemaVersion: GRAPH_SCHEMA_VERSION
    };

    expect(evaluateDrift([stoppedContainer])).toEqual([]);
  });

  it("marks a configured but unloaded LaunchAgent as runtime drift", () => {
    const node: ResourceNode = {
      id: "launchagent:runtime:test",
      type: "runtime",
      label: "test",
      state: "stopped",
      sourceAdapter: "launchagent",
      properties: {
        configured: true,
        loaded: false,
        evidence: ["launchctl loaded=false"]
      },
      lastSeenAt: new Date().toISOString(),
      graphSchemaVersion: GRAPH_SCHEMA_VERSION
    };

    const drift = evaluateDrift([node]);
    expect(drift).toHaveLength(1);
    expect(drift[0].status).toBe("drift-runtime");
    expect(drift[0].evidence).toContain("launchctl loaded=false");
  });
});
