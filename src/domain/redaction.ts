import type { AdapterResult, RedactionHint, ResourceNode } from "../shared/schemas";

const SENSITIVE_KEY_PATTERN = /(token|api[_-]?key|secret|password|credential|auth|helper)/i;

export function redactValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item));
  }

  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) {
      result[key] = SENSITIVE_KEY_PATTERN.test(key) ? "<redacted>" : redactValue(nested);
    }
    return result;
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        return JSON.stringify(redactValue(JSON.parse(trimmed) as unknown));
      } catch {
        // Non-JSON display strings are handled by the narrow text rule below.
      }
    }
  }

  return value;
}

export function redactStringForDisplay(value: string): string {
  if (!SENSITIVE_KEY_PATTERN.test(value)) {
    return value;
  }
  return "<redacted>";
}

export function redactAdapterResult(result: AdapterResult): AdapterResult {
  const redacted = redactValue(result) as AdapterResult;
  for (const hint of result.redactionHints) {
    applyHint(redacted.nodes, hint);
  }
  return redacted;
}

function applyHint(nodes: ResourceNode[], hint: RedactionHint): void {
  const targets = hint.resourceId ? nodes.filter((node) => node.id === hint.resourceId) : nodes;
  for (const target of targets) {
    let current: unknown = target;
    for (const segment of hint.path.slice(0, -1)) {
      if (!current || typeof current !== "object") {
        current = undefined;
        break;
      }
      current = (current as Record<string, unknown>)[segment];
    }
    const final = hint.path.at(-1);
    if (final && current && typeof current === "object" && final in current) {
      (current as Record<string, unknown>)[final] = "<redacted>";
    }
  }
}
