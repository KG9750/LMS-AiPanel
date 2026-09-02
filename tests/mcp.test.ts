import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { McpAdapter } from "../src/adapters/mcpAdapter";
import type { AdapterContext } from "../src/adapters/types";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "lms-mcp-test-"));
  vi.spyOn(os, "homedir").mockReturnValue(tmpDir);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

const CTX: AdapterContext = { now: () => new Date(), timeoutMs: 1_000 };

async function writeCodexConfig(servers: Record<string, unknown>): Promise<void> {
  const dir = path.join(tmpDir, ".codex");
  await fs.mkdir(dir, { recursive: true });
  let toml = "";
  for (const [name, spec] of Object.entries(servers)) {
    toml += `[mcp_servers.${name}]\n`;
    const s = spec as { command?: string; url?: string; env?: Record<string, string> };
    if (s.command) toml += `command = "${s.command}"\n`;
    if (s.url) toml += `url = "${s.url}"\n`;
    if (s.env) {
      toml += `[mcp_servers.${name}.env]\n`;
      for (const [key, value] of Object.entries(s.env)) toml += `${key} = "${value}"\n`;
    }
  }
  await fs.writeFile(path.join(dir, "config.toml"), toml, "utf8");
}

function startMcpEndpoint(): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        try {
          const parsed = JSON.parse(body) as { method?: string };
          if (parsed.method === "initialize") {
            res.end(JSON.stringify({ jsonrpc: "2.0", id: parsed.id, result: { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "fake-mcp", version: "1.0.0" } } }));
          } else if (parsed.method === "tools/list") {
            res.end(JSON.stringify({ jsonrpc: "2.0", id: parsed.id, result: { tools: [{ name: "read_file" }, { name: "search_web" }] } }));
          } else if (parsed.method === "tools/call") {
            // A business tool invocation would be a contract violation.
            res.end(JSON.stringify({ jsonrpc: "2.0", id: parsed.id, error: { code: -32001, message: "tools/call is never invoked by LMS-AiPanel" } }));
          } else {
            res.end(JSON.stringify({ jsonrpc: "2.0", id: parsed.id, result: {} }));
          }
        } catch {
          res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32700, message: "parse error" } }));
        }
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      resolve({ port, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

describe("MCP adapter three-layer inspection", () => {
  it("automatic collection reads config and existing runtime state but never starts a server", async () => {
    await writeCodexConfig({
      files: { command: "/usr/bin/fake-mcp-server" },
      remote: { url: "http://127.0.0.1:1" }
    });
    const result = await new McpAdapter().collect(CTX);

    const filesServer = result.nodes.find((n) => n.label === "files")!;
    expect(filesServer.properties.configLayer).toBe("configured");
    expect(filesServer.properties.runtimeLayer).toBe("stopped"); // no existing process
    expect(filesServer.properties.capabilityVerified).toBe(false);
    expect((filesServer.properties.evidence as string[]).some((e) => e.includes("no existing process"))).toBe(true);

    const remoteServer = result.nodes.find((n) => n.label === "remote")!;
    expect(remoteServer.properties.runtimeLayer).toBe("stopped");
    expect(remoteServer.properties.reachable).toBe(false);
    // configured / running / reachable / capability-verified remain distinct.
    expect(remoteServer.properties.capabilityVerified).toBe(false);
  });

  it("a live endpoint is reported reachable without a capability handshake", async () => {
    const fake = await startMcpEndpoint();
    await writeCodexConfig({ live: { url: `http://127.0.0.1:${fake.port}` } });
    const result = await new McpAdapter().collect(CTX);
    await fake.close();

    const live = result.nodes.find((n) => n.label === "live")!;
    expect(live.properties.runtimeLayer).toBe("running");
    expect(live.properties.reachable).toBe(true);
    expect(live.properties.capabilityVerified).toBe(false);
  });

  it("capability inspection is manual and only retains capability metadata", async () => {
    const fake = await startMcpEndpoint();
    const adapter = new McpAdapter();
    const spec = { url: `http://127.0.0.1:${fake.port}` };

    const outcome = await adapter.verifyCapabilities("live", spec, 1_000);
    await fake.close();

    expect(outcome.ok).toBe(true);
    expect(outcome.capabilities.serverInfo).toEqual({ name: "fake-mcp", version: "1.0.0" });
    expect(outcome.capabilities.tools.sort()).toEqual(["read_file", "search_web"]);
    // Only capability metadata: no env values, no business results.
    expect(JSON.stringify(outcome)).not.toMatch(/tools\/call|read_file.*result|SECRET|ENV_/);
  });

  it("stdio servers refuse automatic handshakes (explicit manual command required)", async () => {
    const adapter = new McpAdapter();
    const outcome = await adapter.verifyCapabilities("files", { command: "/usr/bin/x" }, 1_000);
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toContain("explicit manual command");
  });

  it("an unavailable installation does not fail the adapter", async () => {
    await writeCodexConfig({ nothing: { command: "/no/such/binary" } });
    const result = await new McpAdapter().collect(CTX);
    expect(result.nodes.length).toBeGreaterThan(0);
    const server = result.nodes.find((n) => n.label === "nothing")!;
    expect(server.properties.runtimeLayer).toBe("stopped");
  });
});