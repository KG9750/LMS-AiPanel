import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/server/app";
import { mergeRegistry } from "../src/domain/registryMerge";
import { RegistryRepository } from "../src/storage/registry";
import { GRAPH_SCHEMA_VERSION, type RegistryEntry, type ResourceNode } from "../src/shared/schemas";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "lms-registry-test-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function makeNode(overrides: Partial<ResourceNode> = {}): ResourceNode {
  return {
    id: "omlx:runtime:test-1",
    type: "runtime",
    label: "oMLX test-1",
    state: "running",
    sourceAdapter: "omlx",
    hostId: "host-test",
    properties: { stableKey: "test-1" },
    lastSeenAt: new Date().toISOString(),
    graphSchemaVersion: GRAPH_SCHEMA_VERSION,
    ...overrides
  };
}

function makeEntry(overrides: Partial<RegistryEntry> = {}): RegistryEntry {
  return {
    id: "reg:test",
    hostId: "host-test",
    kind: "match",
    adapterId: "omlx",
    resourceType: "runtime",
    stableKey: "test-1",
    label: "oMLX test-1 (managed)",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides
  };
}

describe("registry merge", () => {
  it("newly discovered resources remain read-only (unmanaged) by default", () => {
    const outcome = mergeRegistry([makeNode()], []);
    expect(outcome.nodes).toHaveLength(1);
    expect(outcome.nodes[0].properties.registryManaged).toBeUndefined();
    expect(outcome.merges).toHaveLength(0);
  });

  it("a match entry marks a discovered resource as registered and managed", () => {
    const entry = makeEntry({ managed: true });
    const outcome = mergeRegistry([makeNode()], [entry]);
    expect(outcome.nodes[0].properties.registryEntryId).toBe("reg:test");
    expect(outcome.nodes[0].properties.registryManaged).toBe(true);
    expect(outcome.merges[0].status).toBe("managed");
    expect(outcome.merges[0].evidence.some((e) => e.includes("discovered by omlx"))).toBe(true);
    expect(outcome.attention).toHaveLength(0);
  });

  it("a supplement entry materializes an unverified resource when discovery found nothing", () => {
    const entry = makeEntry({
      kind: "supplement",
      adapterId: "mlx-server",
      resourceType: "endpoint",
      stableKey: "custom-1",
      label: "MLX custom",
      customEndpoint: "http://127.0.0.1:18080"
    });
    const outcome = mergeRegistry([], [entry]);
    expect(outcome.nodes).toHaveLength(1);
    expect(outcome.nodes[0].id).toBe("mlx-server:endpoint:custom-1");
    expect(outcome.nodes[0].state).toBe("unknown");
    expect(outcome.nodes[0].properties.customEndpoint).toBe("http://127.0.0.1:18080");
    expect(outcome.merges[0].status).toBe("unverified");
  });

  it("ignore entries drop the discovered resource", () => {
    const entry = makeEntry({ kind: "ignore" });
    const outcome = mergeRegistry([makeNode()], [entry]);
    expect(outcome.nodes).toHaveLength(0);
  });

  it("conflicting matches create an attention item instead of overwriting", () => {
    const discovered = makeNode({ properties: { stableKey: "test-1", endpoint: "http://127.0.0.1:9999" } });
    const entry = makeEntry({ customEndpoint: "http://127.0.0.1:8888" });
    const outcome = mergeRegistry([discovered], [entry]);
    expect(outcome.attention).toHaveLength(1);
    expect(outcome.attention[0].resourceId).toBe("omlx:runtime:test-1");
    const merge = outcome.merges[0];
    expect(merge.status).toBe("conflict");
    // Discovery evidence is preserved, not silently overwritten.
    expect(outcome.nodes[0].properties.endpoint).toBe("http://127.0.0.1:9999");
  });

  it("two registry entries matching one resource create a conflict", () => {
    const outcome = mergeRegistry([makeNode()], [makeEntry(), makeEntry({ id: "reg:other" })]);
    expect(outcome.attention.some((a) => a.message.includes("conflicting registry matches"))).toBe(true);
  });
});

describe("registry API", () => {
  it("CRUD + merge states round-trip through the API", async () => {
    const built = await buildApp({ dataDir: path.join(tmpDir, "api") });

    // Create a match entry.
    const create = await built.app.inject({
      method: "POST",
      url: "/api/registry",
      payload: {
        kind: "match",
        adapterId: "omlx",
        resourceType: "runtime",
        stableKey: "test-1",
        label: "oMLX test-1",
        managed: true
      }
    });
    expect(create.statusCode).toBe(200);
    const created = create.json().data as RegistryEntry;
    expect(created.id).toMatch(/^reg:/);
    expect(created.managed).toBe(true);

    // Update to unmanaged.
    const update = await built.app.inject({
      method: "PUT",
      url: `/api/registry/${created.id}`,
      payload: { managed: false }
    });
    expect(update.json().data.managed).toBe(false);

    // Registry endpoint lists entries, merges, attention.
    const list = await built.app.inject({ method: "GET", url: "/api/registry" });
    const body = list.json();
    expect(body.ok).toBe(true);
    expect(body.data.entries).toHaveLength(1);
    expect(Array.isArray(body.data.attention)).toBe(true);

    // Delete.
    const del = await built.app.inject({ method: "DELETE", url: `/api/registry/${created.id}` });
    expect(del.json().data.deleted).toBe(true);
    const after = await built.app.inject({ method: "GET", url: "/api/registry" });
    expect(after.json().data.entries).toHaveLength(0);

    await built.close();
  });

  it("rejects invalid registry entries with a contract error", async () => {
    const built = await buildApp({ dataDir: path.join(tmpDir, "api2") });
    const res = await built.app.inject({
      method: "POST",
      url: "/api/registry",
      payload: { kind: "nonsense", resourceType: "runtime", stableKey: "", label: "" }
    });
    expect(res.json().ok).toBe(false);
    expect(res.json().error.code).toBe("INVALID_REGISTRY_ENTRY");
    await built.close();
  });

  it("registry persists across restart (temporary storage only)", async () => {
    const dataDir = path.join(tmpDir, "persist");
    const repo = new RegistryRepository(
      (await buildApp({ dataDir, adapters: [] })).storage.db,
      (await buildApp({ dataDir, adapters: [] })).host.hostId
    );
    const built1 = await buildApp({ dataDir, adapters: [] });
    const entry = built1.registry.create({
      kind: "supplement",
      adapterId: "ollama",
      resourceType: "runtime",
      stableKey: "ollama",
      label: "Ollama",
      customEndpoint: "http://127.0.0.1:11434"
    });
    await built1.close();
    void repo;

    const built2 = await buildApp({ dataDir, adapters: [] });
    const rows = built2.registry.list();
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(entry.id);
    expect(rows[0].customEndpoint).toBe("http://127.0.0.1:11434");
    await built2.close();
  });
});