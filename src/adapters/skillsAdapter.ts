import fs from "node:fs/promises";
import path from "node:path";
import { execa } from "execa";
import type { AdapterManifest, AdapterResult, ResourceNode } from "../shared/schemas";
import type { AdapterContext, HealthStatus, StackAdapter } from "./types";
import { edge, homePath, node, pathKey } from "./helpers";

export type SkillProvenance = "git" | "registry" | "local-only" | "unknown";

export interface SkillAssessment {
  provenance: SkillProvenance;
  platform?: string;
  scope?: string;
  version?: string;
  localModified: boolean;
  usageSummary?: string;
  usageKnown: boolean;
  valid: boolean;
  validationIssues: string[];
  /** Upgrade availability — ONLY set with a verifiable source + version. */
  upgrade: {
    available: boolean;
    recommended: boolean;
    remoteVersion?: string;
    remoteSource?: string;
    reason?: string;
  } | null;
}

/**
 * Skills adapter with provenance, validation, and upgrade assessment
 * (issue #20). Remote upgrade state is shown ONLY when a verifiable source
 * and version exist; local-only skills show no guessed upgrade status.
 * Available and recommended upgrades are separate concepts.
 */
export class SkillsAdapter implements StackAdapter {
  id = "skills";
  name = "Codex Skills";
  manifest: AdapterManifest = {
    adapterId: "skills",
    adapterName: "Codex Skills",
    manifestVersion: 1,
    description: "Read-only inventory of Codex skills with provenance, validation, and upgrade assessment.",
    discoverySources: ["~/.codex/skills", ".git remotes", "registry metadata (SKILL.md frontmatter)"],
    permissions: ["home-directory-read"],
    refreshProfile: { intervalSeconds: 300, onDemand: true },
    telemetryCoverage: [],
    supportedCapabilities: ["discovery", "model-inventory"],
    supportedActions: []
  };
  private lastError: string | undefined;

  async collect(_context: AdapterContext): Promise<AdapterResult> {
    const root = node(this.id, "tool", "codex-skills", "Codex Skills", "unknown", {
      evidence: ["~/.codex/skills scan"]
    });
    const nodes: ResourceNode[] = [root];
    const edges = [];

    try {
      const skillsRoot = homePath(".codex", "skills");
      const entries = await fs.readdir(skillsRoot, { withFileTypes: true });
      root.state = "ok";
      for (const entry of entries.filter((item) => item.isDirectory())) {
        const skillDir = path.join(skillsRoot, entry.name);
        const skillNode = await this.assessSkill(skillDir, entry.name);
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

  private async assessSkill(skillDir: string, name: string): Promise<ResourceNode> {
    const assessment = await this.assess(skillDir, name);
    const skillNode = node(this.id, "skill", pathKey(skillDir), name, assessment.valid ? "ok" : "warning", {
      stableKey: pathKey(skillDir),
      pathHint: `~/.codex/skills/${name}`,
      provenance: assessment.provenance,
      platform: assessment.platform,
      scope: assessment.scope,
      version: assessment.version,
      localModified: assessment.localModified,
      usageSummary: assessment.usageSummary,
      usageKnown: assessment.usageKnown,
      valid: assessment.valid,
      validationIssues: assessment.validationIssues,
      upgrade: assessment.upgrade,
      evidence: this.evidenceFor(assessment)
    });
    return skillNode;
  }

  private async assess(skillDir: string, name: string): Promise<SkillAssessment> {
    const validation = await this.validateStructure(skillDir);
    const metadata = await this.readMetadata(skillDir);
    const provenance = await this.detectProvenance(skillDir);
    const gitState = provenance === "git" ? await this.gitState(skillDir) : null;
    const localModified = gitState?.modified ?? metadata.localModified ?? false;

    // Upgrade assessment: ONLY with a verifiable source + version.
    let upgrade: SkillAssessment["upgrade"] = null;
    if (gitState?.remoteVersion && gitState.currentVersion) {
      const available = gitState.remoteVersion !== gitState.currentVersion;
      upgrade = {
        available,
        recommended: available && (gitState.behindBy ?? 0) >= 2,
        remoteVersion: gitState.remoteVersion,
        remoteSource: gitState.remoteUrl,
        reason: available ? `remote ${gitState.remoteVersion} vs local ${gitState.currentVersion}` : undefined
      };
    } else if (metadata.registryVersion && metadata.registrySource) {
      const available = metadata.registryVersion !== metadata.version;
      upgrade = {
        available,
        recommended: available,
        remoteVersion: metadata.registryVersion,
        remoteSource: metadata.registrySource,
        reason: available ? "registry metadata indicates a newer version" : undefined
      };
    }

    return {
      provenance,
      platform: metadata.platform,
      scope: metadata.scope,
      version: metadata.version ?? gitState?.currentVersion,
      localModified,
      usageSummary: metadata.usageSummary,
      usageKnown: metadata.usageKnown,
      valid: validation.valid,
      validationIssues: validation.issues,
      upgrade
    };
  }

  private async validateStructure(skillDir: string): Promise<{ valid: boolean; issues: string[] }> {
    const issues: string[] = [];
    const skillMd = path.join(skillDir, "SKILL.md");
    try {
      const text = await fs.readFile(skillMd, "utf8");
      if (!text.trim()) issues.push("SKILL.md is empty");
      // The title may follow YAML frontmatter.
      const body = text.replace(/^---\n[\s\S]*?\n---\n?/, "");
      if (!/^#\s+/.test(body.trimStart())) issues.push("SKILL.md missing a top-level title");
      if (text.length < 40) issues.push("SKILL.md suspiciously short");
    } catch {
      issues.push("SKILL.md missing or unreadable");
    }
    return { valid: issues.length === 0, issues };
  }

  private async readMetadata(skillDir: string): Promise<{
    platform?: string;
    scope?: string;
    version?: string;
    registryVersion?: string;
    registrySource?: string;
    localModified?: boolean;
    usageSummary?: string;
    usageKnown: boolean;
  }> {
    const skillMd = path.join(skillDir, "SKILL.md");
    try {
      const text = await fs.readFile(skillMd, "utf8");
      const frontmatter = text.match(/^---\n([\s\S]*?)\n---/);
      const meta: Record<string, string> = {};
      if (frontmatter) {
        for (const line of frontmatter[1].split("\n")) {
          const match = line.match(/^([a-zA-Z_-]+):\s*(.+)$/);
          if (match) meta[match[1].toLowerCase()] = match[2].trim().replace(/^["']|["']$/g, "");
        }
      }
      const usageMatch = text.match(/^usage:\s*["']?(.+?)["']?\s*$/m);
      return {
        platform: meta.platform,
        scope: meta.scope,
        version: meta.version,
        registryVersion: meta.registry_version ?? meta["registry-version"],
        registrySource: meta.registry_source ?? meta["registry-source"],
        localModified: meta.local_modified === "true",
        usageSummary: usageMatch?.[1] ?? meta.usage,
        usageKnown: Boolean(usageMatch || meta.usage)
      };
    } catch {
      return { usageKnown: false };
    }
  }

  private async detectProvenance(skillDir: string): Promise<SkillProvenance> {
    try {
      const gitDir = path.join(skillDir, ".git");
      await fs.access(gitDir);
      return "git";
    } catch {
      // not a git checkout
    }
    try {
      const meta = await this.readMetadata(skillDir);
      if (meta.registrySource) return "registry";
    } catch {
      // fall through
    }
    try {
      const entries = await fs.readdir(skillDir);
      const registryHints = entries.filter((name) => /registry|manifest\.json|\.omlx/i.test(name));
      if (registryHints.length > 0) return "registry";
    } catch {
      // fall through
    }
    return "local-only";
  }

  private async gitState(skillDir: string): Promise<{
    currentVersion?: string;
    remoteVersion?: string;
    remoteUrl?: string;
    modified: boolean;
    behindBy?: number;
  } | null> {
    try {
      const remoteUrl = (await execa("git", ["-C", skillDir, "remote", "get-url", "origin"], { timeout: 3_000 })).stdout.trim();
      if (!remoteUrl) return null;
      const current = (await execa("git", ["-C", skillDir, "rev-parse", "--short", "HEAD"], { timeout: 3_000 })).stdout.trim();
      const status = (await execa("git", ["-C", skillDir, "status", "--porcelain"], { timeout: 3_000 })).stdout;
      const modified = status.trim().length > 0;

      let remoteVersion: string | undefined;
      let behindBy: number | undefined;
      try {
        await execa("git", ["-C", skillDir, "fetch", "origin", "HEAD"], { timeout: 5_000 });
        const remote = (await execa("git", ["-C", skillDir, "rev-parse", "--short", "origin/HEAD"], { timeout: 3_000 })).stdout.trim();
        if (remote && remote !== current) {
          remoteVersion = remote;
          behindBy = Number(
            (await execa("git", ["-C", skillDir, "rev-list", "--count", `${current}..origin/HEAD`], { timeout: 3_000 })).stdout.trim() || "0"
          );
        }
      } catch {
        // network unavailable: keep remoteVersion undefined
      }

      return { currentVersion: current, remoteVersion, remoteUrl, modified, behindBy };
    } catch {
      return null;
    }
  }

  private evidenceFor(assessment: SkillAssessment): string[] {
    const evidence = [
      `provenance=${assessment.provenance}`,
      `valid=${assessment.valid}`,
      `localModified=${assessment.localModified}`
    ];
    if (assessment.version) evidence.push(`version=${assessment.version}`);
    if (assessment.upgrade?.available) {
      evidence.push(`upgrade available: ${assessment.upgrade.remoteVersion} from ${assessment.upgrade.remoteSource}`);
    } else if (assessment.upgrade === null) {
      evidence.push("no verifiable remote source+version; upgrade status not guessed");
    } else {
      evidence.push("up to date with verifiable remote source");
    }
    if (assessment.usageKnown) {
      evidence.push(`usage summary: ${assessment.usageSummary}`);
    } else {
      evidence.push("usage summary unknown (no skill metadata or SKILL.md usage field)");
    }
    return evidence;
  }
}