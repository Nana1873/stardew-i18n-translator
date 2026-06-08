/**
 * v1 string validation — M2 / Issue 9 (SPEC §10).
 *
 * Exactly four rules, focused on preventing broken mods (not translation
 * quality). "Token" here means any Stardew/SMAPI protected token (Content
 * Patcher `{{...}}`, dialogue commands `$b`/`@`/`^`, `#$b#`, `%item ... %%`,
 * `[...]`, ...) — see protectedTokens.ts. Tokens are compared as multisets, so
 * a dropped second `$b` is caught too.
 *  - token-missing  (error)   a source token is absent (or under-represented)
 *  - token-added    (warning) the target has a token not in the source
 *  - empty-target   (warning) the key is present in the target file but empty
 *  - json-invalid   (error)   the value cannot be serialized to valid JSON
 *                              (export-serialization safety; e.g. lone surrogate)
 */
import { describeToken, extractProtectedTokens } from "./protectedTokens";

export type Severity = "error" | "warning";

export interface ValidationIssue {
  ruleId: "token-missing" | "token-added" | "empty-target" | "json-invalid";
  severity: Severity;
  message: string;
}

function tokenCounts(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const token of extractProtectedTokens(text)) {
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }
  return counts;
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
    const sourceTokens = tokenCounts(source);
    const targetTokens = tokenCounts(target);
    for (const [token, count] of sourceTokens) {
      if ((targetTokens.get(token) ?? 0) < count) {
        issues.push({
          ruleId: "token-missing",
          severity: "error",
          message: `Missing token ${describeToken(token)}`,
        });
      }
    }
    for (const [token, count] of targetTokens) {
      if ((sourceTokens.get(token) ?? 0) < count) {
        issues.push({
          ruleId: "token-added",
          severity: "warning",
          message: `Unexpected token ${describeToken(token)}`,
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
