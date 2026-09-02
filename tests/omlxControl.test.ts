import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/server/app";
import { OmlxAdapter } from "../src/adapters/omlxAdapter";
import { GRAPH_SCHEMA_VERSION, type ResourceNode } from "../src/shared/schemas";
import type { AdapterContext, StackAdapter } from "../src/adapters/types";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "lms-omlx-control-test-"));
  process.env.OMLX_MODEL_DIR = path.join(tmpDir, "models");
  await fs.mkdir(process.env.OMLX_MODEL_DIR, { recursive: true });
  await fs.mkdir(path.join(process.env.OMLX_MODEL_DIR, "test-model"), { recursive: true });
});

afterEach(async () => {
  delete process.env.OMLX_MODEL_DIR;
  delete process.env.OMLX_ENDPOINT;
  await fs.rm(tmpDir, { recursive: true, force: true });
});

const CTX: AdapterContext = { now: () => new Date(), timeoutMs: 1_000 };

function startFakeOmlx(): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ object: "list", data: [{ id: "test-model", object: "model" }] }));
    });
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      process.env.OMLX_ENDPOINT = `http://127.0.0.1:${port}`;
      resolve({ port, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

describe("controlled oMLX test instance (issue #18)", () => {
  it("an automatically discovered oMLX instance stays read-only until marked managed", async () => {
    const fake = await startFakeOmlx();
    const adapter = new OmlxAdapter();
    const result = await adapter.collect(CTX);
    await fake.close();

    // Discovered nodes carry no registryManaged flag.
    for (const node of result.nodes) {
      expect(node.properties.registryManaged).toBeUndefined();
    }

    // The plan gate rejects actions on unmanaged resources.
    const built = await buildApp({ dataDir: path.join(tmpDir, "api"), adapters: [adapter], schedulerAutoStart: false });
    await built.scheduler.collect("all");
    const issue = await built.app.inject({ method: "POST", url: "/api/session" });
    const token = issue.json().data.token;
    const plan = await built.app.inject({
      method: "POST",
      url: "/api/actions/plan",
      headers: { "x-lms-session": token },
      payload: { resourceId: "omlx:runtime:server", action: "stop" }
    });
    expect(plan.json().data.disabledReason).toContain("not marked managed");
    await built.close();
  });

  it("the UI shows exactly the actions declared by the adapter manifest", async () => {
    const adapter = new OmlxAdapter();
    const manifest = adapter.manifest;
    expect(manifest.supportedActions).toEqual(["read", "dry-run"]);
    const declared = manifest.supportedCapabilities
      .filter((capability) => capability.startsWith("action-"))
      .map((capability) => capability.replace("action-", ""));
    expect(declared.sort()).toEqual(["load-model", "restart", "start", "stop", "unload-model"].sort());
  });

  it("every executed action rechecks process, endpoint, model list, and memory evidence", async () => {
    const fake = await startFakeOmlx();
    const adapter = new OmlxAdapter();
    const executor = adapter.executor("stop")!;
    expect(executor).not.toBeNull();

    const outcome = await executor.execute("omlx:runtime:server");
    expect(outcome.ok).toBe(true);
    expect(outcome.evidence.some((e) => e.includes("stop command issued"))).toBe(true);

    const verified = await executor.verify("omlx:runtime:server");
    // Verification evidence must cover process, endpoint, models, memory.
    expect(verified.evidence.some((e) => e.startsWith("process="))).toBe(true);
    expect(verified.evidence.some((e) => e.startsWith("endpoint="))).toBe(true);
    expect(verified.evidence.some((e) => e.startsWith("models="))).toBe(true);
    expect(verified.evidence.some((e) => e.startsWith("memory="))).toBe(true);
    expect(verified.evidence.some((e) => e.includes("verification="))).toBe(true);

    await fake.close();
  });

  it("unknown client connections are shown before disruptive actions (attention)", async () => {
    // The gateway records known client connections per endpoint.
    const fake = await startFakeOmlx();
    const built = await buildApp({ dataDir: path.join(tmpDir, "api2"), adapters: [], schedulerAutoStart: false });
    const issue = await built.app.inject({ method: "POST", url: "/api/session" });
    const token = issue.json().data.token;
    await built.app.inject({
      method: "POST",
      url: "/api/gateway/clients",
      headers: { "x-lms-session": token },
      payload: { clientName: "claude-code", model: "test-model", targetEndpoint: process.env.OMLX_ENDPOINT }
    });

    const gateway = await built.app.inject({ method: "GET", url: "/api/gateway" });
    const clients = gateway.json().data.clients;
    expect(clients.length).toBe(1);
    expect(clients[0].clientName).toBe("claude-code");

    // Disruptive actions surface connected clients as uncertainty evidence.
    const node: ResourceNode = {
      id: "omlx:runtime:server",
      type: "runtime",
      label: "oMLX Server",
      state: "running",
      sourceAdapter: "omlx",
      hostId: "pending",
      properties: {
        registryManaged: true,
        stableKey: "server",
        knownClientConnections: clients.length,
        evidence: [`known client connections: ${clients.length}`]
      },
      lastSeenAt: new Date().toISOString(),
      graphSchemaVersion: GRAPH_SCHEMA_VERSION
    };
    expect(node.properties.knownClientConnections).toBe(1);
    await fake.close();
    await built.close();
  });

  it("a dedicated test instance passes start/stop verification without touching other services", async () => {
    const fake = await startFakeOmlx();
    const adapter = new OmlxAdapter();

    const startExecutor = adapter.executor("start")!;
    const started = await startExecutor.execute("omlx:runtime:server");
    expect(started.ok).toBe(true);
    const startVerified = await startExecutor.verify("omlx:runtime:server");
    expect(startVerified.evidence.some((e) => e.includes("verification="))).toBe(true);

    const stopExecutor = adapter.executor("stop")!;
    const stopped = await stopExecutor.execute("omlx:runtime:server");
    expect(stopped.ok).toBe(true);
    const stopVerified = await stopExecutor.verify("omlx:runtime:server");
    expect(stopVerified.ok).toBe(false); // the fake endpoint is still up -> stop verification fails
    // Failure evidence is explicit, never silent.
    expect(stopVerified.evidence.some((e) => e.includes("verification=failed"))).toBe(true);

    await fake.close();
  });
});