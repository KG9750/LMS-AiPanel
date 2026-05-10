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

  return value;
}

export function redactStringForDisplay(value: string): string {
  if (!SENSITIVE_KEY_PATTERN.test(value)) {
    return value;
  }
  return "<redacted>";
}

