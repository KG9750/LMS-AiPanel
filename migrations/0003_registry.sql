-- Managed Resource Registry (issue #3): operator intent merged with
-- auto-discovery evidence. Idempotent by design.
CREATE TABLE IF NOT EXISTS registry_entries (
  id TEXT PRIMARY KEY,
  host_id TEXT NOT NULL,
  kind TEXT NOT NULL,                -- 'match' | 'supplement' | 'ignore'
  adapter_id TEXT,
  resource_type TEXT NOT NULL,
  stable_key TEXT NOT NULL,
  label TEXT NOT NULL,
  custom_endpoint TEXT,
  managed INTEGER NOT NULL DEFAULT 0,
  note TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_registry_host ON registry_entries (host_id, adapter_id, resource_type, stable_key);