const SENSITIVE_KEY_PATTERN = /(token|api[_-]?key|secret|password|credential|auth|helper)/i;

/**
 * Redacts sensitive values recursively.
 *
 * Rule: a sensitive KEY with a string value (a real secret) is redacted;
 * sensitive keys holding objects/arrays (credential blocks) are redacted
 * whole. Numeric values under metric-ish keys (tokensIn, latencyMs, ...) are
 * counters, not secrets, and are preserved — this keeps the Observability
 * Gateway report usable while API keys, tokens, and credentials stay hidden.
 */
export function redactValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item));
  }

  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) {
      if (SENSITIVE_KEY_PATTERN.test(key)) {
        result[key] = typeof nested === "number" || typeof nested === "boolean" ? nested : "<redacted>";
      } else {
        result[key] = redactValue(nested);
      }
    }
    return result;
  }

  return value;
}

export function redactStringForDisplay(value: string): string {
  if (!SENSITIVE_KEY_PATTERN.test(value)) {
    return value;
  }
  return "<redacted>";
}