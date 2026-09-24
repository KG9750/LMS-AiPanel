import fs from "node:fs/promises";
import path from "node:path";
import { execa } from "execa";
import * as plist from "plist";
import type { AdapterManifest, AdapterResult, ResourceNode } from "../shared/schemas";
import type { AdapterContext, HealthStatus, StackAdapter } from "./types";
import { edge, homePath, node, pathExists } from "./helpers";

interface AssistantPlist {
  Label?: string;
  ProgramArguments?: string[];
  EnvironmentVariables?: Record<string, string>;
}

const ASSISTANT_HINTS = ["openclaw", "hermes", "claw", "assistant"];

/**
 * Assistant adapter (issue #15): represents assistant DEFINITIONS separately
 * from running instances, Channel bindings, and model routes. Independent
 * failure states: instance stopped, Channel unreachable, endpoint
 * unreachable, and route drift are distinct. Channel secrets and message
 * content never enter normalized resources.
 */
export class AssistantAdapter implements StackAdapter {
  id = "assistant";
  name = "Assistants";
  manifest: AdapterManifest = {
    adapterId: "assistant",
    adapterName: "Assistants",
    manifestVersion: 1,
    description:
      "Read-only assistant inventory: definitions, running instances, Channel bindings, and model routes with independent failure states.",
    discoverySources: ["~/Library/LaunchAgents (openclaw/hermes)", "container scan (docker ps)", "~/.openclaw", "~/.hermes"],
    permissions: ["home-directory-read", "launchctl-list-read"],
    refreshProfile: { intervalSeconds: 60, onDemand: true },
    telemetryCoverage: [],
    supportedCapabilities: ["discovery", "config-read", "process-state", "endpoint-state"],
    supportedActions: ["read", "dry-run"]
  };
  private lastError: string | undefined;

  async collect(context: AdapterContext): Promise<AdapterResult> {
    const nodes: ResourceNode[] = [];
    const edges = [];

    const launches = await this.findLaunchAgents();
    const containers = await this.findContainers(context);

    // Definitions discovered from launch agents + config dirs.
    const definitions = new Map<string, { label: string; configDir: string }>();
    for (const launch of launches) {
      const name = this.assistantNameFromLabel(launch.Label);
      if (!name) continue;
      const configDir = homePath(".openclaw", "agents", name);
      definitions.set(name, { label: launch.Label, configDir });
    }
    // Hermes-style config dirs without a launch agent.
    for (const dir of [homePath(".openclaw", "agents"), homePath(".hermes", "agents")]) {
      try {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        for (const entry of entries.filter((item) => item.isDirectory())) {
          if (!definitions.has(entry.name)) {
            definitions.set(entry.name, { label: entry.name, configDir: path.join(dir, entry.name) });
          }
        }
      } catch {
        // directory absent: fine
      }
    }

    for (const [name, definition] of definitions) {
      const definitionId = `assistant:assistant:${name}`;
      const definitionNode = node(this.id, "assistant", name, name, "ok", {
        stableKey: name,
        definitionSource: definition.configDir,
        evidence: ["definition found in assistant config directory"]
      });
      nodes.push(definitionNode);

      // Instances: one per launch agent match.
      const matchingLaunches = launches.filter((launch) => launch.Label?.toLowerCase().includes(name.toLowerCase()));
      const containerMatch = containers.find((container) => container.name.toLowerCase().includes(name.toLowerCase()));

      const instanceStates: string[] = [];
      for (const launch of matchingLaunches) {
        const instanceId = `assistant:process:${name}@${launch.Label}`;
        const running = launch.loaded && launch.pid !== undefined;
        const instance = node(
          this.id,
          "process",
          `${name}@${launch.Label}`,
          `${name} (${launch.Label})`,
          running ? "running" : "stopped",
          {
            stableKey: `${name}@${launch.Label}`,
            pid: launch.pid ?? null,
            launchLoaded: launch.loaded,
            evidence: [
              `launchctl loaded=${launch.loaded}`,
              launch.pid ? `pid=${launch.pid}` : "no running pid",
              "instance state is distinct from definition state"
            ]
          }
        );
        nodes.push(instance);
        edges.push(edge(definitionId, "owns", instanceId));
        instanceStates.push(running ? "running" : "stopped");
      }

      if (containerMatch) {
        const containerId = `assistant:container:${name}`;
        const containerNode = node(
          this.id,
          "container",
          name,
          `${name} (container)`,
          containerMatch.running ? "running" : "stopped",
          {
            stableKey: name,
            image: containerMatch.image,
            evidence: [`docker state=${containerMatch.state}`, "container instance state"]
          }
        );
        nodes.push(containerNode);
        edges.push(edge(definitionId, "owns", containerId));
        instanceStates.push(containerMatch.running ? "running" : "stopped");
      }

      // Channel bindings: read from the definition config (channels.json).
      const channelStates = await this.readChannels(definition.configDir, definitionId, nodes, edges);

      // Model route: which model the assistant uses; route drift when the
      // configured model differs from what the definition declares live.
      const route = await this.readModelRoute(definition.configDir, definitionId, nodes, edges);

      // Aggregate status: distinct states, never hiding component evidence.
      const failed = instanceStates.some((state) => state === "stopped") || channelStates.some((state) => !state);
      definitionNode.state = failed ? "warning" : "ok";
      definitionNode.properties = {
        ...definitionNode.properties,
        aggregateStatus: failed ? "partial-failure" : "ok",
        instanceStates,
        channelStates,
        routeDrift: route.drift,
        evidence: [
          ...(definitionNode.properties.evidence as string[]),
          `instances: ${instanceStates.join(",") || "none"}`,
          `channels: ${channelStates.map((ok) => (ok ? "reachable" : "unreachable")).join(",") || "none"}`,
          ...(route.drift ? [`model route drift: configured=${route.configured} live=${route.live}`] : [])
        ]
      };
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

  private assistantNameFromLabel(label: string | undefined): string | null {
    if (!label) return null;
    const lower = label.toLowerCase();
    if (!ASSISTANT_HINTS.some((hint) => lower.includes(hint))) return null;
    return label.replace(/^(com\.|dev\.|io\.)?[a-z0-9.-]*\./i, "").toLowerCase();
  }

  private async findLaunchAgents(): Promise<Array<{ Label: string; loaded: boolean; pid?: string }>> {
    const dir = homePath("Library", "LaunchAgents");
    let launchctl = "";
    try {
      launchctl = (await execa("launchctl", ["list"], { timeout: 3_000 })).stdout;
    } catch {
      launchctl = "";
    }
    const results: Array<{ Label: string; loaded: boolean; pid?: string }> = [];
    try {
      const entries = await fs.readdir(dir);
      for (const file of entries.filter((name) => name.endsWith(".plist"))) {
        try {
          const text = await fs.readFile(path.join(dir, file), "utf8");
          const parsed = plist.parse(text) as AssistantPlist;
          if (!parsed.Label || !ASSISTANT_HINTS.some((hint) => parsed.Label!.toLowerCase().includes(hint))) continue;
          const line = launchctl.split("\n").find((row) => row.includes(parsed.Label!));
          const pid = line?.trim().split(/\s+/)[0];
          results.push({
            Label: parsed.Label,
            loaded: Boolean(line && pid && pid !== "-"),
            pid: pid && pid !== "-" ? pid : undefined
          });
        } catch {
          // unreadable plist: skip
        }
      }
    } catch {
      // no LaunchAgents dir
    }
    return results;
  }

  private async findContainers(context: AdapterContext): Promise<Array<{ name: string; state: string; running: boolean; image?: string }>> {
    try {
      const { stdout } = await execa("docker", ["ps", "--all", "--format", "{{json .}}"], {
        timeout: Math.min(context.timeoutMs, 2_000)
      });
      return stdout
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const row = JSON.parse(line) as { Names?: string; State?: string; Image?: string };
          return {
            name: row.Names ?? "unknown",
            state: row.State ?? "unknown",
            running: row.State === "running",
            image: row.Image
          };
        })
        .filter((container) => ASSISTANT_HINTS.some((hint) => container.name.toLowerCase().includes(hint)));
    } catch {
      return [];
    }
  }

  /** Reads Channel bindings; secrets and message content are never normalized. */
  private async readChannels(
    configDir: string,
    definitionId: string,
    nodes: ResourceNode[],
    edges: Array<ReturnType<typeof edge>>
  ): Promise<boolean[]> {
    const states: boolean[] = [];
    const candidates = [
      path.join(configDir, "channels.json"),
      path.join(configDir, "config.json"),
      path.join(homePath(".openclaw"), "channels.json")
    ];
    for (const file of candidates) {
      if (!(await pathExists(file))) continue;
      try {
        const raw = await fs.readFile(file, "utf8");
        const parsed = JSON.parse(raw) as { channels?: Array<{ id?: string; type?: string; endpoint?: string }> };
        for (const channel of parsed.channels ?? []) {
          const channelId = `assistant:channel:${channel.id ?? channel.type ?? "unknown"}`;
          const reachable = await this.endpointReachable(channel.endpoint);
          const channelNode = node(
            this.id,
            "channel",
            channel.id ?? channel.type ?? "unknown",
            channel.type ?? "channel",
            reachable ? "running" : "stopped",
            {
              stableKey: channel.id ?? channel.type ?? "unknown",
              endpointReachable: reachable,
              failureState: reachable ? undefined : "channel-unreachable",
              // NOTE: no secrets, no tokens, no message content, no full config.
              evidence: [
                `channel type=${channel.type ?? "unknown"}`,
                `endpoint reachable=${reachable}`,
                "channel secret and message content excluded from normalized resources"
              ]
            }
          );
          nodes.push(channelNode);
          edges.push(edge(definitionId, "binds_to", channelId));
          states.push(reachable);
        }
      } catch {
        // unreadable channel config
      }
    }
    return states;
  }

  /** Reads the model route; drift = configured vs live mismatch. */
  private async readModelRoute(
    configDir: string,
    definitionId: string,
    nodes: ResourceNode[],
    edges: Array<ReturnType<typeof edge>>
  ): Promise<{ configured?: string; live?: string; drift: boolean }> {
    let configured: string | undefined;
    try {
      const raw = await fs.readFile(path.join(configDir, "agent.json"), "utf8");
      const parsed = JSON.parse(raw) as { model?: string };
      configured = parsed.model;
    } catch {
      try {
        const raw = await fs.readFile(path.join(configDir, "config.json"), "utf8");
        const parsed = JSON.parse(raw) as { model?: string };
        configured = parsed.model;
      } catch {
        // no route config
      }
    }
    if (!configured) return { drift: false };

    const routeId = `assistant:model-route:${configured}`;
    const routeNode = node(this.id, "model", `route:${configured}`, configured, "ok", {
      stableKey: `route:${configured}`,
      configuredFrom: "assistant agent.json",
      evidence: ["model route declared by assistant definition"]
    });
    nodes.push(routeNode);
    edges.push(edge(definitionId, "uses", routeId));

    // Live route: probe the assistant's endpoint and compare what it
    // actually serves. Drift = the endpoint is reachable AND the served
    // model differs from the configured route. If the endpoint is
    // unreachable, drift is UNKNOWN (not claimed).
    let live: string | undefined;
    let endpointChecked = false;
    try {
      const endpointBase = (await this.readRouteEndpoint(configDir)) ?? "http://127.0.0.1:8000";
      const endpointRes = await fetch(`${endpointBase}/v1/models`, { signal: AbortSignal.timeout(1_000) });
      endpointChecked = true;
      if (endpointRes.ok) {
        const body = (await endpointRes.json()) as { data?: Array<{ id: string }> };
        const served = (body.data ?? []).map((model) => model.id);
        // The live route is the model the endpoint actually serves; when the
        // configured model is NOT among them, the first served model is the
        // live evidence (or undefined when the endpoint serves nothing).
        if (served.includes(configured)) {
          live = configured;
        } else if (served.length > 0) {
          live = served[0];
        }
      }
    } catch {
      live = undefined;
    }
    const drift = Boolean(endpointChecked && live && live !== configured);
    if (drift) {
      routeNode.state = "warning";
      routeNode.properties = {
        ...routeNode.properties,
        evidence: [`route drift: configured=${configured} live=${live}`]
      };
    } else if (endpointChecked && !live) {
      routeNode.properties = {
        ...routeNode.properties,
        evidence: ["endpoint reachable but serves no models; route drift unknown"]
      };
    }
    return { configured, live, drift };
  }

  private async readRouteEndpoint(configDir: string): Promise<string | undefined> {
    for (const file of ["agent.json", "config.json"]) {
      try {
        const raw = await fs.readFile(path.join(configDir, file), "utf8");
        const parsed = JSON.parse(raw) as { endpoint?: string };
        if (parsed.endpoint) return parsed.endpoint;
      } catch {
        // try next file
      }
    }
    return undefined;
  }

  private async endpointReachable(endpoint: string | undefined): Promise<boolean> {
    if (!endpoint) return false;
    try {
      const response = await fetch(endpoint, { signal: AbortSignal.timeout(1_000) });
      return response.ok;
    } catch {
      return false;
    }
  }
}