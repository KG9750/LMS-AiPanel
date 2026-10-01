import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

export interface ProjectModelTokenUsage {
  model: string;
  displayName: string;
  inputTokens: number;
  outputTokens: number;
  cacheTokens: number;
  totalTokens: number;
  percentage: number;
  costUSD?: number;
}

export interface TokenProjectItem {
  rank: number;
  id: string;
  name: string;
  path: string;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheTokens: number;
  costUSD: number;
  lastActive: string;
  models: ProjectModelTokenUsage[];
}

export interface TopTokenProjectsReport {
  topProjects: TokenProjectItem[];
  totalTrackedTokens: number;
  totalTrackedCostUSD: number;
  overallModelBreakdown: Array<{ model: string; tokens: number; percentage: number }>;
  updatedAt: string;
}

let cachedProjectsReport: TopTokenProjectsReport | null = null;
let lastCollectedAt = 0;

/** Clean project name for UI presentation */
function formatProjectName(rawPath: string): string {
  if (rawPath === "/Users/leo" || rawPath === os.homedir()) return "根目录工作区 (~/)";
  const parts = rawPath.split("/").filter(Boolean);
  if (parts.length >= 2) {
    const last = parts[parts.length - 1];
    const prev = parts[parts.length - 2];
    if (prev === "Projects" || prev === "Novel" || prev === "Godot") {
      return `${prev} / ${last}`;
    }
    return last;
  }
  return parts.pop() || rawPath;
}

function formatLastActive(raw: any): string {
  if (typeof raw === "number" && raw > 1000000000000) {
    const d = new Date(raw);
    if (!isNaN(d.getTime())) {
      return (
        d.toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" }) +
        " " +
        d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })
      );
    }
  }
  if (typeof raw === "string" && raw.length > 8 && raw !== "true" && raw !== "false") {
    const d = new Date(raw);
    if (!isNaN(d.getTime())) {
      return (
        d.toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" }) +
        " " +
        d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })
      );
    }
  }
  return "近期活跃";
}

export async function collectTopTokenProjects(forceFresh = false): Promise<TopTokenProjectsReport> {
  const now = Date.now();
  if (!forceFresh && cachedProjectsReport && now - lastCollectedAt < 5000) {
    return cachedProjectsReport;
  }

  const homedir = os.homedir();
  const rawProjects: Record<string, any> = {};

  try {
    const raw = await fs.readFile(path.join(homedir, ".claude.json"), "utf8");
    const parsed = JSON.parse(raw);
    Object.assign(rawProjects, parsed.projects ?? {});
  } catch {
    // fallback if unreadable
  }

  const projectList: Array<{
    path: string;
    name: string;
    totalTokens: number;
    inputTokens: number;
    outputTokens: number;
    cacheTokens: number;
    costUSD: number;
    lastActive: string;
    modelUsageMap: Record<string, { in: number; out: number; cache: number; cost: number }>;
  }> = [];

  const overallModelMap: Record<string, number> = {};

  for (const [projPath, projData] of Object.entries(rawProjects)) {
    if (!projData || typeof projData !== "object") continue;

    const models = (projData as any).models ?? (projData as any).lastModelUsage ?? {};
    let projIn = Number((projData as any).lastTotalInputTokens ?? 0);
    let projOut = Number((projData as any).lastTotalOutputTokens ?? 0);
    let projCache = Number((projData as any).lastTotalCacheReadInputTokens ?? 0) + Number((projData as any).lastTotalCacheCreationInputTokens ?? 0);
    let projCost = Number((projData as any).lastCost ?? 0);
    const lastActive = formatLastActive((projData as any).lastSessionModified || (projData as any).lastStartTime);

    const modelUsageMap: Record<string, { in: number; out: number; cache: number; cost: number }> = {};

    let modelSumTotal = 0;
    for (const [modelName, mData] of Object.entries(models)) {
      const u = mData as any;
      const mIn = Number(u.inputTokens ?? 0);
      const mOut = Number(u.outputTokens ?? 0);
      const mCache = Number(u.cacheReadInputTokens ?? 0) + Number(u.cacheCreationInputTokens ?? 0);
      const mCost = Number(u.costUSD ?? 0);
      const mTotal = mIn + mOut + mCache;

      modelUsageMap[modelName] = { in: mIn, out: mOut, cache: mCache, cost: mCost };
      modelSumTotal += mTotal;
      overallModelMap[modelName] = (overallModelMap[modelName] ?? 0) + mTotal;
      if (mCost > 0 && projCost === 0) {
        projCost += mCost;
      }
    }

    let calculatedTotal = projIn + projOut + projCache;
    if (modelSumTotal > calculatedTotal) {
      calculatedTotal = modelSumTotal;
    }

    // Skip empty project records
    if (calculatedTotal === 0 && projIn === 0 && projOut === 0) continue;

    projectList.push({
      path: projPath,
      name: formatProjectName(projPath),
      totalTokens: calculatedTotal,
      inputTokens: projIn,
      outputTokens: projOut,
      cacheTokens: projCache,
      costUSD: Number(projCost.toFixed(4)),
      lastActive,
      modelUsageMap
    });
  }

  // Sort descending by totalTokens
  projectList.sort((a, b) => b.totalTokens - a.totalTokens);

  // Take top 10
  const top10 = projectList.slice(0, 10).map((proj, idx) => {
    const modelsArr: ProjectModelTokenUsage[] = [];
    const projTotal = Math.max(1, proj.totalTokens);

    for (const [mName, u] of Object.entries(proj.modelUsageMap)) {
      const mTotal = u.in + u.out + u.cache;
      if (mTotal === 0 && u.in === 0) continue;
      modelsArr.push({
        model: mName,
        displayName: formatModelDisplayName(mName),
        inputTokens: u.in,
        outputTokens: u.out,
        cacheTokens: u.cache,
        totalTokens: mTotal,
        percentage: Math.min(100, Math.round((mTotal / projTotal) * 100)),
        costUSD: u.cost > 0 ? Number(u.cost.toFixed(4)) : undefined
      });
    }

    // Sort project models by tokens desc
    modelsArr.sort((a, b) => b.totalTokens - a.totalTokens);

    return {
      rank: idx + 1,
      id: `top-proj-${idx + 1}`,
      name: proj.name,
      path: proj.path,
      totalTokens: proj.totalTokens,
      inputTokens: proj.inputTokens,
      outputTokens: proj.outputTokens,
      cacheTokens: proj.cacheTokens,
      costUSD: proj.costUSD,
      lastActive: proj.lastActive,
      models: modelsArr
    };
  });

  const totalTrackedTokens = projectList.reduce((acc, p) => acc + p.totalTokens, 0);
  const totalTrackedCostUSD = Number(projectList.reduce((acc, p) => acc + p.costUSD, 0).toFixed(2));

  const overallModelBreakdown = Object.entries(overallModelMap)
    .map(([model, tokens]) => ({
      model: formatModelDisplayName(model),
      tokens,
      percentage: totalTrackedTokens > 0 ? Math.round((tokens / totalTrackedTokens) * 100) : 0
    }))
    .sort((a, b) => b.tokens - a.tokens);

  const report: TopTokenProjectsReport = {
    topProjects: top10,
    totalTrackedTokens,
    totalTrackedCostUSD,
    overallModelBreakdown,
    updatedAt: new Date().toISOString()
  };

  cachedProjectsReport = report;
  lastCollectedAt = now;
  return report;
}

function formatModelDisplayName(raw: string): string {
  if (raw === "deepseek-v4-pro") return "DeepSeek-V4 Pro";
  if (raw === "deepseek-v4-flash") return "DeepSeek-V4 Flash";
  if (raw === "glm-5.3-flash-pipenetwork-6bit") return "GLM-5.3 Flash (本地 6-bit)";
  if (raw === "claude-local-qwen38") return "Qwen 3.8B (本地)";
  if (raw.includes("gpt-6.1")) return "GPT-6.1 Sol";
  if (raw.includes("sonnet")) return "Claude 3.7 Sonnet";
  return raw;
}
