import { nanoid } from "nanoid";
import type { DriftRecord, ResourceNode } from "../shared/schemas";

export function evaluateDrift(nodes: ResourceNode[]): DriftRecord[] {
  const now = new Date().toISOString();

  return nodes
    .map((node): DriftRecord | null => {
      const configured = node.properties.configured === true;
      if (!configured) return null;

      if (node.state === "error") {
        return {
          id: `drift:${nanoid()}`,
          resourceId: node.id,
          status: "unreachable",
          configured: {
            label: node.label,
            type: node.type,
            configured: true
          },
          live: {
            state: node.state
          },
          evidence: evidenceFromNode(node, "Resource reports an error state."),
          severity: "critical",
          createdAt: now
        };
      }

      if (node.state === "unknown") {
        return {
          id: `drift:${nanoid()}`,
          resourceId: node.id,
          status: "unknown",
          configured: {
            label: node.label,
            type: node.type,
            configured: true
          },
          live: {
            state: node.state
          },
          evidence: evidenceFromNode(node, "Adapter could not determine live state."),
          severity: "warning",
          createdAt: now
        };
      }

      if (node.state === "stopped") {
        return {
          id: `drift:${nanoid()}`,
          resourceId: node.id,
          status: "drift-runtime",
          configured: {
            label: node.label,
            type: node.type,
            configured: true
          },
          live: {
            state: node.state
          },
          evidence: evidenceFromNode(node, "Configured runtime resource is not currently running."),
          severity: "warning",
          createdAt: now
        };
      }

      return null;
    })
    .filter((record): record is DriftRecord => record !== null);
}

function evidenceFromNode(node: ResourceNode, fallback: string): string[] {
  const evidence = node.properties.evidence;
  if (Array.isArray(evidence) && evidence.every((item) => typeof item === "string")) {
    return evidence;
  }
  return [fallback, `resource=${node.id}`];
}
