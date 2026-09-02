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

export class OpenWebUIAdapter implements StackAdapter {
  id = "openwebui";
  name = "Open WebUI";
  private lastError: string | undefined;

  async collect(context: AdapterContext): Promise<AdapterResult> {
    const root = node(this.id, "tool", "open-webui", "Open WebUI", "unknown", {
      dbHint: "~/.local/share/open-webui/webui.db",
      evidence: ["Open WebUI SQLite model table"]
    });
    const nodes = [root];
    const edges: ResourceEdge[] = [];

    if (!(await pathExists(DB_PATH))) {
      root.state = "unknown";
      root.properties = { ...root.properties, evidence: ["Open WebUI database not found"] };
      return { nodes, edges, redactionHints: [] };
    }

    try {
      const query = "select id,name,is_active,meta from model order by updated_at desc limit 50;";
      const { stdout } = await execa("sqlite3", ["-json", DB_PATH, query], {
        timeout: context.timeoutMs,
        cancelSignal: context.signal
      });
      const rows = stdout.trim() ? (JSON.parse(stdout) as OpenWebUIModelRow[]) : [];
      root.state = "ok";
      for (const row of rows) {
        const modelNode = node(this.id, "model", row.id, row.name || row.id, row.is_active ? "ok" : "stopped", {
          openWebUIId: row.id,
          isActive: Boolean(row.is_active),
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
