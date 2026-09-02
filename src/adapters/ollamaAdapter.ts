import { execa } from "execa";
import type { AdapterManifest, AdapterResult, ResourceNode } from "../shared/schemas";
import type { AdapterContext, HealthStatus, StackAdapter } from "./types";
import { edge, node, pathKey } from "./helpers";

interface OllamaTags {
  models?: Array<{
    name: string;
    size?: number;
    digest?: string;
    modified_at?: string;
  }>;
}

interface OllamaPs {
  models?: Array<{
    name: string;
    size?: number;
    digest?: string;
    expires_at?: string;
    size_vram?: number;
  }>;
}

interface ProcessRow {
  pid: string;
  command: string;
  rssKb?: number;
}

const DEFAULT_ENDPOINT = "http://127.0.0.1:11434";

/**
 * Read-only Ollama runtime integration (issue #10): installed model artifacts
 * and currently loaded model instances are different resource concepts; API,
 * process, and endpoint evidence are recorded independently.
 */
export class OllamaAdapter implements StackAdapter {
  id = "ollama";
  name = "Ollama";
  manifest: AdapterManifest = {
    adapterId: "ollama",
    adapterName: "Ollama",
    manifestVersion: 1,
    description: "Read-only Ollama runtime: installed artifacts, loaded instances, and independent evidence layers.",
    discoverySources: ["ps/pgrep ollama", "http://127.0.0.1:11434/api/tags", "http://127.0.0.1:11434/api/ps"],
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

  private readonly baseUrl = process.env.OLLAMA_ENDPOINT ?? DEFAULT_ENDPOINT;

  async collect(context: AdapterContext): Promise<AdapterResult> {
    const nodes: ResourceNode[] = [];
    const edges = [];
    const process = await this.findProcess();
    const port = new URL(this.baseUrl).port || "11434";

    const runtime = node(
      this.id,
      "runtime",
      "ollama",
      "Ollama",
      process ? "running" : "stopped",
      process
        ? {
            pid: process.pid,
            processMemoryKb: process.rssKb ?? null,
            memoryLevel: "process",
            evidence: [`process pid=${process.pid}`, `rss_kb=${process.rssKb ?? "unknown"}`]
          }
        : { evidence: ["no ollama process found"] }
    );
    nodes.push(runtime);

    const endpoint = node(this.id, "endpoint", port, `Ollama :${port}`, "unknown", {
      baseUrl: this.baseUrl,
      evidence: ["GET /api/tags"]
    });

    // Independent evidence layers: API vs process vs endpoint.
    const api = await this.queryApi(context.timeoutMs);
    endpoint.properties = {
      ...endpoint.properties,
      apiReachable: api.reachable,
      processPresent: Boolean(process),
      evidence: [
        `api=${api.reachable ? "reachable" : "unreachable"}`,
        `process=${process ? `pid ${process.pid}` : "absent"}`,
        ...(api.error ? [`api error: ${api.error}`] : [])
      ]
    };
    if (api.reachable) {
      endpoint.state = "running";
      endpoint.properties.endpointVerified = true;
    } else if (process) {
      endpoint.state = "unknown";
      endpoint.properties.endpointVerified = false;
    } else {
      endpoint.state = "stopped";
      endpoint.properties.endpointVerified = false;
    }
    nodes.push(endpoint);
    edges.push(edge(runtime.id, "exposes", endpoint.id));

    // Installed artifacts: distinct resource concept from loaded instances.
    for (const model of api.tags) {
      const artifactId = `ollama:model:${pathKey(model.name)}`;
      const loaded = api.loaded.has(model.name);
      const artifact = node(this.id, "model", pathKey(model.name), model.name, loaded ? "ok" : "stopped", {
        stableKey: pathKey(model.name),
        digest: model.digest,
        sizeBytes: model.size ?? null,
        stateEvidence: loaded ? "installed and currently loaded" : "installed but not loaded",
        evidence: [`installed: ${model.name}`, `modified_at=${model.modified_at ?? "unknown"}`]
      });
      nodes.push(artifact);
      edges.push(edge(artifact.id, "configured_by", endpoint.id));

      if (loaded) {
        const ps = api.ps.get(model.name);
        const instance = node(this.id, "model", `instance:${model.name}`, `${model.name} (loaded)`, "running", {
          stableKey: `instance:${model.name}`,
          loadedFrom: endpoint.id,
          memoryLevel: "model",
          memoryKb: ps?.sizeVramKb ?? null,
          expiresAt: ps?.expiresAt ?? null,
          evidence: ["listed in /api/ps response", "endpoint verified live"]
        });
        nodes.push(instance);
        edges.push(edge(instance.id, "runs_on", endpoint.id));
        edges.push(edge(instance.id, "uses", artifact.id));
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
        .find((row) => /(^|\s)(ollama|ollama serve)(\s|$)/i.test(row) && !/grep|ps -axo/.test(row));
      if (!line) return null;
      const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
      if (!match) return null;
      return { pid: match[1], command: match[3], rssKb: Number(match[2]) };
    } catch {
      return null;
    }
  }

  private async queryApi(
    timeoutMs: number
  ): Promise<{
    reachable: boolean;
    tags: Array<{ name: string; size?: number; digest?: string; modified_at?: string }>;
    loaded: Set<string>;
    ps: Map<string, { sizeVramKb?: number; expiresAt?: string }>;
    error?: string;
  }> {
    const empty = { reachable: false, tags: [], loaded: new Set<string>(), ps: new Map() };
    try {
      const [tagsRes, psRes] = await Promise.all([
        fetch(`${this.baseUrl}/api/tags`, { signal: AbortSignal.timeout(timeoutMs) }),
        fetch(`${this.baseUrl}/api/ps`, { signal: AbortSignal.timeout(timeoutMs) })
      ]);
      if (!tagsRes.ok || !psRes.ok) {
        return { ...empty, error: `HTTP tags=${tagsRes.status} ps=${psRes.status}` };
      }
      const tags = (await tagsRes.json()) as OllamaTags;
      const ps = (await psRes.json()) as OllamaPs;
      const loaded = new Set((ps.models ?? []).map((model) => model.name));
      const psMap = new Map<string, { sizeVramKb?: number; expiresAt?: string }>();
      for (const model of ps.models ?? []) {
        psMap.set(model.name, {
          sizeVramKb: model.size_vram !== undefined ? Math.round(model.size_vram / 1024) : undefined,
          expiresAt: model.expires_at ?? undefined
        });
      }
      return {
        reachable: true,
        tags: tags.models ?? [],
        loaded,
        ps: psMap
      };
    } catch (error) {
      return { ...empty, error: error instanceof Error ? error.message : String(error) };
    }
  }
}