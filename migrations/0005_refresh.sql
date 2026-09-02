-- RefreshRun persistence (issue #5): manual refresh progress and SSE
-- recovery. Idempotent by design.
CREATE TABLE IF NOT EXISTS refresh_runs (
  run_id TEXT PRIMARY KEY,
  host_id TEXT NOT NULL,
  status TEXT NOT NULL,              -- pending | running | completed | failed | cancelled
  started_at TEXT NOT NULL,
  finished_at TEXT,
  snapshot_version INTEGER,
  error TEXT,
  adapter_events_json TEXT NOT NULL  -- ordered [{adapterId,status,finishedAt?}]
);