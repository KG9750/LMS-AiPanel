import fs from "node:fs/promises";
import path from "node:path";
import { parse } from "smol-toml";
import type { AdapterManifest, AdapterResult, ResourceNode } from "../shared/schemas";
import type { AdapterContext, HealthStatus, StackAdapter } from "./types";
import { edge, homePath, node, pathExists } from "./helpers";

interface McpServerSpec {
  command?: string;
  args?: string[];
  url?: string;
  endpoint?: string;
  env?: Record<string, string>;
}

export type McpLayerState = "configured" | "running" | "reachable" | "capability-verified";

/**
 * MCP adapter with three evidence layers (issue #21):
 *
 * 1. CONFIG layer: bindings declared in known config files. Automatic
 *    collection only READS config; it never starts an MCP server.
 * 2. RUNTIME layer: existing transport state — a matching process on the
 *    declared command, or a live endpoint for URL servers.
 * 3. CAPABILITY layer: manually requested handshake against a MANAGED
 *    server; only capability metadata is retained, never tool business
 *    results or environment values.
 *
 * configured / running / reachable / capability-verified stay distinct.
 */
export class McpAdapter implements StackAdapter {
  id = "mcp";
  name = "MCP";
  manifest: AdapterManifest = {
    adapterId: "mcp",
    adapterName: "MCP",
    manifestVersion: 1,
    description: "MCP configuration, runtime/transport, and capability evidence in three distinct layers.",
    discoverySources: ["~/.codex/config.toml", "~/.lmstudio/mcp.json", "~/.gemini/antigravity/mcp_config.json", "process scan", "endpoint probe"],
    permissions: ["home-directory-read", "process-read", "endpoint-read"],
    refreshProfile: { intervalSeconds: 120, onDemand: true },
    telemetryCoverage: [],
    supportedCapabilities: ["discovery", "config-read", "process-state", "endpoint-state", "health-check"],
    supportedActions: ["read", "dry-run"]
  };
  private lastError: string | undefined;

  async collect(context: AdapterContext): Promise<AdapterResult> {
    const root = node(this.id, "mcp", "registry", "MCP Registry", "ok", {
      evidence: ["known local MCP config candidates"]
    });
    const nodes: ResourceNode[] = [root];
    const edges = [];

    const configs = [
      homePath(".codex", "config.toml"),
      homePath(".lmstudio", "mcp.json"),
      homePath(".gemini", "antigravity", "mcp_config.json")
    ];

    for (const configPath of configs) {
      if (!(await pathExists(configPath))) continue;
      const configNode = node(this.id, "config", configKey(configPath), configLabel(configPath), "ok", {
        pathHint: configPath.replace(homePath(), "~"),
        evidence: ["MCP config candidate exists", "automatic collection never starts MCP servers"]
      });
      nodes.push(configNode);
      edges.push(edge(root.id, "configured_by", configNode.id));

      const servers = await readServers(configPath);
      for (const [serverName, spec] of servers) {
        const serverId = `mcp:mcp:${configKey(configPath)}:${serverName}`;
        const layers = await this.inspectLayers(serverName, spec, context.timeoutMs);
        const serverNode = node(
          this.id,
          "mcp",
          `${configKey(configPath)}:${serverName}`,
          serverName,
          this.stateFor(layers),
          {
            stableKey: `${configKey(configPath)}:${serverName}`,
            configuredFrom: configLabel(configPath),
            configLayer: layers.config ? "configured" : undefined,
            runtimeLayer: layers.runtime,
            reachable: layers.reachable,
            capabilityVerified: layers.capabilityVerified,
            transport: spec.url ? "url" : "stdio",
            evidence: [
              `config layer: declared in ${configLabel(configPath)}`,
              `runtime layer: ${layers.runtime}`,
              `reachable: ${layers.reachable}`,
              `capability-verified: ${layers.capabilityVerified}`,
              ...(layers.runtimeEvidence ? [layers.runtimeEvidence] : [])
            ]
          }
        );
        nodes.push(serverNode);
        edges.push(edge(configNode.id, "owns", serverId));
      }
    }

    this.lastError = undefined;
    return { nodes, edges, redactionHints: [] };
  }

  async health(): Promise<HealthStatus> {
    return { adapterId: this.id, alive: this.lastError === undefined, lastError: this.lastError };
  }

  private stateFor(layers: { runtime: string; reachable: boolean; capabilityVerified: boolean }): "ok" | "running" | "warning" | "unknown" {
    if (layers.capabilityVerified) return "ok";
    if (layers.reachable) return "running";
    if (layers.runtime === "running") return "running";
    if (layers.runtime === "stopped") return "unknown";
    return "unknown";
  }

  /**
   * Layer inspection. CONFIG is always read-only. RUNTIME checks existing
   * processes/endpoints only. CAPABILITY is verified only when the server is
   * managed (registry) — see verifyCapabilities(), which is never called
   * automatically.
   */
  private async inspectLayers(
    serverName: string,
    spec: McpServerSpec,
    timeoutMs: number
  ): Promise<{
    config: boolean;
    runtime: "running" | "stopped" | "unknown";
    reachable: boolean;
    capabilityVerified: boolean;
    runtimeEvidence?: string;
  }> {
    let runtime: "running" | "stopped" | "unknown" = "unknown";
    let reachable = false;
    let runtimeEvidence: string | undefined;

    if (spec.url || spec.endpoint) {
      // URL transport: probe the existing endpoint; never start anything.
      const url = spec.url ?? spec.endpoint!;
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
        reachable = response.ok;
        runtimeEvidence = `endpoint probe ${url} -> HTTP ${response.status}`;
        runtime = reachable ? "running" : "stopped";
      } catch (error) {
        runtimeEvidence = `endpoint probe ${url} unreachable`;
        runtime = "stopped";
      }
    } else if (spec.command) {
      // stdio transport: match an EXISTING process on the command.
      const found = await this.findProcess(spec.command);
      runtime = found ? "running" : "stopped";
      runtimeEvidence = found ? `existing process matched command '${spec.command}'` : `no existing process for '${spec.command}'`;
    }

    return {
      config: true,
      runtime,
      reachable,
      capabilityVerified: false,
      runtimeEvidence
    };
  }

  /**
   * Capability handshake (manual, managed-only). Returns ONLY capability
   * metadata (server info, tools, resources, prompts). Tool business results
   * and environment values are excluded. Callers must gate on the registry
   * managed flag before invoking.
   */
  async verifyCapabilities(
    serverName: string,
    spec: McpServerSpec,
    timeoutMs: number
  ): Promise<{
    ok: boolean;
    capabilities: { serverInfo?: Record<string, unknown>; tools: string[]; resources: string[]; prompts: string[] };
    evidence: string[];
    error?: string;
  }> {
    // This is the handshake boundary: nothing here starts a business tool;
    // we only exchange the MCP initialize + tools/list metadata.
    const empty = { ok: false, capabilities: { serverInfo: undefined, tools: [], resources: [], prompts: [] }, evidence: [] };
    if (!spec.url && !spec.endpoint) {
      return { ...empty, evidence: ["stdio servers require a managed wrapper; automatic handshake not supported"], error: "stdio handshake requires explicit manual command" };
    }
    const url = spec.url ?? spec.endpoint!;
    try {
      // JSON-RPC initialize handshake over the existing endpoint.
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "lms-aipanel", version: "1" } } }),
        signal: AbortSignal.timeout(timeoutMs)
      });
      if (!response.ok) {
        return { ...empty, evidence: [`handshake HTTP ${response.status}`], error: `HTTP ${response.status}` };
      }
      const init = (await response.json()) as { result?: { serverInfo?: Record<string, unknown> } };
      const serverInfo = init.result?.serverInfo ?? {};

      // tools/list metadata only — never invokes a tool.
      const toolsRes = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
        signal: AbortSignal.timeout(timeoutMs)
      });
      const toolsBody = toolsRes.ok ? ((await toolsRes.json()) as { result?: { tools?: Array<{ name: string }> } }) : undefined;
      const tools = (toolsBody?.result?.tools ?? []).map((tool) => tool.name);

      return {
        ok: true,
        capabilities: { serverInfo, tools, resources: [], prompts: [] },
        evidence: [`initialize handshake ok`, `serverInfo=${JSON.stringify(serverInfo)}`, `tools=${tools.join(",") || "none"}`]
      };
    } catch (error) {
      return { ...empty, evidence: ["handshake failed"], error: error instanceof Error ? error.message : String(error) };
    }
  }

  private async findProcess(command: string): Promise<boolean> {
    try {
      const { execa } = await import("execa");
      const { stdout } = await execa("ps", ["-axo", "command="], { timeout: 3_000 });
      const base = path.basename(command);
      return stdout.split("\n").some((row) => row.includes(base) && !row.includes("ps -axo"));
    } catch {
      return false;
    }
  }
}

async function readServers(configPath: string): Promise<Array<[string, McpServerSpec]>> {
  try {
    const text = await fs.readFile(configPath, "utf8");
    if (configPath.endsWith(".toml")) {
      const parsed = parse(text) as { mcp_servers?: Record<string, McpServerSpec> };
      return Object.entries(parsed.mcp_servers ?? {});
    }
    const parsed = JSON.parse(text) as { mcpServers?: Record<string, McpServerSpec> };
    return Object.entries(parsed.mcpServers ?? {});
  } catch {
    return [];
  }
}

function configKey(configPath: string): string {
  if (configPath.includes(".codex")) return "codex-config";
  if (configPath.includes(".lmstudio")) return "lmstudio-config";
  if (configPath.includes("antigravity")) return "antigravity-config";
  return "unknown-config";
}

function configLabel(configPath: string): string {
  if (configPath.includes(".codex")) return "Codex config.toml";
  if (configPath.includes(".lmstudio")) return "LM Studio mcp.json";
  if (configPath.includes("antigravity")) return "Antigravity mcp_config.json";
  return "MCP config";
}