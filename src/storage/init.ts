import fs from "node:fs/promises";
import { applyMigrations, openDatabase, type Db } from "./db";
import { getAppPaths, type AppPaths } from "./paths";

export interface InitializedStorage {
  db: Db;
  paths: AppPaths;
  appliedMigrations: string[];
}

/**
 * Creates the runtime data directories, opens the SQLite database, and applies
 * pending migrations. Idempotent: safe to call on every service start and on
 * re-initialized storage.
 */
export async function ensureStorage(): Promise<InitializedStorage> {
  const paths = getAppPaths();
  await Promise.all([
    fs.mkdir(paths.storage, { recursive: true }),
    fs.mkdir(paths.backups, { recursive: true }),
    fs.mkdir(paths.logs, { recursive: true })
  ]);

  const db = openDatabase(paths.databasePath);
  const appliedMigrations = await applyMigrations(db, paths.migrationsDir);
  return { db, paths, appliedMigrations };
}