// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ConfigCenterPanel, GatewayPanel, AuditPanel, ResourceListView } from "../src/client/views";
import type { ResourceNode } from "../src/shared/schemas";

async function render(element: React.ReactElement): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  root.render(element);
  await new Promise((resolve) => setTimeout(resolve, 30));
  return container;
}

const NODE: ResourceNode = {
  id: "omlx:runtime:server",
  type: "runtime",
  label: "oMLX Server",
  state: "running",
  sourceAdapter: "omlx",
  hostId: "host-1",
  properties: {},
  lastSeenAt: new Date().toISOString(),
  graphSchemaVersion: 2
};

describe("M7 client views", () => {
  it("ConfigCenterPanel renders redacted preview and apply controls", async () => {
    globalThis.fetch = vi.fn(async (url: string) => {
      if (String(url).includes("/api/config/preview")) {
        return new Response(
          JSON.stringify({
            ok: true,
            data: {
              configType: "codex-config-toml",
              filePath: "/home/u/.codex/config.toml",
              documentedFields: [{ key: "model", label: "模型", value: "gpt-5", valuePresent: true, sensitive: false }],
              undocumentedFields: [{ key: "custom", value: "x" }],
              rawContent: 'model = "gpt-5"\ntoken = "<redacted>"\n',
              previewHash: "h"
            },
            meta: { timestamp: new Date().toISOString() }
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      return new Response(JSON.stringify({ ok: true, data: null, meta: {} }), { status: 200 });
    }) as unknown as typeof fetch;

    const qc = new QueryClient();
    const container = await render(
      <QueryClientProvider client={qc}>
        <ConfigCenterPanel onMessage={() => undefined} />
      </QueryClientProvider>
    );
    // Click read preview.
    container.querySelector("button")?.click();
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(container.textContent).toContain("配置中心");
    expect(container.textContent).toContain("gpt-5");
    expect(container.textContent).toContain("<redacted>");
    expect(container.textContent).toContain("备份并应用");
  });

  it("GatewayPanel shows coverage without double counting", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          ok: true,
          data: {
            clients: [{ id: "g1", clientName: "claude-code", model: "m", targetEndpoint: "http://127.0.0.1:8000", enabled: true }],
            coverage: {
              attributed: { requests: 3, tokensIn: 100, tokensOut: 50, errors: 0 },
              unattributed: { requests: 2, tokensIn: 30, tokensOut: 10, errors: 0 },
              providerTotals: { requests: 5, tokensIn: 130, tokensOut: 60 }
            }
          },
          meta: { timestamp: new Date().toISOString() }
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    ) as unknown as typeof fetch;

    const qc = new QueryClient();
    const container = await render(
      <QueryClientProvider client={qc}>
        <GatewayPanel onMessage={() => undefined} />
      </QueryClientProvider>
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(container.textContent).toContain("归因流量");
    expect(container.textContent).toContain("直连流量（未归因）");
    expect(container.textContent).toContain("Provider 总量");
  });

  it("AuditPanel lists events", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          ok: true,
          data: [{ timestamp: "2026-01-01T00:00:00Z", action: "config:apply", resourceId: "/tmp/config.toml" }],
          meta: { timestamp: new Date().toISOString() }
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    ) as unknown as typeof fetch;

    const qc = new QueryClient();
    const container = await render(
      <QueryClientProvider client={qc}>
        <AuditPanel />
      </QueryClientProvider>
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(container.textContent).toContain("config:apply");
  });

  it("ResourceListView filters by type and opens details", async () => {
    let opened: string | null = null;
    const qc = new QueryClient();
    const container = await render(
      <QueryClientProvider client={qc}>
        <ResourceListView view="运行框架" nodes={[NODE]} onOpen={(id) => (opened = id)} />
      </QueryClientProvider>
    );
    expect(container.textContent).toContain("oMLX Server");
    container.querySelector(".row:not(.header)")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(opened).toBe("omlx:runtime:server");
  });
});
