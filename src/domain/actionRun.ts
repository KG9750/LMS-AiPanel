import type { ActionRunRecord, ActionRunStatus, ActionRunStore } from "../storage/actionRuns";

/**
 * Documented ActionRun state machine (issue #17).
 *
 *   planned ──confirm──▶ confirmed ──execute──▶ executing ──verify──▶ succeeded
 *      │                    │                       │                    │
 *      │                    │                       ├──verify-fail──▶ failed
 *      │                    │                       └──timeout──────▶ failed
 *      │                    └──────cancel──────────▶ (terminal)
 *      └──────cancel────────▶ (terminal)
 *
 * - Only managed resources with a declared adapter action can create an
 *   executable plan (enforced by the plan gate, not the state machine).
 * - Success depends on verification EVIDENCE, not the command exit code.
 * - `failed` runs with `requiresRollback` may transition to `rolled_back`.
 * - Any transition not listed here is rejected.
 */
export const ACTION_RUN_TRANSITIONS: Record<ActionRunStatus, ActionRunStatus[]> = {
  planned: ["confirmed", "failed", "rolled_back"],
  confirmed: ["executing", "failed", "rolled_back"],
  executing: ["succeeded", "failed", "rolled_back"],
  succeeded: [],
  failed: ["rolled_back"],
  rolled_back: []
};

export function canTransition(from: ActionRunStatus, to: ActionRunStatus): boolean {
  return ACTION_RUN_TRANSITIONS[from].includes(to);
}

export interface AdapterActionExecutor {
  /** The adapter's declared action verb, e.g. "start", "stop", "load-model". */
  action: string;
  /** Executes the action against the isolated runtime. */
  execute(resourceId: string): Promise<{ ok: boolean; evidence: string[]; error?: string; rollbackState?: Record<string, unknown> }>;
  /** Re-verifies the final state after execution (or after a restart). */
  verify(resourceId: string): Promise<{ ok: boolean; evidence: string[] }>;
}

/** Fake/isolated runtime used by tests and by the managed test instance. */
export interface IsolatedRuntime {
  /** Adapter actions this runtime can prove. */
  supportedActions: string[];
  /** Executes one action; returns verification evidence. */
  run(
    action: string,
    resourceId: string
  ): Promise<{ ok: boolean; evidence: string[]; error?: string; rollbackState?: Record<string, unknown> }>;
}

/** Adapts an IsolatedRuntime into an AdapterActionExecutor per action verb. */
export function executorFor(runtime: IsolatedRuntime, action: string): AdapterActionExecutor | null {
  if (!runtime.supportedActions.includes(action)) return null;
  return {
    action,
    async execute(resourceId: string) {
      return runtime.run(action, resourceId);
    },
    async verify(resourceId: string) {
      const result = await runtime.run(`verify:${action}`, resourceId);
      return { ok: result.ok, evidence: result.evidence };
    }
  };
}

export interface ActionRunOutcome {
  run: ActionRunRecord;
  ok: boolean;
  evidence: string[];
  error?: string;
}

/**
 * Drives one ActionRun through the state machine with execution + verification.
 */
export class ActionRunDriver {
  constructor(private readonly store: ActionRunStore) {}

  /** Confirms a planned run (operator consent). */
  confirm(runId: string): ActionRunRecord | undefined {
    const run = this.store.get(runId);
    if (!run) return undefined;
    if (!canTransition(run.status, "confirmed")) {
      throw new Error(`invalid transition ${run.status} -> confirmed`);
    }
    return this.store.update(runId, { status: "confirmed", evidence: [...run.evidence, "confirmed by local operator"] });
  }

  /** Rejects a planned run (operator denial). */
  reject(runId: string): ActionRunRecord | undefined {
    const run = this.store.get(runId);
    if (!run) return undefined;
    if (!canTransition(run.status, "failed")) {
      throw new Error(`invalid transition ${run.status} -> failed`);
    }
    return this.store.update(runId, {
      status: "failed",
      finishedAt: new Date().toISOString(),
      error: "rejected by local operator",
      evidence: [...run.evidence, "rejected by local operator"]
    });
  }

  /**
   * Executes a confirmed run against the isolated runtime and verifies the
   * final state. Success requires verification evidence, not exit codes.
   */
  async execute(runId: string, executor: AdapterActionExecutor): Promise<ActionRunOutcome> {
    const run = this.store.get(runId);
    if (!run) throw new Error(`unknown run ${runId}`);
    if (!canTransition(run.status, "executing")) {
      throw new Error(`invalid transition ${run.status} -> executing`);
    }

    this.store.update(runId, { status: "executing", evidence: [...run.evidence, "execution started"] });
    let outcome: ActionRunOutcome;
    try {
      const executed = await executor.execute(run.resourceId);
      // Success is NOT granted by the command result alone: verify first.
      const verified = await executor.verify(run.resourceId);
      const evidence = [...run.evidence, ...executed.evidence, ...verified.evidence];
      if (executed.ok && verified.ok) {
        outcome = {
          run: this.store.update(runId, {
            status: "succeeded",
            finishedAt: new Date().toISOString(),
            evidence
          })!,
          ok: true,
          evidence
        };
      } else {
        const error = executed.error ?? (verified.ok ? undefined : "verification failed: final state not proven");
        const updated = this.store.update(runId, {
          status: "failed",
          finishedAt: new Date().toISOString(),
          evidence,
          error,
          requiresRollback: Boolean(executed.rollbackState),
          rollbackState: executed.rollbackState
        })!;
        outcome = { run: updated, ok: false, evidence, error };
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      outcome = {
        run: this.store.update(runId, {
          status: "failed",
          finishedAt: new Date().toISOString(),
          error: message,
          evidence: [...run.evidence, `execution error: ${message}`]
        })!,
        ok: false,
        evidence: [message],
        error: message
      };
    }
    return outcome;
  }

  /** Rolls a failed run back to its captured pre-action state. */
  rollback(runId: string, executor: AdapterActionExecutor): ActionRunRecord | undefined {
    const run = this.store.get(runId);
    if (!run) return undefined;
    if (!canTransition(run.status, "rolled_back")) {
      throw new Error(`invalid transition ${run.status} -> rolled_back`);
    }
    const evidence = [...run.evidence, "rollback executed", `pre-action state: ${JSON.stringify(run.rollbackState ?? {})}`];
    return this.store.update(runId, {
      status: "rolled_back",
      finishedAt: new Date().toISOString(),
      evidence
    });
  }
}