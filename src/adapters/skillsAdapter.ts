import fs from "node:fs/promises";
import path from "node:path";
import type { AdapterResult } from "../shared/schemas";
import type { AdapterContext, HealthStatus, StackAdapter } from "./types";
import { edge, node, pathExists, pathKey } from "./helpers";

export class SkillsAdapter implements StackAdapter {
  id = "skills";
  name = "Codex Skills";
  private lastError: string | undefined;

  constructor(private readonly skillRoots: string[]) {}

  async collect(_context: AdapterContext): Promise<AdapterResult> {
    const root = node(this.id, "tool", "codex-skills", "Codex Skills", "unknown", {
      evidence: ["~/.codex/skills scan"]
    });
    const nodes = [root];
    const edges = [];

    try {
      let scanError: string | undefined;
      for (const skillsRoot of this.skillRoots) {
        if (!(await pathExists(skillsRoot))) continue;
        let entries;
        try {
          entries = await fs.readdir(skillsRoot, { withFileTypes: true });
          root.state = "ok";
        } catch (error) {
          scanError ??= error instanceof Error ? error.message : String(error);
          continue;
        }
        for (const entry of entries.filter((item) => item.isDirectory())) {
          const skillMd = path.join(skillsRoot, entry.name, "SKILL.md");
          let description = "";
          try {
            const text = await fs.readFile(skillMd, "utf8");
            description = extractDescription(text);
          } catch {
            description = "";
          }
          const skillNode = node(this.id, "skill", `${pathKey(skillsRoot)}:${entry.name}`, entry.name, description ? "ok" : "unknown", {
            description,
            source: path.basename(path.dirname(skillsRoot)),
            evidence: [description ? "SKILL.md parsed" : "SKILL.md missing or unreadable"]
          });
          nodes.push(skillNode);
          edges.push(edge(root.id, "owns", skillNode.id));
        }
      }
      if (scanError && root.state === "ok") root.state = "warning";
      this.lastError = scanError;
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
