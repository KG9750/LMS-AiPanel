import { nanoid } from "nanoid";
import type { Db } from "./db";

export type ActionRunStatus =
  | "planned"
  | "confirmed"
  | "executing"
  | "succeeded"
  | "failed"
  | "rolled_back";

export interface ActionRunRecord {
  runId: string;
  actionPlanId: string;
  resourceId: string;
  adapterId: string;
  action: string;
  status: ActionRunStatus;
  startedAt: string;
  finishedAt?: string;
  evidence: string[];
  error?: string;
  requiresRollback: boolean;
  rollbackState?: Record<string, unknown>;
}

interface ActionRunRow {
  run_id: string;
  action_plan_id: string;
  resource_id: string;
  adapter_id: string;
  action: string;
  status: ActionRunStatus;
  started_at: string;
  finished_at: string | null;
  evidence_json: string;
  error: string | null;
  requires_rollback: number;
  rollback_state_json: string | null;
}

function toRecord(row: ActionRunRow): ActionRunRecord {
  return {
    runId: row.run_id,
    actionPlanId: row.action_plan_id,
    resourceId: row.resource_id,
    adapterId: row.adapter_id,
    action: row.action,
    status: row.status,
    startedAt: row.started_at,
    finishedAt: row.finished_at ?? undefined,
    evidence: JSON.parse(row.evidence_json),
    error: row.error ?? undefined,
    requiresRollback: row.requires_rollback === 1,
    rollbackState: row.rollback_state_json ? JSON.parse(row.rollback_state_json) : undefined
  };
}

export class ActionRunStore {
  constructor(private readonly db: Db) {}

  create(input: Omit<ActionRunRecord, "runId" | "startedAt" | "status"> & { status?: ActionRunStatus }): ActionRunRecord {
    const run: ActionRunRecord = {
      runId: `action:${nanoid(12)}`,
      status: input.status ?? "planned",
      startedAt: new Date().toISOString(),
      ...input
    };
    this.db
      .prepare(
        `INSERT INTO action_runs
         (run_id, action_plan_id, resource_id, adapter_id, action, status, started_at, evidence_json, requires_rollback, rollback_state_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        run.runId,
        run.actionPlanId,
        run.resourceId,
        run.adapterId,
        run.action,
        run.status,
        run.startedAt,
        JSON.stringify(run.evidence),
        run.requiresRollback ? 1 : 0,
        run.rollbackState ? JSON.stringify(run.rollbackState) : null
      );
    return run;
  }

  get(runId: string): ActionRunRecord | undefined {
    const row = this.db.prepare("SELECT * FROM action_runs WHERE run_id = ?").get(runId) as unknown as
      | ActionRunRow
      | undefined;
    return row ? toRecord(row) : undefined;
  }

  list(limit = 50): ActionRunRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM action_runs ORDER BY started_at DESC LIMIT ?")
      .all(limit) as unknown as ActionRunRow[];
    return rows.map(toRecord);
  }

  /** Incomplete runs: not terminal — candidates for restart re-verification. */
  incomplete(): ActionRunRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM action_runs WHERE status IN ('planned', 'confirmed', 'executing')
         ORDER BY started_at`
      )
      .all() as unknown as ActionRunRow[];
    return rows.map(toRecord);
  }

  update(
    runId: string,
    patch: Partial<Pick<ActionRunRecord, "status" | "evidence" | "error" | "finishedAt" | "requiresRollback" | "rollbackState">>
  ): ActionRunRecord | undefined {
    const current = this.get(runId);
    if (!current) return undefined;
    const next: ActionRunRecord = {
      ...current,
      status: patch.status ?? current.status,
      evidence: patch.evidence ?? current.evidence,
      error: patch.error !== undefined ? patch.error : current.error,
      finishedAt: patch.finishedAt ?? current.finishedAt,
      requiresRollback: patch.requiresRollback ?? current.requiresRollback,
      rollbackState: patch.rollbackState !== undefined ? patch.rollbackState : current.rollbackState
    };
    this.db
      .prepare(
        `UPDATE action_runs SET
           status = ?, evidence_json = ?, error = ?, finished_at = ?,
           requires_rollback = ?, rollback_state_json = ?
         WHERE run_id = ?`
      )
      .run(
        next.status,
        JSON.stringify(next.evidence),
        next.error ?? null,
        next.finishedAt ?? null,
        next.requiresRollback ? 1 : 0,
        next.rollbackState ? JSON.stringify(next.rollbackState) : null,
        runId
      );
    return next;
  }
}