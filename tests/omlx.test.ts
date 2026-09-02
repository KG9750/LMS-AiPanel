import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OmlxAdapter } from "../src/adapters/omlxAdapter";
import type { AdapterContext } from "../src/adapters/types";

let tmpDir: string;
let modelDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "lms-omlx-test-"));
  modelDir = path.join(tmpDir, "models");
  await fs.mkdir(path.join(modelDir, "llama-3-8b"), { recursive: true });
  await fs.mkdir(path.join(modelDir, "qwen-2.5-7b"), { recursive: true });
  process.env.OMLX_MODEL_DIR = modelDir;
});

afterEach(async () => {
  delete process.env.OMLX_MODEL_DIR;
  delete process.env.OMLX_ENDPOINT;
  await fs.rm(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const CTX: AdapterContext = { now: () => new Date(), timeoutMs: 1_000 };

function startFakeEndpoint(models: string[]): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.url === "/v1/models") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ object: "list", data: models.map((id) => ({ id, object: "model" })) }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as { port: number };
      process.env.OMLX_ENDPOINT = `http://127.0.0.1:${address.port}`;
      resolve({
        port: address.port,
        close: () => new Promise((res) => server.close(() => res()))
      });
    });
  });
}

describe("oMLX adapter", () => {
  it("models runtime, endpoint, artifact, and instance as distinct identities", async () => {
    const fake = await startFakeEndpoint(["llama-3-8b"]);
    const adapter = new OmlxAdapter();
    const result = await adapter.collect(CTX);
    await fake.close();

    const ids = result.nodes.map((n) => n.id);
    expect(ids).toContain("omlx:runtime:server");
    expect(ids).toContain(`omlx:endpoint:${fake.port}`);
    expect(ids.some((id) => id.startsWith("omlx:model:path-"))).toBe(true);
    expect(ids).toContain("omlx:model:instance:llama-3-8b");

    const endpoint = result.nodes.find((n) => n.id === `omlx:endpoint:${fake.port}`)!;
    expect(endpoint.properties.endpointVerified).toBe(true);
    expect(endpoint.state).toBe("running");

    const artifact = result.nodes.find((n) => n.type === "model" && n.id.startsWith("omlx:model:path-"))!;
    // llama-3-8b is loaded: ok. qwen-2.5-7b is not: stopped (configured but unloaded).
    const qwen = result.nodes.find((n) => n.label === "qwen-2.5-7b")!;
    expect(qwen.state).toBe("stopped");
    expect(artifact.label).toBe("llama-3-8b");
    expect(artifact.state).toBe("ok");
  });

  it("marks loaded models as running instances with model-level memory evidence", async () => {
    const fake = await startFakeEndpoint(["llama-3-8b"]);
    const adapter = new OmlxAdapter();
    const result = await adapter.collect(CTX);
    await fake.close();

    const instance = result.nodes.find((n) => n.id === "omlx:model:instance:llama-3-8b")!;
    expect(instance.state).toBe("running");
    expect(instance.properties.memoryLevel).toBe("model");
    expect((instance.properties.evidence as string[]).some((e: string) => e.includes("listed in /v1/models"))).toBe(true);
  });

  it("stopped runtime: no process and unreachable endpoint stay distinct and read-only", async () => {
    // Point the endpoint at a port with nothing listening.
    process.env.OMLX_ENDPOINT = "http://127.0.0.1:1";
    const adapter = new OmlxAdapter();
    const result = await adapter.collect(CTX);

    const runtime = result.nodes.find((n) => n.id === "omlx:runtime:server")!;
    const endpoint = result.nodes.find((n) => n.id === "omlx:endpoint:1")!;
    // No process on this machine (or the sandbox has none): runtime is stopped
    // or unknown, never 'running' without process evidence.
    expect(runtime.state).toBe("stopped");
    expect(endpoint.properties.endpointVerified).toBe(false);
    // Artifacts remain configured (unloaded), never deleted.
    expect(result.nodes.some((n) => n.label === "qwen-2.5-7b")).toBe(true);
  });

  it("endpoint-total telemetry stays endpoint-scoped without inventing client attribution", async () => {
    const fake = await startFakeEndpoint(["llama-3-8b", "qwen-2.5-7b"]);
    const adapter = new OmlxAdapter();
    const result = await adapter.collect(CTX);
    await fake.close();

    const endpoint = result.nodes.find((n) => n.properties.endpointVerified === true)!;
    expect(endpoint.properties.modelCount).toBe(2);
    // No client attribution anywhere: properties never contain client/user fields.
    for (const node of result.nodes) {
      expect(Object.keys(node.properties).some((k) => /client|user|prompt|chat/i.test(k))).toBe(false);
    }
  });

  it("missing telemetry is distinct from zero values", async () => {
    const fake = await startFakeEndpoint(["llama-3-8b"]);
    const adapter = new OmlxAdapter();
    const result = await adapter.collect(CTX);
    await fake.close();

    const instance = result.nodes.find((n) => n.id === "omlx:model:instance:llama-3-8b")!;
    // memoryKb is explicitly null (unknown) instead of 0.
    expect(instance.properties.memoryKb).toBeNull();
  });
});