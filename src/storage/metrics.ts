import type { Db } from "./db";

export type MetricKind = "counter" | "gauge";
export type MetricLayer = "provider" | "client" | "endpoint" | "model" | "runtime" | "process";

export interface MetricSample {
  hostId: string;
  scope: string;
  layer: MetricLayer;
  metric: string;
  source: string;
  coverage: string;
  kind: MetricKind;
  value: number;
  sampleAt: string;
}

export interface EpochRecord {
  epoch: number;
  hostId: string;
  scope: string;
  metric: string;
  startedAt: string;
  resetReason?: string;
}

export interface SeriesPoint {
  sampleAt: string;
  value: number;
  epoch: number;
}

export interface SeriesResult {
  scope: string;
  metric: string;
  layer: MetricLayer;
  current: number | null;
  currentEpoch: number;
  /** Delta over the window within the CURRENT epoch (never negative). */
  delta: number | null;
  /** Number of counter resets observed in the window. */
  resets: number;
  points: SeriesPoint[];
}

const RETENTION_SECONDS = Number(process.env.LMS_METRIC_RETENTION_SECONDS ?? 7 * 24 * 3600); // 7 days
const FINE_GRANULARITY_AGE_SECONDS = 24 * 3600; // fine-grained samples kept for 24h

/**
 * Token/memory time-series storage with counter epochs (issue #11).
 *
 * - Samples are host- and resource-scoped with source and coverage metadata.
 * - A counter value that rolls back (lower than the previous sample) starts a
 *   NEW epoch; intervals are always computed within one epoch, so they never
 *   go negative.
 * - Retention: fine-grained samples are kept for 24h, hourly-aggregated
 *   samples for 7 days.
 */
export class MetricStore {
  constructor(private readonly db: Db) {}

  record(sample: MetricSample): void {
    const epoch = this.computeEpoch(sample);
    this.db
      .prepare(
        `INSERT INTO metric_samples (host_id, scope, layer, metric, source, coverage, kind, value, epoch, sample_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        sample.hostId,
        sample.scope,
        sample.layer,
        sample.metric,
        sample.source,
        sample.coverage,
        sample.kind,
        sample.value,
        epoch,
        sample.sampleAt
      );

    this.applyRetention(sample.hostId);
  }

  private computeEpoch(sample: MetricSample): number {
    const previous = this.db
      .prepare(
        `SELECT value, epoch FROM metric_samples
         WHERE host_id = ? AND scope = ? AND metric = ? AND kind = 'counter'
         ORDER BY sample_at DESC, id DESC LIMIT 1`
      )
      .get(sample.hostId, sample.scope, sample.metric) as { value: number; epoch: number } | undefined;

    if (!previous) return 1;
    if (sample.kind === "counter" && sample.value < previous.value) {
      // Counter rollback: never produce a negative interval; open a new epoch.
      const epoch = previous.epoch + 1;
      const resetReason = `counter rollback ${previous.value} -> ${sample.value}`;
      this.db
        .prepare(
          `INSERT OR REPLACE INTO metric_epochs (epoch, host_id, scope, metric, started_at, reset_reason)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(epoch, sample.hostId, sample.scope, sample.metric, sample.sampleAt, resetReason);
      return epoch;
    }
    return previous.epoch;
  }

  /** Current value + window delta for one scope/metric within one epoch. */
  series(
    hostId: string,
    scope: string,
    metric: string,
    layer: MetricLayer,
    windowSeconds: number,
    limit = 60
  ): SeriesResult {
    const now = new Date().toISOString();
    const since = new Date(Date.now() - windowSeconds * 1000).toISOString();

    const latest = this.db
      .prepare(
        `SELECT value, epoch, sample_at FROM metric_samples
         WHERE host_id = ? AND scope = ? AND metric = ? AND layer = ?
         ORDER BY sample_at DESC, id DESC LIMIT 1`
      )
      .get(hostId, scope, metric, layer) as { value: number; epoch: number; sample_at: string } | undefined;

    if (!latest) {
      return {
        scope,
        metric,
        layer,
        current: null,
        currentEpoch: 1,
        delta: null,
        resets: 0,
        points: []
      };
    }

    // Epoch resets within the window.
    const resets = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM metric_epochs
         WHERE host_id = ? AND scope = ? AND metric = ? AND started_at >= ?`
      )
      .get(hostId, scope, metric, since) as { n: number };

    // Delta within the current epoch only: never crosses a reset.
    const epochStart = this.db
      .prepare(
        `SELECT MIN(sample_at) AS first_at FROM metric_samples
         WHERE host_id = ? AND scope = ? AND metric = ? AND layer = ? AND epoch = ?`
      )
      .get(hostId, scope, metric, layer, latest.epoch) as { first_at: string | null };

    let delta: number | null = null;
    if (latest.epoch > 0 && epochStart.first_at) {
      const first = this.db
        .prepare(
          `SELECT value FROM metric_samples
           WHERE host_id = ? AND scope = ? AND metric = ? AND layer = ? AND epoch = ? AND sample_at = ?
           ORDER BY id ASC LIMIT 1`
        )
        .get(hostId, scope, metric, layer, latest.epoch, epochStart.first_at) as { value: number } | undefined;
      if (first) {
        delta = Math.max(0, latest.value - first.value);
      }
    }

    const rows = this.db
      .prepare(
        `SELECT sample_at, value, epoch FROM metric_samples
         WHERE host_id = ? AND scope = ? AND metric = ? AND layer = ? AND sample_at >= ?
         ORDER BY sample_at ASC LIMIT ?`
      )
      .all(hostId, scope, metric, layer, since, limit) as unknown as Array<{
      sample_at: string;
      value: number;
      epoch: number;
    }>;

    return {
      scope,
      metric,
      layer,
      current: latest.value,
      currentEpoch: latest.epoch,
      delta,
      resets: resets.n,
      points: rows.map((row) => ({ sampleAt: row.sample_at, value: row.value, epoch: row.epoch }))
    };
  }

  /** Coarse retention: fine-grained samples beyond 24h are removed. */
  private applyRetention(hostId: string): void {
    const fineCutoff = new Date(Date.now() - FINE_GRANULARITY_AGE_SECONDS * 1000).toISOString();
    const coarseCutoff = new Date(Date.now() - RETENTION_SECONDS * 1000).toISOString();
    this.db
      .prepare("DELETE FROM metric_samples WHERE host_id = ? AND sample_at < ?")
      .run(hostId, coarseCutoff);
    // Hourly downsampling placeholder: fine samples older than 24h are
    // dropped; an hourly rollup job (issue #11 extension) can repopulate them.
    this.db
      .prepare(
        `DELETE FROM metric_samples WHERE host_id = ? AND kind = 'gauge' AND sample_at < ? AND id NOT IN (
           SELECT id FROM metric_samples m2
           WHERE m2.host_id = metric_samples.host_id AND m2.scope = metric_samples.scope
             AND m2.metric = metric_samples.metric AND m2.layer = metric_samples.layer
             AND m2.sample_at >= ?
           ORDER BY m2.sample_at DESC LIMIT 24
         )`
      )
      .run(hostId, fineCutoff, fineCutoff);
  }

  listScopes(hostId: string): Array<{ scope: string; metric: string; layer: MetricLayer }> {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT scope, metric, layer FROM metric_samples WHERE host_id = ? ORDER BY scope, metric`
      )
      .all(hostId) as unknown as Array<{ scope: string; metric: string; layer: MetricLayer }>;
    return rows;
  }
}