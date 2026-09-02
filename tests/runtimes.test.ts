import http from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LlamaCppAdapter } from "../src/adapters/llamaCppAdapter";
import { MlxServerAdapter } from "../src/adapters/mlxServerAdapter";
import { OllamaAdapter } from "../src/adapters/ollamaAdapter";
import type { AdapterContext } from "../src/adapters/types";

const CTX: AdapterContext = { now: () => new Date(), timeoutMs: 1_000 };

let servers: Array<{ close: () => Promise<void> }> = [];

afterEach(async () => {
  for (const server of servers) await server.close();
  servers = [];
  delete process.env.MLX_SERVER_ENDPOINTS;
  delete process.env.LLAMACPP_ENDPOINTS;
  delete process.env.OLLAMA_ENDPOINT;
});

function fakeServer(handler: (req: http.IncomingMessage, res: http.ServerResponse) => void): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      const entry = {
        port,
        close: () =>
          new Promise<void>((res) => {
            server.close(() => res());
          })
      };
      servers.push(entry);
      resolve(entry);
    });
  });
}

describe("MLX Server adapter", () => {
  it("discovers a registered endpoint and verified loaded models", async () => {
    const fake = await fakeServer((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ object: "list", data: [{ id: "mlx-community/Qwen3-4B" }] }));
    });
    process.env.MLX_SERVER_ENDPOINTS = `http://127.0.0.1:${fake.port}`;

    const adapter = new MlxServerAdapter();
    const result = await adapter.collect(CTX);

    const endpoint = result.nodes.find((n) => n.id === `mlx-server:endpoint:${fake.port}`)!;
    expect(endpoint.properties.endpointVerified).toBe(true);
    expect(endpoint.state).toBe("running");
    expect(result.nodes.some((n) => n.label === "mlx-community/Qwen3-4B" && n.state === "running")).toBe(true);
  });

  it("stopped endpoint without process stays distinct from verified", async () => {
    process.env.MLX_SERVER_ENDPOINTS = "http://127.0.0.1:1";
    const adapter = new MlxServerAdapter();
    const result = await adapter.collect(CTX);
    const endpoint = result.nodes.find((n) => n.id === "mlx-server:endpoint:1")!;
    expect(endpoint.properties.endpointVerified).toBe(false);
    expect(["stopped", "unknown"]).toContain(endpoint.state);
    (endpoint.properties.evidence as string[]).some((e: string) => e.includes("not reachable") || e.includes("not verified"))).toBe(true);
  });
});

describe("llama.cpp adapter", () => {
  it("records OpenAI-compatible and llama.cpp-specific identity evidence separately", async () => {
    const fake = await fakeServer((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      if (req.url === "/props") {
        res.end(JSON.stringify({ total_slots: 4, model: "qwen2.5-7b" }));
      } else {
        res.end(JSON.stringify({ object: "list", data: [{ id: "qwen2.5-7b" }] }));
      }
    });
    process.env.LLAMACPP_ENDPOINTS = `http://127.0.0.1:${fake.port}`;

    const adapter = new LlamaCppAdapter();
    const result = await adapter.collect(CTX);
    const endpoint = result.nodes.find((n) => n.id === `llama-cpp:endpoint:${fake.port}`)!;
    expect(endpoint.properties.openaiCompatible).toBe(true);
    expect(endpoint.properties.llamaSpecific).toBe(true);
    expect(result.nodes.some((n) => n.label === "qwen2.5-7b" && n.state === "running")).toBe(true);
  });

  it("serving state is not inferred from process presence alone", async () => {
    process.env.LLAMACPP_ENDPOINTS = "http://127.0.0.1:1";
    const adapter = new LlamaCppAdapter();
    const result = await adapter.collect(CTX);
    // No live model instances without endpoint verification, even if a
    // process happened to match.
    expect(result.nodes.filter((n) => n.state === "running" && n.type === "model")).toHaveLength(0);
  });
});

describe("Ollama adapter", () => {
  it("distinguishes installed artifacts from loaded instances", async () => {
    const fake = await fakeServer((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      if (req.url === "/api/tags") {
        res.end(
          JSON.stringify({
            models: [
              { name: "llama3.2:3b", size: 2019393930, modified_at: "2026-01-01T00:00:00Z" },
              { name: "qwen2.5:7b", size: 4812345678, modified_at: "2026-01-02T00:00:00Z" }
            ]
          })
        );
      } else {
        res.end(
          JSON.stringify({
            models: [
              { name: "llama3.2:3b", size: 2019393930, size_vram: 1939393930, expires_at: "2026-01-03T00:00:00Z" }
            ]
          })
        );
      }
    });
    process.env.OLLAMA_ENDPOINT = `http://127.0.0.1:${fake.port}`;

    const adapter = new OllamaAdapter();
    const result = await adapter.collect(CTX);

    const artifactIds = result.nodes.filter((n) => n.id.startsWith("ollama:model:path-")).map((n) => n.label);
    expect(artifactIds.sort()).toEqual(["llama3.2:3b", "qwen2.5:7b"]);

    const loaded = result.nodes.find((n) => n.id === "ollama:model:instance:llama3.2:3b")!;
    expect(loaded).toBeDefined();
    expect(loaded.state).toBe("running");
    expect(loaded.properties.memoryLevel).toBe("model");
    expect(loaded.properties.memoryKb).toBeGreaterThan(0);
    expect(loaded.properties.expiresAt).toBe("2026-01-03T00:00:00Z");

    // qwen is installed but NOT loaded.
    const qwenArtifact = result.nodes.find((n) => n.label === "qwen2.5:7b")!;
    expect(qwenArtifact.state).toBe("stopped");
    expect(result.nodes.some((n) => n.id === "ollama:model:instance:qwen2.5:7b")).toBe(false);
  });

  it("an unavailable installation does not fail the adapter", async () => {
    process.env.OLLAMA_ENDPOINT = "http://127.0.0.1:1";
    const adapter = new OllamaAdapter();
    const result = await adapter.collect(CTX);
    expect(result.nodes.length).toBeGreaterThan(0);
    const endpoint = result.nodes.find((n) => n.id === "ollama:endpoint:1")!;
    expect(endpoint.properties.apiReachable).toBe(false);
    (endpoint.properties.evidence as string[]).some((e: string) => e.includes("api=unreachable"))).toBe(true);
  });

  it("records API, process, and endpoint evidence independently", async () => {
    const fake = await fakeServer((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ models: [] }));
    });
    process.env.OLLAMA_ENDPOINT = `http://127.0.0.1:${fake.port}`;
    const adapter = new OllamaAdapter();
    const result = await adapter.collect(CTX);
    const endpoint = result.nodes.find((n) => n.id === `ollama:endpoint:${fake.port}`)!;
    const evidence = endpoint.properties.evidence as string[];
    expect(evidence.some((e) => e.startsWith("api=reachable"))).toBe(true);
    expect(evidence.some((e) => e.startsWith("process="))).toBe(true);
    expect(endpoint.properties.endpointVerified).toBe(true);
  });
});