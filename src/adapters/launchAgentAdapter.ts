import fs from "node:fs/promises";
import path from "node:path";
import { execa } from "execa";
import * as plist from "plist";
import type { AdapterResult } from "../shared/schemas";
import type { AdapterContext, HealthStatus, StackAdapter } from "./types";
import { edge, homePath, node } from "./helpers";

interface LaunchAgentPlist {
  Label?: string;
  ProgramArguments?: string[];
  RunAtLoad?: boolean;
}

export class LaunchAgentAdapter implements StackAdapter {
  id = "launchagent";
  name = "LaunchAgent";
  private lastError: string | undefined;

  async collect(context: AdapterContext): Promise<AdapterResult> {
    const root = node(this.id, "runtime", "launchd", "launchd LaunchAgents", "ok", {
      evidence: ["~/Library/LaunchAgents scan"]
    });
    const nodes = [root];
    const edges = [];

    const dir = homePath("Library", "LaunchAgents");
    let launchctl = "";
    try {
      launchctl = (await execa("launchctl", ["list"], { timeout: context.timeoutMs })).stdout;
    } catch {
      launchctl = "";
    }

    try {
      const entries = await fs.readdir(dir);
      const candidates = entries.filter(
        (entry) => entry.endsWith(".plist") && /llm|mlx|qwen|openclaw|hermes|claude|vmlx|ollama/i.test(entry)
      );
      for (const entry of candidates) {
        const filePath = path.join(dir, entry);
        const raw = await fs.readFile(filePath, "utf8");
        const parsed = plist.parse(raw) as LaunchAgentPlist;
        const label = parsed.Label ?? entry.replace(/\.plist$/, "");
        const loaded = launchctl.includes(label);
        const launchNode = node(this.id, "runtime", label, label, loaded ? "running" : "stopped", {
          runAtLoad: Boolean(parsed.RunAtLoad),
          program: parsed.ProgramArguments?.[0],
          argCount: parsed.ProgramArguments?.length ?? 0,
          file: entry,
          evidence: [`launchctl loaded=${loaded}`]
        });
        nodes.push(launchNode);
        edges.push(edge(launchNode.id, "runs_on", root.id));
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
