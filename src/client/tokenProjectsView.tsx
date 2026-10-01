import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import type { TokenProjectItem, TopTokenProjectsReport } from "../domain/tokenProjects";
import { readFetch } from "./api";

const MODEL_COLORS: Record<string, string> = {
  "deepseek-v4-pro": "#38bdf8",
  "DeepSeek-V4 Pro": "#38bdf8",
  "deepseek-v4-flash": "#34d399",
  "DeepSeek-V4 Flash": "#34d399",
  "glm-5.3-flash-pipenetwork-6bit": "#f59e0b",
  "GLM-5.3 Flash (本地 6-bit)": "#f59e0b",
  "claude-local-qwen38": "#a855f7",
  "Qwen 3.8B (本地)": "#a855f7",
  "gpt-6.1-sol": "#10b981",
  "GPT-6.1 Sol": "#10b981",
  "claude-3-7-sonnet": "#fb923c",
  "Claude 3.7 Sonnet": "#fb923c"
};

function getModelColor(name: string): string {
  return MODEL_COLORS[name] ?? "#818cf8";
}

export function TokenProjectsPanel() {
  const [filterQuery, setFilterQuery] = useState("");

  const { data, isLoading, refetch, isFetching } = useQuery<TopTokenProjectsReport>({
    queryKey: ["top-token-projects"],
    queryFn: () => readFetch<TopTokenProjectsReport>("/api/tokens/top-projects"),
    refetchInterval: 15_000
  });

  const projects = data?.topProjects ?? [];
  const filtered = useMemo(
    () =>
      filterQuery
        ? projects.filter(
            (p) =>
              p.name.toLowerCase().includes(filterQuery.toLowerCase()) ||
              p.path.toLowerCase().includes(filterQuery.toLowerCase()) ||
              p.models.some((m) => m.displayName.toLowerCase().includes(filterQuery.toLowerCase()))
          )
        : projects,
    [projects, filterQuery]
  );

  const totalTokens = data?.totalTrackedTokens ?? 0;
  const totalCost = data?.totalTrackedCostUSD ?? 0;
  const overallBreakdown = data?.overallModelBreakdown ?? [];

  return (
    <div className="panel" style={{ padding: "20px 24px" }}>
      {/* Top Title Bar */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20, flexWrap: "wrap", gap: 12 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 20, fontWeight: 700, color: "#f8fafc", display: "flex", alignItems: "center", gap: 8 }}>
            <span>📊</span> Token 消耗排名前 10 项目
          </h2>
          <div style={{ color: "#64748b", fontSize: 13, marginTop: 4 }}>
            实时监控全工作栈工程项目的总 Token 消耗量，以及各项目细分到每个大模型的来源占比与成本
          </div>
        </div>

        <button
          className="top-btn"
          onClick={() => void refetch()}
          disabled={isFetching}
          style={{ fontSize: 12, padding: "7px 12px" }}
        >
          {isFetching ? "刷新中..." : "🔄 刷新"}
        </button>
      </div>

      {/* Aggregate Stat Cards */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 14, marginBottom: 22 }}>
        <div style={{ background: "#090e1a", border: "1px solid #1e2a42", borderRadius: 8, padding: 14 }}>
          <div style={{ color: "#64748b", fontSize: 11, fontWeight: 600, textTransform: "uppercase" }}>总追踪消耗 Token</div>
          <div style={{ fontSize: 22, fontWeight: 800, color: "#38bdf8", marginTop: 4 }}>
            {(totalTokens / 1_000_000).toFixed(2)} M
          </div>
          <div style={{ color: "#94a3b8", fontSize: 11, marginTop: 2 }}>{totalTokens.toLocaleString()} tokens</div>
        </div>

        <div style={{ background: "#090e1a", border: "1px solid #1e2a42", borderRadius: 8, padding: 14 }}>
          <div style={{ color: "#64748b", fontSize: 11, fontWeight: 600, textTransform: "uppercase" }}>上榜工程数</div>
          <div style={{ fontSize: 22, fontWeight: 800, color: "#34d399", marginTop: 4 }}>
            {projects.length} 个项目
          </div>
          <div style={{ color: "#94a3b8", fontSize: 11, marginTop: 2 }}>按实际消耗实时降序排列</div>
        </div>

        <div style={{ background: "#090e1a", border: "1px solid #1e2a42", borderRadius: 8, padding: 14 }}>
          <div style={{ color: "#64748b", fontSize: 11, fontWeight: 600, textTransform: "uppercase" }}>预估总消耗成本</div>
          <div style={{ fontSize: 22, fontWeight: 800, color: "#f59e0b", marginTop: 4 }}>
            ${totalCost.toFixed(2)}
          </div>
          <div style={{ color: "#94a3b8", fontSize: 11, marginTop: 2 }}>基于云端 API 实际费率折算</div>
        </div>

        <div style={{ background: "#090e1a", border: "1px solid #1e2a42", borderRadius: 8, padding: 14 }}>
          <div style={{ color: "#64748b", fontSize: 11, fontWeight: 600, textTransform: "uppercase" }}>核心模型来源数</div>
          <div style={{ fontSize: 22, fontWeight: 800, color: "#a855f7", marginTop: 4 }}>
            {overallBreakdown.length} 种模型
          </div>
          <div style={{ color: "#94a3b8", fontSize: 11, marginTop: 2 }}>涵盖云端与本地混合路由</div>
        </div>
      </div>

      {/* Global Model Breakdown Legend */}
      <div style={{ background: "#0a101d", border: "1px solid #182236", borderRadius: 8, padding: "12px 16px", marginBottom: 20 }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: "#94a3b8", marginBottom: 8 }}>全量项目模型贡献分布：</div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
          {overallBreakdown.map((m) => {
            const col = getModelColor(m.model);
            return (
              <div key={m.model} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12 }}>
                <span style={{ width: 10, height: 10, borderRadius: "50%", background: col, display: "inline-block" }} />
                <span style={{ color: "#e2e8f0", fontWeight: 600 }}>{m.model}:</span>
                <span style={{ color: "#94a3b8" }}>{(m.tokens / 1_000_000).toFixed(2)}M ({m.percentage}%)</span>
              </div>
            );
          })}
        </div>
      </div>

      {/* Search Input */}
      <div style={{ marginBottom: 18 }}>
        <input
          placeholder="在 Top 10 中过滤项目名称、路径或模型来源..."
          value={filterQuery}
          onChange={(e) => setFilterQuery(e.target.value)}
          style={{
            width: "100%",
            boxSizing: "border-box",
            background: "#090e1a",
            border: "1px solid #1e2a42",
            borderRadius: 8,
            padding: "9px 14px",
            color: "#f8fafc",
            fontSize: 13,
            outline: "none"
          }}
        />
      </div>

      {isLoading && <p style={{ color: "#64748b", textAlign: "center", padding: 40 }}>正在聚合全工作栈项目 Token 数据...</p>}

      {/* Project Cards List */}
      <div style={{ display: "grid", gap: 14 }}>
        {filtered.map((proj) => (
          <ProjectRankCard key={proj.id} project={proj} maxTokens={projects[0]?.totalTokens || 1} />
        ))}
        {filtered.length === 0 && !isLoading && (
          <p className="empty" style={{ textAlign: "center", padding: 30 }}>暂无匹配的 Token 消耗项目。</p>
        )}
      </div>
    </div>
  );
}

function ProjectRankCard({ project, maxTokens }: { project: TokenProjectItem; maxTokens: number }) {
  const rankColors = ["#f59e0b", "#94a3b8", "#b45309"];
  const rankColor = project.rank <= 3 ? rankColors[project.rank - 1] : "#38bdf8";

  return (
    <div
      style={{
        background: "#090e1a",
        border: "1px solid #1e2a42",
        borderRadius: 10,
        padding: "16px 20px",
        boxShadow: "0 4px 12px rgba(0,0,0,0.15)"
      }}
    >
      {/* Top Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 8, marginBottom: 10 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          {/* Rank Badge */}
          <div
            style={{
              width: 32,
              height: 32,
              borderRadius: "50%",
              background: `${rankColor}20`,
              color: rankColor,
              border: `1px solid ${rankColor}60`,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontWeight: 800,
              fontSize: 14
            }}
          >
            {project.rank}
          </div>

          <div>
            <div style={{ fontSize: 16, fontWeight: 700, color: "#f8fafc" }}>{project.name}</div>
            <div style={{ color: "#64748b", fontSize: 11, fontFamily: "monospace", marginTop: 2 }}>{project.path}</div>
          </div>
        </div>

        <div style={{ textAlign: "right" }}>
          <div style={{ fontSize: 17, fontWeight: 800, color: "#38bdf8" }}>
            {project.totalTokens.toLocaleString()} <span style={{ fontSize: 12, fontWeight: 500, color: "#64748b" }}>Tokens</span>
          </div>
          <div style={{ color: "#94a3b8", fontSize: 11, marginTop: 2 }}>
            预估花费: <strong style={{ color: "#f59e0b" }}>${project.costUSD.toFixed(3)}</strong>
          </div>
        </div>
      </div>

      {/* Stacked Model Percentage Bar */}
      <div style={{ margin: "10px 0" }}>
        <div style={{ height: 8, background: "#151e30", borderRadius: 4, overflow: "hidden", display: "flex" }}>
          {project.models.map((m) => {
            const col = getModelColor(m.displayName);
            return (
              <div
                key={m.model}
                style={{
                  width: `${m.percentage}%`,
                  height: "100%",
                  background: col,
                  transition: "width 0.3s"
                }}
                title={`${m.displayName}: ${m.totalTokens.toLocaleString()} (${m.percentage}%)`}
              />
            );
          })}
        </div>
      </div>

      {/* Model Breakdown Badges */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 10 }}>
        {project.models.map((m) => {
          const col = getModelColor(m.displayName);
          return (
            <div
              key={m.model}
              style={{
                background: "#0c1322",
                border: "1px solid #1a253a",
                borderRadius: 6,
                padding: "5px 10px",
                fontSize: 12,
                display: "flex",
                alignItems: "center",
                gap: 6
              }}
            >
              <span style={{ width: 8, height: 8, borderRadius: "50%", background: col }} />
              <span style={{ color: "#cbd5e1", fontWeight: 600 }}>{m.displayName}</span>
              <span style={{ color: "#38bdf8", fontWeight: 700 }}>{(m.totalTokens / 1000).toFixed(1)}k</span>
              <span style={{ color: "#64748b", fontSize: 11 }}>({m.percentage}%)</span>
              {m.costUSD && m.costUSD > 0 && (
                <span style={{ color: "#f59e0b", fontSize: 11 }}>· ${m.costUSD.toFixed(2)}</span>
              )}
            </div>
          );
        })}
      </div>

      {/* Detailed IO tokens */}
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "#64748b", marginTop: 10, borderTop: "1px solid #131d2e", paddingTop: 8 }}>
        <div>
          输入: <span style={{ color: "#94a3b8" }}>{project.inputTokens.toLocaleString()}</span> ·
          输出: <span style={{ color: "#94a3b8", marginLeft: 4 }}>{project.outputTokens.toLocaleString()}</span> ·
          缓存读取: <span style={{ color: "#94a3b8", marginLeft: 4 }}>{project.cacheTokens.toLocaleString()}</span>
        </div>
        <div>最后活跃: {project.lastActive}</div>
      </div>
    </div>
  );
}
