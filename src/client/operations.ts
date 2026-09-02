import type { ResourceNode, SystemSnapshot } from "../shared/schemas";

export interface AttentionItem {
  resourceId: string;
  title: string;
  detail: string;
  severity: "critical" | "warning" | "info";
}

export interface OperationsWorkspace {
  attention: AttentionItem[];
  running: ResourceNode[];
  activity: Array<{ kind: string; text: string }>;
}

/**
 * Problem-driven operations workspace (issue #13): attention items are
 * ordered before healthy inventory counts; running local models/runtimes
 * show current evidence; recent RefreshRun/ActionRun activity has a home;
 * asset inventory stays reachable but secondary.
 */
export function buildOperations(snapshot: SystemSnapshot): OperationsWorkspace {
interface AttentionItem {
  resourceId: string;
  title: string;
  detail: string;
  severity: "critical" | "warning" | "info";
}

interface OperationsWorkspace {
  attention: AttentionItem[];
  running: ResourceNode[];
  activity: Array<{ kind: string; text: string }>;
}

/**
 * Problem-driven operations workspace (issue #13): attention items are
 * ordered before healthy inventory counts; running local models/runtimes
 * show current evidence; recent RefreshRun/ActionRun activity has a home;
 * asset inventory stays reachable but secondary.
 */

  const attention: AttentionItem[] = [];

  // 1. Unreachable resources (error state / unreachable drift).
  for (const node of snapshot.nodes) {
    if (node.state === "error") {
      attention.push({
        resourceId: node.id,
        title: `不可达：${node.label}`,
        detail: (node.properties.evidence as string[] | undefined)?.join(" · ") ?? node.id,
        severity: "critical"
      });
    }
  }

  // 2. Drift records.
  for (const record of snapshot.driftRecords) {
    attention.push({
      resourceId: record.resourceId,
      title: `漂移：${record.status}`,
      detail: record.evidence.join(" · "),
      severity: record.severity
    });
  }

  // 3. Collection failures / stale adapters.
  for (const run of snapshot.adapterRuns) {
    if (run.status === "failed" || run.status === "timeout") {
      attention.push({
        resourceId: `adapter:${run.adapterId}`,
        title: `采集失败：${run.adapterId}`,
        detail: run.error ?? `${run.status} after ${run.durationMs ?? 0}ms`,
        severity: "warning"
      });
    } else if (run.stale) {
      attention.push({
        resourceId: `adapter:${run.adapterId}`,
        title: `陈旧数据：${run.adapterId}`,
        detail: "展示的是最近一次成功快照，不是最新实时采集结果。",
        severity: "info"
      });
    }
  }

  // 4. Upgrade advice from skills.
  for (const node of snapshot.nodes) {
    const upgrade = node.properties.upgrade as { available?: boolean; recommended?: boolean; remoteVersion?: string } | null | undefined;
    if (upgrade?.available) {
      attention.push({
        resourceId: node.id,
        title: `升级可用：${node.label}`,
        detail: `远程版本 ${upgrade.remoteVersion ?? "未知"}${upgrade.recommended ? "（推荐升级）" : ""}`,
        severity: upgrade.recommended ? "warning" : "info"
      });
    }
  }

  // Running local models / runtimes / assistants with evidence.
  const running = snapshot.nodes.filter(
    (node) =>
      node.state === "running" &&
      (node.type === "runtime" || node.type === "model" || node.type === "assistant" || node.type === "endpoint")
  );

  // Recent activity: RefreshRun + ActionRun visible home.
  const activity: Array<{ kind: string; text: string }> = [];
  for (const run of snapshot.adapterRuns.slice(0, 5)) {
    activity.push({ kind: "adapter", text: `${run.adapterId} ${run.status} · ${run.durationMs ?? 0}ms` });
  }

  return { attention, running, activity };
}


