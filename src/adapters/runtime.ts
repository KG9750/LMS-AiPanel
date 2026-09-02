import { nanoid } from "nanoid";
import type { AdapterResult, AdapterRun } from "../shared/schemas";
import { adapterResultSchema } from "../shared/schemas";
import { stampHostId } from "../domain/scope";
import type { AdapterRuntimeResult, StackAdapter } from "./types";

const EMPTY_RESULT: AdapterResult = {
  nodes: [],
  edges: [],
  redactionHints: []
};

export class AdapterRuntime {
  private readonly lastSuccessful = new Map<string, AdapterResult>();
  private readonly lastRuns = new Map<string, AdapterRun>();
  private readonly failureCounts = new Map<string, number>();

  constructor(
    private readonly adapters: StackAdapter[],
    private readonly timeoutMs = 5_000,
    private readonly hostId = "pending"
  ) {}

  async collectAll(): Promise<AdapterRuntimeResult> {
    const results = await Promise.all(this.adapters.map((adapter) => this.runAdapter(adapter)));
    return {
      result: {
        nodes: stampHostId(
          results.flatMap((item) => item.result.nodes),
          this.hostId
        ),
        edges: results.flatMap((item) => item.result.edges),
        redactionHints: results.flatMap((item) => item.result.redactionHints)
      },
      runs: results.map((item) => item.run)
    };
  }

  getLastRuns(): AdapterRun[] {
    return Array.from(this.lastRuns.values());
  }

  private async runAdapter(adapter: StackAdapter): Promise<{ result: AdapterResult; run: AdapterRun }> {
    const started = Date.now();
    const startedAt = new Date(started).toISOString();
    const runId = `run:${adapter.id}:${nanoid()}`;

    try {
      const collected = await withTimeout(
        adapter.collect({
          now: () => new Date(),
          timeoutMs: this.timeoutMs
        }),
        this.timeoutMs,
        `${adapter.id} timed out after ${this.timeoutMs}ms`
      );

      const parsed = adapterResultSchema.parse(collected);
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
      return { result: previous ?? EMPTY_RESULT, run };
    }
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<T>((_, reject) => {
    timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

