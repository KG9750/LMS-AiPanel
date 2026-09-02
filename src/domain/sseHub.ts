/**
 * Minimal in-memory SSE hub: subscribers receive RefreshRun events as they
 * happen. A disconnected browser recovers by polling /api/refresh/:id and the
 * latest snapshot (the run is persisted), so the hub is only a live channel.
 */
export type RefreshEvent =
  | { type: "run"; runId: string; status: string; startedAt: string }
  | { type: "adapter"; runId: string; adapterId: string; status: string; finishedAt?: string }
  | { type: "snapshot"; runId: string; snapshotVersion: number };

export class SseHub {
  private readonly subscribers = new Set<(event: RefreshEvent) => void>();

  subscribe(listener: (event: RefreshEvent) => void): () => void {
    this.subscribers.add(listener);
    return () => {
      this.subscribers.delete(listener);
    };
  }

  publish(event: RefreshEvent): void {
    for (const listener of this.subscribers) {
      try {
        listener(event);
      } catch {
        // a broken subscriber must not break the run
      }
    }
  }

  subscriberCount(): number {
    return this.subscribers.size;
  }
}