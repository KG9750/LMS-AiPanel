import type { AdapterRun, SystemSnapshot } from "../shared/schemas";
import type { AdapterRuntime } from "../adapters/runtime";
import type { StackAdapter } from "../adapters/types";
import { evaluateDrift } from "../domain/drift";
import { mergeRegistry } from "../domain/registryMerge";
import { stampHostId } from "../domain/scope";
import type { RegistryRepository } from "../storage/registry";
import type { SnapshotStore } from "../storage/snapshots";
import type { HostRecord } from "../shared/schemas";

export interface SchedulerOptions {
  /** Fast refresh profile (seconds) for adapters with interval <= this. */
  fastIntervalMs: number;
  /** Slow refresh profile (seconds) for the rest. */
  slowIntervalMs: number;
  /** When false the scheduler never auto-runs (tests control ticks). */
  autoStart: boolean;
}

const DEFAULT_OPTIONS: SchedulerOptions = {
  fastIntervalMs: 30_000,
  slowIntervalMs: 120_000,
  autoStart: true
};

export interface SchedulerSnapshot {
  version: number;
  createdAt: string;
  /** True when this snapshot was restored from storage, not freshly collected. */
  restored: boolean;
  /** True when some adapters failed and the snapshot reused stale evidence. */
  stale: boolean;
  snapshot: SystemSnapshot;
}

/**
 * Background collection scheduler (issue #4).
 *
 * - Query APIs read the latest COMPLETED snapshot; they never trigger a full
 *   collection.
 * - Adapters follow their manifest refresh profile: adapters with
 *   `intervalSeconds <= 30` use the fast loop, everything else the slow loop.
 * - Concurrent refresh requests reuse in-flight work (single-flight).
 * - Completed snapshots get a monotonic version and persist across restart.
 */
export class Scheduler {
  private latestSnapshot: SchedulerSnapshot | null = null;
  private inFlight: Promise<SchedulerSnapshot> | null = null;
  private fastTimer: ReturnType<typeof setInterval> | null = null;
  private slowTimer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;

  constructor(
    private readonly runtime: AdapterRuntime,
    private readonly registry: RegistryRepository,
    private readonly store: SnapshotStore,
    private readonly host: HostRecord,
    private readonly adapters: StackAdapter[],
    private readonly options: SchedulerOptions = DEFAULT_OPTIONS,
    private readonly now: () => Date = () => new Date()
  ) {}

  start(): void {
    if (!this.options.autoStart || this.stopped) return;
    this.fastTimer = setInterval(() => void this.collect("fast"), this.options.fastIntervalMs);
    this.slowTimer = setInterval(() => void this.collect("slow"), this.options.slowIntervalMs);
  }

  stop(): void {
    this.stopped = true;
    if (this.fastTimer) clearInterval(this.fastTimer);
    if (this.slowTimer) clearInterval(this.slowTimer);
    this.fastTimer = null;
    this.slowTimer = null;
  }

  getLatest(): SchedulerSnapshot | null {
    return this.latestSnapshot;
  }

  /** Single-flight entry point: concurrent callers share the same collection. */
  collect(mode: "fast" | "slow" | "all" = "all"): Promise<SchedulerSnapshot> {
    if (this.inFlight) return this.inFlight;
    const run = this.doCollect(mode).finally(() => {
      this.inFlight = null;
    });
    this.inFlight = run;
    return run;
  }

  private async doCollect(mode: "fast" | "slow" | "all"): Promise<SchedulerSnapshot> {
    const selected = this.selectAdapters(mode);
    const collected = await this.runtime.collectSelected(selected);
    const stamped = stampHostId(collected.result.nodes, this.host.hostId);
    const merged = mergeRegistry(stamped, this.registry.list());
    const driftRecords = evaluateDrift(merged.nodes);

    const snapshot: SystemSnapshot = {
      version: this.store.latestVersion() + 1,
      host: this.host,
      nodes: merged.nodes,
      edges: collected.result.edges,
      adapterRuns: collected.runs,
      driftRecords
    };

    const version = this.store.save(snapshot);
    const stale = collected.runs.some((run) => run.stale);

    this.latestSnapshot = {
      version,
      createdAt: this.now().toISOString(),
      restored: false,
      stale,
      snapshot: { ...snapshot, version }
    };
    return this.latestSnapshot;
  }

  private selectAdapters(mode: "fast" | "slow" | "all"): string[] {
    const all = this.adapters.map((adapter) => adapter.id);
    if (mode === "all") return all;
    const ids = this.adapters
      .filter((adapter) => {
        const interval = adapter.manifest.refreshProfile.intervalSeconds;
        return mode === "fast" ? interval <= 30 : interval > 30;
      })
      .map((adapter) => adapter.id);
    return ids.length > 0 ? ids : all;
  }

  /** Restores the latest persisted snapshot (or null on first run). */
  restore(): SchedulerSnapshot | null {
    const latest = this.store.latest();
    if (!latest) return null;
    this.latestSnapshot = {
      version: latest.version,
      createdAt: new Date().toISOString(),
      restored: true,
      stale: false,
      snapshot: latest
    };
    return this.latestSnapshot;
  }
}