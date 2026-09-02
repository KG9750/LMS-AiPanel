import fs from "node:fs/promises";
import path from "node:path";
import { parse } from "smol-toml";
import type { AdapterManifest, AdapterResult } from "../shared/schemas";
import type { AdapterContext, HealthStatus, StackAdapter } from "./types";
import { edge, homePath, node, pathExists } from "./helpers";

export class CodexConfigAdapter implements StackAdapter {
  id = "codex";
  name = "Codex";
  manifest: AdapterManifest = {
    adapterId: "codex",
    adapterName: "Codex",
    manifestVersion: 1,
    description: "Read-only scan of ~/.codex configuration, model, and configured MCP servers.",
    discoverySources: ["~/.codex/config.toml", "~/.codex/AGENTS.md"],
    permissions: ["home-directory-read"],
    refreshProfile: { intervalSeconds: 120, onDemand: true },
    telemetryCoverage: [],
    supportedCapabilities: ["discovery", "config-read", "model-inventory"],
    supportedActions: []
  };
  private lastError: string | undefined;

  async collect(_context: AdapterContext): Promise<AdapterResult> {
    const tool = node(this.id, "tool", "codex-desktop", "Codex", "ok", {
      evidence: ["~/.codex configuration scan"]
    });
    const nodes = [tool];
    const edges = [];

    const configPath = homePath(".codex", "config.toml");
    const agentsPath = homePath(".codex", "AGENTS.md");
    for (const file of [configPath, agentsPath]) {
      const exists = await pathExists(file);
      const configNode = node(this.id, "config", path.basename(file), path.basename(file), exists ? "ok" : "unknown", {
        exists,
        pathHint: `~/.codex/${path.basename(file)}`,
        evidence: [`exists=${exists}`]
      });
      nodes.push(configNode);
      edges.push(edge(tool.id, "configured_by", configNode.id));
    }

    if (await pathExists(configPath)) {
      const parsed = parse(await fs.readFile(configPath, "utf8")) as Record<string, unknown>;
      const model = String(parsed.model ?? "unknown");
      const provider = String(parsed.model_provider ?? "unknown");
      const modelNode = node(this.id, "model", model, model, model === "unknown" ? "unknown" : "ok", {
        provider,
        configuredFrom: "~/.codex/config.toml"
      });
      nodes.push(modelNode);
      edges.push(edge(tool.id, "uses", modelNode.id));

      const mcpServers = parsed.mcp_servers;
      if (mcpServers && typeof mcpServers === "object") {
        for (const serverName of Object.keys(mcpServers)) {
          const mcpNode = node(this.id, "mcp", serverName, serverName, "ok", {
            configuredFrom: "~/.codex/config.toml"
          });
          nodes.push(mcpNode);
          edges.push(edge(tool.id, "depends_on", mcpNode.id));
        }
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
}

