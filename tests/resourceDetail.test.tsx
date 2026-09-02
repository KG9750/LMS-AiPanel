// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ResourceDetail } from "../src/client/resourceDetail";

function render(element: React.ReactElement): HTMLElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  root.render(element);
  return container;
}

const DETAIL = {
  resource: {
    id: "omlx:runtime:server",
    type: "runtime",
    label: "oMLX Server",
    state: "running",
    sourceAdapter: "omlx",
    hostId: "host-1",
    properties: { evidence: ["process pid=123"] },
    lastSeenAt: "2026-01-01T00:00:00.000Z",
    graphSchemaVersion: 2
  },
  host: { hostId: "host-1", hostName: "macbook", scope: "local", createdAt: "2026-01-01T00:00:00.000Z", lastSeenAt: "2026-01-01T00:00:00.000Z" },
  managed: true,
  capabilities: [{ capability: "action-start", status: "supported" }],
  relations: [{ relation: "exposes", direction: "outgoing", otherId: "omlx:endpoint:8000", otherLabel: "oMLX API" }],
  telemetry: [{ scope: "omlx:runtime:server", metric: "memory_kb", current: 2048, delta: 128 }],
  drift: [],
  actionHistory: [],
  availableActions: ["start", "stop"],
  evidence: [{ text: "process pid=123", source: "omlx", observedAt: "2026-01-01T00:00:00.000Z" }]
};

describe("ResourceDetail (browser)", () => {
  it("shows identity, host scope, managed status, and evidence with source/time", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ ok: true, data: DETAIL, meta: { timestamp: new Date().toISOString() } }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      })
    ) as unknown as typeof fetch;

    const queryClient = new QueryClient();
    const container = render(
      <QueryClientProvider client={queryClient}>
        <ResourceDetail resourceId="omlx:runtime:server" onClose={() => undefined} />
      </QueryClientProvider>
    );

    // Wait for the async query to resolve.
    await vi.waitFor(() => {
      expect(container.textContent).toContain("oMLX Server");
    });

    expect(container.textContent).toContain("omlx:runtime:server");
    expect(container.textContent).toContain("macbook");
    expect(container.textContent).toContain("受管（可执行声明动作）");
    expect(container.textContent).toContain("process pid=123");
    expect(container.textContent).toContain("source=omlx");
    // Unsupported/unavailable capabilities are explained, not failed.
    expect(container.textContent).toContain("action-start · 支持");
    // Available actions visible but gated by the Action Gateway.
    expect(container.textContent).toContain("start");
    expect(container.textContent).toContain("Action Gateway");
  });

  it("explains unmanaged resources as read-only", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({ ok: true, data: { ...DETAIL, managed: false, availableActions: [] }, meta: { timestamp: new Date().toISOString() } }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    ) as unknown as typeof fetch;

    const queryClient = new QueryClient();
    const container = render(
      <QueryClientProvider client={queryClient}>
        <ResourceDetail resourceId="omlx:runtime:server" onClose={() => undefined} />
      </QueryClientProvider>
    );

    await vi.waitFor(() => {
      expect(container.textContent).toContain("仅发现（只读）");
    });
    expect(container.textContent).toContain("资源未受管，动作不可执行（仅读）");
  });
});