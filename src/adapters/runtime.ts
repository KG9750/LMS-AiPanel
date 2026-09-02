import { nanoid } from "nanoid";
import type { AdapterResult, AdapterRun, SystemSnapshot } from "../shared/schemas";
import { adapterResultSchema } from "../shared/schemas";
import type { AdapterRuntimeResult, StackAdapter } from "./types";
import { redactAdapterResult } from "../domain/redaction";

const EMPTY_RESULT: AdapterResult = {
  nodes: [],
  edges: [],
  redactionHints: []
};

export class AdapterRuntime {
  private readonly lastSuccessful = new Map<string, AdapterResult>();
  private readonly lastRuns = new Map<string, AdapterRun>();
  private readonly failureCounts = new Map<string, number>();
  private activeCollection: Promise<AdapterRuntimeResult> | undefined;

  constructor(
    private readonly adapters: StackAdapter[],
    private readonly timeoutMs = 5_000
  ) {}

  async collectAll(): Promise<AdapterRuntimeResult> {
    if (this.activeCollection) return this.activeCollection;
    this.activeCollection = this.collectOnce();
    try {
      return await this.activeCollection;
    } finally {
      this.activeCollection = undefined;
    }
  }

  private async collectOnce(): Promise<AdapterRuntimeResult> {
    const results = await Promise.all(this.adapters.map((adapter) => this.runAdapter(adapter)));
    return {
      result: {
        nodes: results.flatMap((item) => item.result.nodes),
        edges: results.flatMap((item) => item.result.edges),
        redactionHints: results.flatMap((item) => item.result.redactionHints)
      },
      runs: results.map((item) => item.run)
    };
  }

  getLastRuns(): AdapterRun[] {
    return Array.from(this.lastRuns.values());
  }

  seedFromSnapshot(snapshot: SystemSnapshot): void {
    const nodeAdapters = new Map(snapshot.nodes.map((node) => [node.id, node.sourceAdapter]));
    for (const adapter of this.adapters) {
      const nodes = snapshot.nodes.filter((node) => node.sourceAdapter === adapter.id);
      if (!nodes.length) continue;
      const edges = snapshot.edges.filter(
        (edge) => nodeAdapters.get(edge.source) === adapter.id || nodeAdapters.get(edge.target) === adapter.id
      );
      this.lastSuccessful.set(adapter.id, { nodes, edges, redactionHints: [] });
    }
  }

  private async runAdapter(adapter: StackAdapter): Promise<{ result: AdapterResult; run: AdapterRun }> {
    const started = Date.now();
    const startedAt = new Date(started).toISOString();
    const runId = `run:${adapter.id}:${nanoid()}`;
    const controller = new AbortController();

    try {
      const collected = await withTimeout(
        adapter.collect({
          now: () => new Date(),
          timeoutMs: this.timeoutMs,
          signal: controller.signal
        }),
        this.timeoutMs,
        `${adapter.id} timed out after ${this.timeoutMs}ms`,
        controller
      );

      const parsed = redactAdapterResult(adapterResultSchema.parse(collected));
      const run: AdapterRun = {
        runId,
        adapterId: adapter.id,
        startedAt,
        finishedAt: new Date().toISOString(),
        status: "success",
        durationMs: Date.now() - started,
        stale: false
      };
      this.lastSuccessful.set(adapter.id, parsed);
      this.lastRuns.set(adapter.id, run);
      this.failureCounts.set(adapter.id, 0);
      return { result: parsed, run };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const failedCount = (this.failureCounts.get(adapter.id) ?? 0) + 1;
      this.failureCounts.set(adapter.id, failedCount);
      const previous = this.lastSuccessful.get(adapter.id);
      const run: AdapterRun = {
        runId,
        adapterId: adapter.id,
        startedAt,
        finishedAt: new Date().toISOString(),
        status: message.includes("timed out") ? "timeout" : "failed",
        durationMs: Date.now() - started,
        error: message,
        stale: Boolean(previous)
      };
      this.lastRuns.set(adapter.id, run);
      return { result: previous ? markStale(previous) : EMPTY_RESULT, run };
    }
  }
}

function markStale(result: AdapterResult): AdapterResult {
  return {
    ...result,
    nodes: result.nodes.map((node) => ({
      ...node,
      properties: { ...node.properties, stale: true }
    }))
  };
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
  controller: AbortController
): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<T>((_, reject) => {
    timeout = setTimeout(() => {
      reject(new Error(message));
      controller.abort();
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}
