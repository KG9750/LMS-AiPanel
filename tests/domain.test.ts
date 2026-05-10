import { describe, expect, it } from "vitest";
import { resourceId, stableHash } from "../src/domain/ids";
import { redactValue } from "../src/domain/redaction";
import { evaluateDrift } from "../src/domain/drift";
import { GRAPH_SCHEMA_VERSION, type ResourceNode } from "../src/shared/schemas";

describe("resource ids", () => {
  it("creates stable adapter-scoped ids", () => {
    expect(resourceId("claude", "config", "user-settings")).toBe("claude:config:user-settings");
    expect(stableHash("/some/local/path")).toBe(stableHash("/some/local/path"));
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
});

describe("drift engine", () => {
  it("marks stopped runtime resources as runtime drift", () => {
    const node: ResourceNode = {
      id: "launchagent:runtime:test",
      type: "runtime",
      label: "test",
      state: "stopped",
      sourceAdapter: "launchagent",
      properties: {
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
