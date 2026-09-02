import { execa } from "execa";
import { nanoid } from "nanoid";
import { redactValue } from "../domain/redaction";
import { systemSnapshotSchema, type SystemSnapshot } from "../shared/schemas";

export interface AuditEntry {
  id: string;
  timestamp: string;
  actor: string;
  action: string;
  resourceId?: string;
  result: string;
  evidence?: string[];
}

export class StorageRepository {
  constructor(private readonly databasePath: string) {}

  async saveSnapshot(snapshot: SystemSnapshot): Promise<void> {
    const safeSnapshot = redactValue(snapshot) as SystemSnapshot;
    const createdAt = new Date().toISOString();
    const statements = [
      "BEGIN;",
      `INSERT INTO snapshots(id,created_at,snapshot_json) VALUES (${sqlText(`snapshot:${nanoid()}`)},${sqlText(createdAt)},${sqlJson(safeSnapshot)});`,
      "DELETE FROM snapshots WHERE id NOT IN (SELECT id FROM snapshots ORDER BY created_at DESC LIMIT 100);",
      "DELETE FROM adapter_runs;",
      ...safeSnapshot.adapterRuns.map(
        (run) =>
          `INSERT INTO adapter_runs(run_id,adapter_id,started_at,finished_at,status,duration_ms,error,stale) VALUES (${sqlText(run.runId)},${sqlText(run.adapterId)},${sqlText(run.startedAt)},${sqlNullable(run.finishedAt)},${sqlText(run.status)},${run.durationMs ?? "NULL"},${sqlNullable(run.error)},${run.stale ? 1 : 0});`
      ),
      "DELETE FROM resource_nodes;",
      ...safeSnapshot.nodes.map(
        (node) =>
          `INSERT INTO resource_nodes(id,type,label,state,source_adapter,properties_json,last_seen_at,graph_schema_version) VALUES (${sqlText(node.id)},${sqlText(node.type)},${sqlText(node.label)},${sqlText(node.state)},${sqlText(node.sourceAdapter)},${sqlJson(node.properties)},${sqlText(node.lastSeenAt)},${node.graphSchemaVersion});`
      ),
      "DELETE FROM resource_edges;",
      ...safeSnapshot.edges.map(
        (edge) =>
          `INSERT INTO resource_edges(id,source,target,relation,properties_json,graph_schema_version) VALUES (${sqlText(edge.id)},${sqlText(edge.source)},${sqlText(edge.target)},${sqlText(edge.relation)},${sqlJson(edge.properties)},${edge.graphSchemaVersion});`
      ),
      "DELETE FROM drift_records;",
      ...safeSnapshot.driftRecords.map(
        (drift) =>
          `INSERT INTO drift_records(id,resource_id,status,configured_json,live_json,evidence_json,severity,created_at) VALUES (${sqlText(drift.id)},${sqlText(drift.resourceId)},${sqlText(drift.status)},${sqlJson(drift.configured)},${sqlJson(drift.live)},${sqlJson(drift.evidence)},${sqlText(drift.severity)},${sqlText(drift.createdAt)});`
      ),
      "COMMIT;"
    ];
    await this.execute(statements.join("\n"));
  }

  async loadLatestSnapshot(): Promise<SystemSnapshot | undefined> {
    const rows = await this.query<{ snapshot_json: string }>(
      "SELECT snapshot_json FROM snapshots ORDER BY created_at DESC LIMIT 1;"
    );
    if (!rows[0]) return undefined;
    return systemSnapshotSchema.parse(JSON.parse(rows[0].snapshot_json) as unknown);
  }

  async appendAudit(entry: AuditEntry): Promise<void> {
    const safe = redactValue(entry) as AuditEntry;
    await this.execute(
      `INSERT INTO audit_log(id,timestamp,actor,action,resource_id,result,evidence_json) VALUES (${sqlText(safe.id)},${sqlText(safe.timestamp)},${sqlText(safe.actor)},${sqlText(safe.action)},${sqlNullable(safe.resourceId)},${sqlText(safe.result)},${sqlJson(safe.evidence ?? [])});`
    );
  }

  async listAudit(limit = 100): Promise<AuditEntry[]> {
    const rows = await this.query<{
      id: string;
      timestamp: string;
      actor: string;
      action: string;
      resource_id?: string;
      result: string;
      evidence_json: string;
    }>(`SELECT id,timestamp,actor,action,resource_id,result,evidence_json FROM audit_log ORDER BY timestamp DESC LIMIT ${Math.max(1, Math.min(limit, 500))};`);
    return rows.map((row) => ({
      id: row.id,
      timestamp: row.timestamp,
      actor: row.actor,
      action: row.action,
      resourceId: row.resource_id,
      result: row.result,
      evidence: JSON.parse(row.evidence_json) as string[]
    }));
  }

  private async execute(sql: string): Promise<void> {
    await execa("sqlite3", [this.databasePath], { input: sql, timeout: 5_000 });
  }

  private async query<T>(sql: string): Promise<T[]> {
    const { stdout } = await execa("sqlite3", ["-json", this.databasePath, sql], { timeout: 5_000 });
    return stdout.trim() ? (JSON.parse(stdout) as T[]) : [];
  }
}

function sqlText(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function sqlNullable(value: string | undefined): string {
  return value === undefined ? "NULL" : sqlText(value);
}

function sqlJson(value: unknown): string {
  return `CAST(X'${Buffer.from(JSON.stringify(value), "utf8").toString("hex")}' AS TEXT)`;
}
