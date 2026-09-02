import type { ResourceNode } from "../shared/schemas";

/** Placeholder used by adapters before the runtime stamps the real host scope. */
export const UNSTAMPED_HOST_ID = "pending";

/**
 * Scopes every node to the local host. This is the single normalization point
 * that guarantees "every normalized resource is scoped to the local host".
 */
export function stampHostId(nodes: ResourceNode[], hostId: string): ResourceNode[] {
  return nodes.map((node) => ({ ...node, hostId }));
}

export function isStamped(node: ResourceNode): boolean {
  return node.hostId.length > 0 && node.hostId !== UNSTAMPED_HOST_ID;
}