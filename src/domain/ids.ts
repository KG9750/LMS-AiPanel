export function stableKey(input: string): string {
  return Buffer.from(input, "utf8").toString("base64url");
}

export function resourceId(adapter: string, type: string, stableKey: string): string {
  return `${adapter}:${type}:${stableKey}`;
}

export function edgeId(source: string, relation: string, target: string): string {
  return `edge:${stableKey(`${source}|${relation}|${target}`)}`;
}
