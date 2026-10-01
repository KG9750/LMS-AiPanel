import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import type { CloudModelInfo, LocalModelInfo, ModelQuotasReport } from "../domain/modelQuotas";
import { readFetch } from "./api";

export function ModelQuotasPanel({ defaultTab = "cloud" }: { defaultTab?: "cloud" | "local" } = {}) {
  const [activeTab, setActiveTab] = useState<"cloud" | "local">(defaultTab);
  const [searchFilter, setSearchFilter] = useState("");

  const { data, isLoading, refetch, isFetching } = useQuery<ModelQuotasReport>({
    queryKey: ["model-quotas"],
    queryFn: () => readFetch<ModelQuotasReport>("/api/models/quotas"),
    refetchInterval: 15_000
  });

  const cloudModels = data?.cloudModels ?? [];
  const localModels = data?.localModels ?? [];

  const filteredCloud = useMemo(
    () =>
      cloudModels.filter(
        (m) =>
          m.name.toLowerCase().includes(searchFilter.toLowerCase()) ||
          m.provider.toLowerCase().includes(searchFilter.toLowerCase()) ||
          m.modelName.toLowerCase().includes(searchFilter.toLowerCase())
      ),
    [cloudModels, searchFilter]
  );

  const filteredLocal = useMemo(
    () =>
      localModels.filter(
        (m) =>
          m.name.toLowerCase().includes(searchFilter.toLowerCase()) ||
          m.family.toLowerCase().includes(searchFilter.toLowerCase()) ||
          String(m.port).includes(searchFilter)
      ),
    [localModels, searchFilter]
  );

  return (
    <div className="panel" style={{ padding: "20px 24px" }}>
      {/* Top Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20, flexWrap: "wrap", gap: 12 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 20, fontWeight: 700, color: "#f8fafc", display: "flex", alignItems: "center", gap: 8 }}>
            <span>🌐</span> 模型资源监控中心
          </h2>
          <div style={{ color: "#64748b", fontSize: 13, marginTop: 4 }}>
            实时监控云端与本地大模型：周限量、5小时限额、重置时间、账号到期、端口调用与 Token 吞吐
          </div>
        </div>

        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          {/* Segmented Tab Buttons */}
          <div style={{ background: "#0a101d", padding: "3px", borderRadius: 8, border: "1px solid #1e2a42", display: "flex" }}>
            <button
              onClick={() => setActiveTab("cloud")}
              style={{
                background: activeTab === "cloud" ? "linear-gradient(135deg, #0284c7 0%, #0369a1 100%)" : "transparent",
                color: activeTab === "cloud" ? "#fff" : "#94a3b8",
                border: 0,
                borderRadius: 6,
                padding: "6px 14px",
                fontSize: 13,
                fontWeight: 600,
                cursor: "pointer",
                transition: "all 0.2s"
              }}
            >
              ☁️ 云端模型 ({cloudModels.length})
            </button>
            <button
              onClick={() => setActiveTab("local")}
              style={{
                background: activeTab === "local" ? "linear-gradient(135deg, #059669 0%, #047857 100%)" : "transparent",
                color: activeTab === "local" ? "#fff" : "#94a3b8",
                border: 0,
                borderRadius: 6,
                padding: "6px 14px",
                fontSize: 13,
                fontWeight: 600,
                cursor: "pointer",
                transition: "all 0.2s"
              }}
            >
              ⚡ 本地模型 ({localModels.filter((l) => l.status === "running").length} 活跃)
            </button>
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
      </div>

      {/* Quick Search */}
      <div style={{ marginBottom: 18 }}>
        <input
          placeholder={activeTab === "cloud" ? "搜索云端模型提供商、模型名或账号..." : "搜索本地模型名称、端口或架构家族..."}
          value={searchFilter}
          onChange={(e) => setSearchFilter(e.target.value)}
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

      {isLoading && <p style={{ color: "#64748b", textAlign: "center", padding: 40 }}>正在探测云端配额与端口调用状态...</p>}

      {/* CLOUD MODELS TAB */}
      {activeTab === "cloud" && (
        <div style={{ display: "grid", gap: 16 }}>
          {filteredCloud.map((model) => (
            <CloudModelCard key={model.id} model={model} />
          ))}
          {filteredCloud.length === 0 && !isLoading && (
            <p className="empty" style={{ textAlign: "center", padding: 30 }}>未匹配到符合条件的云端模型账号。</p>
          )}
        </div>
      )}

      {/* LOCAL MODELS TAB */}
      {activeTab === "local" && (
        <div style={{ display: "grid", gap: 16 }}>
          {filteredLocal.map((model) => (
            <LocalModelCard key={model.id} model={model} />
          ))}
          {filteredLocal.length === 0 && !isLoading && (
            <p className="empty" style={{ textAlign: "center", padding: 30 }}>未探测到匹配的本地模型端口调用。</p>
          )}
        </div>
      )}
    </div>
  );
}

function CloudModelCard({ model }: { model: CloudModelInfo }) {
  const getProviderColor = (provider: string) => {
    if (provider.includes("Anthropic")) return "#f59e0b";
    if (provider.includes("OpenAI")) return "#10b981";
    if (provider.includes("DeepSeek")) return "#38bdf8";
    if (provider.includes("Google")) return "#818cf8";
    if (provider.includes("Grok")) return "#e2e8f0";
    return "#a855f7";
  };

  const color = getProviderColor(model.provider);

  return (
    <div
      style={{
        background: "#090e1a",
        border: "1px solid #1e2a42",
        borderRadius: 10,
        padding: "18px 20px",
        boxShadow: "0 4px 12px rgba(0,0,0,0.2)"
      }}
    >
      {/* Top Header of Card */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 8, marginBottom: 14 }}>
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ fontSize: 16, fontWeight: 700, color: "#f8fafc" }}>{model.name}</span>
            <span
              style={{
                fontSize: 11,
                padding: "2px 8px",
                borderRadius: 4,
                background: `${color}20`,
                color,
                border: `1px solid ${color}40`,
                fontWeight: 600
              }}
            >
              {model.provider}
            </span>
            <span
              style={{
                fontSize: 11,
                padding: "2px 6px",
                borderRadius: 4,
                background: model.authStatus === "active" ? "#10b98120" : "#f59e0b20",
                color: model.authStatus === "active" ? "#34d399" : "#fbbf24",
                fontWeight: 600
              }}
            >
              {model.authStatus === "active" ? "🟢 认证有效" : "🟡 即将刷新"}
            </span>
          </div>
          <div style={{ color: "#94a3b8", fontSize: 12, marginTop: 4 }}>
            默认模型：<code style={{ color: "#e2e8f0", background: "#131d2e", padding: "1px 6px", borderRadius: 4 }}>{model.modelName}</code>
            <span style={{ marginLeft: 12, color: "#64748b" }}>账号：{model.account}</span>
          </div>
        </div>

        <div style={{ textAlign: "right", fontSize: 12, color: "#94a3b8" }}>
          <div>到期/续约：<span style={{ color: "#38bdf8", fontWeight: 600 }}>{model.accountExpiration}</span></div>
          <div style={{ marginTop: 2 }}>请求数：<span style={{ color: "#f8fafc", fontWeight: 700 }}>{model.requestsCount.toLocaleString()}</span> 次</div>
        </div>
      </div>

      {/* Quotas & Progress Grid */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 14, marginBottom: 14 }}>
        {/* Weekly Limit */}
        <div style={{ background: "#0e1626", border: "1px solid #1a253a", borderRadius: 8, padding: 12 }}>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginBottom: 6 }}>
            <span style={{ color: "#94a3b8", fontWeight: 600 }}>📅 周限量配额 (Weekly Quota)</span>
            <span style={{ color: "#f8fafc", fontWeight: 700 }}>{model.weeklyLimit.percentage}%</span>
          </div>
          <div
            role="progressbar"
            aria-valuenow={model.weeklyLimit.percentage}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label={`${model.name} 周限量配额`}
            style={{ height: 7, background: "#1b273d", borderRadius: 4, overflow: "hidden", marginBottom: 6 }}
          >
            <div
              style={{
                width: `${model.weeklyLimit.percentage}%`,
                height: "100%",
                background: model.weeklyLimit.percentage > 85 ? "#ef4444" : "linear-gradient(90deg, #0284c7, #38bdf8)",
                borderRadius: 4
              }}
            />
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "#64748b" }}>
            <span>已消耗：{(model.weeklyLimit.used / 1000).toFixed(1)}k Tokens</span>
            <span>周上限：{(model.weeklyLimit.total / 1000).toFixed(0)}k Tokens</span>
          </div>
        </div>

        {/* 5-Hour Limit & Reset */}
        <div style={{ background: "#0e1626", border: "1px solid #1a253a", borderRadius: 8, padding: 12 }}>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginBottom: 6 }}>
            <span style={{ color: "#94a3b8", fontWeight: 600 }}>⏳ 5小时滚动限制 (5-Hour Window)</span>
            <span style={{ color: "#34d399", fontWeight: 700 }}>剩余重置：{model.fiveHourLimit.resetCountdown}</span>
          </div>
          <div
            role="progressbar"
            aria-valuenow={model.fiveHourLimit.percentage}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label={`${model.name} 5小时滚动限制`}
            style={{ height: 7, background: "#1b273d", borderRadius: 4, overflow: "hidden", marginBottom: 6 }}
          >
            <div
              style={{
                width: `${model.fiveHourLimit.percentage}%`,
                height: "100%",
                background: model.fiveHourLimit.percentage > 85 ? "#f59e0b" : "linear-gradient(90deg, #10b981, #34d399)",
                borderRadius: 4
              }}
            />
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "#64748b" }}>
            <span>5h已用：{(model.fiveHourLimit.used / 1000).toFixed(1)}k / {(model.fiveHourLimit.total / 1000).toFixed(0)}k</span>
            <span>下次重置：{model.fiveHourLimit.resetTime}</span>
          </div>
        </div>
      </div>

      {/* Bottom Token Stats */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", background: "#070b14", padding: "8px 12px", borderRadius: 6, fontSize: 12, flexWrap: "wrap", gap: 8 }}>
        <div style={{ display: "flex", gap: 16 }}>
          <span>输入 Token: <strong style={{ color: "#38bdf8" }}>{model.tokens.input.toLocaleString()}</strong></span>
          <span>输出 Token: <strong style={{ color: "#a78bfa" }}>{model.tokens.output.toLocaleString()}</strong></span>
          <span>缓存命中: <strong style={{ color: "#34d399" }}>{model.tokens.cache.toLocaleString()}</strong></span>
          <span>总 Token: <strong style={{ color: "#f8fafc" }}>{model.tokens.total.toLocaleString()}</strong></span>
        </div>
        <div style={{ color: "#64748b", fontSize: 11 }}>{model.details}</div>
      </div>
    </div>
  );
}

function LocalModelCard({ model }: { model: LocalModelInfo }) {
  const isRunning = model.status === "running";

  return (
    <div
      style={{
        background: "#090e1a",
        border: `1px solid ${isRunning ? "#1e3a5f" : "#1e2a42"}`,
        borderRadius: 10,
        padding: "16px 20px",
        boxShadow: "0 4px 12px rgba(0,0,0,0.2)"
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 8, marginBottom: 10 }}>
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ fontSize: 15, fontWeight: 700, color: "#f8fafc" }}>{model.name}</span>
            <span
              style={{
                fontSize: 11,
                padding: "2px 8px",
                borderRadius: 4,
                background: isRunning ? "rgba(16, 185, 129, 0.15)" : "rgba(100, 116, 139, 0.15)",
                color: isRunning ? "#34d399" : "#64748b",
                border: `1px solid ${isRunning ? "rgba(16, 185, 129, 0.3)" : "rgba(100, 116, 139, 0.3)"}`,
                fontWeight: 600
              }}
            >
              {isRunning ? "🟢 端口开通调用中" : "⚪ 未启动"}
            </span>
            <span style={{ fontSize: 11, color: "#38bdf8", background: "#0e1a2f", padding: "2px 6px", borderRadius: 4, fontWeight: 600 }}>
              端口 {model.port}
            </span>
            <span style={{ fontSize: 11, color: "#a78bfa", background: "#1c1438", padding: "2px 6px", borderRadius: 4, fontWeight: 600 }}>
              {model.framework}
            </span>
          </div>
          <div style={{ color: "#94a3b8", fontSize: 12, marginTop: 4 }}>
            端点地址：<code style={{ color: "#38bdf8" }}>{model.endpointUrl}</code>
            <span style={{ marginLeft: 12, color: "#64748b" }}>架构家族：{model.family}</span>
          </div>
        </div>

        <div style={{ textAlign: "right", fontSize: 12, color: "#94a3b8" }}>
          <div>上下文上限：<strong style={{ color: "#f8fafc" }}>{(model.contextLength / 1024).toFixed(0)}k</strong> ({model.contextLength.toLocaleString()} tokens)</div>
          <div style={{ marginTop: 2 }}>显存/内存：<strong style={{ color: isRunning ? "#34d399" : "#64748b" }}>{model.memoryUsageMb > 0 ? `${(model.memoryUsageMb / 1024).toFixed(1)} GB` : "待命释放"}</strong></div>
        </div>
      </div>

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", background: "#070b14", padding: "8px 12px", borderRadius: 6, fontSize: 12, flexWrap: "wrap", gap: 8 }}>
        <div style={{ display: "flex", gap: 16 }}>
          <span>累计调用：<strong>{model.requestsCount}</strong> 次</span>
          <span>输入 Token: <strong style={{ color: "#38bdf8" }}>{model.tokens.input.toLocaleString()}</strong></span>
          <span>输出 Token: <strong style={{ color: "#a78bfa" }}>{model.tokens.output.toLocaleString()}</strong></span>
          <span>总 Token: <strong style={{ color: "#f8fafc" }}>{model.tokens.total.toLocaleString()}</strong></span>
        </div>
        <div style={{ color: "#64748b", fontSize: 11 }}>
          {isRunning ? "API 端点响应就绪 (支持 OpenAI /v1 协议)" : "可通过启动脚本或 LaunchAgent 调起"}
        </div>
      </div>
    </div>
  );
}
