// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { collectSystemEnvironment } from "../src/domain/environment";
import { EnvironmentPanel } from "../src/client/environmentView";
import { buildApp } from "../src/server/app";
import type { SystemEnvironmentReport } from "../src/domain/environment";

const MOCK_ENV_REPORT: SystemEnvironmentReport = {
  timestamp: new Date().toISOString(),
  hardware: {
    model: "Mac15,14",
    cpuBrand: "Apple M3 Ultra",
    cpuCores: 32,
    arch: "arm64",
    totalMemoryBytes: 549755813888,
    freeMemoryBytes: 89060753408,
    usedMemoryBytes: 460695060480,
    memoryUsagePercent: 84,
    powerSource: "AC Power",
    uptimeSeconds: 120000,
    bootTime: new Date().toISOString()
  },
  os: {
    platform: "darwin",
    productName: "macOS",
    productVersion: "26.6.2",
    buildVersion: "25G83",
    kernelVersion: "25.0.0",
    hostname: "LMS.local",
    username: "leo",
    homeDir: "/Users/leo"
  },
  network: {
    interfaces: [
      {
        name: "en1",
        family: "IPv4",
        address: "192.168.50.191",
        netmask: "255.255.255.0",
        mac: "00:11:22:33:44:55",
        internal: false,
        type: "wifi"
      },
      {
        name: "utun1024",
        family: "IPv4",
        address: "198.18.0.1",
        netmask: "255.255.255.252",
        mac: "none",
        internal: false,
        type: "vpn"
      }
    ],
    vpn: {
      active: true,
      detectedType: "Clash/Surge Fake-IP 虚拟子网 (utun1024: 198.18.0.1)",
      interfaces: ["utun1024", "utun1"],
      details: ["Clash/Surge Fake-IP 虚拟子网"]
    },
    proxy: {
      enabled: true,
      httpProxy: "127.0.0.1:7897",
      httpsProxy: "127.0.0.1:7897",
      socksProxy: "127.0.0.1:7897",
      exceptions: ["127.0.0.1", "localhost"],
      envProxies: { http_proxy: "http://127.0.0.1:7897" }
    },
    dns: ["198.18.0.2"]
  },
  listeningPorts: [
    {
      protocol: "tcp",
      port: 3777,
      address: "127.0.0.1",
      pid: 85552,
      command: "node",
      user: "leo",
      serviceTag: "LMS-AiPanel 控制面",
      category: "ai"
    },
    {
      protocol: "tcp",
      port: 8780,
      address: "127.0.0.1",
      pid: 62083,
      command: "python3.1",
      user: "leo",
      serviceTag: "Python AI 运行时 / oMLX",
      category: "ai"
    }
  ],
  storage: [
    {
      filesystem: "/dev/disk3s1s1",
      mountPoint: "/",
      size: "1.8Ti",
      used: "12Gi",
      avail: "926Gi",
      capacity: "2%",
      category: "system"
    },
    {
      filesystem: "/dev/disk7s1",
      mountPoint: "/Volumes/Leo_LLM",
      size: "1.8Ti",
      used: "1.7Ti",
      avail: "143Gi",
      capacity: "93%",
      category: "model-volume"
    }
  ],
  toolchain: [
    { name: "Node.js", version: "v26.5.0", status: "installed" },
    { name: "Python 3", version: "Python 3.14.7", status: "installed" }
  ],
  aiRuntimes: [
    { name: "MLX / oMLX", status: "running", details: "Apple Silicon Metal 统一内存原生加速推理", port: 8780 }
  ]
};

async function render(element: React.ReactElement): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  root.render(element);
  await new Promise((resolve) => setTimeout(resolve, 30));
  return container;
}

describe("LMS Local Environment module", () => {
  it("collects system environment with hardware, network, and storage", async () => {
    const report = await collectSystemEnvironment(true);
    expect(report.hardware.arch).toBeDefined();
    expect(report.hardware.totalMemoryBytes).toBeGreaterThan(0);
    expect(report.os.platform).toBe("darwin");
    expect(Array.isArray(report.network.interfaces)).toBe(true);
    expect(Array.isArray(report.listeningPorts)).toBe(true);
    expect(Array.isArray(report.storage)).toBe(true);
    expect(Array.isArray(report.toolchain)).toBe(true);
  });

  it("exposes /api/environment endpoint returning structured envelope", async () => {
    const { app } = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/api/environment"
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.ok).toBe(true);
    expect(body.data.hardware).toBeDefined();
    expect(body.data.network).toBeDefined();
    expect(body.data.listeningPorts).toBeDefined();
    await app.close();
  });

  it("renders EnvironmentPanel with mock data", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          ok: true,
          data: MOCK_ENV_REPORT,
          meta: { timestamp: new Date().toISOString() }
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    ) as unknown as typeof fetch;

    const qc = new QueryClient();
    const container = await render(
      <QueryClientProvider client={qc}>
        <EnvironmentPanel />
      </QueryClientProvider>
    );

    expect(container.textContent).toContain("Apple M3 Ultra");
    expect(container.textContent).toContain("macOS 26.6.2");
    expect(container.textContent).toContain("127.0.0.1:7897");
    expect(container.textContent).toContain("Leo_LLM");
    expect(container.textContent).toContain("LMS-AiPanel 控制面");
    expect(container.textContent).toContain(":3777");
  });
});
