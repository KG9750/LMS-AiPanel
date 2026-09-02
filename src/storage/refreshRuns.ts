import { nanoid } from "nanoid";
import type { Db } from "./db";
import type { AdapterRunStatus } from "../shared/schemas";

export interface RefreshAdapterEvent {
  adapterId: string;
  status: "pending" | "running" | "success" | "failed" | "timeout";
  startedAt?: string;
  finishedAt?: string;
}

export interface RefreshRun {
  runId: string;
  hostId: string;
  status: "pending" | "running" | "completed" | "failed" | "cancelled";
  startedAt: string;
  finishedAt?: string;
  snapshotVersion?: number;
  error?: string;
  adapterEvents: RefreshAdapterEvent[];
}

interface RefreshRunRow {
  run_id: string;
  host_id: string;
  status: RefreshRun["status"];
  started_at: string;
  finished_at: string | null;
  snapshot_version: number | null;
  error: string | null;
  adapter_events_json: string;
}

function toRun(row: RefreshRunRow): RefreshRun {
  return {
    runId: row.run_id,
    hostId: row.host_id,
    status: row.status,
    startedAt: row.started_at,
    finishedAt: row.finished_at ?? undefined,
    snapshotVersion: row.snapshot_version ?? undefined,
    error: row.error ?? undefined,
    adapterEvents: JSON.parse(row.adapter_events_json)
  };
}

/**
 * Persists manual refresh runs so a disconnected browser can recover by
 * polling the run and the latest snapshot.
 */
export class RefreshRunStore {
  constructor(private readonly db: Db) {}

  create(hostId: string): RefreshRun {
    const runId = `refresh:${nanoid(12)}`;
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO refresh_runs (run_id, host_id, status, started_at, adapter_events_json)
         VALUES (?, ?, 'pending', ?, ?)`
      )
      .run(runId, hostId, now, JSON.stringify([]));
    return this.get(runId)!;
  }

  get(runId: string): RefreshRun | undefined {
    const row = this.db.prepare("SELECT * FROM refresh_runs WHERE run_id = ?").get(runId) as unknown as
      | RefreshRunRow
      | undefined;
    return row ? toRun(row) : undefined;
  }

  list(hostId: string, limit = 20): RefreshRun[] {
    const rows = this.db
      .prepare("SELECT * FROM refresh_runs WHERE host_id = ? ORDER BY started_at DESC LIMIT ?")
      .all(hostId, limit) as unknown as RefreshRunRow[];
    return rows.map(toRun);
  }

  updateStatus(runId: string, status: RefreshRun["status"], extra: { snapshotVersion?: number; error?: string } = {}): void {
    this.db
      .prepare(
        `UPDATE refresh_runs SET status = ?, finished_at = ?, snapshot_version = ?, error = ?
         WHERE run_id = ?`
      )
      .run(
        status,
        status === "completed" || status === "failed" || status === "cancelled" ? new Date().toISOString() : null,
        extra.snapshotVersion ?? null,
        extra.error ?? null,
        runId
      );
  }

  setAdapterEvent(runId: string, event: RefreshAdapterEvent): void {
    const run = this.get(runId);
    if (!run) return;
    const events = run.adapterEvents.filter((item) => item.adapterId !== event.adapterId);
    events.push(event);
    this.db
      .prepare("UPDATE refresh_runs SET adapter_events_json = ? WHERE run_id = ?")
      .run(JSON.stringify(events), runId);
  }
}