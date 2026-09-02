import { describe, expect, it } from "vitest";
import { summarizeMeta } from "../src/adapters/openWebUIAdapter";

describe("Open WebUI metadata", () => {
  it("keeps allowlisted summaries and drops credentials", () => {
    const summary = summarizeMeta(
      JSON.stringify({
        description: "Local chat model",
        capabilities: ["tools", "vision"],
        api_key: "must-not-leak",
        connection: { token: "must-not-leak" }
      })
    );
    expect(summary).toEqual({ description: "Local chat model", capabilities: ["tools", "vision"] });
    expect(JSON.stringify(summary)).not.toContain("must-not-leak");
  });
});
