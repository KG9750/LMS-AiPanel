import type { FastifyRequest, FastifyReply } from "fastify";
import type { GatewayStore } from "../storage/gateway";

/**
 * Minimal local OpenAI-compatible gateway route (issue #12): forwards
 * chat/completions to the selected managed local endpoint and records
 * attribution METRICS only — never request or response bodies. Direct
 * traffic on the same endpoint is recorded separately as unattributed
 * coverage by the endpoint-level collector.
 */
export class ObservabilityGateway {
  constructor(private readonly store: GatewayStore) {}

  async proxy(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const started = Date.now();
    const clientName = (request.headers["x-lms-client"] as string | undefined) ?? null;

    // Select the client explicitly by header. Traffic without a client
    // header is DIRECT traffic and must appear as unattributed coverage,
    // never auto-attributed to a client.
    const clients = this.store.listClients().filter((client) => client.enabled);
    const client = clientName ? clients.find((c) => c.clientName === clientName) : undefined;

    if (!client) {
      this.store.recordRequest({
        clientId: null,
        model: null,
        status: "error",
        latencyMs: Date.now() - started,
        tokensIn: null,
        tokensOut: null,
        targetEndpoint: "none"
      });
      reply.code(404).send({ error: { message: "no enabled gateway client matches this request" } });
      return;
    }

    // Body is read only to extract metric-relevant fields; it is never stored.
    const raw = request.body as { model?: string; messages?: Array<{ role?: string }> };
    const model = raw?.model ?? client.model;
    const promptTokens = Array.isArray(raw?.messages) ? estimateTokens(raw.messages) : null;

    try {
      const target = `${client.targetEndpoint.replace(/\/$/, "")}/v1/chat/completions`;
      const upstream = await fetch(target, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        // Fastify already parsed the body; re-serialize it for the upstream.
        body: typeof request.body === "string" ? request.body : JSON.stringify(request.body ?? {}),
        signal: AbortSignal.timeout(30_000)
      });

      // Stream or JSON response — metrics only. The upstream body is read
      // EXACTLY ONCE and forwarded verbatim; never stored.
      const isStream = upstream.headers.get("content-type")?.includes("text/event-stream") ?? false;
      const bodyText = await upstream.text();
      let completionTokens: number | null = null;
      let promptTokensFromUpstream: number | null = null;
      if (isStream) {
        completionTokens = extractStreamUsage(bodyText);
      } else {
        try {
          const json = JSON.parse(bodyText) as { usage?: { prompt_tokens?: number; completion_tokens?: number } };
          promptTokensFromUpstream = json.usage?.prompt_tokens ?? null;
          completionTokens = json.usage?.completion_tokens ?? null;
        } catch {
          completionTokens = null;
        }
      }

      const latencyMs = Date.now() - started;
      const status: "ok" | "error" = upstream.ok ? "ok" : "error";

      this.store.recordRequest({
        clientId: client.id,
        model,
        status,
        latencyMs,
        // Prefer upstream-reported usage; fall back to the message-count
        // estimate only when the endpoint provides no usage.
        tokensIn: promptTokensFromUpstream ?? promptTokens,
        tokensOut: completionTokens,
        targetEndpoint: client.targetEndpoint
      });

      // Forward the upstream body verbatim to the client.
      reply.code(upstream.status).type(upstream.headers.get("content-type") ?? "application/json");
      if (isStream) {
        reply.raw.write(bodyText);
        reply.raw.end();
        return;
      }
      reply.send(bodyText);
    } catch (error) {
      this.store.recordRequest({
        clientId: client.id,
        model,
        status: "timeout",
        latencyMs: Date.now() - started,
        tokensIn: promptTokens,
        tokensOut: null,
        targetEndpoint: client.targetEndpoint
      });
      reply.code(502).send({ error: { message: error instanceof Error ? error.message : String(error) } });
    }
  }
}

function estimateTokens(messages: Array<{ role?: string }>): number {
  // Order-of-magnitude estimate from roles only — never content.
  return messages.length * 4;
}

function extractStreamUsage(text: string): number | null {
  // OpenAI stream chunks carry usage in the final chunk; sum nothing, just
  // report the final usage when present.
  const match = text.match(/"completion_tokens"\s*:\s*(\d+)/g);
  if (!match) return null;
  const last = match[match.length - 1].match(/(\d+)/);
  return last ? Number(last[1]) : null;
}