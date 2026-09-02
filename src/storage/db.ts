import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export type Db = DatabaseSync;

export interface MigrationRecord {
  version: string;
  applied_at: string;
}

/**
 * Opens (or creates) the SQLite database at `databasePath`.
 * Uses the Node built-in `node:sqlite` driver so no external sqlite3 CLI
 * or native dependency is required.
 */
export function openDatabase(databasePath: string): Db {
  const db = new DatabaseSync(databasePath);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  return db;
}

/**
 * Applies every `*.sql` file in `migrationsDir` that has not been applied yet.
 * Tracks applied versions in the `schema_migrations` table. Re-running is
 * idempotent: applied files are skipped, and `CREATE TABLE IF NOT EXISTS`
 * statements make a partial-failure retry safe.
 */
export async function applyMigrations(db: Db, migrationsDir: string): Promise<string[]> {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);

  const entries = await fs.readdir(migrationsDir);
  const files = entries.filter((name) => name.endsWith(".sql")).sort();
  const applied = new Set(
    (db.prepare("SELECT version FROM schema_migrations").all() as Array<{ version: string }>).map(
      (row) => row.version
    )
  );

  const appliedNow: string[] = [];
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = await fs.readFile(path.join(migrationsDir, file), "utf8");
    db.exec(sql);
    db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(
      file,
      new Date().toISOString()
    );
    appliedNow.push(file);
  }
  return appliedNow;
}

export function closeDatabase(db: Db): void {
  try {
    db.close();
  } catch {
    // already closed
  }
}