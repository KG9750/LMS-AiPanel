/**
 * Client-side API helpers (M7): short-lived local session acquisition and
 * authenticated fetches. The session is kept in memory and re-issued when
 * expired; write/command endpoints send it via the x-lms-session header.
 */
import type { ApiEnvelope } from "../shared/schemas";

/**
 * API base URL. In production the panel is served by the DSH proxy at
 * http://127.0.0.1:3080/panel/ (assets under /panel/, API under /panel/api/*,
 * OpenAI-compat under /panel/v1/*), so the client uses same-origin paths
 * prefixed with /panel. Call sites append their own /api (or /v1) prefix.
 */
export const API_BASE = "/panel";

interface SessionInfo {
  token: string;
  expiresAt: string;
  purpose: string;
}

let session: SessionInfo | null = null;

export async function ensureSession(): Promise<string> {
  if (session && new Date(session.expiresAt).getTime() > Date.now() + 5_000) {
    return session.token;
  }
  const response = await fetch(`${API_BASE}/api/session`, { method: "POST" });
  const envelope = (await response.json()) as ApiEnvelope<SessionInfo>;
  if (!envelope.ok) {
    throw new Error(`session acquisition failed: ${envelope.error.message}`);
  }
  session = envelope.data;
  return session.token;
}

export async function apiFetch<T>(url: string, init: RequestInit = {}): Promise<T> {
  const token = await ensureSession();
  const response = await fetch(`${API_BASE}${url}`, {
    ...init,
    headers: {
      ...(init.headers ?? {}),
      "x-lms-session": token
    }
  });
  const envelope = (await response.json()) as ApiEnvelope<T>;
  if (!envelope.ok) {
    const error = new Error(envelope.error.message) as Error & { code?: string; evidence?: string[] };
    error.code = envelope.error.code;
    error.evidence = envelope.error.evidence;
    throw error;
  }
  return envelope.data;
}

/** Read-only fetch that never acquires a session. */
export async function readFetch<T>(url: string): Promise<T> {
  const response = await fetch(`${API_BASE}${url}`);
  const envelope = (await response.json()) as ApiEnvelope<T>;
  if (!envelope.ok) {
    throw new Error(envelope.error.message);
  }
  return envelope.data;
}