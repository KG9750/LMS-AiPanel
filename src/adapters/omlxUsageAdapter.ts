import fs from "node:fs/promises";
import path from "node:path";
import type { AdapterResult } from "../shared/schemas";
import type { AdapterContext, HealthStatus, StackAdapter } from "./types";
import { edge, node, pathExists, pathKey, readJsonFile } from "./helpers";

interface OmlxStats {
  total_prompt_tokens?: number;
  total_completion_tokens?: number;
  total_cached_tokens?: number;
  total_requests?: number;
  prompt_tokens?: number;
  completion_tokens?: number;
  cached_tokens?: number;
  requests?: number;
  per_model?: Record<string, Partial<OmlxStats>>;
}

interface OmlxModelSettings {
  models?: Record<string, { display_name?: string; is_default?: boolean }>;
}

export class OmlxUsageAdapter implements StackAdapter {
  id = "omlx-usage";
  name = "oMLX Token Usage";
  private lastError: string | undefined;

  constructor(private readonly dataRoots: string[]) {}

  async collect(_context: AdapterContext): Promise<AdapterResult> {
    const root = node(this.id, "runtime", "telemetry", "oMLX Token Telemetry", "unknown", {
      telemetryLayer: "provider",
      coverage: "all-endpoint-clients",
      evidence: ["oMLX stats.json discovery"]
    });
    const nodes = [root];
    const edges = [];
    const errors: string[] = [];

    for (const dataRoot of this.dataRoots) {
      if (!(await pathExists(dataRoot))) continue;
      let entries;
      try {
        entries = await fs.readdir(dataRoot, { withFileTypes: true });
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
        continue;
      }

      for (const entry of entries.filter((item) => item.isDirectory())) {
        const instancePath = path.join(dataRoot, entry.name);
        const statsPath = path.join(instancePath, "stats.json");
        if (!(await pathExists(statsPath))) continue;
        try {
          const stats = (await readJsonFile(statsPath)) as OmlxStats | null;
          if (!stats) continue;
          const settings = (await readJsonFile(path.join(instancePath, "model_settings.json"))) as OmlxModelSettings | null;
          const observations = observationsFromStats(stats, settings, entry.name);
          for (const observation of observations) {
            const usageNode = node(this.id, observation.attribution === "endpoint" ? "runtime" : "model", pathKey(`${statsPath}:${observation.stableKey}`), observation.label, "ok", {
              modelId: observation.modelId,
              usageAttribution: observation.attribution,
              tokenUsage: observation.tokenUsage,
              evidence: ["oMLX cumulative provider statistics"]
            });
            nodes.push(usageNode);
            edges.push(edge(root.id, "watches", usageNode.id));
          }
        } catch (error) {
          errors.push(error instanceof Error ? error.message : String(error));
        }
      }
    }

    root.state = nodes.length > 1 ? (errors.length ? "warning" : "ok") : "unknown";
    this.lastError = errors[0];
    return { nodes, edges, redactionHints: [] };
  }

  async health(): Promise<HealthStatus> {
    return { adapterId: this.id, alive: this.lastError === undefined, lastError: this.lastError };
  }
}

function observationsFromStats(
  stats: OmlxStats,
  settings: OmlxModelSettings | null,
  instanceName: string
) {
  const perModel = Object.entries(stats.per_model ?? {});
  if (perModel.length > 0) {
    return perModel.map(([modelId, modelStats]) => ({
      modelId,
      stableKey: modelId,
      attribution: "model" as const,
      label: settings?.models?.[modelId]?.display_name ?? modelId,
      tokenUsage: tokenUsageFromStats(modelStats)
    }));
  }

  const instanceLabel = instanceName.replace(/-data$/, "");
  return [{
    modelId: null,
    stableKey: "endpoint-total",
    attribution: "endpoint" as const,
    label: `${instanceLabel} endpoint 合计`,
    tokenUsage: tokenUsageFromStats(stats)
  }];
}

function tokenUsageFromStats(stats: Partial<OmlxStats>) {
  const inputTokens = count(stats.total_prompt_tokens ?? stats.prompt_tokens);
  const outputTokens = count(stats.total_completion_tokens ?? stats.completion_tokens);
  return {
    source: "omlx",
    telemetryLayer: "provider",
    coverage: "all-endpoint-clients",
    inputTokens,
    outputTokens,
    cachedTokens: count(stats.total_cached_tokens ?? stats.cached_tokens),
    totalTokens: inputTokens + outputTokens,
    requestCount: count(stats.total_requests ?? stats.requests),
    lastUsedAt: null
  };
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
}
