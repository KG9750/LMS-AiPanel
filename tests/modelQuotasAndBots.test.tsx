// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { collectModelQuotas } from "../src/domain/modelQuotas";
import { collectTopTokenProjects } from "../src/domain/tokenProjects";
import { collectBotStatus } from "../src/domain/botMonitor";
import { ModelQuotasPanel } from "../src/client/modelQuotasView";
import { TokenProjectsPanel } from "../src/client/tokenProjectsView";
import { BotMonitorPanel } from "../src/client/botMonitorView";
import { buildApp } from "../src/server/app";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

async function render(element: React.ReactElement): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  root.render(element);
  await new Promise((resolve) => setTimeout(resolve, 60));
  return container;
}

describe("Model Quotas, Token Projects, and Bot Monitor", () => {
  it("collectModelQuotas collects cloud models and active local models", async () => {
    const report = await collectModelQuotas(true);
    expect(report.cloudModels.length).toBeGreaterThanOrEqual(4);
    
    // Check cloud models contain Codex, Claude, DeepSeek, Antigravity
    const names = report.cloudModels.map((m) => m.name);
    expect(names).toContain("OpenAI Codex");
    expect(names).toContain("Claude Code");
    expect(names).toContain("DeepSeek API");
    expect(names).toContain("Google Antigravity");

    // Check weekly and 5h limit fields
    for (const m of report.cloudModels) {
      expect(m.weeklyLimit.total).toBeGreaterThan(0);
      expect(m.fiveHourLimit.total).toBeGreaterThan(0);
      expect(m.fiveHourLimit.resetCountdown).toBeDefined();
      expect(m.accountExpiration).toBeDefined();
      expect(m.tokens.total).toBeGreaterThanOrEqual(0);
    }

    // Check local models contain ports
    expect(report.localModels.length).toBeGreaterThan(0);
    const ports = report.localModels.map((l) => l.port);
    expect(ports).toContain(18185);
    expect(ports).toContain(18186);
  });

  it("collectTopTokenProjects returns top 10 projects with model breakdown", async () => {
    const report = await collectTopTokenProjects(true);
    expect(report.topProjects.length).toBeLessThanOrEqual(10);
    expect(report.totalTrackedTokens).toBeGreaterThan(0);

    if (report.topProjects.length > 0) {
      const top1 = report.topProjects[0];
      expect(top1.rank).toBe(1);
      expect(top1.totalTokens).toBeGreaterThan(0);
      expect(top1.models.length).toBeGreaterThan(0);
      expect(top1.models[0].displayName).toBeDefined();
    }
  });

  it("collectBotStatus discovers Grok, Muse, Dot, Feishu, WeCom, Telegram, Discord, Hermes", async () => {
    const report = await collectBotStatus(true);
    expect(report.bots.length).toBeGreaterThanOrEqual(7);

    const names = report.bots.map((b) => b.name);
    expect(names).toContain("Grok Bot");
    expect(names).toContain("Muse Bot");
    expect(names).toContain("Dot");
    expect(names).toContain("PaperLib 飞书 Bot");
    expect(names).toContain("企业微信 Obsidian Bot");
    expect(names).toContain("Telegram Bot (OpenClaw / Hermes)");
    expect(names).toContain("Discord Bot (Hermes Agent)");
    expect(names).toContain("Hermes Codex 核心智能体");

    for (const bot of report.bots) {
      expect(["running", "idle", "warning", "stopped"]).toContain(bot.status);
      expect(bot.boundModel).toBeDefined();
      expect(bot.healthEvidence.length).toBeGreaterThan(0);
    }
  });

  it("GET /api/models/quotas, /api/tokens/top-projects, /api/bots/monitor return valid JSON", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "lms-test-api-"));
    const { app } = await buildApp({ dataDir: tmp });

    const resQuotas = await app.inject({ method: "GET", url: "/api/models/quotas" });
    expect(resQuotas.statusCode).toBe(200);
    const bodyQuotas = JSON.parse(resQuotas.body);
    expect(bodyQuotas.ok).toBe(true);
    expect(bodyQuotas.data.cloudModels).toBeDefined();
    expect(bodyQuotas.data.localModels).toBeDefined();

    const resTokens = await app.inject({ method: "GET", url: "/api/tokens/top-projects" });
    expect(resTokens.statusCode).toBe(200);
    const bodyTokens = JSON.parse(resTokens.body);
    expect(bodyTokens.ok).toBe(true);
    expect(bodyTokens.data.topProjects).toBeDefined();

    const resBots = await app.inject({ method: "GET", url: "/api/bots/monitor" });
    expect(resBots.statusCode).toBe(200);
    const bodyBots = JSON.parse(resBots.body);
    expect(bodyBots.ok).toBe(true);
    expect(bodyBots.data.bots).toBeDefined();

    await app.close();
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it("ModelQuotasPanel, TokenProjectsPanel, BotMonitorPanel render without crashing", async () => {
    const qc = new QueryClient();

    // Render ModelQuotasPanel
    const c1 = await render(
      <QueryClientProvider client={qc}>
        <ModelQuotasPanel defaultTab="cloud" />
      </QueryClientProvider>
    );
    expect(c1.textContent).toContain("模型资源监控中心");

    // Render TokenProjectsPanel
    const c2 = await render(
      <QueryClientProvider client={qc}>
        <TokenProjectsPanel />
      </QueryClientProvider>
    );
    expect(c2.textContent).toContain("Token 消耗排名前 10 项目");

    // Render BotMonitorPanel
    const c3 = await render(
      <QueryClientProvider client={qc}>
        <BotMonitorPanel />
      </QueryClientProvider>
    );
    expect(c3.textContent).toContain("全量 Bot 实时监控面板");
  });
});
