import { execa } from "execa";
import type { AdapterManifest, AdapterResult, ResourceNode } from "../shared/schemas";
import type { AdapterContext, HealthStatus, StackAdapter } from "./types";
import { edge, node } from "./helpers";

interface ModelList {
  data?: Array<{ id: string }>;
}

interface ProcessRow {
  pid: string;
  command: string;
  rssKb?: number;
}

/**
 * Read-only MLX Server runtime integration (issue #8): detects registered
 * custom endpoints and running processes, projects them through the unified
 * Runtime/Endpoint/Model capability and evidence vocabulary established by
 * the oMLX slice.
 */
export class MlxServerAdapter implements StackAdapter {
  id = "mlx-server";
  name = "MLX Server";
  manifest: AdapterManifest = {
    adapterId: "mlx-server",
    adapterName: "MLX Server",
    manifestVersion: 1,
    description: "Read-only MLX Server runtime: process and endpoint discovery with verified endpoint identity.",
    discoverySources: ["ps/pgrep mlx_lm.server", "registered custom endpoints (registry)", "http://127.0.0.1:8080/v1/models"],
    permissions: ["process-read", "endpoint-read"],
    refreshProfile: { intervalSeconds: 15, onDemand: true },
    telemetryCoverage: ["memory-telemetry", "token-telemetry"],
    supportedCapabilities: [
      "discovery",
      "process-state",
      "endpoint-state",
      "model-inventory",
      "model-load-state",
      "memory-telemetry",
      "token-telemetry",
      "health-check"
    ],
    supportedActions: ["read", "dry-run"]
  };
  private lastError: string | undefined;

  private readonly endpoints = (process.env.MLX_SERVER_ENDPOINTS ?? "http://127.0.0.1:8080")
    .split(",")
    .map((endpoint) => endpoint.trim())
    .filter(Boolean);

  async collect(context: AdapterContext): Promise<AdapterResult> {
    const nodes: ResourceNode[] = [];
    const edges = [];
    const process = await this.findProcess();

    const runtime = node(
      this.id,
      "runtime",
      "mlx-server",
      "MLX Server",
      process ? "running" : "stopped",
      process
        ? {
            pid: process.pid,
            processMemoryKb: process.rssKb ?? null,
            memoryLevel: "process",
            evidence: [`process pid=${process.pid}`, `rss_kb=${process.rssKb ?? "unknown"}`]
          }
        : { evidence: ["no mlx_lm.server process found"] }
    );
    nodes.push(runtime);

    for (const baseUrl of this.endpoints) {
      const port = new URL(baseUrl).port || "8080";
      const endpointId = `mlx-server:endpoint:${port}`;
      const endpoint = node(this.id, "endpoint", port, `MLX Server :${port}`, "unknown", {
        baseUrl,
        evidence: ["registered endpoint", "GET /v1/models"]
      });

      const verified = await this.verifyEndpoint(baseUrl, context.timeoutMs);
      if (verified.ok) {
        endpoint.state = "running";
        endpoint.properties = {
          ...endpoint.properties,
          endpointVerified: true,
          modelCount: verified.modelCount,
          evidence: [`GET ${baseUrl}/v1/models -> 200`, `models=${verified.modelCount}`]
        };
      } else if (process) {
        endpoint.state = "unknown";
        endpoint.properties = {
          ...endpoint.properties,
          endpointVerified: false,
          evidence: [`endpoint not verified: ${verified.error ?? "unreachable"}`]
        };
      } else {
        endpoint.state = "stopped";
        endpoint.properties = {
          ...endpoint.properties,
          endpointVerified: false,
          evidence: ["runtime stopped; endpoint not reachable"]
        };
      }
      nodes.push(endpoint);
      edges.push(edge(runtime.id, "exposes", endpoint.id));

      for (const modelId of verified.modelIds) {
        const instance = node(this.id, "model", `instance:${port}:${modelId}`, modelId, "running", {
          stableKey: `instance:${port}:${modelId}`,
          loadedFrom: endpointId,
          memoryLevel: "model",
          memoryKb: null,
          evidence: ["listed in /v1/models response", "endpoint verified live"]
        });
        nodes.push(instance);
        edges.push(edge(instance.id, "runs_on", endpoint.id));
      }
    }

    this.lastError = undefined;
    return { nodes, edges, redactionHints: [] };
  }

  async health(): Promise<HealthStatus> {
    return {
      adapterId: this.id,
      alive: this.lastError === undefined,
      lastError: this.lastError
    };
  }

  private async findProcess(): Promise<ProcessRow | null> {
    try {
      const { stdout } = await execa("ps", ["-axo", "pid=,rss=,command="], { timeout: 3_000 });
      const line = stdout
        .split("\n")
        .find((row) => /(^|\s)(mlx_lm\.server|python.*mlx_lm)(\s|$)/i.test(row) && !/grep|ps -axo/.test(row));
      if (!line) return null;
      const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
      if (!match) return null;
      return { pid: match[1], command: match[3], rssKb: Number(match[2]) };
    } catch {
      return null;
    }
  }

  private async verifyEndpoint(
    baseUrl: string,
    timeoutMs: number
  ): Promise<{ ok: boolean; modelIds: string[]; modelCount: number; error?: string }> {
    try {
      const response = await fetch(`${baseUrl}/v1/models`, { signal: AbortSignal.timeout(timeoutMs) });
      if (!response.ok) return { ok: false, modelIds: [], modelCount: 0, error: `HTTP ${response.status}` };
      const body = (await response.json()) as ModelList;
      const ids = (body.data ?? []).map((model) => model.id);
      return { ok: true, modelIds: ids, modelCount: ids.length };
    } catch (error) {
      return {
        ok: false,
        modelIds: [],
        modelCount: 0,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }
}