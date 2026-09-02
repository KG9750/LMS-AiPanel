-- Token and memory time-series with counter epochs (issue #11).
-- Idempotent by design.
CREATE TABLE IF NOT EXISTS metric_samples (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  host_id TEXT NOT NULL,
  scope TEXT NOT NULL,                -- resource id or host scope
  layer TEXT NOT NULL,                -- provider | client | endpoint | model | runtime | process
  metric TEXT NOT NULL,               -- tokens_in | tokens_out | memory_kb | ...
  source TEXT NOT NULL,               -- adapter id or gateway
  coverage TEXT NOT NULL,             -- coverage semantics, e.g. 'endpoint-total' | 'client-attributed'
  kind TEXT NOT NULL,                 -- counter | gauge
  value REAL NOT NULL,
  epoch INTEGER NOT NULL DEFAULT 1,
  sample_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_metric_scope_time ON metric_samples (host_id, scope, metric, sample_at);
CREATE INDEX IF NOT EXISTS idx_metric_layer ON metric_samples (host_id, layer, metric, sample_at);

CREATE TABLE IF NOT EXISTS metric_epochs (
  epoch INTEGER NOT NULL,
  host_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  metric TEXT NOT NULL,
  started_at TEXT NOT NULL,
  reset_reason TEXT,
  PRIMARY KEY (epoch, host_id, scope, metric)
);