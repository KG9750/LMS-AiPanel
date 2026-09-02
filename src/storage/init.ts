import fs from "node:fs/promises";
import path from "node:path";
import { execa } from "execa";
import { getAppPaths } from "./paths";

export interface StorageStatus {
  ready: boolean;
  error?: string;
}

export async function ensureStorage(): Promise<StorageStatus> {
  const appPaths = getAppPaths();
  await Promise.all([
    fs.mkdir(appPaths.storage, { recursive: true }),
    fs.mkdir(appPaths.backups, { recursive: true }),
    fs.mkdir(appPaths.logs, { recursive: true })
  ]);

  try {
    for (const migration of ["0001_initial.sql", "0002_snapshots.sql"]) {
      const migrationPath = path.join(process.cwd(), "migrations", migration);
      await execa("sqlite3", [appPaths.databasePath, `.read ${migrationPath}`], { timeout: 5_000 });
    }
    return { ready: true };
  } catch (error) {
    return { ready: false, error: error instanceof Error ? error.message : String(error) };
  }
}
