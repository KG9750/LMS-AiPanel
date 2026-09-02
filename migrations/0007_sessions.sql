-- Local write session (issue #16): short-lived browser session for the
-- localhost write boundary. Idempotent by design.
CREATE TABLE IF NOT EXISTS local_sessions (
  token TEXT PRIMARY KEY,
  host_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  purpose TEXT NOT NULL DEFAULT 'write'
);