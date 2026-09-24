#!/usr/bin/env node
/**
 * LMS-AiPanel management CLI (issue #22).
 *
 * Packages the built API + UI as one localhost service and provides:
 *
 *   lms-aipanel install   — install a LaunchAgent (macOS) or write a
 *                           systemd-less supervisor script (other platforms)
 *   lms-aipanel start     — start the service
 *   lms-aipanel stop      — stop the service (removes the live endpoint)
 *   lms-aipanel status    — verify process AND health endpoint
 *   lms-aipanel logs      — tail the service log
 *   lms-aipanel upgrade   — rebuild + restart, preserving runtime storage
 *
 * Runtime data always lives outside the repository
 * (LMS_AIPANEL_DATA_DIR or ~/Library/Application Support/LMS-AiPanel).
 */
import { spawn } from "node:child_process";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// dist/cli/index.js -> dist -> repo root (contains package.json).
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const HOST = process.env.LMS_AIPANEL_HOST ?? "127.0.0.1";
const PORT = Number(process.env.LMS_AIPANEL_PORT ?? 3777);
const HEALTH_URL = `http://${HOST}:${PORT}/api/health`;

function homeDir(): string {
  return process.env.HOME || os.homedir();
}

function dataRoot(): string {
  const override = process.env.LMS_AIPANEL_DATA_DIR;
  if (override && override.trim()) return override;
  return path.join(homeDir(), "Library", "Application Support", "LMS-AiPanel");
}

function launchAgentPlistPath(): string {
  return path.join(homeDir(), "Library", "LaunchAgents", "com.lms-aipanel.service.plist");
}

function guiDomain(): string {
  const uid = typeof process.getuid === "function" ? process.getuid() : 501;
  return `gui/${uid}`;
}

function buildPlist(): string {
  const nodeBin = process.execPath;
  const serverEntry = path.join(ROOT, "dist", "server", "index.js");
  const logDir = path.join(dataRoot(), "logs");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.lms-aipanel.service</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodeBin}</string>
    <string>${serverEntry}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>LMS_AIPANEL_HOST</key><string>${HOST}</string>
    <key>LMS_AIPANEL_PORT</key><string>${String(PORT)}</string>
    <key>LMS_AIPANEL_DATA_DIR</key><string>${dataRoot()}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${path.join(logDir, "service.log")}</string>
  <key>StandardErrorPath</key><string>${path.join(logDir, "service.err.log")}</string>
  <key>WorkingDirectory</key><string>${ROOT}</string>
</dict>
</plist>
`;
}

async function ensureLogDir(): Promise<string> {
  const logDir = path.join(dataRoot(), "logs");
  await fs.mkdir(logDir, { recursive: true });
  return logDir;
}

function isMac(): boolean {
  return process.platform === "darwin";
}

function run(cmd: string, args: string[]): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(cmd, args, { encoding: "utf8", timeout: 60_000 });
  return { status: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

async function fetchHealth(timeoutMs = 2_000): Promise<{ ok: boolean; body?: string; error?: string }> {
  try {
    const response = await fetch(HEALTH_URL, { signal: AbortSignal.timeout(timeoutMs) });
    return { ok: response.ok, body: await response.text() };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** Status verifies process AND health endpoint, not just metadata. */
async function status(verbose = false): Promise<{ running: boolean; pid?: number; healthy: boolean; health?: string }> {
  let pid: number | undefined;
  let running = false;

  if (isMac()) {
    const plist = launchAgentPlistPath();
    const exists = await fs.access(plist).then(() => true).catch(() => false);
    if (exists) {
      const out = run("launchctl", ["print", `${guiDomain()}/com.lms-aipanel.service`]);
      if (out.status === 0) {
        running = true;
        const pidMatch = out.stdout.match(/pid\s*=\s*(\d+)/);
        if (pidMatch) pid = Number(pidMatch[1]);
      }
    }
  }

  if (!running) {
    // Check the pid file first, then fallback to pgrep or listening socket.
    try {
      const pidFile = path.join(dataRoot(), "logs", "service.pid");
      const saved = Number((await fs.readFile(pidFile, "utf8")).trim());
      if (saved > 0) {
        const alive = run("sh", ["-c", `kill -0 ${saved} 2>/dev/null && echo alive || true`]);
        if (alive.stdout.trim() === "alive") {
          pid = saved;
          running = true;
        }
      }
    } catch {
      // no pid file yet
    }
  }

  if (!running) {
    const serverEntry = path.join(ROOT, "dist", "server", "index.js");
    const matches = run("pgrep", ["-f", serverEntry]);
    for (const line of matches.stdout.trim().split("\n")) {
      const p = Number(line.trim());
      if (p > 0 && p !== process.pid) {
        pid = p;
        running = true;
        break;
      }
    }
  }

  if (!running) {
    const out = run("sh", ["-c", `ss -tlnp 2>/dev/null | grep -q ':${PORT} ' && echo listening || true`]);
    running = out.stdout.trim() === "listening";
  }

  const health = await fetchHealth();
  if (verbose) {
    console.log(`process running: ${running}${pid ? ` (pid ${pid})` : ""}`);
    console.log(`health endpoint: ${health.ok ? "healthy" : "unhealthy"} ${health.error ? `(${health.error})` : ""}`);
  }
  return { running, pid, healthy: health.ok, health: health.body };
}

async function cmdInstall(): Promise<void> {
  if (!isMac()) {
    throw new Error(
      "install requires macOS (LaunchAgent). On other platforms use: node dist/server/index.js (run manually) or your own supervisor."
    );
  }
  const plistPath = launchAgentPlistPath();
  await ensureLogDir();
  await fs.writeFile(plistPath, buildPlist(), "utf8");
  const out = run("launchctl", ["load", plistPath]);
  if (out.status !== 0) {
    // Modern macOS prefers bootstrap; fall back with a warning.
    const boot = run("launchctl", ["bootstrap", guiDomain(), plistPath]);
    if (boot.status !== 0) {
      console.error(`install: launchctl failed: ${out.stderr}${boot.stderr}`);
      process.exitCode = 1;
      return;
    }
  }
  console.log(`installed LaunchAgent: ${plistPath}`);
  await cmdStatus(true);
}

async function cmdStart(): Promise<void> {
  let startedViaLaunchctl = false;
  if (isMac()) {
    const plistPath = launchAgentPlistPath();
    const exists = await fs.access(plistPath).then(() => true).catch(() => false);
    if (exists) {
      const kick = run("launchctl", ["kickstart", "-k", `${guiDomain()}/com.lms-aipanel.service`]);
      if (kick.status === 0) {
        startedViaLaunchctl = true;
      }
    }
  }

  if (!startedViaLaunchctl) {
    // Spawn the server directly with detached:true (new process group/session).
    const logDir = await ensureLogDir();
    const serverEntry = path.join(ROOT, "dist", "server", "index.js");
    const env = {
      ...process.env,
      LMS_AIPANEL_HOST: HOST,
      LMS_AIPANEL_PORT: String(PORT),
      LMS_AIPANEL_DATA_DIR: dataRoot()
    };
    const child = spawn(process.execPath, [serverEntry], {
      detached: true,
      stdio: ["ignore", "ignore", "ignore"],
      env
    });
    child.on("error", (error) => {
      console.error(`start: spawn failed: ${error.message}`);
    });
    child.on("exit", (code, signal) => {
      if (code !== 0 || signal) {
        console.error(`start: server exited early (code=${code} signal=${signal})`);
      }
    });
    child.unref();
    await fs.writeFile(path.join(logDir, "service.pid"), String(child.pid ?? ""), "utf8");
  }
  console.log("start requested; waiting for health...");
  for (let i = 0; i < 20; i++) {
    const health = await fetchHealth();
    if (health.ok) {
      console.log("service is up:", health.body?.slice(0, 120));
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  console.error("start: health endpoint did not come up in time");
  process.exitCode = 1;
}

async function cmdStop(): Promise<void> {
  if (isMac()) {
    const plist = launchAgentPlistPath();
    const exists = await fs.access(plist).then(() => true).catch(() => false);
    if (exists) {
      const out = run("launchctl", ["bootout", `${guiDomain()}/com.lms-aipanel.service`]);
      if (out.status !== 0) {
        run("launchctl", ["unload", plist]);
      }
    }
  }

  // Also stop any pid-file or pgrep-managed instance (works on macOS fallback and other OS)
  const pidFile = path.join(dataRoot(), "logs", "service.pid");
  let killed = false;
  try {
    const pid = Number((await fs.readFile(pidFile, "utf8")).trim());
    if (pid > 0) {
      try {
        process.kill(pid, "SIGTERM");
        killed = true;
      } catch {
        // process already gone
      }
    }
  } catch {
    // no pid file
  }
  if (!killed) {
    const serverEntry = path.join(ROOT, "dist", "server", "index.js");
    const matches = run("pgrep", ["-f", serverEntry]);
    for (const line of matches.stdout.trim().split("\n")) {
      const pid = Number(line.trim());
      if (pid > 0 && pid !== process.pid) {
        try {
          process.kill(pid, "SIGTERM");
        } catch {
          // already gone
        }
      }
    }
  }

  // Stop must remove the live endpoint and report the final state.
  for (let i = 0; i < 20; i++) {
    const health = await fetchHealth(500);
    if (!health.ok) {
      console.log("stopped: live endpoint removed");
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  console.error("stop: endpoint still responding after 6s");
  process.exitCode = 1;
}

async function cmdStatus(verbose = true): Promise<void> {
  const state = await status(verbose);
  if (!state.running || !state.healthy) {
    console.error("service is NOT fully running (process/health check failed)");
    process.exitCode = 1;
    return;
  }
  console.log("service OK");
}

async function cmdLogs(): Promise<void> {
  const logDir = await ensureLogDir();
  const logFile = path.join(logDir, "service.log");
  const errFile = path.join(logDir, "service.err.log");
  console.log(`log dir: ${logDir}`);
  try {
    const out = await fs.readFile(logFile, "utf8");
    console.log(out.slice(-4000));
  } catch {
    console.log("(no stdout log yet)");
  }
  try {
    const err = await fs.readFile(errFile, "utf8");
    if (err.trim()) console.error(`--- stderr ---\n${err.slice(-2000)}`);
  } catch {
    // no stderr yet
  }
}

/** Upgrade: rebuild + restart, preserving runtime storage. */
async function cmdUpgrade(): Promise<void> {
  const state = await status(false);
  const wasRunning = state.running && state.healthy;

  console.log("building production artifacts...");
  const build = run("npm", ["run", "build"]);
  if (build.status !== 0) {
    console.error(`upgrade: build failed\n${build.stderr}`);
    process.exitCode = 1;
    return;
  }

  if (wasRunning) {
    console.log("restarting service...");
    await cmdStop();
    await cmdStart();
  }
  console.log("upgrade complete; runtime storage preserved at", dataRoot());
}

async function main(): Promise<void> {
  const command = process.argv[2];
  switch (command) {
    case "install":
      await cmdInstall();
      break;
    case "start":
      await cmdStart();
      break;
    case "stop":
      await cmdStop();
      break;
    case "status":
      await cmdStatus(true);
      break;
    case "logs":
      await cmdLogs();
      break;
    case "upgrade":
      await cmdUpgrade();
      break;
    default:
      console.log(`LMS-AiPanel service CLI

Usage:
  lms-aipanel install    install the localhost LaunchAgent service
  lms-aipanel start      start the service
  lms-aipanel stop       stop the service
  lms-aipanel status     verify process + health endpoint
  lms-aipanel logs       show service logs (${path.join(dataRoot(), "logs")})
  lms-aipanel upgrade    rebuild + restart, preserving runtime storage

Runtime data: ${dataRoot()} (outside the repository)
`);
      process.exitCode = command ? 2 : 0;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});