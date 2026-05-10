import fs from "node:fs/promises";
import path from "node:path";
import type { AdapterResult } from "../shared/schemas";
import type { AdapterContext, HealthStatus, StackAdapter } from "./types";
import { edge, node, pathKey } from "./helpers";

const MODEL_ROOT = "/Volumes/Leo_LLM/LLM Models";

export class LocalModelsAdapter implements StackAdapter {
  id = "local-model";
  name = "Local Models";
  private lastError: string | undefined;

  async collect(_context: AdapterContext): Promise<AdapterResult> {
    const root = node(this.id, "volume", "leo-llm-models", "Leo_LLM Models", "unknown", {
      mount: "/Volumes/Leo_LLM",
      evidence: [MODEL_ROOT]
    });
    const nodes = [root];
    const edges = [];

    try {
      const entries = await fs.readdir(MODEL_ROOT, { withFileTypes: true });
      root.state = "ok";
      for (const entry of entries.filter((item) => item.isDirectory()).slice(0, 80)) {
        const fullPath = path.join(MODEL_ROOT, entry.name);
        const modelNode = node(this.id, "model", pathKey(fullPath), entry.name, "ok", {
          pathHash: pathKey(fullPath),
          modelFamilyHint: familyHint(entry.name),
          evidence: ["directory exists on local model volume"]
        });
        nodes.push(modelNode);
        edges.push(edge(root.id, "owns", modelNode.id));
      }
      this.lastError = undefined;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      root.state = "unknown";
      root.properties = {
        ...root.properties,
        evidence: [this.lastError]
      };
    }

    return { nodes, edges, redactionHints: [] };
  }

  async health(): Promise<HealthStatus> {
    return { adapterId: this.id, alive: this.lastError === undefined, lastError: this.lastError };
  }
}

function familyHint(name: string): string {
  const lower = name.toLowerCase();
  if (lower.includes("qwen")) return "qwen";
  if (lower.includes("gemma")) return "gemma";
  if (lower.includes("deepseek")) return "deepseek";
  if (lower.includes("llama")) return "llama";
  return "unknown";
}

