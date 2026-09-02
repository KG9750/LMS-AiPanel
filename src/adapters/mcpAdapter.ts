import fs from "node:fs/promises";
import { parse } from "smol-toml";
import type { AdapterResult } from "../shared/schemas";
import type { AdapterContext, HealthStatus, StackAdapter } from "./types";
import { edge, homePath, node, pathExists, pathKey, safeBaseName } from "./helpers";

export class McpAdapter implements StackAdapter {
  id = "mcp";
  name = "MCP";
  private lastError: string | undefined;

  constructor(private readonly configs: string[]) {}

  async collect(_context: AdapterContext): Promise<AdapterResult> {
    const root = node(this.id, "mcp", "registry", "MCP Registry", "ok", {
      evidence: ["known local MCP config candidates"]
    });
    const nodes = [root];
    const edges = [];

    const seenServers = new Map<string, string>();
    for (const configPath of this.configs) {
      if (!(await pathExists(configPath))) continue;
      const configNode = node(this.id, "config", configKey(configPath), configLabel(configPath), "ok", {
        pathHint: configPath.replace(homePath(), "~"),
        evidence: ["MCP config candidate exists"]
      });
      nodes.push(configNode);
      edges.push(edge(root.id, "configured_by", configNode.id));

      const serverNames = await readServerNames(configPath);
      for (const serverName of serverNames) {
        const existing = seenServers.get(serverName);
        if (existing) {
          edges.push(edge(configNode.id, "owns", existing));
        } else {
          const mcpNode = node(this.id, "mcp", serverName, serverName, "ok", {
            configuredFrom: [configLabel(configPath)]
          });
          seenServers.set(serverName, mcpNode.id);
          nodes.push(mcpNode);
          edges.push(edge(configNode.id, "owns", mcpNode.id));
        }
      }
    }

    this.lastError = undefined;
    return { nodes, edges, redactionHints: [] };
  }

  async health(): Promise<HealthStatus> {
    return { adapterId: this.id, alive: this.lastError === undefined, lastError: this.lastError };
  }
}

async function readServerNames(configPath: string): Promise<string[]> {
  try {
    const text = await fs.readFile(configPath, "utf8");
    if (configPath.endsWith(".toml")) {
      const parsed = parse(text) as { mcp_servers?: Record<string, unknown> };
      return Object.keys(parsed.mcp_servers ?? {});
    }
    const parsed = JSON.parse(text) as { mcpServers?: Record<string, unknown> };
    return Object.keys(parsed.mcpServers ?? {});
  } catch {
    return [];
  }
}

function configKey(configPath: string): string {
  return pathKey(configPath);
}

function configLabel(configPath: string): string {
  if (configPath.includes(".codex")) return "Codex config.toml";
  if (configPath.includes(".lmstudio")) return "LM Studio mcp.json";
  if (configPath.includes("antigravity")) return "Antigravity mcp_config.json";
  if (configPath.includes("Claude")) return "Claude Desktop config";
  if (configPath.includes(".claude")) return "Claude Code config";
  return safeBaseName(configPath);
}
