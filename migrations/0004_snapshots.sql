-- Snapshot versioning and background scheduler state (issue #4).
-- Idempotent by design.
CREATE TABLE IF NOT EXISTS snapshots (
  version INTEGER PRIMARY KEY,
  host_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  nodes_json TEXT NOT NULL,
  edges_json TEXT NOT NULL,
  adapter_runs_json TEXT NOT NULL,
  drift_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS app_kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);