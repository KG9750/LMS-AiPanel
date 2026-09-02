import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/server/app";
import { ensureStorage } from "../src/storage/init";
import { applyMigrations, closeDatabase, openDatabase } from "../src/storage/db";
import { getOrCreateHost } from "../src/storage/host";
import { isStamped, stampHostId, UNSTAMPED_HOST_ID } from "../src/domain/scope";
import { GRAPH_SCHEMA_VERSION, hostRecordSchema, type ResourceNode } from "../src/shared/schemas";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "lms-host-test-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function makeNode(overrides: Partial<ResourceNode> = {}): ResourceNode {
  return {
    id: "test:tool:one",
    type: "tool",
    label: "Test Tool",
    state: "ok",
    sourceAdapter: "test",
    hostId: UNSTAMPED_HOST_ID,
    properties: {},
    lastSeenAt: new Date().toISOString(),
    graphSchemaVersion: GRAPH_SCHEMA_VERSION,
    ...overrides
  };
}

describe("host identity persistence", () => {
  it("creates a stable hostId on first run and reuses it after restart", async () => {
    const dataDir = path.join(tmpDir, "data");

    const first = await buildApp({ dataDir, adapters: [] });
    const firstHost = first.host;
    expect(hostRecordSchema.safeParse(firstHost).success).toBe(true);
    expect(firstHost.hostId).toMatch(/^host-/);
    expect(firstHost.scope).toBe("local");
    expect(firstHost.hostName.length).toBeGreaterThan(0);
    await first.close();

    // Simulate a service restart against the same storage directory.
    const second = await buildApp({ dataDir, adapters: [] });
    expect(second.host.hostId).toBe(firstHost.hostId);
    expect(second.host.hostName).toBe(firstHost.hostName);
    expect(second.host.createdAt).toBe(firstHost.createdAt);
    await second.close();
  });

  it("storage reinitialization is idempotent and does not duplicate the host", async () => {
    const dataDir = path.join(tmpDir, "data2");

    await ensureStorage();
    process.env.LMS_AIPANEL_DATA_DIR = dataDir;
    const first = await ensureStorage();
    const second = await ensureStorage();
    expect(first.appliedMigrations.sort()).toEqual(["0001_initial.sql", "0002_host.sql", "0003_registry.sql"]);
    expect(second.appliedMigrations).toEqual([]);

    const hostOne = getOrCreateHost(first.db);
    const hostTwo = getOrCreateHost(second.db);
    expect(hostTwo.hostId).toBe(hostOne.hostId);

    const rows = second.db.prepare("SELECT COUNT(*) AS n FROM host").get() as { n: number };
    expect(rows.n).toBe(1);

    closeDatabase(first.db);
    closeDatabase(second.db);
  });

  it("re-running migrations on an existing database is a no-op", async () => {
    const dbPath = path.join(tmpDir, "migrate.sqlite");
    const db = openDatabase(dbPath);
    const migrationsDir = path.join(process.cwd(), "migrations");
    const first = await applyMigrations(db, migrationsDir);
    const second = await applyMigrations(db, migrationsDir);
    expect(first.length).toBe(3);
    expect(second).toEqual([]);
    closeDatabase(db);
  });
});

describe("resource host scope", () => {
  it("stamps every node with the local hostId", () => {
    const stamped = stampHostId([makeNode(), makeNode({ id: "test:tool:two" })], "host-abc");
    expect(stamped.every((node) => node.hostId === "host-abc")).toBe(true);
    expect(isStamped(stamped[0])).toBe(true);
    expect(isStamped(makeNode())).toBe(false);
  });

  it("API responses carry host scope end to end", async () => {
    const dataDir = path.join(tmpDir, "api");
    const built = await buildApp({ dataDir, adapters: [] });

    const health = await built.app.inject({ method: "GET", url: "/api/health" });
    expect(health.statusCode).toBe(200);
    const healthBody = health.json();
    expect(healthBody.ok).toBe(true);
    expect(healthBody.meta.hostId).toBe(built.host.hostId);
    expect(healthBody.data.scope).toBe("local");
    expect(healthBody.data.hostId).toBe(built.host.hostId);

    const host = await built.app.inject({ method: "GET", url: "/api/host" });
    const hostBody = host.json();
    expect(hostBody.ok).toBe(true);
    expect(hostBody.data.host.hostId).toBe(built.host.hostId);
    expect(hostBody.data.host.hostName).toBe(built.host.hostName);
    expect(hostBody.data.scope).toBe("local");

    const graph = await built.app.inject({ method: "GET", url: "/api/graph" });
    const graphBody = graph.json();
    expect(graphBody.ok).toBe(true);
    expect(graphBody.meta.hostId).toBe(built.host.hostId);
    expect(graphBody.data.host.hostId).toBe(built.host.hostId);
    expect(graphBody.data.version).toBeGreaterThan(0);
    // Every normalized resource is scoped to the local host.
    for (const node of graphBody.data.nodes) {
      expect(node.hostId).toBe(built.host.hostId);
    }

    await built.close();
  });

  it("adapter-sourced nodes are stamped at the runtime boundary", async () => {
    const dataDir = path.join(tmpDir, "runtime");
    const built = await buildApp({ dataDir, adapters: [] });
    const collected = await built.runtime.collectAll();
    expect(collected.result.nodes.every((node) => node.hostId === built.host.hostId)).toBe(true);
    await built.close();
  });
});