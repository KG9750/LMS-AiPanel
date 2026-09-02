import React from "react";
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
import "./styles.css";

const queryClient = new QueryClient();

const NAV_ITEMS = ["运行总览", "AI 工具", "AI 助手", "本地模型", "运行框架", "技能", "MCP", "配置中心", "审计日志"];

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

async function fetchGraph(): Promise<SystemSnapshot> {
  const response = await fetch("/api/graph");
  const envelope = (await response.json()) as ApiEnvelope<SystemSnapshot>;
  if (!envelope.ok) {
    throw new Error(envelope.error.message);
  }
  return envelope.data;
}

function App() {
  const [detailId, setDetailId] = React.useState<string | null>(() => {
    const match = window.location.hash.match(/^#\/resource\/(.+)$/);
    return match ? decodeURIComponent(match[1]) : null;
  });
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

  const { data, error, isLoading, refetch, isFetching } = useQuery({
    queryKey: ["graph"],
    queryFn: fetchGraph,
    refetchInterval: 15_000
  });

  if (isLoading) {
    return <div className="screen center">正在加载 AI 工作栈快照...</div>;
  }

  if (error) {
    return <div className="screen center error">加载资源图失败：{(error as Error).message}</div>;
  }

  const snapshot = data!;
  const totals = summarize(snapshot);
  const driftPriority = snapshot.driftRecords.slice(0, 8);

  const { data: hostInfo } = useQuery({
    queryKey: ["host"],
    queryFn: async (): Promise<HostInfo> => {
      const response = await fetch("/api/host");
      const envelope = (await response.json()) as ApiEnvelope<HostInfo>;
      if (!envelope.ok) {
        throw new Error(envelope.error.message);
      }
      return envelope.data;
    },
    staleTime: 60_000
  });

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">LMS-AiPanel</div>
        {NAV_ITEMS.map((item, index) => (
          <button className={index === 0 ? "nav active" : "nav"} key={item}>
            <span className="nav-dot" />
            {item}
          </button>
        ))}
      </aside>

      <main className="main">
        <header className="topbar">
          <div>
            <h1>运行总览</h1>
            <p>仅本机访问的 AI 工作栈控制面板</p>
          </div>
          <div className="top-actions">
            <HostBadge info={hostInfo} />
            <Explain
              as="span"
              className="localhost"
              description="服务绑定在 127.0.0.1，只接受本机访问。这个边界用于避免面板把本机 AI 配置、模型路径或运行状态暴露到局域网。"
            >
              127.0.0.1
            </Explain>
            <button onClick={() => void refetch()}>{isFetching ? "正在刷新" : "刷新快照"}</button>
          </div>
        </header>

        <section className="metrics">
          <Metric metric="resources" value={snapshot.nodes.length} />
          <Metric metric="edges" value={snapshot.edges.length} />
          <Metric metric="drift" value={snapshot.driftRecords.length} tone={snapshot.driftRecords.length ? "warn" : "ok"} />
          <Metric metric="adapters" value={snapshot.adapterRuns.length} />
          <Metric metric="running" value={totals.running} tone="ok" />
          <Metric metric="stopped" value={totals.stopped} tone="warn" />
        </section>

        <section className="content-grid">
          <div className="panel table-panel">
            <div className="panel-head">
              <h2>
                <Explain description="资源表列出当前快照中最重要的资源节点，包括名称、类型、状态和来源 adapter。它是排查本机 AI 栈配置、服务和模型状态的主入口。">
                  资源表
                </Explain>
              </h2>
              <Explain as="span" description="当前快照中的资源节点总数，和顶部“资源”指标一致。表格为了保持可读性默认展示前 60 个节点。">
                {snapshot.nodes.length} 个节点
              </Explain>
            </div>
            <div className="resource-table">
              <div className="row header">
                <Explain as="span" description="资源名称。悬浮在具体资源名上可查看稳定 ID、采集来源、最后发现时间和关键属性摘要。">
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
              {snapshot.nodes.slice(0, 60).map((node) => (
                <div className="row" key={node.id} onClick={() => openDetail(node.id)}>
                  <Explain as="span" className="truncate" description={describeResource(node)}>
                    {node.label}
                  </Explain>
                  <Explain as="span" description={RESOURCE_TYPE_INFO[node.type].description}>
                    {RESOURCE_TYPE_INFO[node.type].label}
                  </Explain>
                  <Status value={node.state} kind="resource" />
                  <Explain as="span" description={`该资源由 ${node.sourceAdapter} adapter 采集。adapter 负责读取对应系统边界的数据，并把结果统一转换为 Resource Graph 节点。点击行打开资源详情。`}>
                    {node.sourceAdapter}
                  </Explain>
                </div>
              ))}
            </div>
          </div>

          <div className="panel map-panel">
            <div className="panel-head">
              <h2>
                <Explain description="轻量拓扑图用卡片展示资源图前部节点，帮助快速识别工具、配置、模型、运行时之间的大致分布。MVP 不依赖复杂拓扑布局。">
                  AI 栈地图
                </Explain>
              </h2>
              <span>轻量拓扑</span>
            </div>
            <div className="map">
              {snapshot.nodes.slice(0, 18).map((node) => (
                <div className={`map-node ${node.state}`} key={node.id}>
                  <Explain as="strong" description={describeResource(node)}>
                    {node.label}
                  </Explain>
                  <Explain as="small" description={RESOURCE_TYPE_INFO[node.type].description}>
                    {RESOURCE_TYPE_INFO[node.type].label}
                  </Explain>
                </div>
              ))}
            </div>
          </div>

          <div className="panel drift-panel">
            <div className="panel-head">
              <h2>
                <Explain description="配置漂移展示 configured 与 live 状态不一致的高优先级记录。MVP 阶段重点识别已配置但未运行、运行态不可达或采集证据不一致的问题。">
                  配置漂移
                </Explain>
              </h2>
              <Explain as="span" description="当前突出展示的漂移记录数量。列表最多显示 8 条，优先用于首页排障。">
                {driftPriority.length} 条重点
              </Explain>
            </div>
            {driftPriority.length === 0 ? (
              <p className="empty">最新快照没有发现配置漂移。</p>
            ) : (
              <div className="drift-list">
                {driftPriority.map((record) => (
                  <div className="drift" key={record.id}>
                    <Explain as="strong" description={`${DRIFT_INFO[record.status].description} 严重度：${SEVERITY_INFO[record.severity].label}，${SEVERITY_INFO[record.severity].description}`}>
                      {DRIFT_INFO[record.status].label}
                    </Explain>
                    <Explain as="span" description="发生漂移的资源稳定 ID，格式通常为 adapter:type:stable-key，可用于在资源表或日志中定位同一个对象。">
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

          <div className="panel adapter-panel">
            <div className="panel-head">
              <h2>
                <Explain description="采集器运行面板展示每个采集器本次执行结果。它用于确认数据是否新鲜、是否有采集器失败、是否触发超时或陈旧数据回退。">
                  采集器运行
                </Explain>
              </h2>
              <span>隔离采集器</span>
            </div>
            <div className="adapter-list">
              {snapshot.adapterRuns.map((run) => (
                <div className="adapter-run" key={run.runId}>
                  <Explain as="span" description={`adapterId=${run.adapterId}。采集器负责读取一个明确边界内的数据，并把失败隔离在本次运行记录中。`}>
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
        </section>
      </main>

      {detailId && <ResourceDetail resourceId={detailId} onClose={closeDetail} />}
    </div>
  );
}

function Metric({
  metric,
  value,
  tone = "neutral"
}: {
  metric: keyof typeof METRIC_INFO;
  value: number;
  tone?: "neutral" | "ok" | "warn";
}) {
  const info = METRIC_INFO[metric];
  return (
    <div className={`metric ${tone}`}>
      <Explain as="span" description={info.description}>
        {info.label}
      </Explain>
      <strong>{value}</strong>
    </div>
  );
}

function Status({ value, kind }: { value: ResourceState | AdapterRunStatus; kind: "resource" | "adapter" }) {
  const info = kind === "resource" ? RESOURCE_STATE_INFO[value as ResourceState] : ADAPTER_STATUS_INFO[value as AdapterRunStatus];
  return (
    <Explain as="span" className={`status ${value}`} description={info.description}>
      {info.label}
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
      const response = await fetch("/api/adapters");
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
          description={`${CAPABILITY_LABELS[state.capability]}：${CAPABILITY_STATUS_INFO[state.status].description}${state.reason ? `（${state.reason}）` : ""}`}
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
    `${node.label} 是一个${type.label}资源。`,
    type.description,
    `当前状态：${state.label}。${state.description}`,
    `稳定 ID：${node.id}。来源 adapter：${node.sourceAdapter}。最后发现时间：${formatDate(node.lastSeenAt)}。`,
    properties ? `关键属性：${properties}` : "当前节点没有可展示的额外属性。"
  ].join(" ");
}

function describeDrift(record: DriftRecord) {
  return [
    DRIFT_INFO[record.status].description,
    `严重度：${SEVERITY_INFO[record.severity].label}。`,
    record.evidence.length ? `证据：${record.evidence.join("；")}。` : "当前记录没有附加证据。",
    `创建时间：${formatDate(record.createdAt)}。`
  ].join(" ");
}

function describeAdapterRun(run: SystemSnapshot["adapterRuns"][number]) {
  const status = ADAPTER_STATUS_INFO[run.status];
  return [
    `本次运行状态：${status.label}。${status.description}`,
    `耗时：${run.durationMs ?? 0}ms。`,
    run.finishedAt ? `完成时间：${formatDate(run.finishedAt)}。` : "尚未记录完成时间。",
    run.stale ? "该结果被标记为陈旧，表示当前数据可能来自最近一次成功快照。" : "该结果未标记为陈旧。",
    run.error ? `错误：${run.error}` : "没有错误信息。"
  ].join(" ");
}

function formatProperties(properties: Record<string, unknown>): string {
  const entries = Object.entries(properties).slice(0, 4);
  if (!entries.length) return "";
  return entries
    .map(([key, value]) => `${key}=${formatPropertyValue(value)}`)
    .join("；");
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
