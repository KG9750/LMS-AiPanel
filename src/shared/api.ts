import type { ApiEnvelope, ApiError } from "./schemas";

export function ok<T>(data: T, meta: Partial<ApiEnvelope<T>["meta"]> = {}): ApiEnvelope<T> {
  return {
    ok: true,
    data,
    meta: {
      timestamp: new Date().toISOString(),
      ...meta
    }
  };
}

export function fail<T = never>(
  error: ApiError,
  meta: Partial<ApiEnvelope<T>["meta"]> = {}
): ApiEnvelope<T> {
  return {
    ok: false,
    error,
    meta: {
      timestamp: new Date().toISOString(),
      ...meta
    }
  };
}

