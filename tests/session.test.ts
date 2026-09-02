import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/server/app";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "lms-session-test-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

const WRITE_PAYLOAD = {
  kind: "match",
  adapterId: "omlx",
  resourceType: "runtime",
  stableKey: "test-1",
  label: "oMLX test-1"
};

describe("local session + origin guard", () => {
  it("read-only GET endpoints work without a session", async () => {
    const built = await buildApp({ dataDir: path.join(tmpDir, "ro"), adapters: [], schedulerAutoStart: false });
    const health = await built.app.inject({ method: "GET", url: "/api/health" });
    expect(health.json().ok).toBe(true);
    const host = await built.app.inject({ method: "GET", url: "/api/host" });
    expect(host.json().ok).toBe(true);
    await built.close();
  });

  it("write endpoints reject missing sessions", async () => {
    const built = await buildApp({ dataDir: path.join(tmpDir, "missing"), adapters: [], schedulerAutoStart: false });
    const res = await built.app.inject({ method: "POST", url: "/api/registry", payload: WRITE_PAYLOAD });
    expect(res.json().ok).toBe(false);
    expect(res.json().error.code).toBe("WRITE_GUARD_REJECTED");
    await built.close();
  });

  it("a valid session authorizes writes from an allowed origin", async () => {
    const built = await buildApp({ dataDir: path.join(tmpDir, "valid"), adapters: [], schedulerAutoStart: false });

    const issue = await built.app.inject({
      method: "POST",
      url: "/api/session",
      headers: { origin: "http://127.0.0.1:5173" }
    });
    const { token, expiresAt } = issue.json().data;
    expect(token).toMatch(/^sess-/);
    expect(new Date(expiresAt).getTime()).toBeGreaterThan(Date.now());

    const write = await built.app.inject({
      method: "POST",
      url: "/api/registry",
      headers: { origin: "http://127.0.0.1:5173", "x-lms-session": token },
      payload: WRITE_PAYLOAD
    });
    expect(write.json().ok).toBe(true);
    await built.close();
  });

  it("expired sessions are rejected", async () => {
    const built = await buildApp({
      dataDir: path.join(tmpDir, "expired"),
      adapters: [],
      schedulerAutoStart: false,
      sessionTtlMs: 1
    });
    const issue = await built.app.inject({
      method: "POST",
      url: "/api/session",
      headers: { origin: "http://127.0.0.1:5173" }
    });
    const token = issue.json().data.token;
    await new Promise((resolve) => setTimeout(resolve, 15));

    const write = await built.app.inject({
      method: "POST",
      url: "/api/registry",
      headers: { origin: "http://127.0.0.1:5173", "x-lms-session": token },
      payload: WRITE_PAYLOAD
    });
    expect(write.json().error.code).toBe("WRITE_GUARD_REJECTED");
    await built.close();
  });

  it("disallowed origins cannot execute writes even with a valid session", async () => {
    const built = await buildApp({ dataDir: path.join(tmpDir, "origin"), adapters: [], schedulerAutoStart: false });

    // Issue a session from the allowed origin.
    const issue = await built.app.inject({
      method: "POST",
      url: "/api/session",
      headers: { origin: "http://127.0.0.1:5173" }
    });
    const token = issue.json().data.token;

    // Session issuance from a foreign origin is rejected outright.
    const foreignIssue = await built.app.inject({
      method: "POST",
      url: "/api/session",
      headers: { origin: "https://evil.example.com" }
    });
    expect(foreignIssue.json().error.code).toBe("ORIGIN_DISALLOWED");

    // A cross-origin write with a valid token is still rejected.
    const write = await built.app.inject({
      method: "POST",
      url: "/api/registry",
      headers: { origin: "https://evil.example.com", "x-lms-session": token },
      payload: WRITE_PAYLOAD
    });
    expect(write.json().error.code).toBe("WRITE_GUARD_REJECTED");
    await built.close();
  });

  it("CLI path: no Origin header + valid session is the explicit supported path", async () => {
    const built = await buildApp({ dataDir: path.join(tmpDir, "cli"), adapters: [], schedulerAutoStart: false });
    const issue = await built.app.inject({ method: "POST", url: "/api/session" });
    const token = issue.json().data.token;

    // CLI: no Origin header, session header present — allowed.
    const write = await built.app.inject({
      method: "POST",
      url: "/api/registry",
      headers: { "x-lms-session": token },
      payload: WRITE_PAYLOAD
    });
    expect(write.json().ok).toBe(true);
    await built.close();
  });

  it("session status reflects validity and revocation", async () => {
    const built = await buildApp({ dataDir: path.join(tmpDir, "status"), adapters: [], schedulerAutoStart: false });
    const issue = await built.app.inject({ method: "POST", url: "/api/session" });
    const token = issue.json().data.token;

    const status = await built.app.inject({
      method: "GET",
      url: "/api/session/status",
      headers: { "x-lms-session": token }
    });
    expect(status.json().data.valid).toBe(true);

    await built.app.inject({
      method: "POST",
      url: "/api/session/revoke",
      headers: { "x-lms-session": token }
    });
    const after = await built.app.inject({
      method: "GET",
      url: "/api/session/status",
      headers: { "x-lms-session": token }
    });
    expect(after.json().data.valid).toBe(false);
    await built.close();
  });
});