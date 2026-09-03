import type { RedactionHint, ResourceNode } from "../shared/schemas";

/** Terms that mark a key as sensitive when they appear as a token. */
const SENSITIVE_TERMS = new Set([
  "token",
  "tokens",
  "api",
  "apikey",
  "apikeys",
  "secret",
  "password",
  "credential",
  "auth"
]);

/** Value-level secret patterns: redacted wherever they appear in a string. */
const SECRET_VALUE_PATTERN =
  /(sk-[A-Za-z0-9_-]{8,}|ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[bap]-[A-Za-z0-9-]{10,}|Bearer\s+[A-Za-z0-9._~+/=-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}|glpat-[A-Za-z0-9_-]{15,}|hf_[A-Za-z0-9]{20,})/gi;

/** URL-embedded credentials: scheme://user:password@host and redis://:pass@ */
const URL_CREDENTIAL_PATTERN =
  /([a-z][a-z0-9+.-]*:\/\/)([^/@\s:]*):([^@\s/]+)@/gi;

/**
 * Splits a key into tokens: camelCase ("tokensIn" -> ["tokens","in"]),
 * snake/kebab ("api_key" -> ["api","key"]), and mixed ("ANTHROPIC_API_KEY"
 * -> ["anthropic","api","key"]). "author" -> ["author"] and therefore is NOT
 * sensitive, fixing the old substring-match false positive.
 */
export function sensitiveKeyTokens(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

export function isSensitiveKey(key: string): boolean {
  const tokens = sensitiveKeyTokens(key);
  return tokens.some((token) => SENSITIVE_TERMS.has(token));
}

export function redactSecretString(value: string): string {
  return value
    .replace(SECRET_VALUE_PATTERN, "<redacted>")
    .replace(URL_CREDENTIAL_PATTERN, "$1<redacted>@");
}

/** Numeric metrics counters that must survive redaction (gateway report). */
const NUMERIC_METRIC_KEYS = new Set([
  "tokensin",
  "tokensout",
  "latencyms",
  "count",
  "requests",
  "errors",
  "modelcount",
  "processmemorykb",
  "memorykb",
  "sizebytes",
  "rsskb",
  "durationms"
]);

/**
 * Whether a sensitive-key numeric value is a metric counter (preserved) or a
 * sensitive value (redacted). Numeric secrets under token/password/secret
 * keys are redacted (N5); counter metrics stay visible.
 */
function isMetricCounter(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
  return NUMERIC_METRIC_KEYS.has(normalized);
}

/**
 * Redacts sensitive values recursively.
 *
 * Rules:
 * - A sensitive KEY (token-based matching, see isSensitiveKey) holding a
 *   string is redacted; holding an object/array (credential blocks) the whole
 *   subtree is redacted.
 * - Numeric/boolean values under metric-ish keys (tokensIn, latencyMs, ...)
 *   are counters, not secrets, and are preserved.
 * - Value-level: strings that LOOK like secrets (sk-..., Bearer ..., ghp_...)
 *   are redacted even under non-sensitive keys.
 */
export function redactValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item));
  }

  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) {
      if (isSensitiveKey(key)) {
        result[key] =
          typeof nested === "number" && isMetricCounter(key)
            ? nested
            : typeof nested === "boolean" && isMetricCounter(key)
              ? nested
              : "<redacted>";
      } else {
        result[key] = redactValue(nested);
      }
    }
    return result;
  }

  if (typeof value === "string") {
    return redactSecretString(value);
  }

  return value;
}

/**
 * Line-level redaction for raw config previews: `key = value` lines whose key
 * is sensitive get their value replaced, then value-level patterns are
 * applied to the whole content. Preserves formatting for the diff UX while
 * never exposing plaintext secrets.
 */
export function redactConfigContent(content: string): string {
  const lines = content.split("\n");
  const redacted = lines.map((line) => {
    const match = line.match(/^(\s*)([A-Za-z0-9_.-]+)(\s*=\s*)(.*)$/);
    if (!match) return line;
    const [, indent, key, eq, value] = match;
    if (isSensitiveKey(key)) {
      return `${indent}${key}${eq}"<redacted>"`;
    }
    return `${indent}${key}${eq}${redactSecretString(value)}`;
  });
  return redacted.join("\n");
}

/**
 * Consumes adapter redaction hints at the API boundary: each hint names a
 * node (by resourceId) and a property path whose value must be redacted
 * regardless of its key.
 */
export function applyRedactionHints(nodes: ResourceNode[], hints: RedactionHint[]): ResourceNode[] {
  if (hints.length === 0) return nodes;
  const byId = new Map(nodes.map((node) => [node.id, node]));
  for (const hint of hints) {
    if (!hint.resourceId) continue;
    const node = byId.get(hint.resourceId);
    if (!node) continue;
    const target = walkPath(node, hint.path);
    if (target !== undefined) {
      setPath(node, hint.path, typeof target === "string" ? "<redacted>" : redactValue(target));
    }
  }
  return nodes;
}

function walkPath(obj: unknown, path: string[]): unknown {
  let current = obj;
  for (const segment of path) {
    if (current && typeof current === "object") {
      current = (current as Record<string, unknown>)[segment];
    } else {
      return undefined;
    }
  }
  return current;
}

function setPath(obj: Record<string, unknown>, path: string[], value: unknown): void {
  let current = obj;
  for (let i = 0; i < path.length - 1; i++) {
    const next = current[path[i]];
    if (!next || typeof next !== "object") return;
    current = next as Record<string, unknown>;
  }
  const last = path[path.length - 1];
  if (last) current[last] = value;
}