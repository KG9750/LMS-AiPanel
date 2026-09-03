import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { ApiEnvelope, ResourceNode } from "../shared/schemas";
import { apiFetch, readFetch } from "./api";

/* ------------------------------------------------------------------ */
/* 配置中心 (M7): preview / diff / apply for the whitelisted config    */
/* ------------------------------------------------------------------ */

interface ConfigPreviewData {
  configType: string;
  filePath: string;
  documentedFields: Array<{ key: string; label: string; value: unknown; valuePresent: boolean; sensitive: boolean }>;
  undocumentedFields: Array<{ key: string; value: unknown }>;
  rawContent: string;
  previewHash: string;
}

export function ConfigCenterPanel({ onMessage }: { onMessage: (kind: "ok" | "error", text: string) => void }) {
  const [preview, setPreview] = useState<ConfigPreviewData | null>(null);
  const [editing, setEditing] = useState("");
  const [applying, setApplying] = useState(false);
  const [diffLines, setDiffLines] = useState<Array<{ type: string; line: string }> | null>(null);

  const showDiff = async () => {
    if (!preview) return;
    try {
      const result = await apiFetch<{ diff: Array<{ type: string; line: string }>; fresh: boolean }>("/api/config/diff", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: preview.filePath, content: editing })
      });
      setDiffLines(result.diff);
      if (!result.fresh) {
        onMessage("error", "文件已被外部修改，预览已失效，请重新读取");
      }
    } catch (error) {
      onMessage("error", `diff 失败：${(error as Error).message}`);
    }
  };

  const loadPreview = async () => {
    try {
      const data = await readFetch<ConfigPreviewData>("/api/config/preview");
      setPreview(data);
      setEditing(data.rawContent);
    } catch (error) {
      onMessage("error", `预览失败：${(error as Error).message}`);
    }
  };

  const apply = async () => {
    if (!preview) return;
    setApplying(true);
    try {
      const result = await apiFetch<{ ok: boolean; evidence: string[] }>("/api/config/apply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: preview.filePath, content: editing, previewHash: preview.previewHash })
      });
      onMessage(result.ok ? "ok" : "error", result.ok ? "配置已应用并通过验证" : `应用失败：${result.evidence.join("；")}`);
      await loadPreview();
    } catch (error) {
      onMessage("error", `应用被拒绝：${(error as Error).message}`);
    } finally {
      setApplying(false);
    }
  };

  if (!preview) {
    return (
      <div className="panel">
        <div className="panel-head">
          <h2>配置中心</h2>
          <button onClick={() => void loadPreview()}>读取配置预览</button>
        </div>
        <p className="empty">读取 Codex config.toml 的脱敏预览后即可编辑、diff 与安全应用。</p>
      </div>
    );
  }

  return (
    <div className="panel config-panel">
      <div className="panel-head">
        <h2>配置中心 · {preview.filePath.replace(/^.*\//, "~/" + preview.filePath.split("/").slice(0, -1).pop())}</h2>
        <button onClick={() => void loadPreview()}>重新读取</button>
      </div>

      <div className="config-fields">
        <h3>已知字段（版本化中文语义）</h3>
        {preview.documentedFields.filter((f) => f.valuePresent).map((field) => (
          <div className="config-field" key={field.key}>
            <code>{field.key}</code>
            <span className={field.sensitive ? "sensitive" : ""}>{JSON.stringify(field.value)}</span>
          </div>
        ))}
        {preview.undocumentedFields.length > 0 && (
          <>
            <h3>未文档化字段（原样保留）</h3>
            {preview.undocumentedFields.map((field) => (
              <div className="config-field" key={field.key}>
                <code>{field.key}</code>
                <span className="undocumented">{JSON.stringify(field.value)}</span>
              </div>
            ))}
          </>
        )}
      </div>

      <label className="config-edit-label">原始编辑（保存前会 diff 并校验外部变更）</label>
      <textarea
        className="config-editor"
        value={editing}
        onChange={(event) => setEditing(event.target.value)}
        rows={12}
        spellCheck={false}
      />
      <div className="config-actions">
        <button onClick={() => void showDiff()}>预览 diff</button>
        <button disabled={applying} onClick={() => void apply()}>
          {applying ? "正在应用..." : "备份并应用"}
        </button>
        <span className="config-hint">应用走 ActionRun：备份 → 原子替换 → 重新读取 → 验证</span>
      </div>
      {diffLines && (
        <div className="config-diff">
          {diffLines.slice(0, 80).map((line, index) => (
            <div key={index} className={`diff-line ${line.type}`}>
              {line.type === "added" ? "+ " : line.type === "removed" ? "- " : "  "}
              {line.line}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 网关覆盖 (M7): attributed / unattributed / provider totals          */
/* ------------------------------------------------------------------ */

interface GatewayReport {
  clients: Array<{ id: string; clientName: string; model: string; targetEndpoint: string; enabled: boolean }>;
  coverage: {
    attributed: { requests: number; tokensIn: number; tokensOut: number; errors: number };
    unattributed: { requests: number; tokensIn: number; tokensOut: number; errors: number };
    providerTotals: { requests: number; tokensIn: number; tokensOut: number };
  };
}

export function GatewayPanel({ onMessage }: { onMessage: (kind: "ok" | "error", text: string) => void }) {
  const { data } = useQuery({
    queryKey: ["gateway"],
    queryFn: () => readFetch<GatewayReport>("/api/gateway"),
    refetchInterval: 30_000
  });
  const [name, setName] = useState("");
  const [model, setModel] = useState("");
  const [endpoint, setEndpoint] = useState("");

  const register = async () => {
    try {
      await apiFetch("/api/gateway/clients", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientName: name, model, targetEndpoint: endpoint })
      });
      onMessage("ok", `网关客户端 ${name} 已注册`);
      setName("");
      setModel("");
      setEndpoint("");
    } catch (error) {
      onMessage("error", `注册失败：${(error as Error).message}`);
    }
  };

  const c = data?.coverage;
  return (
    <div className="panel gateway-panel">
      <div className="panel-head">
        <h2>可观测网关（OpenAI 兼容代理）</h2>
        <span>只记录指标，不存储请求/响应</span>
      </div>
      <div className="gateway-metrics">
        <div className="metric">
          <span>归因流量</span>
          <strong>{c?.attributed.requests ?? 0}</strong>
          <small>tokens {c ? c.attributed.tokensIn + c.attributed.tokensOut : 0}</small>
        </div>
        <div className="metric">
          <span>直连流量（未归因）</span>
          <strong>{c?.unattributed.requests ?? 0}</strong>
          <small>不双重计数</small>
        </div>
        <div className="metric">
          <span>Provider 总量</span>
          <strong>{c?.providerTotals.requests ?? 0}</strong>
          <small>归因 + 未归因 = 总量</small>
        </div>
      </div>
      <div className="gateway-clients">
        <h3>已配置客户端</h3>
        {data?.clients.map((client) => (
          <div className="gateway-client" key={client.id}>
            <code>{client.clientName}</code>
            <span>{client.model}</span>
            <small>{client.targetEndpoint}</small>
          </div>
        ))}
      </div>
      <div className="gateway-register">
        <input placeholder="客户端名（如 claude-code）" value={name} onChange={(e) => setName(e.target.value)} />
        <input placeholder="模型" value={model} onChange={(e) => setModel(e.target.value)} />
        <input placeholder="目标端点 http://127.0.0.1:8000" value={endpoint} onChange={(e) => setEndpoint(e.target.value)} />
        <button onClick={() => void register()}>注册客户端</button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 审计日志 (M7)                                                        */
/* ------------------------------------------------------------------ */

export function AuditPanel() {
  const { data } = useQuery({
    queryKey: ["audit"],
    queryFn: () => readFetch<Array<Record<string, unknown>>>("/api/audit"),
    refetchInterval: 30_000
  });
  return (
    <div className="panel audit-panel">
      <div className="panel-head">
        <h2>审计日志</h2>
        <span>{data?.length ?? 0} 条</span>
      </div>
      <div className="audit-list">
        {data?.length === 0 && <p className="empty">暂无审计事件。</p>}
        {data?.map((entry, index) => (
          <div className="audit-item" key={index}>
            <code>{String(entry.timestamp ?? "")}</code>
            <span>{String(entry.action ?? "")}</span>
            <small>{String(entry.resourceId ?? "")}</small>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 资源列表视图 (M7): 按类型过滤的资源表                                  */
/* ------------------------------------------------------------------ */

const VIEW_FILTERS: Record<string, ResourceNode["type"] | null> = {
  "AI 工具": "tool",
  "AI 助手": "assistant",
  本地模型: "model",
  运行框架: "runtime",
  技能: "skill",
  MCP: "mcp"
};

export function ResourceListView({ view, nodes, onOpen }: { view: string; nodes: ResourceNode[]; onOpen: (id: string) => void }) {
  const typeFilter = VIEW_FILTERS[view];
  const filtered = typeFilter ? nodes.filter((node) => node.type === typeFilter) : nodes;
  return (
    <div className="panel table-panel">
      <div className="panel-head">
        <h2>{view}</h2>
        <span>{filtered.length} 个资源</span>
      </div>
      <div className="resource-table">
        <div className="row header">
          <span>资源</span>
          <span>类型</span>
          <span>状态</span>
          <span>采集器</span>
        </div>
        {filtered.length === 0 && <p className="empty">没有 {view} 类型的资源。</p>}
        {filtered.slice(0, 100).map((node) => (
          <div className="row" key={node.id} onClick={() => onOpen(node.id)}>
            <span className="truncate">{node.label}</span>
            <span>{node.type}</span>
            <span className={`status ${node.state}`}>{node.state}</span>
            <span>{node.sourceAdapter}</span>
          </div>
        ))}
      </div>
    </div>
  );
}