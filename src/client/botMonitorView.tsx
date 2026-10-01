import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import type { BotMonitorReport, BotStatusItem } from "../domain/botMonitor";
import { readFetch } from "./api";

export function BotMonitorPanel() {
  const [platformFilter, setPlatformFilter] = useState<string>("all");
  const [searchFilter, setSearchFilter] = useState("");

  const { data, isLoading, refetch, isFetching } = useQuery<BotMonitorReport>({
    queryKey: ["bot-monitor"],
    queryFn: () => readFetch<BotMonitorReport>("/api/bots/monitor"),
    refetchInterval: 10_000
  });

  const bots = data?.bots ?? [];
  const runningCount = data?.runningCount ?? 0;
  const totalBots = data?.totalBots ?? 0;

  const filteredBots = useMemo(
    () =>
      bots.filter((b) => {
        const matchesPlatform =
          platformFilter === "all" ||
          (platformFilter === "running" && b.status === "running") ||
          (platformFilter === "feishu_wechat" && (b.platform.includes("飞书") || b.platform.includes("微信"))) ||
          (platformFilter === "chat_community" && (b.platform === "Discord" || b.platform === "Telegram")) ||
          (platformFilter === "desktop_agents" &&
            (b.platform === "xAI Grok" || b.platform === "Muse" || b.platform === "Dot AI" || b.platform.includes("Hermes")));

        const matchesSearch =
          b.name.toLowerCase().includes(searchFilter.toLowerCase()) ||
          b.displayName.toLowerCase().includes(searchFilter.toLowerCase()) ||
          b.platform.toLowerCase().includes(searchFilter.toLowerCase()) ||
          b.boundModel.toLowerCase().includes(searchFilter.toLowerCase());

        return matchesPlatform && matchesSearch;
      }),
    [bots, platformFilter, searchFilter]
  );

  return (
    <div className="panel" style={{ padding: "20px 24px" }}>
      {/* Top Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20, flexWrap: "wrap", gap: 12 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 20, fontWeight: 700, color: "#f8fafc", display: "flex", alignItems: "center", gap: 8 }}>
            <span>🤖</span> 全量 Bot 实时监控面板
          </h2>
          <div style={{ color: "#64748b", fontSize: 13, marginTop: 4 }}>
            实时监控全工作栈各类机器人与智能体：飞书 Bot、企业微信 Bot、Telegram/Discord (Hermes/OpenClaw)、Grok Bot、Muse、Dot
          </div>
        </div>

        <button
          className="top-btn"
          onClick={() => void refetch()}
          disabled={isFetching}
          style={{ fontSize: 12, padding: "7px 12px" }}
        >
          {isFetching ? "探测中..." : "🔄 实时刷新"}
        </button>
      </div>

      {/* Top Stat Summary Grid */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 14, marginBottom: 20 }}>
        <div style={{ background: "#090e1a", border: "1px solid #1e2a42", borderRadius: 8, padding: 14 }}>
          <div style={{ color: "#64748b", fontSize: 11, fontWeight: 600, textTransform: "uppercase" }}>运行中机器人</div>
          <div style={{ fontSize: 24, fontWeight: 800, color: "#34d399", marginTop: 4 }}>
            {runningCount} <span style={{ fontSize: 14, fontWeight: 500, color: "#64748b" }}>/ {totalBots} 个</span>
          </div>
          <div style={{ color: "#94a3b8", fontSize: 11, marginTop: 2 }}>健康运行率 {totalBots > 0 ? Math.round((runningCount / totalBots) * 100) : 0}%</div>
        </div>

        <div style={{ background: "#090e1a", border: "1px solid #1e2a42", borderRadius: 8, padding: 14 }}>
          <div style={{ color: "#64748b", fontSize: 11, fontWeight: 600, textTransform: "uppercase" }}>覆盖交互平台</div>
          <div style={{ fontSize: 24, fontWeight: 800, color: "#38bdf8", marginTop: 4 }}>
            {Object.keys(data?.platformSummary ?? {}).length} 个平台
          </div>
          <div style={{ color: "#94a3b8", fontSize: 11, marginTop: 2 }}>飞书、企业微信、TG、Discord、xAI 等</div>
        </div>

        <div style={{ background: "#090e1a", border: "1px solid #1e2a42", borderRadius: 8, padding: 14 }}>
          <div style={{ color: "#64748b", fontSize: 11, fontWeight: 600, textTransform: "uppercase" }}>宿主环境分布</div>
          <div style={{ fontSize: 24, fontWeight: 800, color: "#a855f7", marginTop: 4 }}>
            4 种载体
          </div>
          <div style={{ color: "#94a3b8", fontSize: 11, marginTop: 2 }}>LaunchAgent / Docker / 原生 App / Bridge</div>
        </div>

        <div style={{ background: "#090e1a", border: "1px solid #1e2a42", borderRadius: 8, padding: 14 }}>
          <div style={{ color: "#64748b", fontSize: 11, fontWeight: 600, textTransform: "uppercase" }}>自动守护保活</div>
          <div style={{ fontSize: 24, fontWeight: 800, color: "#f59e0b", marginTop: 4 }}>
            全部就绪
          </div>
          <div style={{ color: "#94a3b8", fontSize: 11, marginTop: 2 }}>异常退出 60s 级自动拉起守护</div>
        </div>
      </div>

      {/* Filter Tabs & Search */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 18, flexWrap: "wrap", gap: 12 }}>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {[
            { id: "all", label: "全部 Bot" },
            { id: "running", label: "🟢 仅看运行中" },
            { id: "feishu_wechat", label: "📱 飞书与微信 Bot" },
            { id: "chat_community", label: "🌐 Discord & Telegram" },
            { id: "desktop_agents", label: "💻 桌面与核心智能体" }
          ].map((tab) => (
            <button
              key={tab.id}
              onClick={() => setPlatformFilter(tab.id)}
              style={{
                background: platformFilter === tab.id ? "rgba(56, 189, 248, 0.2)" : "#090e1a",
                color: platformFilter === tab.id ? "#38bdf8" : "#94a3b8",
                border: `1px solid ${platformFilter === tab.id ? "#38bdf8" : "#1e2a42"}`,
                borderRadius: 6,
                padding: "6px 12px",
                fontSize: 12,
                fontWeight: 600,
                cursor: "pointer"
              }}
            >
              {tab.label}
            </button>
          ))}
        </div>

        <input
          placeholder="搜索 Bot 名称、模型或平台..."
          value={searchFilter}
          onChange={(e) => setSearchFilter(e.target.value)}
          style={{
            background: "#090e1a",
            border: "1px solid #1e2a42",
            borderRadius: 6,
            padding: "6px 12px",
            color: "#f8fafc",
            fontSize: 12,
            outline: "none",
            minWidth: 220
          }}
        />
      </div>

      {isLoading && <p style={{ color: "#64748b", textAlign: "center", padding: 40 }}>正在探测各平台 Bot 实时状态与进程...</p>}

      {/* Bot Cards Grid */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(360px, 1fr))", gap: 16 }}>
        {filteredBots.map((bot) => (
          <BotCard key={bot.id} bot={bot} />
        ))}
        {filteredBots.length === 0 && !isLoading && (
          <p className="empty" style={{ gridColumn: "1/-1", textAlign: "center", padding: 30 }}>未匹配到符合条件的 Bot。</p>
        )}
      </div>
    </div>
  );
}

function BotCard({ bot }: { bot: BotStatusItem }) {
  const isRunning = bot.status === "running";
  const isWarning = bot.status === "warning";

  const getPlatformIcon = (platform: string) => {
    if (platform.includes("飞书")) return "🐦";
    if (platform.includes("微信")) return "💬";
    if (platform.includes("Discord")) return "🎮";
    if (platform.includes("Telegram")) return "✈️";
    if (platform.includes("Grok")) return "⚡";
    if (platform.includes("Muse")) return "🎨";
    if (platform.includes("Dot")) return "🟣";
    return "🤖";
  };

  return (
    <div
      style={{
        background: "#090e1a",
        border: `1px solid ${isRunning ? "rgba(56, 189, 248, 0.3)" : "#1e2a42"}`,
        borderRadius: 10,
        padding: "16px 18px",
        boxShadow: isRunning ? "0 4px 16px rgba(56, 189, 248, 0.08)" : "0 4px 12px rgba(0,0,0,0.15)",
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between"
      }}
    >
      <div>
        {/* Top Header */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 12 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ fontSize: 24 }}>{getPlatformIcon(bot.platform)}</span>
            <div>
              <div style={{ fontSize: 15, fontWeight: 700, color: "#f8fafc" }}>{bot.name}</div>
              <div style={{ color: "#64748b", fontSize: 11, marginTop: 1 }}>{bot.platform} · {bot.runtimeType}</div>
            </div>
          </div>

          <span
            style={{
              fontSize: 11,
              padding: "3px 8px",
              borderRadius: 6,
              background: isRunning ? "rgba(16, 185, 129, 0.2)" : isWarning ? "rgba(245, 158, 11, 0.2)" : "rgba(100, 116, 139, 0.2)",
              color: isRunning ? "#34d399" : isWarning ? "#fbbf24" : "#94a3b8",
              border: `1px solid ${isRunning ? "rgba(16, 185, 129, 0.4)" : isWarning ? "rgba(245, 158, 11, 0.4)" : "rgba(100, 116, 139, 0.4)"}`,
              fontWeight: 700,
              display: "flex",
              alignItems: "center",
              gap: 4
            }}
          >
            <span>{isRunning ? "●" : isWarning ? "▲" : "○"}</span>
            {isRunning ? "运行中" : isWarning ? "异常告警" : "待机离线"}
          </span>
        </div>

        {/* Detailed Metadata Fields */}
        <div style={{ background: "#0c1322", border: "1px solid #1a253a", borderRadius: 8, padding: 12, marginBottom: 12, fontSize: 12 }}>
          <div style={{ marginBottom: 6 }}>
            <span style={{ color: "#64748b" }}>驱动模型:</span>{" "}
            <strong style={{ color: "#e2e8f0" }}>{bot.boundModel}</strong>
          </div>
          {bot.portOrEndpoint && (
            <div style={{ marginBottom: 6 }}>
              <span style={{ color: "#64748b" }}>端点/信道:</span>{" "}
              <code style={{ color: "#38bdf8", fontSize: 11 }}>{bot.portOrEndpoint}</code>
            </div>
          )}
          <div style={{ display: "flex", justifyContent: "space-between", color: "#64748b", fontSize: 11 }}>
            <span>PID: <strong style={{ color: "#94a3b8" }}>{bot.pid ?? "无独立进程"}</strong></span>
            <span>事件/消息: <strong style={{ color: "#34d399" }}>{bot.messagesOrEventsCount} 条</strong></span>
            <span>状态: <span style={{ color: "#94a3b8" }}>{bot.lastActive}</span></span>
          </div>
        </div>
      </div>

      {/* Health Evidence Box */}
      <div style={{ borderTop: "1px solid #131d2e", paddingTop: 8, fontSize: 11, color: "#64748b" }}>
        <div style={{ fontWeight: 600, color: "#475569", marginBottom: 3 }}>健康证据：</div>
        {bot.healthEvidence.slice(0, 2).map((ev, idx) => (
          <div key={`${bot.id}-ev-${idx}`} style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            • {ev}
          </div>
        ))}
      </div>
    </div>
  );
}
