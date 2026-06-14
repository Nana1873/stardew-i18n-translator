/**
 * v1 string validation — M2 / Issue 9 (SPEC §10).
 *
 * Five rules, focused on preventing broken mods (not translation quality).
 * "Token" here means any Stardew/SMAPI protected token (Content Patcher
 * `{{...}}`, dialogue commands `$b`/`@`/`^`, `#$b#`, `%item ... %%`,
 * `[...]`, ...) — see protectedTokens.ts. Tokens are compared as multisets, so
 * a dropped second `$b` is caught too.
 *  - token-missing    (error)   a source token is absent (or under-represented)
 *  - token-added      (error)   the target has more of a token than the source
 *  - newline-mismatch (warning) the line-break count differs — layout, not
 *                                syntax: a translation rewraps freely (German
 *                                runs longer than English), so `\n` is exempt
 *                                from the token error rules and never blocks
 *                                export
 *  - quote-mismatch   (warning) the paired `'` quote-delimiter count differs —
 *                                punctuation, not runtime syntax in SMAPI i18n,
 *                                so `'` is exempt from the token error rules and
 *                                never blocks export (SPEC §10)
 *  - empty-target     (warning) the key is present in the target file but empty
 *  - json-invalid     (error)   the value cannot be serialized to valid JSON
 *                                (export-serialization safety; e.g. lone surrogate)
 *  - identical-to-source (warning) target is unchanged from the source
 *  - escape-suspicious   (warning) literal JSON-style escapes differ
 */
import { describeToken, extractProtectedTokens } from "./protectedTokens";

export type Severity = "error" | "warning";

export interface ValidationIssue {
  ruleId:
    | "token-missing"
    | "token-added"
    | "newline-mismatch"
    | "quote-mismatch"
    | "empty-target"
    | "json-invalid"
    | "identical-to-source"
    | "escape-suspicious";
  severity: Severity;
  message: string;
}

/** Soft tokens: extracted (shown as chips) but kept out of the token error
 * multisets. A count difference is reported via a softer warning instead, never
 * the blocking token-missing/token-added error.
 *  - `\n` is layout, not syntax (a translation rewraps freely).
 *  - `'` paired quote delimiters are punctuation, not runtime syntax in SMAPI
 *    i18n, so adding/removing/restyling quotes never breaks a mod (SPEC §10). */
const NEWLINE = "\n";
const QUOTE = "'";

function tokenCounts(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const token of extractProtectedTokens(text)) {
    if (token === NEWLINE || token === QUOTE) continue;
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }
  return counts;
}

function newlineCount(text: string): number {
  let count = 0;
  for (const char of text) if (char === NEWLINE) count += 1;
  return count;
}

/** Count of paired `'` quote delimiters (word-internal apostrophes excluded —
 * the extractor only emits `'` when it forms a balanced pair). */
function quoteDelimiterCount(text: string): number {
  let count = 0;
  for (const token of extractProtectedTokens(text))
    if (token === QUOTE) count += 1;
  return count;
}

function escapeCounts(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const match of text.matchAll(/\\(?:["\\nrt])/g)) {
    const escape = match[0];
    counts.set(escape, (counts.get(escape) ?? 0) + 1);
  }
  return counts;
}

function escapeSummary(text: string): string {
  return [...escapeCounts(text)]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([escape, count]) => `${escape} x${count}`)
    .join(", ");
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
        const found = targetTokens.get(token) ?? 0;
        issues.push({
          ruleId: "token-missing",
          severity: "error",
          message: `Token count mismatch for ${describeToken(token)} (expected ${count}, found ${found})`,
        });
      }
    }
    for (const [token, count] of targetTokens) {
      if ((sourceTokens.get(token) ?? 0) < count) {
        const expected = sourceTokens.get(token) ?? 0;
        issues.push({
          ruleId: "token-added",
          severity: "error",
          message: `Token count mismatch for ${describeToken(token)} (expected ${expected}, found ${count})`,
        });
      }
    }
    const sourceNewlines = newlineCount(source);
    const targetNewlines = newlineCount(target);
    if (sourceNewlines !== targetNewlines) {
      issues.push({
        ruleId: "newline-mismatch",
        severity: "warning",
        message: `Line breaks differ (original ${sourceNewlines}, translation ${targetNewlines}) — fine if the text rewraps`,
      });
    }
    const sourceQuotes = quoteDelimiterCount(source);
    const targetQuotes = quoteDelimiterCount(target);
    if (sourceQuotes !== targetQuotes) {
      issues.push({
        ruleId: "quote-mismatch",
        severity: "warning",
        message: `Quote delimiters differ (original ${sourceQuotes}, translation ${targetQuotes}) — fine if the punctuation legitimately changed`,
      });
    }
    if (hasLoneSurrogate(target)) {
      issues.push({
        ruleId: "json-invalid",
        severity: "error",
        message: "Contains characters that cannot be serialized to valid JSON",
      });
    }
    if (source === target) {
      issues.push({
        ruleId: "identical-to-source",
        severity: "warning",
        message: "Translation is identical to the original",
      });
    }
    if (escapeSummary(source) !== escapeSummary(target)) {
      issues.push({
        ruleId: "escape-suspicious",
        severity: "warning",
        message: "Literal escape sequences differ from the original",
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
