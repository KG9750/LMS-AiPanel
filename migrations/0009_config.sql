-- Config Center (issue #19): structured config preview/apply evidence.
-- Idempotent by design.
CREATE TABLE IF NOT EXISTS config_backups (
  id TEXT PRIMARY KEY,
  host_id TEXT NOT NULL,
  config_type TEXT NOT NULL,
  file_path TEXT NOT NULL,
  content TEXT NOT NULL,
  file_hash TEXT NOT NULL,
  action_run_id TEXT,
  created_at TEXT NOT NULL
);