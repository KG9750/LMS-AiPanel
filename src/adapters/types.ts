import type { AdapterManifest, AdapterResult, AdapterRun, CapabilityState } from "../shared/schemas";

export interface AdapterContext {
  now: () => Date;
  timeoutMs: number;
}

export interface HealthStatus {
  adapterId: string;
  alive: boolean;
  lastRun?: AdapterRun;
  lastError?: string;
}

export interface StackAdapter {
  id: string;
  name: string;
  /** Versioned capability manifest (issue #2). */
  manifest: AdapterManifest;
  collect(context: AdapterContext): Promise<AdapterResult>;
  health(): Promise<HealthStatus>;
}

export interface AdapterRuntimeResult {
  result: AdapterResult;
  runs: AdapterRun[];
}

/**
 * Resolves the declared capability set against the current adapter run state.
 *
 * - capabilities the adapter never declared are `unsupported`
 * - declared capabilities that need live evidence and have no recent success
 *   are `unavailable`
 * - capabilities whose backing evidence comes from a failed run are `failed`
 */
export function resolveCapabilityStates(
  manifest: AdapterManifest,
  run: AdapterRun | undefined
): CapabilityState[] {
  const declared = new Set(manifest.supportedCapabilities);
  const runFailed = run?.status === "failed" || run?.status === "timeout";

  const states: CapabilityState[] = [];
  for (const capability of manifest.supportedCapabilities) {
    if (runFailed) {
      states.push({ capability, status: "failed", reason: `last run ${run?.status}` });
    } else if (!run) {
      states.push({ capability, status: "unavailable", reason: "no run evidence yet" });
    } else {
      states.push({ capability, status: "supported" });
    }
  }
  return states;
}