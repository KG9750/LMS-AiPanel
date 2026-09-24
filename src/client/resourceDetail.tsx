import React from "react";
import { useQuery } from "@tanstack/react-query";
import { API_BASE, apiFetch } from "./api";
import type {
  ActionPlan,
  AdapterRunStatus,
  ApiEnvelope,
  CapabilityState,
  DriftRecord,
  HostRecord,
  ResourceEdge,
  ResourceNode
} from "../shared/schemas";

export interface ResourceDetail {
  resource: ResourceNode;
  host: HostRecord;
  managed: boolean;
  capabilities: CapabilityState[];
  relations: Array<{
    relation: ResourceEdge["relation"];
    direction: "outgoing" | "incoming";
    otherId: string;
    otherLabel: string;
  }>;
  telemetry: Array<{ scope: string; metric: string; current: number | null; delta: number | null }>;
  drift: DriftRecord[];
  actionHistory: Array<{ runId: string; action: string; status: string; startedAt: string }>;
  availableActions: string[];
  evidence: Array<{ text: string; source: string; observedAt: string }>;
}

const CAPABILITY_STATUS_LABEL: Record<CapabilityState["status"], string> = {
  supported: "支持",
  unsupported: "不支持",
  unavailable: "暂不可用",
  failed: "失败"
};

const RELATION_LABEL: Record<string, string> = {
  uses: "使用",
  configured_by: "由…配置",
  runs_on: "运行于",
  exposes: "暴露",
  binds_to: "绑定",
  depends_on: "依赖",
  owns: "拥有",
  watches: "监听"
};

/**
 * Unified resource detail view (issue #14): deep-linkable via a stable
 * resource id. Brings together identity, host scope, configuration, live
 * evidence, relationships, telemetry, capabilities, available actions,
 * drift, and audit history.
 */
export function ResourceDetail({ resourceId, onClose }: { resourceId: string; onClose: () => void }) {
  const [runningAction, setRunningAction] = React.useState<string | null>(null);
  const [actionStatus, setActionStatus] = React.useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [mcpChecking, setMcpChecking] = React.useState(false);
  const [mcpResult, setMcpResult] = React.useState<string | null>(null);
  const [mcpError, setMcpError] = React.useState<string | null>(null);

  // M3: explicit manual MCP capability handshake (managed servers only).
  const checkMcp = async () => {
    setMcpChecking(true);
    setMcpError(null);
    setMcpResult(null);
    try {
      const result = await apiFetch<{ serverInfo?: Record<string, unknown>; tools?: string[] }>(
        `/api/mcp/${encodeURIComponent(resourceId)}/verify`,
        { method: "POST" }
      );
      setMcpResult(`serverInfo=${JSON.stringify(result.serverInfo ?? {})} tools=${(result.tools ?? []).join(",") || "无"}`);
    } catch (err) {
      const e = err as Error & { code?: string };
      setMcpError(`${e.code ?? "握手失败"}：${e.message}`);
    } finally {
      setMcpChecking(false);
    }
  };

  // M7: full Action Gateway flow — plan -> create run -> confirm -> execute.
  const runAction = async (action: string) => {
    setRunningAction(action);
    setActionStatus(null);
    try {
      const plan = await apiFetch<{ actionId: string; disabledReason?: string }>("/api/actions/plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ resourceId, action })
      });
      if (plan.disabledReason) {
        setActionStatus({ kind: "error", text: `不可执行：${plan.disabledReason}` });
        return;
      }
      const run = await apiFetch<{ runId: string; status: string }>("/api/actions/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ resourceId, action, planId: plan.actionId })
      });
      await apiFetch(`/api/actions/runs/${run.runId}/confirm`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision: "confirm" })
      });
      const executed = await apiFetch<{ status: string }>(`/api/actions/runs/${run.runId}/execute`, { method: "POST" });
      setActionStatus({
        kind: executed.status === "succeeded" ? "ok" : "error",
        text: `动作 ${action} → ${executed.status}（验证证据决定结果）`
      });
    } catch (err) {
      const e = err as Error & { code?: string };
      setActionStatus({ kind: "error", text: `${e.code ?? "执行失败"}：${e.message}` });
    } finally {
      setRunningAction(null);
    }
  };

  const { data, error, isLoading } = useQuery({
    queryKey: ["resource", resourceId],
    queryFn: async (): Promise<ResourceDetail> => {
      const response = await fetch(`${API_BASE}/api/resources/${encodeURIComponent(resourceId)}`);
      const envelope = (await response.json()) as ApiEnvelope<ResourceDetail>;
      if (!envelope.ok) {
        throw new Error(envelope.error.message);
      }
      return envelope.data;
    },
    staleTime: 15_000
  });

  return (
    <div className="detail-overlay" onClick={onClose}>
      <div className="detail-panel" onClick={(event) => event.stopPropagation()}>
        <header className="detail-head">
          <div>
            <h2>{data?.resource.label ?? resourceId}</h2>
            <code className="detail-id">{resourceId}</code>
          </div>
          <button className="detail-close" onClick={onClose} aria-label="关闭">
            ×
          </button>
        </header>

        {isLoading && <p className="empty">正在加载资源详情...</p>}
        {error && <p className="empty error">加载失败：{(error as Error).message}</p>}
        {!data && !isLoading && !error && <p className="empty">资源不存在或已不在最新快照中。</p>}

        {data && (
          <div className="detail-body">
            <section>
              <h3>身份与作用域</h3>
              <dl className="detail-grid">
                <dt>类型</dt>
                <dd>{data.resource.type}</dd>
                <dt>状态</dt>
                <dd className={`status ${data.resource.state}`}>{data.resource.state}</dd>
                <dt>采集器</dt>
                <dd>{data.resource.sourceAdapter}</dd>
                <dt>本机</dt>
                <dd>
                  {data.host.hostName} <code>{data.host.hostId}</code>
                </dd>
                <dt>管理状态</dt>
                <dd>{data.managed ? "受管（可执行声明动作）" : "仅发现（只读）"}</dd>
                <dt>最后发现</dt>
                <dd>{data.resource.lastSeenAt}</dd>
              </dl>
            </section>

            <section>
              <h3>配置与实时证据</h3>
              <div className="detail-evidence">
                {data.evidence.length === 0 && <p className="empty">没有可用证据。</p>}
                {data.evidence.map((item, index) => (
                  <div className="evidence-row" key={index}>
                    <span>{item.text}</span>
                    <small>
                      source={item.source} · observed {item.observedAt}
                    </small>
                  </div>
                ))}
              </div>
            </section>

            <section>
              <h3>能力</h3>
              <div className="cap-chips">
                {data.capabilities.map((state) => (
                  <span key={state.capability} className={`cap-chip ${state.status}`} title={state.reason}>
                    {state.capability} · {CAPABILITY_STATUS_LABEL[state.status]}
                  </span>
                ))}
              </div>
            </section>

            <section>
              <h3>关系</h3>
              {data.relations.length === 0 && <p className="empty">没有关系。</p>}
              <div className="relation-list">
                {data.relations.map((relation, index) => (
                  <div className="relation-row" key={index}>
                    <span className="relation-arrow">{relation.direction === "outgoing" ? "→" : "←"}</span>
                    <code>{relation.otherLabel}</code>
                    <small>{RELATION_LABEL[relation.relation] ?? relation.relation}</small>
                  </div>
                ))}
              </div>
            </section>

            <section>
              <h3>遥测（最近 1 小时）</h3>
              {data.telemetry.length === 0 && <p className="empty">该资源没有遥测采样（未知 ≠ 0）。</p>}
              {data.telemetry.map((series, index) => (
                <div className="telemetry-row" key={index}>
                  <code>{series.metric}</code>
                  <span>当前 {series.current ?? "未知"}</span>
                  <span>窗口增量 {series.delta ?? "未知"}</span>
                </div>
              ))}
            </section>

            <section>
              <h3>漂移</h3>
              {data.drift.length === 0 && <p className="empty">没有漂移记录。</p>}
              {data.drift.map((record) => (
                <div className="drift" key={record.id}>
                  <strong>{record.status}</strong>
                  <small>{record.evidence.join(" · ")}</small>
                </div>
              ))}
            </section>

            {data.resource.type === "mcp" && data.managed && (
              <section>
                <h3>MCP 能力检查（手动握手，仅能力元数据）</h3>
                <button
                  className="action-chip"
                  disabled={mcpChecking}
                  onClick={() => void checkMcp()}
                >
                  {mcpChecking ? "握手检查中..." : "执行能力握手"}
                </button>
                {mcpResult && <p className="action-status ok">{mcpResult}</p>}
                {mcpError && <p className="action-status error">{mcpError}</p>}
              </section>
            )}

            <section>
              <h3>可用动作（执行必须通过 Action Gateway）</h3>
              {!data.managed && <p className="empty">资源未受管，动作不可执行（仅读）。</p>}
              {data.managed && data.availableActions.length === 0 && <p className="empty">该资源没有声明任何动作。</p>}
              {data.managed && data.availableActions.length > 0 && (
                <div className="action-chips">
                  {data.availableActions.map((action) => (
                    <button
                      key={action}
                      className="action-chip"
                      disabled={runningAction !== null}
                      onClick={() => void runAction(action)}
                    >
                      {runningAction === action ? "执行中..." : action}
                    </button>
                  ))}
                </div>
              )}
              {actionStatus && <p className={`action-status ${actionStatus.kind}`}>{actionStatus.text}</p>}
            </section>

            <section>
              <h3>动作历史（ActionRun）</h3>
              {data.actionHistory.length === 0 && <p className="empty">没有动作历史。</p>}
              {data.actionHistory.map((run) => (
                <div className="action-run" key={run.runId}>
                  <span>{run.action}</span>
                  <span className={`status ${run.status}`}>{run.status}</span>
                  <small>{run.startedAt}</small>
                </div>
              ))}
            </section>
          </div>
        )}
      </div>
    </div>
  );
}