import { randomBytes } from "node:crypto";
import type { Db } from "./db";

export interface LocalSession {
  token: string;
  hostId: string;
  createdAt: string;
  expiresAt: string;
  purpose: string;
}

const DEFAULT_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Short-lived local write sessions (issue #16). No user accounts: the browser
 * requests a session, the server issues a short-lived token bound to the
 * local host, and write endpoints require it. Read-only GET endpoints never
 * touch sessions.
 */
export class SessionStore {
  constructor(
    private readonly db: Db,
    private readonly hostId: string,
    private readonly ttlMs = DEFAULT_TTL_MS
  ) {}

  /** Issues a fresh short-lived session token. */
  issue(purpose = "write"): LocalSession {
    const now = new Date();
    const token = `sess-${randomBytes(18).toString("hex")}`;
    const session: LocalSession = {
      token,
      hostId: this.hostId,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + this.ttlMs).toISOString(),
      purpose
    };
    this.db
      .prepare(
        "INSERT INTO local_sessions (token, host_id, created_at, expires_at, purpose) VALUES (?, ?, ?, ?, ?)"
      )
      .run(session.token, session.hostId, session.createdAt, session.expiresAt, session.purpose);
    // Prune expired sessions opportunistically.
    this.db.prepare("DELETE FROM local_sessions WHERE expires_at < ?").run(new Date().toISOString());
    return session;
  }

  /** Validates a token: exists, belongs to this host, and not expired. */
  verify(token: string | undefined): LocalSession | null {
    if (!token) return null;
    const row = this.db
      .prepare("SELECT token, host_id, created_at, expires_at, purpose FROM local_sessions WHERE token = ? AND host_id = ?")
      .get(token, this.hostId) as unknown as
      | { token: string; host_id: string; created_at: string; expires_at: string; purpose: string }
      | undefined;
    if (!row) return null;
    if (new Date(row.expires_at).getTime() < Date.now()) {
      this.db.prepare("DELETE FROM local_sessions WHERE token = ?").run(token);
      return null;
    }
    return {
      token: row.token,
      hostId: row.host_id,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      purpose: row.purpose
    };
  }

  revoke(token: string): void {
    this.db.prepare("DELETE FROM local_sessions WHERE token = ?").run(token);
  }
}