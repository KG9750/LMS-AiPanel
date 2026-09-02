PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS snapshots (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  snapshot_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS snapshots_created_at ON snapshots(created_at DESC);
