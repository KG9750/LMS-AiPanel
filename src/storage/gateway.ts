import { nanoid } from "nanoid";
import type { Db } from "./db";

export interface GatewayClient {
  id: string;
  hostId: string;
  clientName: string;
  model: string;
  targetEndpoint: string;
  enabled: boolean;
  createdAt: string;
}

export interface GatewayRequestRecord {
  id: string;
  hostId: string;
  clientId: string | null;
  model: string | null;
  status: "ok" | "error" | "timeout";
  latencyMs: number;
  tokensIn: number | null;
  tokensOut: number | null;
  targetEndpoint: string;
  requestedAt: string;
}

export interface CoverageReport {
  /** Attributed traffic: proxied through the gateway for a configured client. */
  attributed: { requests: number; tokensIn: number; tokensOut: number; errors: number };
  /** Unattributed traffic: direct client traffic observed on the endpoint. */
  unattributed: { requests: number; tokensIn: number; tokensOut: number; errors: number };
  /** Provider totals stay separate from client attribution. */
  providerTotals: { requests: number; tokensIn: number; tokensOut: number };
}

interface ClientRow {
  id: string;
  host_id: string;
  client_name: string;
  model: string;
  target_endpoint: string;
  enabled: number;
  created_at: string;
}

interface RequestRow {
  id: string;
  host_id: string;
  client_id: string | null;
  model: string | null;
  status: string;
  latency_ms: number;
  tokens_in: number | null;
  tokens_out: number | null;
  target_endpoint: string;
  requested_at: string;
}

/**
 * Observability Gateway storage (issue #12): records attribution METRICS
 * (client, model, token counts, latency, error, target endpoint, coverage)
 * while never storing request or response bodies. Provider totals are kept
 * separate; direct traffic appears as unattributed coverage.
 */
export class GatewayStore {
  constructor(private readonly db: Db, private readonly hostId: string) {}

  registerClient(input: { clientName: string; model: string; targetEndpoint: string }): GatewayClient {
    const client: GatewayClient = {
      id: `gateway:${nanoid(8)}`,
      hostId: this.hostId,
      clientName: input.clientName,
      model: input.model,
      targetEndpoint: input.targetEndpoint,
      enabled: true,
      createdAt: new Date().toISOString()
    };
    this.db
      .prepare(
        `INSERT INTO gateway_clients (id, host_id, client_name, model, target_endpoint, enabled, created_at)
         VALUES (?, ?, ?, ?, ?, 1, ?)`
      )
      .run(client.id, client.hostId, client.clientName, client.model, client.targetEndpoint, client.createdAt);
    return client;
  }

  listClients(): GatewayClient[] {
    const rows = this.db
      .prepare("SELECT * FROM gateway_clients WHERE host_id = ? ORDER BY created_at")
      .all(this.hostId) as unknown as ClientRow[];
    return rows.map((row) => ({
      id: row.id,
      hostId: row.host_id,
      clientName: row.client_name,
      model: row.model,
      targetEndpoint: row.target_endpoint,
      enabled: row.enabled === 1,
      createdAt: row.created_at
    }));
  }

  recordRequest(input: Omit<GatewayRequestRecord, "id" | "hostId" | "requestedAt">): GatewayRequestRecord {
    const record: GatewayRequestRecord = {
      ...input,
      id: `req:${nanoid(10)}`,
      hostId: this.hostId,
      requestedAt: new Date().toISOString()
    };
    this.db
      .prepare(
        `INSERT INTO gateway_requests
         (id, host_id, client_id, model, status, latency_ms, tokens_in, tokens_out, target_endpoint, requested_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        record.id,
        record.hostId,
        record.clientId,
        record.model,
        record.status,
        record.latencyMs,
        record.tokensIn,
        record.tokensOut,
        record.targetEndpoint,
        record.requestedAt
      );
    return record;
  }

  recent(limit = 50): GatewayRequestRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM gateway_requests WHERE host_id = ? ORDER BY requested_at DESC LIMIT ?")
      .all(this.hostId, limit) as unknown as RequestRow[];
    return rows.map((row) => ({
      id: row.id,
      hostId: row.host_id,
      clientId: row.client_id,
      model: row.model,
      status: row.status as GatewayRequestRecord["status"],
      latencyMs: row.latency_ms,
      tokensIn: row.tokens_in,
      tokensOut: row.tokens_out,
      targetEndpoint: row.target_endpoint,
      requestedAt: row.requested_at
    }));
  }

  /** Coverage report without double counting: attributed + unattributed = provider totals. */
  coverage(): CoverageReport {
    const totals = (clientFilter: string) => {
      const row = this.db
        .prepare(
          `SELECT
             COUNT(*) AS requests,
             COALESCE(SUM(CASE WHEN tokens_in IS NOT NULL THEN tokens_in ELSE 0 END), 0) AS tokens_in,
             COALESCE(SUM(CASE WHEN tokens_out IS NOT NULL THEN tokens_out ELSE 0 END), 0) AS tokens_out,
             COALESCE(SUM(CASE WHEN status = 'error' OR status = 'timeout' THEN 1 ELSE 0 END), 0) AS errors
           FROM gateway_requests WHERE host_id = ? AND ${clientFilter}`
        )
        .get(this.hostId) as { requests: number; tokens_in: number; tokens_out: number; errors: number };
      return { requests: row.requests, tokensIn: row.tokens_in, tokensOut: row.tokens_out, errors: row.errors };
    };

    const attributed = totals("client_id IS NOT NULL");
    const unattributed = totals("client_id IS NULL");
    const provider = totals("1=1");

    return {
      attributed,
      unattributed,
      providerTotals: {
        requests: provider.requests,
        tokensIn: provider.tokensIn,
        tokensOut: provider.tokensOut
      }
    };
  }
}