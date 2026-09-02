-- ActionRun persistence (issue #17): executable action lifecycle with
-- verification evidence. Idempotent by design.
CREATE TABLE IF NOT EXISTS action_runs (
  run_id TEXT PRIMARY KEY,
  action_plan_id TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  adapter_id TEXT NOT NULL,
  action TEXT NOT NULL,
  status TEXT NOT NULL,              -- planned | confirmed | executing | succeeded | failed | rolled_back
  started_at TEXT NOT NULL,
  finished_at TEXT,
  evidence_json TEXT NOT NULL,
  error TEXT,
  requires_rollback INTEGER NOT NULL DEFAULT 0,
  rollback_state_json TEXT
);