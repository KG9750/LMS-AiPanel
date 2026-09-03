import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/server/app";
import { ConfigCenter, CODEX_FIELD_SPECS } from "../src/domain/configCenter";

let tmpDir: string;
let configFile: string;

const INITIAL = `model = "gpt-5"
model_provider = "openai"
temperature = 0.7
custom_unknown_key = "keep-me"
`;

const UPDATED = `model = "gpt-5.1"
model_provider = "openai"
temperature = 0.4
custom_unknown_key = "keep-me"
`;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "lms-config-test-"));
  configFile = path.join(tmpDir, "config.toml");
  await fs.writeFile(configFile, INITIAL, "utf8");
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

async function sessionHeader(built: { app: import("fastify").FastifyInstance }): Promise<Record<string, string>> {
  const issue = await built.app.inject({ method: "POST", url: "/api/session" });
  return { "x-lms-session": issue.json().data.token as string };
}

describe("Config Center", () => {
  it("exposes meaning, type, source, sensitivity, version, and restart requirements per field", async () => {
    const built = await buildApp({ dataDir: path.join(tmpDir, "data"), adapters: [], schedulerAutoStart: false, configPaths: [configFile] });
    const auth = await sessionHeader(built);
    const res = await built.app.inject({ method: "GET", url: `/api/config/preview?path=${encodeURIComponent(configFile)}`,
      headers: auth
    });
    const preview = res.json().data;

    expect(preview.configType).toBe("codex-config-toml");
    expect(preview.documentedFields.length).toBe(CODEX_FIELD_SPECS.length);
    for (const field of preview.documentedFields) {
      expect(field.meaning.length).toBeGreaterThan(0);
      expect(["string", "number", "boolean", "string[]", "object"]).toContain(field.type);
      expect(field.source).toContain("config.toml");
      expect(typeof field.sensitive).toBe("boolean");
      expect(field.version).toBeGreaterThan(0);
      expect(typeof field.restartRequired).toBe("boolean");
    }
    const model = preview.documentedFields.find((f: { key: string }) => f.key === "model");
    expect(model.value).toBe("gpt-5");
    expect(model.valuePresent).toBe(true);
    await built.close();
  });

  it("unknown fields survive a round trip and are labeled undocumented", async () => {
    const built = await buildApp({ dataDir: path.join(tmpDir, "data2"), adapters: [], schedulerAutoStart: false, configPaths: [configFile] });
    const auth = await sessionHeader(built);
    const res = await built.app.inject({ method: "GET", url: `/api/config/preview?path=${encodeURIComponent(configFile)}`,
      headers: auth
    });
    const preview = res.json().data;

    expect(preview.undocumentedFields).toContainEqual({ key: "custom_unknown_key", value: "keep-me" });

    // Apply keeps the unknown field intact.
    const issue = await built.app.inject({ method: "POST", url: "/api/session" });
    const token = issue.json().data.token;
    const applied = await built.app.inject({
      method: "POST",
      url: "/api/config/apply",
      headers: { "x-lms-session": token },
      payload: { path: configFile, content: UPDATED, previewHash: preview.previewHash }
    });
    expect(applied.json().data.ok).toBe(true);

    const after = await fs.readFile(configFile, "utf8");
    expect(after).toContain('custom_unknown_key = "keep-me"');
    await built.close();
  });

  it("an external file change invalidates the preview before apply", async () => {
    const built = await buildApp({ dataDir: path.join(tmpDir, "data3"), adapters: [], schedulerAutoStart: false, configPaths: [configFile] });
    const auth = await sessionHeader(built);
    const res = await built.app.inject({ method: "GET", url: `/api/config/preview?path=${encodeURIComponent(configFile)}`,
      headers: auth
    });
    const preview = res.json().data;

    // External change after preview.
    await fs.writeFile(configFile, 'model = "external-edit"\n', "utf8");

    const issue = await built.app.inject({ method: "POST", url: "/api/session" });
    const token = issue.json().data.token;
    const applied = await built.app.inject({
      method: "POST",
      url: "/api/config/apply",
      headers: { "x-lms-session": token },
      payload: { path: configFile, content: UPDATED, previewHash: preview.previewHash }
    });
    const body = applied.json();
    // The stale apply is rejected at the guard level with a clear code.
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("PREVIEW_STALE");
    // The file was NOT overwritten by the stale apply.
    expect(await fs.readFile(configFile, "utf8")).toBe('model = "external-edit"\n');
    await built.close();
  });

  it("apply creates ActionRun and audit evidence with backup", async () => {
    const built = await buildApp({ dataDir: path.join(tmpDir, "data4"), adapters: [], schedulerAutoStart: false, configPaths: [configFile] });
    const auth = await sessionHeader(built);
    const res = await built.app.inject({ method: "GET", url: `/api/config/preview?path=${encodeURIComponent(configFile)}`,
      headers: auth
    });
    const preview = res.json().data;
    const issue = await built.app.inject({ method: "POST", url: "/api/session" });
    const token = issue.json().data.token;

    const applied = await built.app.inject({
      method: "POST",
      url: "/api/config/apply",
      headers: { "x-lms-session": token },
      payload: { path: configFile, content: UPDATED, previewHash: preview.previewHash }
    });
    const data = applied.json().data;
    expect(data.ok).toBe(true);
    expect(data.run.status).toBe("succeeded");
    expect(data.backupId).toMatch(/^backup:/);

    // Backup list has the before-apply content.
    const backups = await built.app.inject({ method: "GET", url: "/api/config/backups" });
    const backup = backups.json().data[0];
    expect(backup.content).toBe(INITIAL);

    // Restore brings the original back.
    const restored = await built.app.inject({
      method: "POST",
      url: `/api/config/backups/${backup.id}/restore`,
      headers: { "x-lms-session": token }
    });
    expect(restored.json().data.restored).toBe(true);
    expect(await fs.readFile(configFile, "utf8")).toBe(INITIAL);

    // Audit trail contains the apply.
    const audit = await built.app.inject({ method: "GET", url: "/api/audit" });
    expect(audit.json().data.some((e: { action: string }) => e.action === "config:apply")).toBe(true);
    await built.close();
  });

  it("diff preview shows added/removed lines", async () => {
    const built = await buildApp({ dataDir: path.join(tmpDir, "data5"), adapters: [], schedulerAutoStart: false, configPaths: [configFile] });
    const auth = await sessionHeader(built);
    const res = await built.app.inject({
      method: "POST",
      url: "/api/config/diff",
      headers: auth,
      payload: { path: configFile, content: UPDATED }
    });
    const data = res.json().data;
    expect(data.diff.some((l: { type: string; line: string }) => l.type === "removed" && l.line.includes("gpt-5"))).toBe(true);
    expect(data.diff.some((l: { type: string; line: string }) => l.type === "added" && l.line.includes("gpt-5.1"))).toBe(true);
    expect(data.fresh).toBe(true);
    await built.close();
  });

  it("apply without a session is rejected by the write guard", async () => {
    const built = await buildApp({ dataDir: path.join(tmpDir, "data6"), adapters: [], schedulerAutoStart: false, configPaths: [configFile] });
    const res = await built.app.inject({
      method: "POST",
      url: "/api/config/apply",
      payload: { path: configFile, content: UPDATED, previewHash: "x" }
    });
    expect(res.json().error.code).toBe("WRITE_GUARD_REJECTED");
    await built.close();
  });
});

describe("ConfigCenter direct", () => {
  it("restore path works in temporary directories only", async () => {
    const built = await buildApp({ dataDir: path.join(tmpDir, "direct"), adapters: [], schedulerAutoStart: false, configPaths: [configFile] });
    const center = new ConfigCenter(built.storage.db, built.host.hostId);
    const preview = await center.readPreview(configFile);
    const outcome = await center.apply(preview, UPDATED, "action:test");
    expect(outcome.ok).toBe(true);
    expect(outcome.backup.content).toBe(INITIAL);

    const restored = await center.restore(outcome.backup.id, async () => true);
    expect(restored?.content).toBe(INITIAL);
    expect(await fs.readFile(configFile, "utf8")).toBe(INITIAL);
    await built.close();
  });
});