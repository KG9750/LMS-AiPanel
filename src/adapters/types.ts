import type { AdapterResult, AdapterRun } from "../shared/schemas";

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
  collect(context: AdapterContext): Promise<AdapterResult>;
  health(): Promise<HealthStatus>;
}

export interface AdapterRuntimeResult {
  result: AdapterResult;
  runs: AdapterRun[];
}

