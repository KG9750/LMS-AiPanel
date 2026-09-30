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

  // Upgrade legacy snapshots table if version column is missing from pre-v0.1 dev iterations
  const snapshotCols = db.prepare("PRAGMA table_info(snapshots)").all() as Array<{ name: string }>;
  const hasVersion = snapshotCols.some((col) => col.name === "version");
  if (snapshotCols.length > 0 && !hasVersion) {
    db.exec(`
      DROP TABLE snapshots;
      CREATE TABLE snapshots (
        version INTEGER PRIMARY KEY,
        host_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        nodes_json TEXT NOT NULL,
        edges_json TEXT NOT NULL,
        adapter_runs_json TEXT NOT NULL,
        drift_json TEXT NOT NULL
      );
    `);
  }

  return { db, paths, appliedMigrations };
}