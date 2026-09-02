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
 * Read-only llama.cpp runtime integration (issue #9): process and registry
 * discovery produce one canonical runtime per instance; OpenAI-compatible and
 * llama.cpp-specific identity evidence are recorded separately; loaded and
 * serving states are never inferred from process presence alone.
 */
export class LlamaCppAdapter implements StackAdapter {
  id = "llama-cpp";
  name = "llama.cpp";
  manifest: AdapterManifest = {
    adapterId: "llama-cpp",
    adapterName: "llama.cpp",
    manifestVersion: 1,
    description: "Read-only llama.cpp server: canonical runtime per instance with separate identity evidence layers.",
    discoverySources: ["ps/pgrep llama-server", "registered custom endpoints (registry)", "http://127.0.0.1:8081/v1/models"],
    permissions: ["process-read", "endpoint-read"],
    refreshProfile: { intervalSeconds: 15, onDemand: true },
    telemetryCoverage: ["memory-telemetry"],
    supportedCapabilities: [
      "discovery",
      "process-state",
      "endpoint-state",
      "model-inventory",
      "model-load-state",
      "memory-telemetry",
      "health-check"
    ],
    supportedActions: ["read", "dry-run"]
  };
  private lastError: string | undefined;

  private readonly endpoints = (process.env.LLAMACPP_ENDPOINTS ?? "http://127.0.0.1:8081")
    .split(",")
    .map((endpoint) => endpoint.trim())
    .filter(Boolean);

  async collect(context: AdapterContext): Promise<AdapterResult> {
    const nodes: ResourceNode[] = [];
    const edges = [];
    const process = await this.findProcess();

    // One canonical runtime per instance: process discovery wins the identity,
    // registry endpoints attach to the same runtime when they match.
    const runtime = node(
      this.id,
      "runtime",
      process ? `pid-${process.pid}` : "llama-server",
      "llama.cpp Server",
      process ? "running" : "stopped",
      process
        ? {
            pid: process.pid,
            processMemoryKb: process.rssKb ?? null,
            memoryLevel: "process",
            identitySource: "process",
            evidence: [`process pid=${process.pid}`, `rss_kb=${process.rssKb ?? "unknown"}`]
          }
        : { evidence: ["no llama-server process found"] }
    );
    nodes.push(runtime);

    for (const baseUrl of this.endpoints) {
      const port = new URL(baseUrl).port || "8081";
      const endpoint = node(this.id, "endpoint", port, `llama.cpp :${port}`, "unknown", {
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
          evidence: [
            `GET ${baseUrl}/v1/models -> 200`,
            `openai_compatible=${verified.openaiCompatible}`,
            `llama_specific=${verified.llamaSpecific}`
          ],
          openaiCompatible: verified.openaiCompatible,
          llamaSpecific: verified.llamaSpecific
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
          loadedFrom: endpoint.id,
          memoryLevel: "model",
          memoryKb: null,
          evidence: ["listed in /v1/models response", "serving state requires endpoint verification, not process presence"]
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
        .find(
          (row) =>
            /(^|\s)(llama-server|llama-server\.exe|python.*llama\.cpp)(\s|$)/i.test(row) && !/grep|ps -axo/.test(row)
        );
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
  ): Promise<{ ok: boolean; modelIds: string[]; modelCount: number; openaiCompatible: boolean; llamaSpecific: boolean; error?: string }> {
    try {
      const response = await fetch(`${baseUrl}/v1/models`, { signal: AbortSignal.timeout(timeoutMs) });
      if (!response.ok) {
        return { ok: false, modelIds: [], modelCount: 0, openaiCompatible: false, llamaSpecific: false, error: `HTTP ${response.status}` };
      }
      const body = (await response.json()) as ModelList;
      const ids = (body.data ?? []).map((model) => model.id);
      // llama.cpp exposes /props (server info); OpenAI-compatible shape is the /v1/models list.
      let llamaSpecific = false;
      try {
        const props = await fetch(`${baseUrl}/props`, { signal: AbortSignal.timeout(timeoutMs) });
        llamaSpecific = props.ok;
      } catch {
        llamaSpecific = false;
      }
      return {
        ok: true,
        modelIds: ids,
        modelCount: ids.length,
        openaiCompatible: true,
        llamaSpecific
      };
    } catch (error) {
      return {
        ok: false,
        modelIds: [],
        modelCount: 0,
        openaiCompatible: false,
        llamaSpecific: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }
}