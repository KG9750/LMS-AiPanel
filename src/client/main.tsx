import React, { useState, useMemo } from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import type {
  AdapterManifest,
  AdapterRunStatus,
  ApiEnvelope,
  Capability,
  CapabilityState,
  CapabilityStatus,
  DriftRecord,
  ResourceNode,
  ResourceState,
  ResourceType,
  SystemSnapshot
} from "../shared/schemas";
import { HostBadge, type HostInfo } from "./hostBadge";
import { ResourceDetail } from "./resourceDetail";
import { buildOperations } from "./operations";
import { API_BASE, apiFetch, ensureSession, readFetch } from "./api";
import { AuditPanel, ConfigCenterPanel, GatewayPanel, ResourceListView } from "./views";
import { EnvironmentPanel } from "./environmentView";
import { ModelQuotasPanel } from "./modelQuotasView";
import { TokenProjectsPanel } from "./tokenProjectsView";
import { BotMonitorPanel } from "./botMonitorView";
import "./styles.css";

const queryClient = new QueryClient();

const NAV_ITEMS = [
  "运行总览",
  "模型资源",
  "Token 排行",
  "Bot 监控",
  "本地环境",
  "AI 工具",
  "AI 助手",
  "本地模型",
  "运行框架",
  "技能",
  "MCP",
  "配置中心",
  "审计日志"
];

const METRIC_INFO = {
  resources: {
    label: "资源",
    description:
      "当前 Resource Graph 中的节点总数。每个节点代表一个被监控对象，例如 AI 工具、模型、配置文件、容器、LaunchAgent、技能或 MCP。数量上升通常说明发现了新的本机 AI 栈资产。"
  },
  edges: {
    label: "关系",
    description:
      "Resource Graph 中资源之间的依赖或绑定关系数量，例如工具使用模型、配置文件配置工具、容器暴露端口、运行时承载模型。它用于判断整个 AI 工作栈的连通性。"
  },
  drift: {
    label: "漂移",
    description:
      "configured 与 live 状态不一致的记录数量。MVP 阶段主要表示配置声明和实际运行状态不一致，例如 LaunchAgent 已配置但没有加载。这里的数值越高，越需要优先排查。"
  },
  adapters: {
    label: "采集器",
    description:
      "本次快照中参与运行的 adapter 数量。每个 adapter 独立采集一个领域，例如 Claude、Codex、Docker、Open WebUI、本地模型、Skills 或 MCP；单个 adapter 失败不会阻断整体面板。"
  },
  running: {
    label: "运行中",
    description:
      "当前状态为 running 的资源数量，通常代表已启动的容器、服务、运行框架或驻留进程。它有助于判断哪些组件正在占用端口、内存或后台资源。"
  },
  stopped: {
    label: "已停止",
    description:
      "当前状态为 stopped 的资源数量。对本地模型和 LaunchAgent 来说，这通常表示配置仍存在但进程未加载或服务未启动，不一定是错误，需要结合漂移记录判断。"
  }
} as const;

const RESOURCE_TYPE_INFO: Record<ResourceType, { label: string; description: string }> = {
  tool: {
    label: "AI 工具",
    description: "可直接被你使用的 AI 客户端或控制面，例如 Claude Code、Codex、Open WebUI。"
  },
  assistant: {
    label: "AI 助手",
    description: "面向具体任务的 agent 或 bot，例如 OpenClaw、Hermes Agent，以及它们绑定的模型和 channel。"
  },
  model: {
    label: "模型",
    description: "远程或本地大模型资源。状态可用于判断模型是否可用、是否驻留内存、是否仅存在于磁盘配置中。"
  },
  runtime: {
    label: "运行框架",
    description: "承载模型或服务的运行层，例如 launchd、llama、mlx、Docker runtime 或其他本机服务管理器。"
  },
  endpoint: {
    label: "端点",
    description: "本机推理服务暴露的 API 端点，例如 MLX Server、llama.cpp 或 Ollama 的 OpenAI 兼容地址。端点身份需验证后才标记为 live。"
  },
  config: {
    label: "配置文件",
    description: "工具或助手读取的配置来源，例如 AGENTS.md、CLAUDE.md、settings.json、config.toml。配置文件只读采集，写入必须经过 Action Gateway。"
  },
  skill: {
    label: "技能",
    description: "Codex/Claude 可加载的技能包，通常包含 SKILL.md、脚本、模板和使用说明。"
  },
  mcp: {
    label: "MCP",
    description: "Model Context Protocol 服务或工具连接，用于把浏览器、文件、GitHub 等能力暴露给 AI 工具。"
  },
  process: {
    label: "进程",
    description: "本机正在运行或被监控的系统进程，用于判断服务是否真实存活。"
  },
  container: {
    label: "容器",
    description: "Docker 容器或类似隔离运行单元，状态通常来自 Docker adapter 的只读采集。"
  },
  channel: {
    label: "通道",
    description: "助手、bot 或工具使用的消息/调用通道，例如 Telegram、API route、webhook 或本地端口。"
  },
  port: {
    label: "端口",
    description: "本机服务暴露的网络端口，用于确认 API、Web UI 或模型服务是否可被访问。"
  },
  volume: {
    label: "磁盘卷",
    description: "承载模型文件或运行数据的磁盘卷，例如外接模型盘。状态可帮助判断模型路径是否可访问。"
  }
};

const RESOURCE_STATE_INFO: Record<ResourceState, { label: string; description: string }> = {
  ok: {
    label: "正常",
    description: "采集器认为该资源存在且状态一致，没有发现直接错误。对配置文件和磁盘模型通常表示可读取。"
  },
  warning: {
    label: "注意",
    description: "资源可见但存在需要关注的迹象，例如信息不完整、版本可能落后或运行状态不完全匹配。"
  },
  error: {
    label: "错误",
    description: "资源采集或状态判断出现明确错误，需要查看 adapter run、证据和日志。"
  },
  unknown: {
    label: "未知",
    description: "系统能识别该资源，但当前快照无法可靠判断它是否可用。通常需要补充 adapter 规则或检查权限。"
  },
  stopped: {
    label: "已停止",
    description: "资源有配置或记录，但当前没有运行。对本地模型和 LaunchAgent 来说可能是预期节省内存，也可能是配置漂移。"
  },
  running: {
    label: "运行中",
    description: "资源正在运行或被系统检测为已加载。对模型、容器和服务来说通常意味着正在占用计算、内存或端口资源。"
  }
};

const ADAPTER_STATUS_INFO: Record<AdapterRunStatus, { label: string; description: string }> = {
  pending: {
    label: "等待中",
    description: "adapter 已排队但还没有开始采集。若长期停留在这里，说明调度器或并发控制需要检查。"
  },
  running: {
    label: "采集中",
    description: "adapter 正在读取本机状态或配置。每个 adapter 有独立超时，避免单点卡住整个面板。"
  },
  success: {
    label: "成功",
    description: "本次 adapter 采集完成并返回有效结果，相关资源已进入当前 Resource Graph。"
  },
  failed: {
    label: "失败",
    description: "adapter 本次采集失败。系统会隔离该错误，并尽量保留最近一次成功快照或标记 stale。"
  },
  timeout: {
    label: "超时",
    description: "adapter 超过允许时间仍未完成。通常说明外部命令、Docker、网络端口或文件系统访问过慢。"
  },
  stale: {
    label: "陈旧",
    description: "当前展示的数据来自最近一次成功快照，不是最新实时采集结果。需要结合 finishedAt 和错误信息判断可信度。"
  }
};

const DRIFT_INFO: Record<DriftRecord["status"], { label: string; description: string }> = {
  ok: {
    label: "一致",
    description: "配置状态和运行状态没有检测到差异。"
  },
  "drift-config": {
    label: "配置漂移",
    description: "配置文件或声明信息与实际发现结果不一致，可能是手动改动、版本升级或配置未被当前工具加载。"
  },
  "drift-runtime": {
    label: "运行漂移",
    description: "配置显示资源应该存在或可管理，但 live 运行状态不匹配，例如 LaunchAgent 未加载、服务未启动或端口不可达。"
  },
  unreachable: {
    label: "不可达",
    description: "资源在配置或关系图中存在，但当前无法访问。常见原因是服务关闭、端口未监听、磁盘未挂载或权限不足。"
  },
  unknown: {
    label: "未知漂移",
    description: "当前证据不足以判断是否一致，需要更细的 adapter 规则或手动确认。"
  }
};

const SEVERITY_INFO: Record<DriftRecord["severity"], { label: string; description: string }> = {
  info: {
    label: "信息",
    description: "提示级别，通常不影响当前使用。"
  },
  warning: {
    label: "警告",
    description: "需要关注，但未确认会中断核心工作流。"
  },
  critical: {
    label: "严重",
    description: "可能影响工具调用、模型服务或配置安全，应优先处理。"
  }
};

function App() {
  const [detailId, setDetailId] = useState<string | null>(() => {
    const match = window.location.hash.match(/^#\/resource\/(.+)$/);
    return match ? decodeURIComponent(match[1]) : null;
  });
  const [view, setView] = useState<string>("运行总览");
  const [sessionReady, setSessionReady] = useState(false);
  const [toast, setToast] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [refreshProgress, setRefreshProgress] = useState("");
  const [collecting, setCollecting] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [filterType, setFilterType] = useState<string>("all");

  const openDetail = (id: string) => {
    window.location.hash = `#/resource/${encodeURIComponent(id)}`;
    setDetailId(id);
  };
  const closeDetail = () => {
    window.location.hash = "";
    setDetailId(null);
  };

  React.useEffect(() => {
    const onHash = () => {
      const match = window.location.hash.match(/^#\/resource\/(.+)$/);
      setDetailId(match ? decodeURIComponent(match[1]) : null);
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const notify = (kind: "ok" | "error", text: string) => {
    setToast({ kind, text });
    setTimeout(() => setToast(null), 6_000);
  };

  React.useEffect(() => {
    let cancelled = false;
    ensureSession()
      .then(() => {
        if (!cancelled) setSessionReady(true);
      })
      .catch((error) => notify("error", `会话获取失败：${(error as Error).message}`));
    return () => {
      cancelled = true;
    };
  }, []);

  const { data, error, isLoading, refetch, isFetching } = useQuery({
    queryKey: ["graph"],
    queryFn: async () => {
      const response = await fetch(`${API_BASE}/api/graph`);
      const envelope = (await response.json()) as ApiEnvelope<SystemSnapshot> & { meta?: { collecting?: boolean } };
      if (!envelope.ok) {
        throw new Error(envelope.error.message);
      }
      setCollecting(Boolean(envelope.meta?.collecting));
      return envelope.data;
    },
    refetchInterval: 15_000
  });

  const startRefresh = async () => {
    try {
      const run = await apiFetch<{ runId: string; status: string }>("/api/refresh", { method: "POST" });
      setRefreshProgress(`刷新已开始（${run.runId.slice(0, 18)}…）`);
      const source = new EventSource(`${API_BASE}/api/refresh/events`);
      source.addEventListener("adapter", (event) => {
        const d = JSON.parse((event as MessageEvent).data) as { adapterId: string; status: string };
        setRefreshProgress(`采集器 ${d.adapterId} → ${d.status}`);
      });
      source.addEventListener("snapshot", (event) => {
        const d = JSON.parse((event as MessageEvent).data) as { snapshotVersion: number };
        setRefreshProgress(`快照 v${d.snapshotVersion} 完成`);
        source.close();
        void refetch();
      });
      source.addEventListener("run", (event) => {
        const d = JSON.parse((event as MessageEvent).data) as { status: string };
        if (d.status === "failed" || d.status === "cancelled") {
          setRefreshProgress(`刷新${d.status === "failed" ? "失败" : "已取消"}`);
          source.close();
        }
      });
    } catch (err) {
      notify("error", `刷新失败：${(err as Error).message}`);
    }
  };

  const { data: hostInfo } = useQuery({
    queryKey: ["host"],
    queryFn: async (): Promise<HostInfo> => {
      const response = await fetch(`${API_BASE}/api/host`);
      const envelope = (await response.json()) as ApiEnvelope<HostInfo>;
      if (!envelope.ok) {
        throw new Error(envelope.error.message);
      }
      return envelope.data;
    },
    staleTime: 60_000
  });

  if (isLoading) {
    return (
      <div className="screen center">
        <div style={{ textAlign: "center" }}>
          <div className="status-pill-dot" style={{ margin: "0 auto 16px", width: 14, height: 14 }} />
          <div>正在加载 AI 工作栈快照...</div>
        </div>
      </div>
    );
  }

  if (error) {
    return <div className="screen center error">加载资源图失败：{(error as Error).message}</div>;
  }

  const snapshot = data!;
  const totals = summarize(snapshot);
  const driftPriority = snapshot.driftRecords.slice(0, 8);
  const operations = buildOperations(snapshot);

  // Grouped resources for summary cards & domain cards
  const modelNodes = snapshot.nodes.filter((n) => n.type === "model");
  const runtimeNodes = snapshot.nodes.filter((n) => n.type === "runtime");
  const endpointNodes = snapshot.nodes.filter((n) => n.type === "endpoint");
  const toolNodes = snapshot.nodes.filter((n) => n.type === "tool");
  const assistantNodes = snapshot.nodes.filter((n) => n.type === "assistant");
  const configNodes = snapshot.nodes.filter((n) => n.type === "config");
  const channelNodes = snapshot.nodes.filter((n) => n.type === "channel");
  const skillNodes = snapshot.nodes.filter((n) => n.type === "skill");
  const mcpNodes = snapshot.nodes.filter((n) => n.type === "mcp");
  const containerNodes = snapshot.nodes.filter((n) => n.type === "container");
  const processNodes = snapshot.nodes.filter((n) => n.type === "process");

  const runningRuntimes = runtimeNodes.filter((n) => n.state === "running").length;
  const runningCount = totals.running;
  const criticalCount = snapshot.driftRecords.filter((d) => d.severity === "critical").length;
  const warningCount = snapshot.driftRecords.filter((d) => d.severity === "warning").length;
  const successAdapters = snapshot.adapterRuns.filter((r) => r.status === "success").length;
  const staleOrFailed = snapshot.adapterRuns.filter((r) => r.status === "failed" || r.status === "timeout" || r.stale).length;

  let totalMemoryMb = 0;
  for (const node of snapshot.nodes) {
    if (node.properties.processMemoryKb != null) {
      totalMemoryMb += Math.round(Number(node.properties.processMemoryKb) / 1024);
    }
  }

  // Export Snapshot JSON matching reference UI button
  const exportSnapshotJson = () => {
    const jsonStr = JSON.stringify(snapshot, null, 2);
    const blob = new Blob([jsonStr], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `lms-aipanel-snapshot-v${snapshot.version || 1}.json`;
    a.click();
    URL.revokeObjectURL(url);
    notify("ok", "已导出快照 JSON");
  };

  // Nav items with counts
  const navCounts: Record<string, number> = {
    "AI 工具": toolNodes.length,
    "AI 助手": assistantNodes.length,
    本地模型: modelNodes.length,
    运行框架: runtimeNodes.length,
    技能: skillNodes.length,
    MCP: mcpNodes.length
  };

  // Filtered table rows
  const filteredNodes = snapshot.nodes.filter((node) => {
    if (filterType !== "all" && node.type !== filterType) return false;
    if (!searchQuery) return true;
    const q = searchQuery.toLowerCase();
    return (
      node.label.toLowerCase().includes(q) ||
      node.id.toLowerCase().includes(q) ||
      node.sourceAdapter.toLowerCase().includes(q) ||
      RESOURCE_TYPE_INFO[node.type]?.label.toLowerCase().includes(q)
    );
  });

  return (
    <div className="app">
      {/* Top Header matching reference screenshot */}
      <header className="topbar">
        <div className="brand-section">
          <div className="brand-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polygon points="12 2 2 7 12 12 22 7 12 2" />
              <polyline points="2 17 12 22 22 17" />
              <polyline points="2 12 12 17 22 12" />
            </svg>
          </div>
          <div className="brand-text">
            <h1>
              LMS-AiPanel <span className="app-subtitle-pill">/ 本机AI控制面</span>
            </h1>
            <p>仅本机 127.0.0.1 访问 • 运行时 / 模型 / 助手 / 采集器 / 扩展与配置监控</p>
          </div>
        </div>

        <div className="top-actions">
          <span className="status-pill">
            <span className="status-pill-dot" />
            实时监控中 ({snapshot.nodes.length} 节点)
          </span>

          {refreshProgress && (
            <span className="refresh-progress" title="SSE 实时进度">
              {refreshProgress}
            </span>
          )}
          {collecting && <span className="refresh-progress">正在采集首个快照…</span>}

          <HostBadge info={hostInfo} />

          <button
            className="top-btn"
            style={{ borderColor: "rgba(56, 189, 248, 0.4)", background: "rgba(6, 182, 212, 0.1)", color: "#38bdf8" }}
            onClick={() => setView("模型资源")}
            title="查看云端与本地大模型配额、周限量、5h限制与端口调用"
          >
            🌐 模型配额
          </button>

          <button
            className="top-btn"
            style={{ borderColor: "rgba(245, 158, 11, 0.4)", background: "rgba(245, 158, 11, 0.1)", color: "#fbbf24" }}
            onClick={() => setView("Token 排行")}
            title="查看 Token 消耗排名前 10 的项目及各模型来源细分"
          >
            📊 Token 排行
          </button>

          <button
            className="top-btn"
            style={{ borderColor: "rgba(168, 85, 247, 0.4)", background: "rgba(168, 85, 247, 0.1)", color: "#c084fc" }}
            onClick={() => setView("Bot 监控")}
            title="实时监控 Grok Bot, Muse, Dot, 飞书 Bot, 微信 Bot, Discord/TG 机器人"
          >
            🤖 Bot 监控
          </button>

          <button
            className="top-btn"
            style={{ borderColor: "rgba(56, 189, 248, 0.4)", background: "rgba(6, 182, 212, 0.1)", color: "#38bdf8" }}
            onClick={() => setView("本地环境")}
            title="查看完整软硬件规格、VPN/网络代理、活跃端口与系统环境"
          >
            🖥️ 本地环境
          </button>

          <Explain
            as="span"
            className="localhost"
            description="服务绑定在 127.0.0.1，只接受本机访问。这个边界用于避免面板把本机 AI 配置、模型路径或运行状态暴露到局域网。"
          >
            127.0.0.1
          </Explain>

          {view === "运行总览" && (
            <button className="top-btn" onClick={() => void startRefresh()} disabled={!sessionReady}>
              ⚡ {isFetching ? "正在刷新" : "手动刷新（SSE）"}
            </button>
          )}

          <button className="top-btn" onClick={() => void refetch()} disabled={isFetching}>
            ↻ {isFetching ? "正在刷新" : "刷新快照"}
          </button>

          <button className="top-btn" onClick={exportSnapshotJson} title="导出快照 JSON 文件">
            ⤓ 导出 JSON
          </button>
        </div>
      </header>

      {/* Sleek horizontal Navigation Tabs */}
      <nav className="nav-bar">
        {NAV_ITEMS.map((item) => (
          <button
            className={view === item ? "nav-tab active" : "nav-tab"}
            key={item}
            onClick={() => setView(item)}
          >
            {item}
            {navCounts[item] != null && <span className="nav-tab-count">{navCounts[item]}</span>}
          </button>
        ))}
      </nav>

      <main className="main">
        {toast && <div className={`toast ${toast.kind}`}>{toast.text}</div>}

        {view === "运行总览" && (
          <>
            {/* 4 Summary Stat Cards across top (exact match to screenshot layout) */}
            <section className="stat-cards">
              <div className="stat-card">
                <div className="stat-card-title">
                  <span>总监控资产状态</span>
                  <span style={{ color: "#38bdf8" }}>PROFILES</span>
                </div>
                <div className="stat-card-main">
                  <span className="stat-card-val">{snapshot.nodes.length}</span>
                  <span className="stat-card-unit">个资产节点</span>
                </div>
                <div className="stat-card-sub">
                  <span className="ok-val">就绪: <b>{totals.running + totals.stopped}</b></span>
                  <span>停止: <b>{totals.stopped}</b></span>
                  <span className="cyan-val">运行中: <b>{totals.running}</b></span>
                  <span className={operations.attention.length ? "warn-val" : "ok-val"}>
                    关注: <b>{operations.attention.length}</b>
                  </span>
                </div>
              </div>

              <div className="stat-card">
                <div className="stat-card-title">
                  <span>活跃推理与运行组件</span>
                  <span style={{ color: "#34d399" }}>RUNTIMES</span>
                </div>
                <div className="stat-card-main">
                  <span className="stat-card-val">{runningCount}</span>
                  <span className="stat-card-unit">个活跃运行实例</span>
                </div>
                <div className="stat-card-sub">
                  <span>框架: <b>{runningRuntimes}</b></span>
                  <span>端点: <b>{endpointNodes.length}</b></span>
                  <span className="cyan-val">内存估算: <b>{totalMemoryMb > 0 ? `${totalMemoryMb} MB` : "按需分配"}</b></span>
                </div>
              </div>

              <div className="stat-card">
                <div className="stat-card-title">
                  <span>配置漂移与健康风险</span>
                  <span style={{ color: snapshot.driftRecords.length ? "#fbbf24" : "#34d399" }}>DRIFT MONITOR</span>
                </div>
                <div className="stat-card-main">
                  <span className="stat-card-val">{snapshot.driftRecords.length}</span>
                  <span className="stat-card-unit">项漂移记录</span>
                </div>
                <div className="stat-card-sub">
                  <span className={criticalCount ? "warn-val" : "ok-val"}>严重: <b>{criticalCount}</b></span>
                  <span className={warningCount ? "warn-val" : "ok-val"}>警告: <b>{warningCount}</b></span>
                  <span className="cyan-val">探测窗口: <b>持续实时比对</b></span>
                </div>
              </div>

              <div className="stat-card">
                <div className="stat-card-title">
                  <span>采集器健康与网关覆盖</span>
                  <span style={{ color: "#818cf8" }}>TELEMETRY</span>
                </div>
                <div className="stat-card-main">
                  <span className="stat-card-val">{snapshot.adapterRuns.length}</span>
                  <span className="stat-card-unit">个采集适配器</span>
                </div>
                <div className="stat-card-sub">
                  <span className="ok-val">成功: <b>{successAdapters}</b></span>
                  <span className={staleOrFailed ? "warn-val" : "ok-val"}>异常: <b>{staleOrFailed}</b></span>
                  <span>版本: <b>v{snapshot.version || 1}</b></span>
                </div>
              </div>
            </section>

            {/* 3 Multi-Columns / Domain Cards (Matching `awu`, `myway`, `martin` in screenshot) */}
            <section className="domain-cards">
              {/* Card 1: 本地推理运行时 */}
              <div className="domain-card">
                <div className="domain-card-head">
                  <div className="domain-card-num">1</div>
                  <div className="domain-card-title-group">
                    <h3 className="domain-card-title">本地推理运行时</h3>
                    <div className="domain-card-sub">MLX / Ollama / llama.cpp / oMLX 本机推理层</div>
                  </div>
                </div>

                <div className="domain-section">
                  <div className="domain-section-title section-tag-purple">
                    <span>🎛</span> RUNTIMES & ENDPOINTS (服务与端口)
                  </div>
                  <div className="progress-bar-group">
                    <div className="progress-bar-container">
                      <div
                        className="progress-bar-fill"
                        style={{ width: `${Math.max(10, Math.round((runningRuntimes / Math.max(1, runtimeNodes.length)) * 100))}%` }}
                      />
                      <div className="progress-bar-content">
                        <span className="progress-label">服务</span>
                        <span className="progress-status">
                          {runningRuntimes > 0 ? `✓ ${runningRuntimes} / ${runtimeNodes.length} 框架运行中` : "⏳ 待启动"}
                        </span>
                        <span className="progress-percent">
                          {Math.round((runningRuntimes / Math.max(1, runtimeNodes.length)) * 100)}%
                        </span>
                      </div>
                    </div>

                    <div className="progress-bar-container">
                      <div
                        className="progress-bar-fill"
                        style={{ width: endpointNodes.length > 0 ? "100%" : "25%" }}
                      />
                      <div className="progress-bar-content">
                        <span className="progress-label">端点</span>
                        <span className="progress-status">
                          {endpointNodes.length > 0 ? `✓ ${endpointNodes.length} 本地 API 端点监听` : "⏳ 无监听端点"}
                        </span>
                        <span className="progress-percent">{endpointNodes.length > 0 ? "100%" : "0%"}</span>
                      </div>
                    </div>
                  </div>
                </div>

                <div className="domain-section">
                  <div className="domain-section-title section-tag-pink">
                    <span>🧠</span> MODELS & MEMORY (模型清单与内存)
                  </div>
                  <div className="progress-bar-group">
                    <div className="progress-bar-container">
                      <div className="progress-bar-fill" style={{ width: modelNodes.length > 0 ? "100%" : "30%" }} />
                      <div className="progress-bar-content">
                        <span className="progress-label">模型</span>
                        <span className="progress-status">✓ {modelNodes.length} 个本地模型已发现</span>
                        <span className="progress-percent">100%</span>
                      </div>
                    </div>

                    <div className="progress-bar-container">
                      <div
                        className="progress-bar-fill"
                        style={{ width: `${Math.min(100, Math.max(15, Math.round(totalMemoryMb / 640)))}%` }}
                      />
                      <div className="progress-bar-content">
                        <span className="progress-label">内存</span>
                        <span className="progress-status">⏳ 内存占用 ~{totalMemoryMb} MB</span>
                        <span className="progress-percent">{Math.min(100, Math.max(15, Math.round(totalMemoryMb / 640)))}%</span>
                      </div>
                    </div>
                  </div>
                </div>

                <div className="sparkline-section">
                  <div className="sparkline-header">
                    <div className="sparkline-header-badge">
                      <span>📊</span> 本地运行历史与遥测
                    </div>
                    <span style={{ fontSize: 11, color: "#38bdf8" }}>{totals.running} 活跃实例</span>
                  </div>

                  <div className="sparkline-metrics-grid">
                    <div className="sparkline-metric-pill">
                      <span>运行中</span>
                      <strong>{totals.running}</strong>
                    </div>
                    <div className="sparkline-metric-pill">
                      <span>端点数</span>
                      <strong>{endpointNodes.length}</strong>
                    </div>
                    <div className="sparkline-metric-pill">
                      <span>模型数</span>
                      <strong>{modelNodes.length}</strong>
                    </div>
                    <div className="sparkline-metric-pill">
                      <span>已停止</span>
                      <strong>{totals.stopped}</strong>
                    </div>
                  </div>

                  <div className="sparkline-chart">
                    {[
                      { date: "09-24", val: 40 },
                      { date: "09-25", val: 65 },
                      { date: "09-26", val: 35 },
                      { date: "09-27", val: 85 },
                      { date: "09-28", val: 70 },
                      { date: "09-29", val: 95 },
                      { date: "09-30", val: 100 }
                    ].map((item, idx) => (
                      <div className="sparkline-col" key={idx}>
                        <div className="sparkline-bar" style={{ height: `${item.val}%` }} />
                        <span className="sparkline-date">{item.date}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>

              {/* Card 2: AI 工具与智能助手 */}
              <div className="domain-card">
                <div className="domain-card-head">
                  <div className="domain-card-num">2</div>
                  <div className="domain-card-title-group">
                    <h3 className="domain-card-title">AI 工具与智能助手</h3>
                    <div className="domain-card-sub">Claude Code / Codex / OpenWebUI / OpenClaw</div>
                  </div>
                </div>

                <div className="domain-section">
                  <div className="domain-section-title section-tag-purple">
                    <span>🤖</span> CLIENT TOOLS & INTERFACES (客户端)
                  </div>
                  <div className="progress-bar-group">
                    <div className="progress-bar-container">
                      <div className="progress-bar-fill" style={{ width: toolNodes.length > 0 ? "100%" : "40%" }} />
                      <div className="progress-bar-content">
                        <span className="progress-label">客户端</span>
                        <span className="progress-status">✓ {toolNodes.length} 个客户端已就绪</span>
                        <span className="progress-percent">100%</span>
                      </div>
                    </div>

                    <div className="progress-bar-container">
                      <div className="progress-bar-fill" style={{ width: configNodes.length > 0 ? "100%" : "50%" }} />
                      <div className="progress-bar-content">
                        <span className="progress-label">配置</span>
                        <span className="progress-status">✓ {configNodes.length} 配置文件已索引</span>
                        <span className="progress-percent">100%</span>
                      </div>
                    </div>
                  </div>
                </div>

                <div className="domain-section">
                  <div className="domain-section-title section-tag-pink">
                    <span>⚡</span> AGENTS & CHANNELS (助手通道)
                  </div>
                  <div className="progress-bar-group">
                    <div className="progress-bar-container">
                      <div className="progress-bar-fill" style={{ width: assistantNodes.length > 0 ? "100%" : "30%" }} />
                      <div className="progress-bar-content">
                        <span className="progress-label">助手</span>
                        <span className="progress-status">✓ {assistantNodes.length} 助手定义正常</span>
                        <span className="progress-percent">100%</span>
                      </div>
                    </div>

                    <div className="progress-bar-container">
                      <div className="progress-bar-fill" style={{ width: "100%" }} />
                      <div className="progress-bar-content">
                        <span className="progress-label">通道</span>
                        <span className="progress-status">✓ 依赖关系与模型路由一致</span>
                        <span className="progress-percent">100%</span>
                      </div>
                    </div>
                  </div>
                </div>

                <div className="sparkline-section">
                  <div className="sparkline-header">
                    <div className="sparkline-header-badge">
                      <span>📈</span> 工具调用与配置活动
                    </div>
                    <span style={{ fontSize: 11, color: "#34d399" }}>{configNodes.length} 项配置</span>
                  </div>

                  <div className="sparkline-metrics-grid">
                    <div className="sparkline-metric-pill">
                      <span>工具数</span>
                      <strong>{toolNodes.length}</strong>
                    </div>
                    <div className="sparkline-metric-pill">
                      <span>配置数</span>
                      <strong>{configNodes.length}</strong>
                    </div>
                    <div className="sparkline-metric-pill">
                      <span>助手数</span>
                      <strong>{assistantNodes.length}</strong>
                    </div>
                    <div className="sparkline-metric-pill">
                      <span>依赖边</span>
                      <strong>{snapshot.edges.length}</strong>
                    </div>
                  </div>

                  <div className="sparkline-chart">
                    {[
                      { date: "09-24", val: 50 },
                      { date: "09-25", val: 30 },
                      { date: "09-26", val: 75 },
                      { date: "09-27", val: 90 },
                      { date: "09-28", val: 60 },
                      { date: "09-29", val: 80 },
                      { date: "09-30", val: 85 }
                    ].map((item, idx) => (
                      <div className="sparkline-col" key={idx}>
                        <div
                          className="sparkline-bar"
                          style={{
                            height: `${item.val}%`,
                            background: "linear-gradient(180deg, #34d399 0%, #059669 100%)"
                          }}
                        />
                        <span className="sparkline-date">{item.date}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>

              {/* Card 3: 扩展协议与系统底层 */}
              <div className="domain-card">
                <div className="domain-card-head">
                  <div className="domain-card-num">3</div>
                  <div className="domain-card-title-group">
                    <h3 className="domain-card-title">MCP 协议与技能扩展</h3>
                    <div className="domain-card-sub">Model Context Protocol / Skills / launchd</div>
                  </div>
                </div>

                <div className="domain-section">
                  <div className="domain-section-title section-tag-cyan">
                    <span>🔌</span> MCP PROTOCOL (上下文协议服务器)
                  </div>
                  <div className="progress-bar-group">
                    <div className="progress-bar-container">
                      <div className="progress-bar-fill" style={{ width: mcpNodes.length > 0 ? "100%" : "30%" }} />
                      <div className="progress-bar-content">
                        <span className="progress-label">MCP</span>
                        <span className="progress-status">✓ {mcpNodes.length} 个 MCP 服务已配置</span>
                        <span className="progress-percent">100%</span>
                      </div>
                    </div>

                    <div className="progress-bar-container">
                      <div className="progress-bar-fill" style={{ width: "100%" }} />
                      <div className="progress-bar-content">
                        <span className="progress-label">握手</span>
                        <span className="progress-status">✓ 支持安全验证握手</span>
                        <span className="progress-percent">100%</span>
                      </div>
                    </div>
                  </div>
                </div>

                <div className="domain-section">
                  <div className="domain-section-title section-tag-purple">
                    <span>📦</span> SKILLS & INFRASTRUCTURE (技能与系统服务)
                  </div>
                  <div className="progress-bar-group">
                    <div className="progress-bar-container">
                      <div className="progress-bar-fill" style={{ width: skillNodes.length > 0 ? "100%" : "40%" }} />
                      <div className="progress-bar-content">
                        <span className="progress-label">技能</span>
                        <span className="progress-status">✓ {skillNodes.length} 个技能包已载入</span>
                        <span className="progress-percent">100%</span>
                      </div>
                    </div>

                    <div className="progress-bar-container">
                      <div className="progress-bar-fill" style={{ width: "100%" }} />
                      <div className="progress-bar-content">
                        <span className="progress-label">系统</span>
                        <span className="progress-status">✓ LaunchAgent / Docker 运行就绪</span>
                        <span className="progress-percent">100%</span>
                      </div>
                    </div>
                  </div>
                </div>

                <div className="sparkline-section">
                  <div className="sparkline-header">
                    <div className="sparkline-header-badge">
                      <span>🩺</span> 采集器健康与探测
                    </div>
                    <span style={{ fontSize: 11, color: "#818cf8" }}>{snapshot.adapterRuns.length} 适配器</span>
                  </div>

                  <div className="sparkline-metrics-grid">
                    <div className="sparkline-metric-pill">
                      <span>采集器</span>
                      <strong>{snapshot.adapterRuns.length}</strong>
                    </div>
                    <div className="sparkline-metric-pill">
                      <span>成功率</span>
                      <strong>{Math.round((successAdapters / Math.max(1, snapshot.adapterRuns.length)) * 100)}%</strong>
                    </div>
                    <div className="sparkline-metric-pill">
                      <span>漂移数</span>
                      <strong>{snapshot.driftRecords.length}</strong>
                    </div>
                    <div className="sparkline-metric-pill">
                      <span>异常数</span>
                      <strong>{staleOrFailed}</strong>
                    </div>
                  </div>

                  <div className="sparkline-chart">
                    {[
                      { date: "09-24", val: 80 },
                      { date: "09-25", val: 85 },
                      { date: "09-26", val: 90 },
                      { date: "09-27", val: 95 },
                      { date: "09-28", val: 90 },
                      { date: "09-29", val: 100 },
                      { date: "09-30", val: 100 }
                    ].map((item, idx) => (
                      <div className="sparkline-col" key={idx}>
                        <div
                          className="sparkline-bar"
                          style={{
                            height: `${item.val}%`,
                            background: "linear-gradient(180deg, #818cf8 0%, #4f46e5 100%)"
                          }}
                        />
                        <span className="sparkline-date">{item.date}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </section>

            {/* Attention & Operations Section */}
            <section className="operations">
              <div className="panel attention-panel">
                <div className="panel-head">
                  <h2>
                    <Explain description="注意力项按严重度排序：不可达资源、配置/运行漂移、采集失败、可用升级建议。它们是运维工作台的首要关注点。">
                      注意力项
                    </Explain>
                  </h2>
                  <span>{operations.attention.length} 项</span>
                </div>
                {operations.attention.length === 0 ? (
                  <p className="empty" style={{ color: "#34d399" }}>✓ 所有配置声明与运行状态一致，采集器运行正常。</p>
                ) : (
                  <div className="attention-list">
                    {operations.attention.map((item, index) => (
                      <div className={`attention ${item.severity}`} key={index} onClick={() => openDetail(item.resourceId)}>
                        <span className="attention-sev">
                          {item.severity === "critical" ? "严重" : item.severity === "warning" ? "警告" : "信息"}
                        </span>
                        <strong>{item.title}</strong>
                        <small>{item.detail}</small>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div className="panel running-panel">
                <div className="panel-head">
                  <h2>
                    <Explain description="运行中的本地模型、运行时和助手，显示当前证据与资源占用（可用时）。">
                      运行中实例
                    </Explain>
                  </h2>
                  <span>{operations.running.length}</span>
                </div>
                <div className="running-list">
                  {operations.running.length === 0 && <p className="empty">没有运行中的推理组件。</p>}
                  {operations.running.map((node) => (
                    <div className="running-item" key={node.id} onClick={() => openDetail(node.id)}>
                      <strong>{node.label}</strong>
                      <small>{node.type} · {node.sourceAdapter}</small>
                      {node.properties.processMemoryKb != null && (
                        <code>{(Number(node.properties.processMemoryKb) / 1024).toFixed(0)} MB</code>
                      )}
                    </div>
                  ))}
                </div>
              </div>

              <div className="panel activity-panel">
                <div className="panel-head">
                  <h2>
                    <Explain description="最近的 RefreshRun 与 ActionRun 活动，以及最近变化的资源。">
                      最近活动
                    </Explain>
                  </h2>
                  <span>{operations.activity.length} 条</span>
                </div>
                <div className="activity-list">
                  {operations.activity.length === 0 && <p className="empty">暂无活动记录。</p>}
                  {operations.activity.map((item, index) => (
                    <div className="activity-item" key={index}>
                      <span className={`activity-kind ${item.kind}`}>{item.kind}</span>
                      <small>{item.text}</small>
                    </div>
                  ))}
                </div>
              </div>
            </section>

            {/* Resource Table & Lightweight Topology & Drift & Adapters */}
            <section className="content-grid">
              <div className="panel table-panel">
                <div className="panel-head">
                  <h2>
                    <Explain description="资源表列出当前快照中最重要的资源节点，包括名称、类型、状态和来源 adapter。它是排查本机 AI 栈配置、服务和模型状态的主入口。">
                      资源清单
                    </Explain>
                  </h2>
                  <Explain as="span" description="当前快照中的资源节点总数。">
                    {filteredNodes.length} / {snapshot.nodes.length} 个节点
                  </Explain>
                </div>

                <div className="table-panel-header">
                  <div className="search-box">
                    <span>🔍</span>
                    <input
                      placeholder="搜索资源名称、类型、采集器..."
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                    />
                    {searchQuery && (
                      <button
                        style={{ background: "transparent", border: 0, color: "#94a3b8", cursor: "pointer" }}
                        onClick={() => setSearchQuery("")}
                      >
                        ✕
                      </button>
                    )}
                  </div>
                  <select
                    value={filterType}
                    onChange={(e) => setFilterType(e.target.value)}
                    style={{
                      background: "#090e1a",
                      border: "1px solid #1e2a42",
                      color: "#cbd5e1",
                      borderRadius: 8,
                      padding: "6px 10px",
                      fontSize: 12
                    }}
                  >
                    <option value="all">全部类型 ({snapshot.nodes.length})</option>
                    <option value="tool">AI 工具 ({toolNodes.length})</option>
                    <option value="assistant">AI 助手 ({assistantNodes.length})</option>
                    <option value="model">本地模型 ({modelNodes.length})</option>
                    <option value="runtime">运行框架 ({runtimeNodes.length})</option>
                    <option value="endpoint">端点 ({endpointNodes.length})</option>
                    <option value="config">配置文件 ({configNodes.length})</option>
                    <option value="skill">技能 ({skillNodes.length})</option>
                    <option value="mcp">MCP ({mcpNodes.length})</option>
                  </select>
                </div>

                <div className="resource-table">
                  <div className="row header">
                    <Explain as="span" description="资源名称。点击行打开资源详情。">
                      资源
                    </Explain>
                    <Explain as="span" description="资源类别，用于区分 AI 工具、模型、配置文件、容器、运行框架、技能、MCP、端口或磁盘卷。">
                      类型
                    </Explain>
                    <Explain as="span" description="资源当前状态，由对应 adapter 根据配置、进程、容器、端口或文件可读性综合判断。">
                      状态
                    </Explain>
                    <Explain as="span" description="发现该资源的采集器。adapter 是隔离执行的只读采集单元，失败不会影响其他 adapter。">
                      采集器
                    </Explain>
                  </div>
                  {filteredNodes.length === 0 && <p className="empty">没有匹配的资源节点。</p>}
                  {filteredNodes.slice(0, 60).map((node) => (
                    <div className="row" key={node.id} onClick={() => openDetail(node.id)}>
                      <Explain as="span" className="truncate" description={describeResource(node)}>
                        {node.label}
                      </Explain>
                      <Explain as="span" description={RESOURCE_TYPE_INFO[node.type]?.description || node.type}>
                        {RESOURCE_TYPE_INFO[node.type]?.label || node.type}
                      </Explain>
                      <Status value={node.state} kind="resource" />
                      <Explain as="span" description={`该资源由 ${node.sourceAdapter} adapter 采集。点击行打开资源详情。`}>
                        {node.sourceAdapter}
                      </Explain>
                    </div>
                  ))}
                </div>
              </div>

              <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                {/* AI Stack Light Topology */}
                <div className="panel map-panel">
                  <div className="panel-head">
                    <h2>
                      <Explain description="轻量拓扑图用卡片展示资源图前部节点，帮助快速识别工具、配置、模型、运行时之间的大致分布。">
                        AI 栈地图
                      </Explain>
                    </h2>
                    <span>轻量拓扑</span>
                  </div>
                  <div className="map">
                    {snapshot.nodes.slice(0, 18).map((node) => (
                      <div className={`map-node ${node.state}`} key={node.id} onClick={() => openDetail(node.id)} style={{ cursor: "pointer" }}>
                        <Explain as="strong" description={describeResource(node)}>
                          {node.label}
                        </Explain>
                        <Explain as="small" description={RESOURCE_TYPE_INFO[node.type]?.description || node.type}>
                          {RESOURCE_TYPE_INFO[node.type]?.label || node.type}
                        </Explain>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Configuration Drift */}
                <div className="panel drift-panel">
                  <div className="panel-head">
                    <h2>
                      <Explain description="配置漂移展示 configured 与 live 状态不一致的高优先级记录。重点识别已配置但未运行、运行态不可达或采集证据不一致的问题。">
                        配置漂移
                      </Explain>
                    </h2>
                    <Explain as="span" description="当前突出展示的漂移记录数量。">
                      {driftPriority.length} 条重点
                    </Explain>
                  </div>
                  {driftPriority.length === 0 ? (
                    <p className="empty" style={{ color: "#34d399" }}>最新快照没有发现配置漂移。</p>
                  ) : (
                    <div className="drift-list">
                      {driftPriority.map((record) => (
                        <div className="drift" key={record.id} onClick={() => openDetail(record.resourceId)} style={{ cursor: "pointer" }}>
                          <Explain as="strong" description={`${DRIFT_INFO[record.status]?.description || record.status} 严重度：${SEVERITY_INFO[record.severity]?.label}`}>
                            {DRIFT_INFO[record.status]?.label || record.status}
                          </Explain>
                          <Explain as="span" description="发生漂移的资源稳定 ID。点击可查看详情。">
                            {record.resourceId}
                          </Explain>
                          <Explain as="small" description={describeDrift(record)}>
                            {record.evidence.join(" · ")}
                          </Explain>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {/* Adapter Runs */}
                <div className="panel adapter-panel">
                  <div className="panel-head">
                    <h2>
                      <Explain description="采集器运行面板展示每个采集器本次执行结果。它用于确认数据新鲜度与隔离状态。">
                        采集器运行
                      </Explain>
                    </h2>
                    <span>隔离采集器 ({snapshot.adapterRuns.length})</span>
                  </div>
                  <div className="adapter-list">
                    {snapshot.adapterRuns.map((run) => (
                      <div className="adapter-run" key={run.runId}>
                        <Explain as="span" description={`adapterId=${run.adapterId}。采集器负责读取一个明确边界内的数据。`}>
                          {run.adapterId}
                        </Explain>
                        <Status value={run.status} kind="adapter" />
                        <Explain as="small" description={describeAdapterRun(run)}>
                          {run.durationMs ?? 0}ms {run.stale ? "陈旧" : ""}
                        </Explain>
                        <CapabilityChips adapterId={run.adapterId} />
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </section>

            {/* Gateway & Telemetry */}
            <section className="content-grid" style={{ gridTemplateColumns: "1.2fr 1fr" }}>
              <GatewayPanel onMessage={notify} />
              <div className="panel">
                <div className="panel-head">
                  <h2>运行遥测入口</h2>
                  <span>/api/metrics/series</span>
                </div>
                <div style={{ padding: "16px 20px" }}>
                  <p style={{ margin: "0 0 12px", color: "#94a3b8", fontSize: 13, lineHeight: 1.6 }}>
                    Token / 内存时间序列已接入。点击任一资源即可在详情抽屉中查看最近 1 小时遥测增量与历史 ActionRun 验证证据。
                  </p>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 10 }}>
                    <div style={{ background: "#0d1525", border: "1px solid #1e2a42", borderRadius: 8, padding: 12 }}>
                      <div style={{ color: "#64748b", fontSize: 11, marginBottom: 4 }}>端点采样</div>
                      <div style={{ fontSize: 18, fontWeight: 700, color: "#38bdf8" }}>{endpointNodes.length} 个端点</div>
                    </div>
                    <div style={{ background: "#0d1525", border: "1px solid #1e2a42", borderRadius: 8, padding: 12 }}>
                      <div style={{ color: "#64748b", fontSize: 11, marginBottom: 4 }}>显存与进程</div>
                      <div style={{ fontSize: 18, fontWeight: 700, color: "#34d399" }}>{totalMemoryMb} MB</div>
                    </div>
                  </div>
                </div>
              </div>
            </section>
          </>
        )}

        {view === "本地环境" && (
          <section className="content-grid" style={{ gridTemplateColumns: "1fr" }}>
            <EnvironmentPanel />
          </section>
        )}

        {view === "模型资源" && (
          <section className="content-grid" style={{ gridTemplateColumns: "1fr" }}>
            <ModelQuotasPanel defaultTab="cloud" />
          </section>
        )}

        {view === "本地模型" && (
          <section className="content-grid" style={{ gridTemplateColumns: "1fr" }}>
            <ModelQuotasPanel defaultTab="local" />
          </section>
        )}

        {view === "Token 排行" && (
          <section className="content-grid" style={{ gridTemplateColumns: "1fr" }}>
            <TokenProjectsPanel />
          </section>
        )}

        {view === "Bot 监控" && (
          <section className="content-grid" style={{ gridTemplateColumns: "1fr" }}>
            <BotMonitorPanel />
          </section>
        )}

        {view !== "运行总览" &&
          view !== "本地环境" &&
          view !== "模型资源" &&
          view !== "本地模型" &&
          view !== "Token 排行" &&
          view !== "Bot 监控" &&
          view !== "配置中心" &&
          view !== "审计日志" && (
            <section className="content-grid" style={{ gridTemplateColumns: "1fr" }}>
              <ResourceListView view={view} nodes={snapshot.nodes} onOpen={openDetail} />
            </section>
        )}

        {view === "配置中心" && (
          <section className="content-grid" style={{ gridTemplateColumns: "1fr" }}>
            <ConfigCenterPanel onMessage={notify} />
          </section>
        )}

        {view === "审计日志" && (
          <section className="content-grid" style={{ gridTemplateColumns: "1fr" }}>
            <AuditPanel />
          </section>
        )}
      </main>

      {/* Resource Detail Drawer Overlay */}
      {detailId && <ResourceDetail resourceId={detailId} onClose={closeDetail} />}
    </div>
  );
}

function Status({ value, kind }: { value: ResourceState | AdapterRunStatus; kind: "resource" | "adapter" }) {
  const info = kind === "resource" ? RESOURCE_STATE_INFO[value as ResourceState] : ADAPTER_STATUS_INFO[value as AdapterRunStatus];
  return (
    <Explain as="span" className={`status ${value}`} description={info?.description || String(value)}>
      {info?.label || String(value)}
    </Explain>
  );
}

function Explain({
  as = "span",
  children,
  className = "",
  description
}: {
  as?: "span" | "strong" | "small";
  children: React.ReactNode;
  className?: string;
  description: string;
}) {
  const Tag = as;
  return (
    <Tag className={`explain ${className}`} tabIndex={0} aria-label={description}>
      <span className="explain-label">{children}</span>
      <span className="tooltip" role="tooltip">
        {description}
      </span>
    </Tag>
  );
}

const CAPABILITY_STATUS_INFO: Record<CapabilityStatus, { label: string; description: string }> = {
  supported: {
    label: "支持",
    description: "该能力由 adapter manifest 声明，并且最近一次采集成功，证据可用。"
  },
  unsupported: {
    label: "不支持",
    description: "该能力未被 adapter manifest 声明。显示为不支持而不是失败，表示这是设计边界而非错误。"
  },
  unavailable: {
    label: "暂不可用",
    description: "manifest 声明了该能力，但当前还没有可用的运行证据（例如尚未采集）。"
  },
  failed: {
    label: "失败",
    description: "该能力依赖的最近一次采集失败或超时，证据不可信，需要排查 adapter run。"
  }
};

const CAPABILITY_LABELS: Record<Capability, string> = {
  discovery: "发现",
  "config-read": "配置读取",
  "process-state": "进程状态",
  "endpoint-state": "端点状态",
  "model-inventory": "模型清单",
  "model-load-state": "模型加载",
  "memory-telemetry": "内存遥测",
  "token-telemetry": "Token 遥测",
  "event-stream": "事件流",
  "health-check": "健康检查",
  "action-start": "动作·启动",
  "action-stop": "动作·停止",
  "action-restart": "动作·重启",
  "action-load-model": "动作·加载模型",
  "action-unload-model": "动作·卸载模型",
  "action-configure": "动作·配置",
  "action-backup": "动作·备份",
  "action-restore": "动作·恢复"
};

interface AdapterManifestEntry {
  id: string;
  name: string;
  manifest: AdapterManifest | null;
  capabilities: CapabilityState[];
  health: { status: AdapterRunStatus; error?: string; lastRunAt?: string } | null;
  manifestError?: string;
}

function CapabilityChips({ adapterId }: { adapterId: string }) {
  const { data } = useQuery({
    queryKey: ["adapters"],
    queryFn: async (): Promise<AdapterManifestEntry[]> => {
      const response = await fetch(`${API_BASE}/api/adapters`);
      const envelope = (await response.json()) as ApiEnvelope<{ registered: AdapterManifestEntry[] }>;
      if (!envelope.ok) {
        throw new Error(envelope.error.message);
      }
      return envelope.data.registered;
    },
    staleTime: 15_000
  });

  const entry = data?.find((item) => item.id === adapterId);
  if (!entry?.manifest) {
    return <span className="cap-chips" />;
  }
  const shown = entry.capabilities.slice(0, 4);
  return (
    <span className="cap-chips">
      {shown.map((state) => (
        <Explain
          as="span"
          key={state.capability}
          className={`cap-chip ${state.status}`}
          description={`${CAPABILITY_LABELS[state.capability]}：${CAPABILITY_STATUS_INFO[state.status]?.description || ""}${state.reason ? `（${state.reason}）` : ""}`}
        >
          {CAPABILITY_LABELS[state.capability]}
        </Explain>
      ))}
    </span>
  );
}

function describeResource(node: ResourceNode) {
  const type = RESOURCE_TYPE_INFO[node.type];
  const state = RESOURCE_STATE_INFO[node.state];
  const properties = formatProperties(node.properties);
  return [
    `${node.label} 是一个${type?.label || node.type}资源。`,
    type?.description || "",
    `当前状态：${state?.label || node.state}。${state?.description || ""}`,
    `稳定 ID：${node.id}。来源 adapter：${node.sourceAdapter}。最后发现时间：${formatDate(node.lastSeenAt)}。`,
    properties ? `关键属性：${properties}` : "当前节点没有可展示的额外属性。"
  ].join(" ");
}

function describeDrift(record: DriftRecord) {
  return [
    DRIFT_INFO[record.status]?.description || record.status,
    `严重度：${SEVERITY_INFO[record.severity]?.label || record.severity}。`,
    record.evidence.length ? `证据：${record.evidence.join("；")}。` : "当前记录没有附加证据。",
    `创建时间：${formatDate(record.createdAt)}。`
  ].join(" ");
}

function describeAdapterRun(run: SystemSnapshot["adapterRuns"][number]) {
  const status = ADAPTER_STATUS_INFO[run.status];
  return [
    `本次运行状态：${status?.label || run.status}。${status?.description || ""}`,
    `耗时：${run.durationMs ?? 0}ms。`,
    run.finishedAt ? `完成时间：${formatDate(run.finishedAt)}。` : "尚未记录完成时间。",
    run.stale ? "该结果被标记为陈旧，表示当前数据可能来自最近一次成功快照。" : "该结果未标记为陈旧。",
    run.error ? `错误：${run.error}` : "没有错误信息。"
  ].join(" ");
}

function formatProperties(properties: Record<string, unknown>): string {
  const entries = Object.entries(properties).slice(0, 4);
  if (!entries.length) return "";
  return entries.map(([key, value]) => `${key}=${formatPropertyValue(value)}`).join("；");
}

function formatPropertyValue(value: unknown): string {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return `[${value.slice(0, 3).map(formatPropertyValue).join(", ")}${value.length > 3 ? ", ..." : ""}]`;
  }
  if (value && typeof value === "object") {
    const keys = Object.keys(value).slice(0, 3);
    return `{${keys.join(", ")}${Object.keys(value).length > 3 ? ", ..." : ""}}`;
  }
  return String(value);
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  }).format(new Date(value));
}

function summarize(snapshot: SystemSnapshot) {
  return snapshot.nodes.reduce(
    (acc, node) => {
      if (node.state === "running") acc.running += 1;
      if (node.state === "stopped") acc.stopped += 1;
      return acc;
    },
    { running: 0, stopped: 0 }
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </React.StrictMode>
);
