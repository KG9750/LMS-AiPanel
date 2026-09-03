import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { GRAPH_SCHEMA_VERSION, type EdgeRelation, type ResourceEdge, type ResourceNode, type ResourceState, type ResourceType } from "../shared/schemas";
import { UNSTAMPED_HOST_ID } from "../domain/scope";
import { edgeId, resourceId, stableHash } from "../domain/ids";

export function homePath(...parts: string[]): string {
  return path.join(os.homedir(), ...parts);
}

export async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function readJsonFile(filePath: string): Promise<unknown | null> {
  try {
    const text = await fs.readFile(filePath, "utf8");
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

export function node(
  adapter: string,
  type: ResourceType,
  stableKey: string,
  label: string,
  state: ResourceState,
  properties: Record<string, unknown> = {}
): ResourceNode {
  return {
    id: resourceId(adapter, type, stableKey),
    type,
    label,
    state,
    sourceAdapter: adapter,
    hostId: UNSTAMPED_HOST_ID,
    properties,
    lastSeenAt: new Date().toISOString(),
    graphSchemaVersion: GRAPH_SCHEMA_VERSION
  };
}

export function edge(
  source: string,
  relation: EdgeRelation,
  target: string,
  properties: Record<string, unknown> = {}
): ResourceEdge {
  return {
    id: edgeId(source, relation, target),
    source,
    target,
    relation,
    properties,
    graphSchemaVersion: GRAPH_SCHEMA_VERSION
  };
}

export function pathKey(filePath: string): string {
  return `path-${stableHash(filePath)}`;
}

