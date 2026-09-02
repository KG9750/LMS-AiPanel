import type { RegistryEntry, RegistryMerge, ResourceNode } from "../shared/schemas";

export interface MergeOutcome {
  /** Nodes after registry intent is applied (custom endpoints etc.). */
  nodes: ResourceNode[];
  /** Per-resource merge status and evidence. */
  merges: RegistryMerge[];
  /** Attention items created for conflicting matches. */
  attention: Array<{ resourceId: string; message: string }>;
}

/**
 * Merges auto-discovery evidence with registry intent into one canonical
 * resource, preserving both sources.
 *
 * Rules:
 * - A `match` entry binds to a discovered resource and can mark it managed.
 * - A `supplement` entry contributes a custom endpoint even when discovery
 *   found nothing (resource becomes `unverified` until live evidence exists).
 * - `ignore` entries drop the discovered resource.
 * - Conflicting matches (two entries matching one resource, or an entry whose
 *   custom endpoint disagrees with discovery) create attention items instead
 *   of silently overwriting evidence.
 */
export function mergeRegistry(
  nodes: ResourceNode[],
  entries: RegistryEntry[]
): MergeOutcome {
  const nodesById = new Map(nodes.map((node) => [node.id, { ...node }]));
  const merges: RegistryMerge[] = [];
  const attention: MergeOutcome["attention"] = [];
  const seenEntryIds = new Set<string>();

  const conflict = (resourceId: string, message: string) => {
    attention.push({ resourceId, message });
  };

  for (const entry of entries) {
    if (entry.kind === "ignore") {
      const key = entryKey(entry);
      const matched = [...nodesById.values()].find((node) => matchKey(node) === key);
      if (matched) {
        nodesById.delete(matched.id);
        merges.push({
          resourceId: matched.id,
          status: "discovered",
          evidence: [`ignored by registry entry ${entry.id}`]
        });
      }
      continue;
    }

    const key = entryKey(entry);
    const matched = [...nodesById.values()].find((node) => matchKey(node) === key);
    if (matched) {
      seenEntryIds.add(entry.id);
      if (matched.properties.registryEntryId && matched.properties.registryEntryId !== entry.id) {
        conflict(matched.id, `conflicting registry matches (${matched.properties.registryEntryId} vs ${entry.id})`);
        merges.push({
          resourceId: matched.id,
          status: "conflict",
          evidence: ["two registry entries match the same resource; intent not applied"]
        });
        continue;
      }

      // Detect endpoint conflict against ORIGINAL discovery evidence, before
      // the registry intent is applied to the merged properties.
      const endpointConflict = conflictFor(matched, entry);

      const merged: ResourceNode = {
        ...matched,
        properties: {
          ...matched.properties,
          registryEntryId: entry.id,
          registryManaged: entry.managed,
          customEndpoint: entry.customEndpoint ?? matched.properties.customEndpoint
        }
      };
      const states: string[] = ["discovered", "registered"];
      if (entry.managed) states.push("managed");
      if (merged.state === "running" || merged.state === "ok") states.push("live");
      if (entry.customEndpoint && merged.properties.endpointVerified === false) states.push("unverified");
      // A conflict is only a conflict; a clean match is authoritative.
      merges.push({
        resourceId: merged.id,
        status: endpointConflict ? "conflict" : (states.includes("managed") ? "managed" : "registered"),
        evidence: [
          `discovered by ${matched.sourceAdapter}`,
          `registry intent: ${entry.kind}${entry.managed ? ", managed" : ""}`,
          ...(entry.customEndpoint ? [`custom endpoint ${entry.customEndpoint}`] : [])
        ]
      });
      if (endpointConflict) {
        conflict(merged.id, `registry entry ${entry.id} disagrees with discovered endpoint evidence`);
        merges[merges.length - 1] = { ...merges[merges.length - 1], status: "conflict" };
      }
      nodesById.set(merged.id, merged);
      continue;
    }

    // No discovery match: a supplement entry materializes an unverified resource.
    if (entry.kind === "supplement") {
      seenEntryIds.add(entry.id);
      const id = `${entry.adapterId ?? "registry"}:${entry.resourceType}:${entry.stableKey}`;
      const materialized: ResourceNode = {
        id,
        type: entry.resourceType,
        label: entry.label,
        state: "unknown",
        sourceAdapter: entry.adapterId ?? "registry",
        hostId: nodesById.values().next().value?.hostId ?? "pending",
        properties: {
          registryEntryId: entry.id,
          registryManaged: entry.managed,
          customEndpoint: entry.customEndpoint,
          evidence: ["materialized from registry supplement; awaiting live verification"]
        },
        lastSeenAt: new Date().toISOString(),
        graphSchemaVersion: 2
      };
      nodesById.set(id, materialized);
      merges.push({
        resourceId: id,
        status: "unverified",
        evidence: [`registry supplement ${entry.id}`, entry.customEndpoint ? `custom endpoint ${entry.customEndpoint}` : "no endpoint yet"]
      });
    }
  }

  return {
    nodes: [...nodesById.values()],
    merges,
    attention
  };
}

function entryKey(entry: RegistryEntry): string {
  return `${entry.adapterId ?? ""}|${entry.resourceType}|${entry.stableKey}`;
}

function matchKey(node: ResourceNode): string {
  const stableKey = String(node.properties.stableKey ?? node.id.split(":").slice(2).join(":"));
  return `${node.sourceAdapter}|${node.type}|${stableKey}`;
}

function conflictFor(node: ResourceNode, entry: RegistryEntry): boolean {
  if (!entry.customEndpoint) return false;
  const discovered = node.properties.customEndpoint ?? node.properties.endpoint ?? node.properties.baseUrl;
  return typeof discovered === "string" && discovered.length > 0 && discovered !== entry.customEndpoint;
}