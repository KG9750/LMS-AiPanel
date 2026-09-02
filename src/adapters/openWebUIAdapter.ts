import { execa } from "execa";
import type { AdapterResult, ResourceEdge } from "../shared/schemas";
import type { AdapterContext, HealthStatus, StackAdapter } from "./types";
import { edge, homePath, node, pathExists } from "./helpers";

const DB_PATH = homePath(".local", "share", "open-webui", "webui.db");

interface OpenWebUIModelRow {
  id: string;
  name: string;
  is_active: number;
  meta?: string;
}

interface OpenWebUIUsageRow {
  model_id: string;
  request_count: number;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  last_used_at: number;
}

export class OpenWebUIAdapter implements StackAdapter {
  id = "openwebui";
  name = "Open WebUI";
  private lastError: string | undefined;

  constructor(private readonly databasePath = DB_PATH) {}

  async collect(context: AdapterContext): Promise<AdapterResult> {
    const root = node(this.id, "tool", "open-webui", "Open WebUI", "unknown", {
      dbHint: "~/.local/share/open-webui/webui.db",
      evidence: ["Open WebUI SQLite model table"]
    });
    const nodes = [root];
    const edges: ResourceEdge[] = [];

    if (!(await pathExists(this.databasePath))) {
      root.state = "unknown";
      root.properties = { ...root.properties, evidence: ["Open WebUI database not found"] };
      return { nodes, edges, redactionHints: [] };
    }

    try {
      const modelQuery = await execa(
        "sqlite3",
        ["-json", this.databasePath, "select id,name,is_active,meta from model order by updated_at desc limit 50;"],
        {
          timeout: context.timeoutMs,
          cancelSignal: context.signal
        }
      );
      const rows = modelQuery.stdout.trim() ? (JSON.parse(modelQuery.stdout) as OpenWebUIModelRow[]) : [];
      const usageRows = await collectTokenUsage(this.databasePath, context);
      const usageByModel = new Map(usageRows.map((usage) => [usage.model_id, normalizeTokenUsage(usage)]));
      root.state = usageRows.available ? "ok" : "warning";
      root.properties = {
        ...root.properties,
        tokenUsageStatus: usageRows.available ? "available" : "unavailable",
        evidence: usageRows.available
          ? ["Open WebUI model and token usage tables"]
          : ["Open WebUI model table; token usage unavailable"]
      };
      for (const row of rows) {
        const tokenUsage = usageByModel.get(row.id);
        const modelNode = node(this.id, "model", row.id, row.name || row.id, row.is_active ? "ok" : "stopped", {
          openWebUIId: row.id,
          isActive: Boolean(row.is_active),
          ...(tokenUsage ? { tokenUsage } : {}),
          ...summarizeMeta(row.meta),
          evidence: [`is_active=${row.is_active}`]
        });
        nodes.push(modelNode);
        edges.push(edge(root.id, "uses", modelNode.id));
      }
      this.lastError = undefined;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      root.state = "unknown";
      root.properties = { ...root.properties, evidence: [this.lastError] };
    }

    return { nodes, edges, redactionHints: [] };
  }

  async health(): Promise<HealthStatus> {
    return { adapterId: this.id, alive: this.lastError === undefined, lastError: this.lastError };
  }
}

async function collectTokenUsage(
  databasePath: string,
  context: AdapterContext
): Promise<OpenWebUIUsageRow[] & { available: boolean }> {
  try {
    const { stdout } = await execa("sqlite3", ["-json", databasePath, TOKEN_USAGE_QUERY], {
      timeout: context.timeoutMs,
      cancelSignal: context.signal
    });
    const rows = (stdout.trim() ? JSON.parse(stdout) : []) as OpenWebUIUsageRow[];
    return Object.assign(rows, { available: true });
  } catch {
    return Object.assign([] as OpenWebUIUsageRow[], { available: false });
  }
}

const TOKEN_USAGE_QUERY = `
  select
    model_id,
    count(*) as request_count,
    sum(coalesce(json_extract(usage,'$.input_tokens'),json_extract(usage,'$.prompt_tokens'),json_extract(usage,'$.prompt_n'),0)) as input_tokens,
    sum(coalesce(json_extract(usage,'$.output_tokens'),json_extract(usage,'$.completion_tokens'),json_extract(usage,'$.predicted_n'),0)) as output_tokens,
    sum(coalesce(
      json_extract(usage,'$.total_tokens'),
      coalesce(json_extract(usage,'$.input_tokens'),json_extract(usage,'$.prompt_tokens'),json_extract(usage,'$.prompt_n'),0) +
      coalesce(json_extract(usage,'$.output_tokens'),json_extract(usage,'$.completion_tokens'),json_extract(usage,'$.predicted_n'),0)
    )) as total_tokens,
    max(created_at) as last_used_at
  from chat_message
  where model_id is not null
    and usage is not null
    and json_valid(usage)
    and json_type(usage) = 'object'
  group by model_id;
`;

export interface ModelTokenUsage {
  source: "openwebui";
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  requestCount: number;
  lastUsedAt: string;
}

export function normalizeTokenUsage(row: OpenWebUIUsageRow): ModelTokenUsage {
  const timestamp = Number(row.last_used_at);
  return {
    source: "openwebui",
    inputTokens: nonnegativeInteger(row.input_tokens),
    outputTokens: nonnegativeInteger(row.output_tokens),
    totalTokens: nonnegativeInteger(row.total_tokens),
    requestCount: nonnegativeInteger(row.request_count),
    lastUsedAt: new Date(timestamp < 1_000_000_000_000 ? timestamp * 1_000 : timestamp).toISOString()
  };
}

function nonnegativeInteger(value: number): number {
  return Math.max(0, Math.round(Number(value) || 0));
}

export function summarizeMeta(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const meta = JSON.parse(raw) as Record<string, unknown>;
    const summary: Record<string, unknown> = {};
    if (typeof meta.description === "string") summary.description = meta.description;
    if (Array.isArray(meta.capabilities)) {
      summary.capabilities = meta.capabilities.filter((item): item is string => typeof item === "string").slice(0, 20);
    }
    return summary;
  } catch {
    return {};
  }
}
