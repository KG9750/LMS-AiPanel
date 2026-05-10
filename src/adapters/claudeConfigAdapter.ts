import path from "node:path";
import type { AdapterResult } from "../shared/schemas";
import type { AdapterContext, HealthStatus, StackAdapter } from "./types";
import { edge, homePath, node, pathExists, readJsonFile } from "./helpers";

export class ClaudeConfigAdapter implements StackAdapter {
  id = "claude";
  name = "Claude Code";
  private lastError: string | undefined;

  async collect(_context: AdapterContext): Promise<AdapterResult> {
    const root = node(this.id, "tool", "claude-code", "Claude Code", "ok", {
      evidence: ["~/.claude configuration scan"]
    });
    const nodes = [root];
    const edges = [];
    const redactionHints = [];

    const files = [
      { key: "user-settings", file: homePath(".claude", "settings.json") },
      { key: "local-settings", file: homePath(".claude", "settings.local.json") },
      { key: "claude-md", file: homePath(".claude", "CLAUDE.md") },
      { key: "anthropic-router", file: homePath(".claude", "anthropic_model_router.py") }
    ];

    for (const item of files) {
      const exists = await pathExists(item.file);
      const configNode = node(this.id, "config", item.key, path.basename(item.file), exists ? "ok" : "unknown", {
        exists,
        pathHint: `~/.claude/${path.basename(item.file)}`,
        evidence: [`exists=${exists}`]
      });
      nodes.push(configNode);
      edges.push(edge(root.id, "configured_by", configNode.id));
    }

    const settings = await readJsonFile(files[0].file);
    if (settings && typeof settings === "object") {
      const env = (settings as { env?: Record<string, unknown> }).env ?? {};
      const model = String((settings as { model?: unknown }).model ?? env.ANTHROPIC_MODEL ?? "unknown");
      const modelNode = node(this.id, "model", model, model, model === "unknown" ? "unknown" : "ok", {
        provider: env.ANTHROPIC_BASE_URL ? "anthropic-compatible" : "unknown",
        baseUrl: env.ANTHROPIC_BASE_URL,
        configuredFrom: "~/.claude/settings.json"
      });
      nodes.push(modelNode);
      edges.push(edge(root.id, "uses", modelNode.id));
      redactionHints.push({ resourceId: modelNode.id, path: ["properties", "baseUrl"], reason: "endpoint" });
    }

    this.lastError = undefined;
    return { nodes, edges, redactionHints };
  }

  async health(): Promise<HealthStatus> {
    return {
      adapterId: this.id,
      alive: this.lastError === undefined,
      lastError: this.lastError
    };
  }
}

