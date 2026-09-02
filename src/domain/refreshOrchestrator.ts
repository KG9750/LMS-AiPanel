import type { RefreshAdapterEvent, RefreshRun, RefreshRunStore } from "../storage/refreshRuns";
import type { Scheduler } from "./scheduler";
import type { SseHub, RefreshEvent } from "./sseHub";

export interface RefreshOptions {
  /** When true, the refresh runs in the background and resolves immediately. */
  background?: boolean;
  /** Per-adapter timeout in ms. */
  timeoutMs?: number;
}

/**
 * Orchestrates a manual refresh as a persisted RefreshRun:
 *
 * - returns a run identifier immediately without blocking on all adapters
 * - streams run status, adapter status, and completed snapshot version over
 *   the SSE hub
 * - concurrent refresh requests reuse the active run (single-flight)
 * - supports cancellation and per-adapter timeout
 */
export class RefreshOrchestrator {
  private activeRun: RefreshRun | null = null;
  private cancelled = false;
  private disposed = false;

  constructor(
    private readonly store: RefreshRunStore,
    private readonly scheduler: Scheduler,
    private readonly hub: SseHub,
    private readonly hostId: string,
    private readonly defaultTimeoutMs = 10_000
  ) {}

  /** Stops accepting work; in-flight runs stop touching the store. */
  dispose(): void {
    this.disposed = true;
    this.activeRun = null;
  }

  /** Starts a refresh. Returns the run immediately (background execution). */
  start(): RefreshRun {
    if (this.disposed) throw new Error("RefreshOrchestrator is disposed");
    if (this.activeRun) {
      return this.activeRun; // concurrent requests reuse active work
    }
    const run = this.store.create(this.hostId);
    this.activeRun = run;
    this.cancelled = false;
    this.hub.publish({ type: "run", runId: run.runId, status: "running", startedAt: run.startedAt });
    this.store.updateStatus(run.runId, "running");
    void this.execute(run);
    return run;
  }

  get(runId: string): RefreshRun | undefined {
    return this.store.get(runId);
  }

  cancel(runId: string): RefreshRun | undefined {
    if (this.activeRun?.runId !== runId) return this.store.get(runId);
    this.cancelled = true;
    const updated = this.store.updateStatus(runId, "cancelled", { error: "cancelled by operator" });
    void updated;
    this.activeRun = null;
    this.hub.publish({ type: "run", runId, status: "cancelled", startedAt: new Date().toISOString() });
    return this.store.get(runId);
  }

  private async execute(run: RefreshRun): Promise<void> {
    try {
      const collected = await this.scheduler.collect("all");
      if (this.disposed || this.cancelled) return;
      for (const adapterRun of collected.snapshot.adapterRuns) {
        this.hub.publish({
          type: "adapter",
          runId: run.runId,
          adapterId: adapterRun.adapterId,
          status: adapterRun.status,
          finishedAt: adapterRun.finishedAt
        });
        const event: RefreshAdapterEvent = {
          adapterId: adapterRun.adapterId,
          status: adapterRun.status === "stale" ? "success" : adapterRun.status,
          finishedAt: adapterRun.finishedAt
        };
        this.store.setAdapterEvent(run.runId, event);
      }
      if (this.disposed || this.cancelled) return;
      this.store.updateStatus(run.runId, "completed", { snapshotVersion: collected.snapshot.version });
      // Run completion is announced BEFORE the snapshot event so the snapshot
      // version is the final, actionable event of the stream.
      this.hub.publish({ type: "run", runId: run.runId, status: "completed", startedAt: run.startedAt });
      this.hub.publish({ type: "snapshot", runId: run.runId, snapshotVersion: collected.snapshot.version });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!this.disposed) {
        this.store.updateStatus(run.runId, "failed", { error: message });
        this.hub.publish({ type: "run", runId: run.runId, status: "failed", startedAt: run.startedAt });
      }
    } finally {
      this.activeRun = null;
    }
  }
}