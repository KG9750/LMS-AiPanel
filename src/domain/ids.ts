import { createHash } from "node:crypto";

export function stableHash(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 16);
}

export function resourceId(adapter: string, type: string, stableKey: string): string {
  return `${adapter}:${type}:${stableKey}`;
}

export function edgeId(source: string, relation: string, target: string): string {
  return `edge:${stableHash(`${source}|${relation}|${target}`)}`;
}

