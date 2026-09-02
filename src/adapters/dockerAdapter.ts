import { execa } from "execa";
import type { AdapterManifest, AdapterResult } from "../shared/schemas";
import type { AdapterContext, HealthStatus, StackAdapter } from "./types";
import { edge, node } from "./helpers";

interface DockerPsRow {
  ID?: string;
  Names?: string;
  Image?: string;
  State?: string;
  Status?: string;
  Ports?: string;
}

export class DockerAdapter implements StackAdapter {
  id = "docker";
  name = "Docker";
  manifest: AdapterManifest = {
    adapterId: "docker",
    adapterName: "Docker",
    manifestVersion: 1,
    description: "Read-only inventory of the local Docker runtime and its containers.",
    discoverySources: ["docker ps --all"],
    permissions: ["docker-socket-read"],
    refreshProfile: { intervalSeconds: 30, onDemand: true },
    telemetryCoverage: [],
    supportedCapabilities: ["discovery", "process-state", "endpoint-state"],
    supportedActions: []
  };
  private lastError: string | undefined;

  async collect(context: AdapterContext): Promise<AdapterResult> {
    const root = node(this.id, "runtime", "docker", "Docker", "unknown", {
      evidence: ["docker ps --all"]
    });
    const nodes = [root];
    const edges = [];

    try {
      const { stdout } = await execa("docker", ["ps", "--all", "--format", "{{json .}}"], {
        timeout: context.timeoutMs
      });
      root.state = "running";
      const rows = stdout
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => JSON.parse(line) as DockerPsRow);

      for (const row of rows) {
        const name = row.Names ?? row.ID ?? "unknown-container";
        const isRunning = row.State === "running";
        const containerNode = node(this.id, "container", name, name, isRunning ? "running" : "stopped", {
          image: row.Image,
          status: row.Status,
          ports: row.Ports,
          evidence: [`docker state=${row.State ?? "unknown"}`]
        });
        nodes.push(containerNode);
        edges.push(edge(containerNode.id, "runs_on", root.id));
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
    return {
      adapterId: this.id,
      alive: this.lastError === undefined,
      lastError: this.lastError
    };
  }
}

