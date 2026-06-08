/**
 * v1 string validation — M2 / Issue 9 (SPEC §10).
 *
 * Exactly four rules, focused on preventing broken mods (not translation
 * quality):
 *  - token-missing  (error)   a source {{token}} is absent from the target
 *  - token-added    (warning) the target has a {{token}} not in the source
 *  - empty-target   (warning) the key is present in the target file but empty
 *  - json-invalid   (error)   the value cannot be serialized to valid JSON
 *                              (export-serialization safety; e.g. lone surrogate)
 */
export type Severity = "error" | "warning";

export interface ValidationIssue {
  ruleId: "token-missing" | "token-added" | "empty-target" | "json-invalid";
  severity: Severity;
  message: string;
}

const TOKEN_RE = /\{\{([^}]+)\}\}/g;

function tokenSet(text: string): Set<string> {
  return new Set(Array.from(text.matchAll(TOKEN_RE), (match) => match[0]));
}

/** True if the string contains an unpaired UTF-16 surrogate (invalid JSON). */
function hasLoneSurrogate(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      i += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

export function validate(
  source: string,
  target: string,
  targetPresent: boolean,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  if (target.length > 0) {
    const sourceTokens = tokenSet(source);
    const targetTokens = tokenSet(target);
    for (const token of sourceTokens) {
      if (!targetTokens.has(token)) {
        issues.push({
          ruleId: "token-missing",
          severity: "error",
          message: `Missing token ${token}`,
        });
      }
    }
    for (const token of targetTokens) {
      if (!sourceTokens.has(token)) {
        issues.push({
          ruleId: "token-added",
          severity: "warning",
          message: `Unexpected token ${token}`,
        });
      }
    }
    if (hasLoneSurrogate(target)) {
      issues.push({
        ruleId: "json-invalid",
        severity: "error",
        message: "Contains characters that cannot be serialized to valid JSON",
      });
    }
  } else if (targetPresent) {
    issues.push({
      ruleId: "empty-target",
      severity: "warning",
      message: "Key is present but empty",
    });
  }

  return issues;
}

export function worstSeverity(issues: ValidationIssue[]): Severity | null {
  if (issues.some((issue) => issue.severity === "error")) return "error";
  if (issues.length > 0) return "warning";
  return null;
}
