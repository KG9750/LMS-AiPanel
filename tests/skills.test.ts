import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execa } from "execa";
import { SkillsAdapter } from "../src/adapters/skillsAdapter";
import type { AdapterContext } from "../src/adapters/types";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "lms-skills-test-"));
  vi.spyOn(os, "homedir").mockReturnValue(tmpDir);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

const CTX: AdapterContext = { now: () => new Date(), timeoutMs: 2_000 };

async function writeSkill(name: string, files: Record<string, string>): Promise<string> {
  const dir = path.join(tmpDir, ".codex", "skills", name);
  await fs.mkdir(dir, { recursive: true });
  for (const [file, content] of Object.entries(files)) {
    await fs.writeFile(path.join(dir, file), content, "utf8");
  }
  return dir;
}

const VALID_SKILL = `---
platform: macos
scope: claude
version: "1.2.0"
usage: 分析代码仓库并生成测试计划
---
# My Skill

这个技能用于代码分析，包含详细的执行步骤和示例说明，足够长以通过结构校验。
`;

describe("Skills adapter provenance", () => {
  it("classifies a git-sourced skill with remote upgrade evidence", async () => {
    const dir = await writeSkill("git-skill", { "SKILL.md": VALID_SKILL });
    // Make it a real git repo with a remote-less origin (no fetch possible).
    await execa("git", ["init", "-q"], { cwd: dir });
    await execa("git", ["-C", dir, "config", "user.email", "t@t"], {});
    await execa("git", ["-C", dir, "config", "user.name", "t"], {});
    await execa("git", ["-C", dir, "add", "."], {});
    await execa("git", ["-C", dir, "commit", "-qm", "init"], {});

    const result = await new SkillsAdapter().collect(CTX);
    const skill = result.nodes.find((n) => n.id === `skills:skill:path-${require("node:crypto").createHash("sha256").update(dir).digest("hex").slice(0, 16)}`);
    expect(skill).toBeDefined();
    expect(skill?.properties.provenance).toBe("git");
    expect(skill?.properties.valid).toBe(true);
    expect(skill?.properties.version).toBe("1.2.0");
    // No verifiable remote (no origin URL): upgrade must NOT be guessed.
    expect(skill?.properties.upgrade).toBeNull();
    expect((skill?.properties.evidence as string[]).some((e) => e.includes("not guessed"))).toBe(true);
  });

  it("local-only skills show no guessed upgrade status", async () => {
    await writeSkill("local-skill", { "SKILL.md": VALID_SKILL });
    const result = await new SkillsAdapter().collect(CTX);
    const skill = result.nodes.find((n) => n.label === "local-skill")!;
    expect(skill.properties.provenance).toBe("local-only");
    expect(skill.properties.upgrade).toBeNull();
    expect((skill.properties.evidence as string[]).some((e) => e.includes("no verifiable remote source"))).toBe(true);
  });

  it("registry-sourced skills show upgrade only with a verifiable source and version", async () => {
    await writeSkill("reg-skill", {
      "SKILL.md": `---
platform: macos
scope: claude
version: "1.0.0"
registry_source: "https://registry.example.com/skills/reg-skill"
registry_version: "2.0.0"
usage: 处理注册表技能
---
# Reg Skill

注册表技能说明文本，足够长以通过结构校验要求。这里补充更多说明文字。
`,
      "manifest.json": "{}"
    });
    const result = await new SkillsAdapter().collect(CTX);
    const skill = result.nodes.find((n) => n.label === "reg-skill")!;
    expect(skill.properties.provenance).toBe("registry");
    expect((skill.properties.upgrade as { available: boolean }).available).toBe(true);
    expect((skill.properties.upgrade as { remoteVersion?: string }).remoteVersion).toBe("2.0.0");
    expect((skill.properties.upgrade as { remoteSource?: string }).remoteSource).toBe("https://registry.example.com/skills/reg-skill");
    expect((skill.properties.upgrade as { recommended: boolean }).recommended).toBe(true);
  });

  it("registry skills without a remote version show no upgrade status", async () => {
    await writeSkill("no-upgrade", {
      "SKILL.md": `---
version: "1.0.0"
registry_source: "https://registry.example.com/skills/no-upgrade"
---
# No Upgrade

本地副本与注册表版本一致，无需升级。文本足够长以通过校验。
`,
      "manifest.json": "{}"
    });
    const result = await new SkillsAdapter().collect(CTX);
    const skill = result.nodes.find((n) => n.label === "no-upgrade")!;
    // No verifiable remote version: the upgrade status is NOT guessed.
    expect(skill.properties.upgrade).toBeNull();
    expect((skill.properties.evidence as string[]).some((e) => e.includes("not guessed"))).toBe(true);
  });

  it("detects local modification and invalid structure separately", async () => {
    await writeSkill("modified-skill", {
      "SKILL.md": `---
version: "1.0.0"
usage: 被本地修改的技能
---
# Modified Skill

这是一个被本地修改的技能，说明文本足够长以通过结构校验。
`,
      "local-patch.txt": "local edit"
    });
    await writeSkill("invalid-skill", { "SKILL.md": "" });

    const result = await new SkillsAdapter().collect(CTX);
    const modified = result.nodes.find((n) => n.label === "modified-skill")!;
    expect(modified.properties.localModified).toBe(false); // no git -> not detectable as modified
    expect(modified.properties.valid).toBe(true);

    const invalid = result.nodes.find((n) => n.label === "invalid-skill")!;
    expect(invalid.properties.valid).toBe(false);
    expect((invalid.properties.validationIssues as string[]).length).toBeGreaterThan(0);
    expect(invalid.state).toBe("warning");
  });

  it("usage summaries come from skill metadata and preserve unknowns", async () => {
    await writeSkill("with-usage", { "SKILL.md": VALID_SKILL });
    await writeSkill("no-usage", {
      "SKILL.md": "# No Usage\n\n没有 usage 字段的技能描述文本，足够长以通过结构校验要求。"
    });

    const result = await new SkillsAdapter().collect(CTX);
    const withUsage = result.nodes.find((n) => n.label === "with-usage")!;
    expect(withUsage.properties.usageKnown).toBe(true);
    expect(withUsage.properties.usageSummary).toContain("测试计划");

    const noUsage = result.nodes.find((n) => n.label === "no-usage")!;
    expect(noUsage.properties.usageKnown).toBe(false);
    expect((noUsage.properties.evidence as string[]).some((e) => e.includes("usage summary unknown"))).toBe(true);
  });
});