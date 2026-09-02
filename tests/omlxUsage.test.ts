import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { OmlxUsageAdapter } from "../src/adapters/omlxUsageAdapter";

let tempRoot: string | undefined;

afterEach(async () => {
  if (tempRoot) await fs.rm(tempRoot, { recursive: true, force: true });
  tempRoot = undefined;
});

describe("oMLX provider telemetry", () => {
  it("collects cumulative usage that covers every endpoint client", async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lms-omlx-"));
    const instance = path.join(tempRoot, "deepseek-data");
    await fs.mkdir(instance);
    await fs.writeFile(
      path.join(instance, "stats.json"),
      JSON.stringify({
        total_prompt_tokens: 1000,
        total_completion_tokens: 250,
        total_cached_tokens: 600,
        total_requests: 12,
        per_model: {}
      })
    );
    await fs.writeFile(
      path.join(instance, "model_settings.json"),
      JSON.stringify({ models: { "deepseek-local": { display_name: "DeepSeek Local", is_default: true } } })
    );

    const result = await new OmlxUsageAdapter([tempRoot]).collect({
      now: () => new Date(),
      timeoutMs: 1_000,
      signal: new AbortController().signal
    });
    const model = result.nodes.find((item) => item.type === "model");
    expect(model?.properties.tokenUsage).toMatchObject({
      source: "omlx",
      telemetryLayer: "provider",
      coverage: "all-endpoint-clients",
      inputTokens: 1000,
      outputTokens: 250,
      cachedTokens: 600,
      totalTokens: 1250,
      requestCount: 12
    });
  });

  it("supports per-model oMLX statistic field names", async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lms-omlx-model-"));
    const instance = path.join(tempRoot, "deepseek-data");
    await fs.mkdir(instance);
    await fs.writeFile(
      path.join(instance, "stats.json"),
      JSON.stringify({
        per_model: {
          "deepseek-local": {
            prompt_tokens: 900,
            completion_tokens: 100,
            cached_tokens: 700,
            requests: 4
          }
        }
      })
    );

    const result = await new OmlxUsageAdapter([tempRoot]).collect({
      now: () => new Date(),
      timeoutMs: 1_000,
      signal: new AbortController().signal
    });
    expect(result.nodes.find((item) => item.type === "model")?.properties.tokenUsage).toMatchObject({
      inputTokens: 900,
      outputTokens: 100,
      cachedTokens: 700,
      totalTokens: 1000,
      requestCount: 4
    });
  });
});
