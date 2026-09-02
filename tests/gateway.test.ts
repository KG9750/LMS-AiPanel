import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/server/app";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "lms-gateway-test-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

let upstreamRequests: Array<{ url: string; body: string }> = [];

function startUpstream(): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        upstreamRequests.push({ url: req.url ?? "", body });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            id: "chatcmpl-test",
            choices: [{ message: { role: "assistant", content: "hello from upstream" } }],
            usage: { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19 }
          })
        );
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      resolve({ port, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

describe("observability gateway", () => {
  it("routes traffic to the selected managed endpoint and records attribution metrics only", async () => {
    const upstream = await startUpstream();
    const built = await buildApp({ dataDir: path.join(tmpDir, "gw"), adapters: [], schedulerAutoStart: false });

    // Register one explicitly configured client.
    const issue = await built.app.inject({ method: "POST", url: "/api/session" });
    const token = issue.json().data.token;
    const registered = await built.app.inject({
      method: "POST",
      url: "/api/gateway/clients",
      headers: { "x-lms-session": token },
      payload: { clientName: "claude-code", model: "qwen2.5-7b", targetEndpoint: `http://127.0.0.1:${upstream.port}` }
    });
    expect(registered.json().ok).toBe(true);

    // A real test client request through the gateway.
    const proxied = await built.app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { "x-lms-client": "claude-code" },
      payload: { model: "qwen2.5-7b", messages: [{ role: "user", content: "ping" }] }
    });
    expect(proxied.statusCode).toBe(200);
    const forwarded = proxied.json();
    expect(forwarded.choices[0].message.content).toBe("hello from upstream");

    // The upstream really received the traffic.
    expect(upstreamRequests).toHaveLength(1);
    expect(upstreamRequests[0].url).toBe("/v1/chat/completions");

    // Gateway report: attributed traffic with metrics, no bodies.
    const report = await built.app.inject({ method: "GET", url: "/api/gateway" });
    const data = report.json().data;
    expect(data.clients).toHaveLength(1);
    expect(data.coverage.attributed.requests).toBe(1);
    expect(data.coverage.attributed.tokensOut).toBe(7);
    expect(data.coverage.attributed.tokensIn).toBe(12);
    expect(data.recent[0].latencyMs).toBeGreaterThanOrEqual(0);
    // No prompt/response/chat text anywhere in the report.
    expect(JSON.stringify(data)).not.toContain("ping");
    expect(JSON.stringify(data)).not.toContain("hello from upstream");

    await upstream.close();
    await built.close();
  });

  it("keeps provider totals separate; direct traffic appears as unattributed coverage", async () => {
    const upstream = await startUpstream();
    const built = await buildApp({ dataDir: path.join(tmpDir, "gw2"), adapters: [], schedulerAutoStart: false });
    const issue = await built.app.inject({ method: "POST", url: "/api/session" });
    const token = issue.json().data.token;
    await built.app.inject({
      method: "POST",
      url: "/api/gateway/clients",
      headers: { "x-lms-session": token },
      payload: { clientName: "cli", model: "m", targetEndpoint: `http://127.0.0.1:${upstream.port}` }
    });

    // Attributed request.
    await built.app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { "x-lms-client": "cli" },
      payload: { model: "m", messages: [{ role: "user", content: "a" }] }
    });
    // Unattributed request (no client header).
    await built.app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: { model: "m", messages: [{ role: "user", content: "b" }] }
    });

    const report = await built.app.inject({ method: "GET", url: "/api/gateway" });
    const coverage = report.json().data.coverage;
    expect(coverage.attributed.requests).toBe(1);
    expect(coverage.unattributed.requests).toBe(1);
    // Provider totals = attributed + unattributed (no double counting).
    expect(coverage.providerTotals.requests).toBe(coverage.attributed.requests + coverage.unattributed.requests);

    await upstream.close();
    await built.close();
  });

  it("rejects requests without an enabled matching client", async () => {
    const built = await buildApp({ dataDir: path.join(tmpDir, "gw3"), adapters: [], schedulerAutoStart: false });
    const res = await built.app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: { model: "x", messages: [] }
    });
    expect(res.statusCode).toBe(404);
    await built.close();
  });
});