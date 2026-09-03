/**
 * In-memory SSE hub with history replay (M6): subscribers receive RefreshRun
 * events as they happen. A LATE or RECONNECTING subscriber is replayed the
 * buffered events for the active run so it can catch up on adapter progress
 * and the completed snapshot version without waiting for new events. The run
 * itself is persisted, so polling /api/refresh/:id remains the durable
 * recovery path.
 */
export type RefreshEvent =
  | { type: "run"; runId: string; status: string; startedAt: string }
  | { type: "adapter"; runId: string; adapterId: string; status: string; finishedAt?: string }
  | { type: "snapshot"; runId: string; snapshotVersion: number };

const HISTORY_LIMIT = 200;

export class SseHub {
  private readonly subscribers = new Set<(event: RefreshEvent) => void>();
  private readonly history: RefreshEvent[] = [];

  subscribe(listener: (event: RefreshEvent) => void): () => void {
    this.subscribers.add(listener);
    // Replay buffered events so late/reconnecting subscribers catch up.
    for (const event of this.history) {
      try {
        listener(event);
      } catch {
        // a broken subscriber must not break replay
      }
    }
    return () => {
      this.subscribers.delete(listener);
    };
  }

  publish(event: RefreshEvent): void {
    this.history.push(event);
    if (this.history.length > HISTORY_LIMIT) {
      this.history.splice(0, this.history.length - HISTORY_LIMIT);
    }
    for (const listener of this.subscribers) {
      try {
        listener(event);
      } catch {
        // a broken subscriber must not break the run
      }
    }
  }

  /** Returns the replayed event history (for tests). */
  getHistory(): RefreshEvent[] {
    return [...this.history];
  }

  subscriberCount(): number {
    return this.subscribers.size;
  }
}