import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execa } from "execa";
import { afterEach, describe, expect, it } from "vitest";
import { OpenWebUIAdapter, summarizeMeta } from "../src/adapters/openWebUIAdapter";

let tempRoot: string | undefined;

afterEach(async () => {
  if (tempRoot) await fs.rm(tempRoot, { recursive: true, force: true });
  tempRoot = undefined;
});

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

  it("aggregates persisted token usage by model without reading chat content", async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lms-openwebui-"));
    const databasePath = path.join(tempRoot, "webui.db");
    await execa("sqlite3", [databasePath], {
      input: `
        create table model (id text, name text, is_active integer, meta text, updated_at integer);
        create table chat_message (model_id text, content text, usage text, created_at integer);
        insert into model values ('local-qwen','Local Qwen',1,'{}',2);
        insert into chat_message values ('local-qwen','must not be queried','{"input_tokens":120,"output_tokens":30,"total_tokens":150}',1700000000);
        insert into chat_message values ('local-qwen','must not be queried','{"prompt_n":20,"predicted_n":10}',1700000100);
      `
    });

    const adapter = new OpenWebUIAdapter(databasePath);
    const result = await adapter.collect({
      now: () => new Date(),
      timeoutMs: 1_000,
      signal: new AbortController().signal
    });
    const model = result.nodes.find((node) => node.id === "openwebui:model:local-qwen");
    expect(model?.properties.tokenUsage).toEqual({
      source: "openwebui",
      inputTokens: 140,
      outputTokens: 40,
      totalTokens: 180,
      requestCount: 2,
      lastUsedAt: "2023-11-14T22:15:00.000Z"
    });
    expect(JSON.stringify(result)).not.toContain("must not be queried");
  });

  it("keeps model discovery when an older database has no usage table", async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lms-openwebui-old-"));
    const databasePath = path.join(tempRoot, "webui.db");
    await execa("sqlite3", [databasePath], {
      input: "create table model (id text, name text, is_active integer, meta text, updated_at integer); insert into model values ('legacy','Legacy Model',1,'{}',1);"
    });

    const result = await new OpenWebUIAdapter(databasePath).collect({
      now: () => new Date(),
      timeoutMs: 1_000,
      signal: new AbortController().signal
    });
    expect(result.nodes.some((node) => node.label === "Legacy Model")).toBe(true);
    expect(result.nodes[0].state).toBe("warning");
    expect(result.nodes[0].properties.tokenUsageStatus).toBe("unavailable");
  });
});
