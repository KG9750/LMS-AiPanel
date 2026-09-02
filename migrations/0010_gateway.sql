-- Observability Gateway (issue #12): OpenAI-compatible local proxy with
-- attribution metrics. Idempotent by design.
CREATE TABLE IF NOT EXISTS gateway_clients (
  id TEXT PRIMARY KEY,
  host_id TEXT NOT NULL,
  client_name TEXT NOT NULL,
  model TEXT NOT NULL,
  target_endpoint TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS gateway_requests (
  id TEXT PRIMARY KEY,
  host_id TEXT NOT NULL,
  client_id TEXT,                    -- null = direct/unattributed traffic
  model TEXT,
  status TEXT NOT NULL,              -- ok | error | timeout
  latency_ms INTEGER NOT NULL,
  tokens_in INTEGER,
  tokens_out INTEGER,
  target_endpoint TEXT NOT NULL,
  requested_at TEXT NOT NULL
);