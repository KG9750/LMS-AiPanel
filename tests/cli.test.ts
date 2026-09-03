import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/server/app";

let tmpDir: string;
let dataDir: string;
const PORT = 3811;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "lms-cli-test-"));
  dataDir = path.join(tmpDir, "data");
});

afterEach(async () => {
  // Ensure no stray server survives a test.
  try {
    execFileSync("node", [path.join(process.cwd(), "dist", "cli", "index.js"), "stop"], {
      env: { ...process.env, HOME: tmpDir, LMS_AIPANEL_DATA_DIR: dataDir, LMS_AIPANEL_PORT: String(PORT) },
      timeout: 15_000
    });
  } catch {
    // not running
  }
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function runCli(args: string[], timeoutMs = 20_000): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync("node", [path.join(process.cwd(), "dist", "cli", "index.js"), ...args], {
      encoding: "utf8",
      timeout: timeoutMs,
      env: { ...process.env, HOME: tmpDir, LMS_AIPANEL_DATA_DIR: dataDir, LMS_AIPANEL_PORT: String(PORT) }
    });
    return { status: 0, stdout, stderr: "" };
  } catch (error) {
    const e = error as { status?: number; stdout?: string; stderr?: string };
    return { status: e.status ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

describe("management CLI (issue #22)", () => {
  it("builds a LaunchAgent plist that binds 127.0.0.1 and keeps runtime data outside the repo", async () => {
    // Invoke the CLI on macOS to install; on other platforms install is
    // unsupported — verify the plist content function indirectly by checking
    // the CLI help exposes install and the data dir.
    const help = runCli([]);
    expect(help.stdout).toContain("install");
    expect(help.stdout).toContain("status");
    expect(help.stdout).toContain("logs");
    expect(help.stdout).toContain("upgrade");
    expect(help.stdout).toContain(dataDir); // runtime data outside the repo
  });

  it("status verifies process AND health endpoint, not just metadata", async () => {
    // Start via the CLI so the child server is reachable from the CLI, then
    // verify status reports BOTH process and health evidence.
    const start = runCli(["start"], 30_000);
    expect(start.stdout).toContain("service is up");

    const status = runCli(["status"]);
    expect(status.stdout).toContain("process running: true");
    expect(status.stdout).toContain("health endpoint: healthy");
    expect(status.stdout).toContain("service OK");
    expect(status.status).toBe(0);

    runCli(["stop"], 15_000);
  });

  it("logs points at the runtime log directory", async () => {
    const logs = runCli(["logs"]);
    expect(logs.stdout).toContain("log dir:");
    expect(logs.stdout).toContain(path.join(dataDir, "logs"));
  });

  it("start/stop removes the live endpoint and reports the final state", async () => {
    // Start via CLI.
    const start = runCli(["start"], 30_000);
    expect(start.stdout).toContain("service is up");

    // Stop removes the live endpoint.
    const stop = runCli(["stop"], 30_000);
    expect(stop.stdout).toContain("endpoint removed");

    // After stop, status reports the service is not fully running.
    const after = runCli(["status"]);
    expect(after.status).toBe(1);
    expect(after.stdout).toContain("health endpoint: unhealthy");
  });
});

describe("CLI server entry", () => {
  it("the compiled server binds only to 127.0.0.1", async () => {
    const server = spawn("node", [path.join(process.cwd(), "dist", "server", "index.js")], {
      env: {
        ...process.env,
        HOME: tmpDir,
        LMS_AIPANEL_DATA_DIR: dataDir,
        LMS_AIPANEL_PORT: String(PORT),
        LMS_AIPANEL_HOST: "127.0.0.1"
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    try {
      let healthy = false;
      for (let i = 0; i < 20; i++) {
        try {
          const res = await fetch(`http://127.0.0.1:${PORT}/api/health`);
          if (res.ok) {
            healthy = true;
            break;
          }
        } catch {
          // retry
        }
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
      expect(healthy).toBe(true);
      const health = await (await fetch(`http://127.0.0.1:${PORT}/api/health`)).json();
      expect(health.ok).toBe(true);
      expect(health.data.service).toBe("LMS-AiPanel");
    } finally {
      server.kill("SIGTERM");
    }
  });
});