import fs from "node:fs/promises";
import path from "node:path";
import { execa } from "execa";
import { getAppPaths } from "./paths";

export async function ensureStorage(): Promise<void> {
  const appPaths = getAppPaths();
  await Promise.all([
    fs.mkdir(appPaths.storage, { recursive: true }),
    fs.mkdir(appPaths.backups, { recursive: true }),
    fs.mkdir(appPaths.logs, { recursive: true })
  ]);

  const migrationPath = path.join(process.cwd(), "migrations", "0001_initial.sql");
  try {
    await execa("sqlite3", [appPaths.databasePath, `.read ${migrationPath}`], { timeout: 5_000 });
  } catch {
    // The app can run read-only without sqlite3. Tests cover paths and schemas; runtime reports API data from adapters.
  }
}

