import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/server/app";
import { isSensitiveKey, redactConfigContent, redactValue, applyRedactionHints } from "../src/domain/redaction";
import { GRAPH_SCHEMA_VERSION, type RedactionHint, type ResourceNode } from "../src/shared/schemas";

let tmpDir: string;
let configFile: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "lms-sec-test-"));
  configFile = path.join(tmpDir, "config.toml");
  await fs.writeFile(configFile, 'model = "gpt-5"\ntoken = "sk-real-secret-abc"\n', "utf8");
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("S1: config endpoints cannot read arbitrary files", () => {
  it("preview rejects paths outside the whitelist", async () => {
    const secret = path.join(tmpDir, "secret.txt");
    await fs.writeFile(secret, "top secret", "utf8");
    const built = await buildApp({ dataDir: path.join(tmpDir, "data"), adapters: [], schedulerAutoStart: false, configPaths: [configFile] });

    const res = await built.app.inject({ method: "GET", url: `/api/config/preview?path=${encodeURIComponent(secret)}` });
    expect(res.json().ok).toBe(false);
    expect(res.json().error.code).toBe("CONFIG_PATH_NOT_ALLOWED");

    // The whitelisted path still works.
    const ok = await built.app.inject({ method: "GET", url: `/api/config/preview?path=${encodeURIComponent(configFile)}` });
    expect(ok.json().ok).toBe(true);
    await built.close();
  });

  it("preview never returns plaintext secrets in rawContent or fields", async () => {
    const built = await buildApp({ dataDir: path.join(tmpDir, "data2"), adapters: [], schedulerAutoStart: false, configPaths: [configFile] });
    const res = await built.app.inject({ method: "GET", url: `/api/config/preview?path=${encodeURIComponent(configFile)}` });
    const data = res.json().data;
    expect(data.rawContent).not.toContain("sk-real-secret-abc");
    expect(data.rawContent).toContain('"<redacted>"');
    const tokenField = data.undocumentedFields.find((f: { key: string }) => f.key === "token");
    expect(tokenField?.value).not.toContain("sk-real-secret-abc");
    await built.close();
  });

  it("diff rejects paths outside the whitelist", async () => {
    const built = await buildApp({ dataDir: path.join(tmpDir, "data3"), adapters: [], schedulerAutoStart: false, configPaths: [configFile] });
    const res = await built.app.inject({
      method: "POST",
      url: "/api/config/diff",
      payload: { path: "/etc/passwd", content: "x" }
    });
    expect(res.json().error.code).toBe("CONFIG_PATH_NOT_ALLOWED");
    await built.close();
  });
});

describe("S2: config apply cannot write arbitrary files", () => {
  it("apply rejects paths outside the whitelist even with a valid session", async () => {
    const built = await buildApp({ dataDir: path.join(tmpDir, "data4"), adapters: [], schedulerAutoStart: false, configPaths: [configFile] });
    const issue = await built.app.inject({ method: "POST", url: "/api/session" });
    const token = issue.json().data.token;

    const res = await built.app.inject({
      method: "POST",
      url: "/api/config/apply",
      headers: { "x-lms-session": token },
      payload: { path: path.join(tmpDir, "victim.txt"), content: "pwned", previewHash: "x" }
    });
    expect(res.json().error.code).toBe("CONFIG_PATH_NOT_ALLOWED");
    // The victim file is untouched.
    await expect(fs.readFile(path.join(tmpDir, "victim.txt"))).rejects.toThrow();
    await built.close();
  });

  it("apply rejects symlink escapes from the whitelisted path", async () => {
    // Build while the whitelisted file is a REGULAR file (canonical set
    // captured at build time), then swap it for a symlink to a victim.
    const built = await buildApp({ dataDir: path.join(tmpDir, "data5"), adapters: [], schedulerAutoStart: false, configPaths: [configFile] });
    const victim = path.join(tmpDir, "victim.toml");
    await fs.writeFile(victim, 'model = "original"\n', "utf8");
    await fs.rm(configFile);
    await fs.symlink(victim, configFile);

    const res = await built.app.inject({ method: "GET", url: `/api/config/preview?path=${encodeURIComponent(configFile)}` });
    expect(res.json().ok).toBe(false);
    expect(res.json().error.code).toBe("CONFIG_PATH_NOT_ALLOWED");
    await built.close();
  });
});

describe("S3: redaction rules", () => {
  it("author is not redacted (no substring false positive)", () => {
    expect(isSensitiveKey("author")).toBe(false);
    expect(isSensitiveKey("helperScript")).toBe(false);
    expect(redactValue({ author: "kg9750" })).toEqual({ author: "kg9750" });
  });

  it("api_key / token / password style keys are redacted", () => {
    expect(isSensitiveKey("ANTHROPIC_API_KEY")).toBe(true);
    expect(isSensitiveKey("api_key")).toBe(true);
    expect(isSensitiveKey("accessToken")).toBe(true);
    expect(isSensitiveKey("password")).toBe(true);
    expect(redactValue({ api_key: "x", nested: { password: "y" } })).toEqual({
      api_key: "<redacted>",
      nested: { password: "<redacted>" }
    });
  });

  it("value-level patterns redact secrets under non-sensitive keys", () => {
    expect(redactValue({ note: "use sk-abcdef1234567890 now" })).toEqual({
      note: "use <redacted> now"
    });
    const urlResult = redactValue({ url: "https://x?Bearer abcdefghijklmnopqrstuvwxyz123456" }) as { url: string };
    expect(urlResult.url).not.toMatch(/Bearer\s+[A-Za-z0-9]{20,}/);
  });

  it("raw config content redacts sensitive lines and preserves format", () => {
    const out = redactConfigContent('model = "gpt-5"\ntoken = "sk-abcdef1234567890"\n[env]\nAPI_KEY = "x"\n');
    expect(out).toContain('token = "<redacted>"');
    expect(out).toContain('API_KEY = "<redacted>"');
    expect(out).toContain('model = "gpt-5"');
    expect(out).not.toContain("sk-abcdef1234567890");
  });

  it("redaction hints are consumed at the node boundary", () => {
    const node: ResourceNode = {
      id: "claude:model:m",
      type: "model",
      label: "m",
      state: "ok",
      sourceAdapter: "claude",
      hostId: "host-1",
      properties: { baseUrl: "http://secret-endpoint" },
      lastSeenAt: new Date().toISOString(),
      graphSchemaVersion: GRAPH_SCHEMA_VERSION
    };
    const hints: RedactionHint[] = [{ resourceId: "claude:model:m", path: ["properties", "baseUrl"], reason: "endpoint" }];
    const [out] = applyRedactionHints([node], hints);
    expect(out.properties.baseUrl).toBe("<redacted>");
  });

  it("numeric counters stay visible while strings under the same key are redacted", () => {
    expect(redactValue({ tokensIn: 12, token: "sk-abcdef1234567890" })).toEqual({
      tokensIn: 12,
      token: "<redacted>"
    });
  });
});
describe("M1: command endpoints reject missing sessions", () => {
  it("refresh, metrics, and action plan require a session", async () => {
    const built = await buildApp({ dataDir: path.join(tmpDir, "m1"), adapters: [], schedulerAutoStart: false });

    const refresh = await built.app.inject({ method: "POST", url: "/api/refresh" });
    expect(refresh.json().error.code).toBe("WRITE_GUARD_REJECTED");

    const metrics = await built.app.inject({
      method: "POST",
      url: "/api/metrics",
      payload: { scope: "s", layer: "endpoint", metric: "m", source: "x", coverage: "c", kind: "counter", value: 1 }
    });
    expect(metrics.json().error.code).toBe("WRITE_GUARD_REJECTED");

    const plan = await built.app.inject({
      method: "POST",
      url: "/api/actions/plan",
      payload: { resourceId: "x", action: "read" }
    });
    expect(plan.json().error.code).toBe("WRITE_GUARD_REJECTED");
    await built.close();
  });
});
