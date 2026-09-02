import type { Db } from "./db";
import type { SystemSnapshot } from "../shared/schemas";

interface SnapshotRow {
  version: number;
  host_id: string;
  created_at: string;
  nodes_json: string;
  edges_json: string;
  adapter_runs_json: string;
  drift_json: string;
}

/**
 * Persists completed versioned snapshots and restores the latest one across
 * service restarts. Versions are monotonic: the next version is always the
 * maximum stored version + 1, so a restart never re-issues a version number.
 */
export class SnapshotStore {
  constructor(private readonly db: Db) {}

  private nextVersion(): number {
    const row = this.db.prepare("SELECT COALESCE(MAX(version), 0) AS max_version FROM snapshots").get() as {
      max_version: number;
    };
    return row.max_version + 1;
  }

  save(snapshot: SystemSnapshot): number {
    const version = this.nextVersion();
    this.db
      .prepare(
        `INSERT INTO snapshots (version, host_id, created_at, nodes_json, edges_json, adapter_runs_json, drift_json)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        version,
        snapshot.host.hostId,
        snapshot.host.lastSeenAt,
        JSON.stringify(snapshot.nodes),
        JSON.stringify(snapshot.edges),
        JSON.stringify(snapshot.adapterRuns),
        JSON.stringify(snapshot.driftRecords)
      );
    this.db.prepare("DELETE FROM snapshots WHERE version < ?").run(version - 50);
    return version;
  }

  latest(): SystemSnapshot | null {
    const row = this.db
      .prepare("SELECT * FROM snapshots ORDER BY version DESC LIMIT 1")
      .get() as unknown as SnapshotRow | undefined;
    if (!row) return null;
    return {
      version: row.version,
      host: {
        hostId: row.host_id,
        hostName: "restored",
        scope: "local",
        createdAt: row.created_at,
        lastSeenAt: row.created_at
      },
      nodes: JSON.parse(row.nodes_json),
      edges: JSON.parse(row.edges_json),
      adapterRuns: JSON.parse(row.adapter_runs_json),
      driftRecords: JSON.parse(row.drift_json)
    };
  }

  latestVersion(): number {
    const row = this.db.prepare("SELECT COALESCE(MAX(version), 0) AS max_version FROM snapshots").get() as {
      max_version: number;
    };
    return row.max_version;
  }
}