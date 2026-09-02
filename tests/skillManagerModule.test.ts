import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createAdapters } from "../src/adapters";
import { LocalSkillManagerAdapter } from "../src/adapters/localSkillManagerAdapter";
import { AdapterRuntime } from "../src/adapters/runtime";
import { collectSkillManagerModule, parseSkillManagerPort } from "../src/modules/skillManagerModule";

describe("Local Skill Manager module", () => {
  it("maps the Local Skill Manager CLI scan into a module snapshot", async () => {
    const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), "lms-skill-manager-"));
    const cliPath = path.join(projectPath, "dist", "cli", "index.js");
    await fs.mkdir(path.dirname(cliPath), { recursive: true });
    await fs.writeFile(cliPath, "", "utf8");
    const signal = new AbortController().signal;

    const snapshot = await collectSkillManagerModule({
      projectPath,
      cliPath,
      port: 19001,
      signal,
      checkPort: async () => false,
      runCommand: async (file, args, options) => {
        expect(file).toBe(process.execPath);
        expect(options.cwd).toBe(projectPath);
        expect(options.signal).toBeInstanceOf(AbortSignal);
        expect(options.signal?.aborted).toBe(false);
        expect(args).toEqual([cliPath, "scan", "--dry-run", "--json", "--workspace", projectPath]);
        return {
          exitCode: 0,
          stderr: "",
          stdout: JSON.stringify({
            skills: [
              {
                id: "codex-a",
                platform: "codex",
                scope: "user",
                relativeDirName: "write-a-skill",
                name: "write-a-skill",
                description: "Create skills.",
                status: "enabled",
                skillMdPath: `${projectPath}/write-a-skill/SKILL.md`,
                skillMdMtime: "2026-09-02T01:00:00.000Z",
                validation: { state: "OK", issues: [] }
              },
              {
                id: "claude-a",
                platform: "claude",
                scope: "user",
                relativeDirName: "hf-cli",
                name: "hf-cli",
                description: "",
                status: "readonly",
                skillMdPath: `${projectPath}/hf-cli/SKILL.md`,
                skillMdMtime: "2026-09-02T02:00:00.000Z",
                validation: {
                  state: "WARN",
                  issues: [{ severity: "WARN", code: "MISSING_REFERENCE", message: "Missing referenced file." }]
                }
              }
            ],
            rootWarnings: [{ severity: "WARN", code: "ROOT_NOTE", message: "Fixture warning." }],
            summary: { total: 999 }
          })
        };
      }
    });

    expect(snapshot.available).toBe(true);
    expect(snapshot.summary.total).toBe(2);
    expect(snapshot.summary.byPlatform.codex).toBe(1);
    expect(snapshot.summary.byStatus.readonly).toBe(1);
    expect(snapshot.summary.byValidation.WARN).toBe(1);
    expect(snapshot.rootWarnings[0]?.code).toBe("ROOT_NOTE");
    expect(snapshot.recentSkills[0]?.name).toBe("hf-cli");
    expect(snapshot.panel.readonlyCommand).toContain("serve --readonly --port 19001");
  });

  it("reports an unavailable module when the CLI build is missing", async () => {
    const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), "lms-skill-manager-missing-"));
    let called = false;
    const snapshot = await collectSkillManagerModule({
      projectPath,
      cliPath: path.join(projectPath, "dist", "cli", "index.js"),
      checkPort: async () => false,
      runCommand: async () => {
        called = true;
        return { exitCode: 1, stdout: "", stderr: "" };
      }
    });

    expect(called).toBe(false);
    expect(snapshot.available).toBe(false);
    expect(snapshot.summary.total).toBe(0);
    expect(snapshot.error).toContain("CLI 尚未构建");
  });

  it("never exposes an unauthenticated panel link", async () => {
    const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), "lms-skill-manager-panel-"));
    const cliPath = path.join(projectPath, "dist", "cli", "index.js");
    await fs.mkdir(path.dirname(cliPath), { recursive: true });
    await fs.writeFile(cliPath, "", "utf8");

    const snapshot = await collectSkillManagerModule({
      projectPath,
      cliPath,
      probePanel: async () => ({ portOccupied: true, identityVerified: true }),
      runCommand: async () => ({ exitCode: 0, stdout: JSON.stringify({ skills: [] }), stderr: "" })
    });

    expect(snapshot.panel.running).toBe(true);
    expect(snapshot.panel.identityVerified).toBe(true);
    expect(snapshot.panel.url).toBeNull();
    expect(snapshot.panel.accessMessage).toContain("一次性 URL");
  });

  it("requires an explicit project path before enabling the integration", async () => {
    const snapshot = await collectSkillManagerModule({ environment: {} });

    expect(snapshot.configured).toBe(false);
    expect(snapshot.available).toBe(false);
    expect(snapshot.projectPath).toBe("");
    expect(snapshot.error).toContain("LMS_AIPANEL_SKILL_MANAGER_PATH");
    expect(createAdapters({}).some((adapter) => adapter.id === "local-skill-manager")).toBe(false);
  });

  it("uses the configured panel port and falls back when it is invalid", () => {
    expect(parseSkillManagerPort("19003")).toBe(19003);
    expect(parseSkillManagerPort("0")).toBe(8787);
    expect(parseSkillManagerPort("70000")).toBe(8787);
    expect(parseSkillManagerPort("not-a-port")).toBe(8787);
  });

  it("reports a failed adapter run when the configured CLI build is missing", async () => {
    const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), "lms-skill-manager-adapter-missing-"));
    const runtime = new AdapterRuntime([
      new LocalSkillManagerAdapter(projectPath, 19004, async () => ({
        portOccupied: false,
        identityVerified: false
      }))
    ]);

    const result = await runtime.collectAll();

    expect(result.runs[0]).toMatchObject({ adapterId: "local-skill-manager", status: "failed", stale: false });
    expect(result.runs[0].error).toContain("CLI 尚未构建");
    expect(result.result.nodes).toEqual([]);
  });

  it("keeps the Resource Graph adapter on a lightweight inspection path", async () => {
    const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), "lms-skill-manager-light-"));
    const cliPath = path.join(projectPath, "dist", "cli", "index.js");
    await fs.mkdir(path.dirname(cliPath), { recursive: true });
    await fs.writeFile(cliPath, "this is intentionally not executable JavaScript", "utf8");
    const adapter = new LocalSkillManagerAdapter(projectPath, 19002, async () => ({
      portOccupied: false,
      identityVerified: false
    }));

    const result = await adapter.collect({
      now: () => new Date(),
      timeoutMs: 1_000,
      signal: new AbortController().signal
    });

    expect(result.nodes.find((node) => node.id.includes("local-skill-manager"))?.state).toBe("ok");
    expect(result.nodes.some((node) => node.type === "skill")).toBe(false);
  });

  it("cancels a module scan that exceeds its timeout", async () => {
    const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), "lms-skill-manager-timeout-"));
    const cliPath = path.join(projectPath, "dist", "cli", "index.js");
    await fs.mkdir(path.dirname(cliPath), { recursive: true });
    await fs.writeFile(cliPath, "", "utf8");

    const snapshot = await collectSkillManagerModule({
      projectPath,
      cliPath,
      timeoutMs: 20,
      checkPort: async () => false,
      runCommand: async (_file, _args, options) => new Promise((_resolve, reject) => {
        options.signal?.addEventListener("abort", () => reject(options.signal?.reason), { once: true });
      })
    });

    expect(snapshot.available).toBe(false);
    expect(snapshot.error).toContain("扫描超时");
  });
});
