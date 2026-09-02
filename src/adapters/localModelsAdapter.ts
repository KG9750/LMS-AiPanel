import fs from "node:fs/promises";
import path from "node:path";
import type { AdapterResult } from "../shared/schemas";
import type { AdapterContext, HealthStatus, StackAdapter } from "./types";
import { edge, node, pathExists, pathKey, safeBaseName } from "./helpers";

export class LocalModelsAdapter implements StackAdapter {
  id = "local-model";
  name = "Local Models";
  private lastError: string | undefined;

  constructor(private readonly modelRoots: string[]) {}

  async collect(_context: AdapterContext): Promise<AdapterResult> {
    const root = node(this.id, "volume", "catalog", "Local Model Roots", "unknown", {
      evidence: ["configured model root scan"]
    });
    const nodes = [root];
    const edges = [];

    try {
      let scanError: string | undefined;
      for (const modelRoot of this.modelRoots) {
        if (!(await pathExists(modelRoot))) continue;
        try {
          const entries = await fs.readdir(modelRoot, { withFileTypes: true });
          root.state = "ok";
          for (const entry of entries.filter((item) => item.isDirectory()).slice(0, 80)) {
            const fullPath = path.join(modelRoot, entry.name);
            const modelNode = node(this.id, "model", pathKey(fullPath), entry.name, "ok", {
              root: safeBaseName(modelRoot),
              modelFamilyHint: familyHint(entry.name),
              evidence: ["directory exists in a configured model root"]
            });
            nodes.push(modelNode);
            edges.push(edge(root.id, "owns", modelNode.id));
          }
        } catch (error) {
          scanError ??= error instanceof Error ? error.message : String(error);
        }
      }
      if (scanError && root.state === "ok") root.state = "warning";
      this.lastError = scanError;
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
