PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS adapter_runs (
  run_id TEXT PRIMARY KEY,
  adapter_id TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL,
  duration_ms INTEGER,
  error TEXT,
  stale INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS resource_nodes (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  label TEXT NOT NULL,
  state TEXT NOT NULL,
  source_adapter TEXT NOT NULL,
  properties_json TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  graph_schema_version INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS resource_edges (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  target TEXT NOT NULL,
  relation TEXT NOT NULL,
  properties_json TEXT NOT NULL,
  graph_schema_version INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS drift_records (
  id TEXT PRIMARY KEY,
  resource_id TEXT NOT NULL,
  status TEXT NOT NULL,
  configured_json TEXT NOT NULL,
  live_json TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  severity TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  timestamp TEXT NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  resource_id TEXT,
  result TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  backup_id TEXT
);

INSERT OR IGNORE INTO schema_migrations(version, applied_at)
VALUES ('0001_initial', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
