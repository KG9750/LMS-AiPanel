import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ensureStorage } from "../src/storage/init";
import { getAppPaths } from "../src/storage/paths";
import { StorageRepository } from "../src/storage/repository";
import { GRAPH_SCHEMA_VERSION, type SystemSnapshot } from "../src/shared/schemas";
import { execa } from "execa";

let tempRoot: string | undefined;

afterEach(async () => {
  vi.unstubAllEnvs();
  if (tempRoot) await fs.rm(tempRoot, { recursive: true, force: true });
  tempRoot = undefined;
});

describe("SQLite repository", () => {
  it("persists a redacted snapshot and audit entry across repository instances", async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lms-aipanel-"));
    vi.stubEnv("LMS_AIPANEL_DATA_DIR", tempRoot);
    expect(await ensureStorage()).toEqual({ ready: true });
    expect(await ensureStorage()).toEqual({ ready: true });

    const migrations = await execa("sqlite3", [
      "-json",
      getAppPaths().databasePath,
      "SELECT version FROM schema_migrations ORDER BY version;"
    ]);
    expect(JSON.parse(migrations.stdout)).toEqual([
      { version: "0001_initial" },
      { version: "0002_snapshots" }
    ]);

    const snapshot: SystemSnapshot = {
      nodes: [
        {
          id: "test:tool:one",
          type: "tool",
          label: "Test",
          state: "ok",
          sourceAdapter: "test",
          properties: { apiKey: "must-not-persist", model: "test-model" },
          lastSeenAt: new Date().toISOString(),
          graphSchemaVersion: GRAPH_SCHEMA_VERSION
        }
      ],
      edges: [],
      adapterRuns: [
        {
          runId: "run:test:one",
          adapterId: "test",
          startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
          status: "success",
          durationMs: 1,
          stale: false
        }
      ],
      driftRecords: []
    };

    const first = new StorageRepository(getAppPaths().databasePath);
    await first.saveSnapshot(snapshot);
    await first.appendAudit({
      id: "audit:test",
      timestamp: new Date().toISOString(),
      actor: "local-user",
      action: "plan:read",
      result: "planned"
    });

    const second = new StorageRepository(getAppPaths().databasePath);
    const restored = await second.loadLatestSnapshot();
    expect(restored?.nodes[0].properties.apiKey).toBe("<redacted>");
    expect((await second.listAudit())[0].id).toBe("audit:test");
  });
});
