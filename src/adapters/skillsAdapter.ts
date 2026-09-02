import fs from "node:fs/promises";
import path from "node:path";
import type { AdapterManifest, AdapterResult } from "../shared/schemas";
import type { AdapterContext, HealthStatus, StackAdapter } from "./types";
import { edge, homePath, node } from "./helpers";

export class SkillsAdapter implements StackAdapter {
  id = "skills";
  name = "Codex Skills";
  manifest: AdapterManifest = {
    adapterId: "skills",
    adapterName: "Codex Skills",
    manifestVersion: 1,
    description: "Read-only inventory of Codex skills under ~/.codex/skills.",
    discoverySources: ["~/.codex/skills"],
    permissions: ["home-directory-read"],
    refreshProfile: { intervalSeconds: 120, onDemand: true },
    telemetryCoverage: [],
    supportedCapabilities: ["discovery", "model-inventory"],
    supportedActions: []
  };
  private lastError: string | undefined;

  async collect(_context: AdapterContext): Promise<AdapterResult> {
    const root = node(this.id, "tool", "codex-skills", "Codex Skills", "unknown", {
      evidence: ["~/.codex/skills scan"]
    });
    const nodes = [root];
    const edges = [];

    try {
      const skillsRoot = homePath(".codex", "skills");
      const entries = await fs.readdir(skillsRoot, { withFileTypes: true });
      root.state = "ok";
      for (const entry of entries.filter((item) => item.isDirectory())) {
        const skillMd = path.join(skillsRoot, entry.name, "SKILL.md");
        let description = "";
        try {
          const text = await fs.readFile(skillMd, "utf8");
          description = extractDescription(text);
        } catch {
          description = "";
        }
        const skillNode = node(this.id, "skill", entry.name, entry.name, description ? "ok" : "unknown", {
          description,
          pathHint: `~/.codex/skills/${entry.name}/SKILL.md`,
          evidence: [description ? "SKILL.md parsed" : "SKILL.md missing or unreadable"]
        });
        nodes.push(skillNode);
        edges.push(edge(root.id, "owns", skillNode.id));
      }
      this.lastError = undefined;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      root.state = "unknown";
      root.properties = { ...root.properties, evidence: [this.lastError] };
    }

    return { nodes, edges, redactionHints: [] };
  }

  async health(): Promise<HealthStatus> {
    return { adapterId: this.id, alive: this.lastError === undefined, lastError: this.lastError };
  }
}

function extractDescription(text: string): string {
  const match = text.match(/^description:\s*["']?(.+?)["']?\s*$/m);
  if (match) return match[1].slice(0, 180);
  return text
    .split("\n")
    .find((line) => line.trim().length > 20 && !line.startsWith("---"))
    ?.trim()
    .slice(0, 180) ?? "";
}

