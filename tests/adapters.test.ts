import path from "node:path";
import { describe, expect, it } from "vitest";
import { ClaudeConfigAdapter } from "../src/adapters/claudeConfigAdapter";
import { CodexConfigAdapter } from "../src/adapters/codexConfigAdapter";

const context = {
  now: () => new Date(),
  timeoutMs: 100,
  signal: new AbortController().signal
};

describe("configuration adapters", () => {
  it("parses the Claude model and provider fixture", async () => {
    const adapter = new ClaudeConfigAdapter(path.resolve("tests/fixtures/claude"));
    const result = await adapter.collect(context);
    const model = result.nodes.find((node) => node.type === "model");
    expect(model?.label).not.toBe("unknown");
    expect(model?.properties.baseUrl).toBe("https://api.example.test/anthropic");
  });

  it("parses model and MCP names from the Codex fixture", async () => {
    const adapter = new CodexConfigAdapter(path.resolve("tests/fixtures/codex"));
    const result = await adapter.collect(context);
    expect(result.nodes.some((node) => node.type === "model" && node.label !== "unknown")).toBe(true);
    expect(result.nodes.some((node) => node.type === "mcp")).toBe(true);
  });
});
