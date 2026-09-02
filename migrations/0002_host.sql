-- Host identity: one stable local host record. Idempotent by design.
CREATE TABLE IF NOT EXISTS host (
  host_id TEXT PRIMARY KEY,
  host_name TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT 'local',
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);