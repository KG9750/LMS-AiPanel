import os from "node:os";
import { nanoid } from "nanoid";
import type { Db } from "./db";
import type { HostRecord } from "../shared/schemas";

interface HostRow {
  host_id: string;
  host_name: string;
  scope: "local";
  created_at: string;
  last_seen_at: string;
}

function toRecord(row: HostRow): HostRecord {
  return {
    hostId: row.host_id,
    hostName: row.host_name,
    scope: row.scope,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at
  };
}

/**
 * Returns the single local Host record, creating it on first run.
 *
 * The hostId is generated once and persisted; every subsequent call (including
 * across service restarts and re-initialized storage) returns the same record,
 * so resources and snapshots stay scoped to one stable host identity.
 */
export function getOrCreateHost(db: Db): HostRecord {
  const row = db
    .prepare("SELECT host_id, host_name, scope, created_at, last_seen_at FROM host LIMIT 1")
    .get() as HostRow | undefined;

  if (row) {
    const now = new Date().toISOString();
    db.prepare("UPDATE host SET last_seen_at = ? WHERE host_id = ?").run(now, row.host_id);
    return toRecord({ ...row, last_seen_at: now });
  }

  const now = new Date().toISOString();
  const hostId = `host-${nanoid(12)}`;
  const hostName = os.hostname() || "localhost";
  db.prepare(
    "INSERT INTO host (host_id, host_name, scope, created_at, last_seen_at) VALUES (?, ?, 'local', ?, ?)"
  ).run(hostId, hostName, now, now);
  return toRecord({ host_id: hostId, host_name: hostName, scope: "local", created_at: now, last_seen_at: now });
}