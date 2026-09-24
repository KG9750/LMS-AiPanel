import { nanoid } from "nanoid";
import type { Db } from "./db";

export interface AuditRecord {
  id: string;
  timestamp: string;
  actor: string;
  action: string;
  resourceId?: string | null;
  result: string;
  evidence?: unknown[];
  backupId?: string | null;
  [key: string]: unknown;
}

export class AuditStore {
  constructor(private readonly db: Db) {}

  record(entry: Partial<AuditRecord> & { action: string }): AuditRecord {
    const record: AuditRecord = {
      ...entry,
      id: entry.id ?? `audit:${nanoid()}`,
      timestamp: entry.timestamp ?? new Date().toISOString(),
      actor: entry.actor ?? "local-user",
      action: entry.action,
      resourceId: entry.resourceId ?? null,
      result: entry.result ?? "ok",
      evidence: Array.isArray(entry.evidence) ? entry.evidence : [],
      backupId: entry.backupId ?? null
    };

    try {
      this.db
        .prepare(
          "INSERT INTO audit_log (id, timestamp, actor, action, resource_id, result, evidence_json, backup_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
        )
        .run(
          record.id,
          record.timestamp,
          record.actor,
          record.action,
          record.resourceId ?? null,
          record.result,
          JSON.stringify(record.evidence ?? []),
          record.backupId ?? null
        );
    } catch {
      // Non-fatal if DB write fails
    }

    return record;
  }

  list(limit = 100): AuditRecord[] {
    try {
      const rows = this.db
        .prepare(
          "SELECT id, timestamp, actor, action, resource_id, result, evidence_json, backup_id FROM audit_log ORDER BY timestamp DESC LIMIT ?"
        )
        .all(limit) as unknown as Array<{
          id: string;
          timestamp: string;
          actor: string;
          action: string;
          resource_id: string | null;
          result: string;
          evidence_json: string;
          backup_id: string | null;
        }>;

      return rows.map((r) => ({
        id: r.id,
        timestamp: r.timestamp,
        actor: r.actor,
        action: r.action,
        resourceId: r.resource_id ?? undefined,
        result: r.result,
        evidence: r.evidence_json ? JSON.parse(r.evidence_json) : [],
        backupId: r.backup_id ?? undefined
      }));
    } catch {
      return [];
    }
  }
}
