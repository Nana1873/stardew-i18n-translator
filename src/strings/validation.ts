/**
 * String validation rules. See SPEC.md, Validation and Export.
 *
 * Five rules, focused on preventing broken mods and surfacing review risks.
 * "Token" here means any Stardew/SMAPI protected token (Content Patcher
 * `{{...}}`, dialogue commands `$b`/`@`/`^`, `#$b#`, `%item ... %%`,
 * and recognized bracket forms like `[FarmName]`) — see protectedTokens.ts.
 * Tokens are compared as multisets, so
 * a dropped second `$b` is caught too.
 *  - token-missing    (error or warning, see tokenSeverity) a source token is
 *                                absent (or under-represented)
 *  - token-added      (error or warning) the target has more of a token
 *  - json-invalid     (error)   the value cannot be serialized to valid JSON
 *                                (export-serialization safety; e.g. lone surrogate)
 *  - escape-suspicious   (warning) literal JSON-style escapes differ
 */
import {
  isBlankText,
  noTranslationNeeded,
  isIntentionalBlankTarget,
} from "./status";
import {
  articleForArgument,
  branchText,
  extractProtectedTokens,
  pagesWithMultiplePortraits,
  isGenderSwitchShape,
  tokenSeverity,
} from "./protectedTokens";
import { describeTokenIssue, type TokenDifference } from "./tokenIssueText";

export type { TokenDifference };

export type Severity = "error" | "warning";

export interface ValidationIssue {
  ruleId:
    "token-missing" | "token-added" | "json-invalid" | "escape-suspicious";
  severity: Severity;
  message: string;
  /** The protected token a token issue is about, when it names one. */
  token?: string;
}

/** True for a token-missing or token-added issue. */
export function isTokenIssue(issue: ValidationIssue): boolean {
  return issue.ruleId === "token-missing" || issue.ruleId === "token-added";
}

/** Non-blocking markers kept out of the token error multisets.
 *  - `\n` is layout, not syntax (a translation rewraps freely).
 *  - `'` paired quote delimiters are punctuation, not runtime syntax in SMAPI
 *    i18n, so adding/removing/restyling quotes is ignored. */
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

/** Token counts as one player sees them: switch-shape identities keep their
 * full count, every other token takes its highest count over the gender
 * branches instead of the sum of all branches. */
function playerViewCounts(
  text: string,
  counts: Map<string, number>,
): Map<string, number> {
  const view = new Map<string, number>();
  for (const [token, count] of counts)
    if (isGenderSwitchShape(token)) view.set(token, count);
  for (let branch = 0; branch < 3; branch += 1) {
    for (const [token, count] of tokenCounts(branchText(text, branch))) {
      if (count > (view.get(token) ?? 0)) view.set(token, count);
    }
  }
  return view;
}

/**
 * Source and target token counts as the comparison uses them. The editor's
 * token chips read these too, so a chip never asks for a token the export
 * would not require.
 */
export function comparableTokenCounts(
  source: string,
  target: string,
): { source: Map<string, number>; target: Map<string, number> } {
  let sourceTokens = tokenCounts(source);
  let targetTokens = tokenCounts(target);
  // A switch removed (languages without grammatical gender) or added (the
  // source has none) changes only which branch a player reads. Compare the
  // side that has the switch as a player sees it, so tokens repeated in
  // every branch are not counted once per branch.
  const sourceSwitches = [...sourceTokens.keys()].some(isGenderSwitchShape);
  const targetSwitches = [...targetTokens.keys()].some(isGenderSwitchShape);
  if (sourceSwitches && !targetSwitches)
    sourceTokens = playerViewCounts(source, sourceTokens);
  if (targetSwitches && !sourceSwitches)
    targetTokens = playerViewCounts(target, targetTokens);
  [sourceTokens, targetTokens] = unifyPlaceholderSpellings(
    sourceTokens,
    targetTokens,
  );
  allowArticleForArguments(sourceTokens, targetTokens);
  return { source: sourceTokens, target: targetTokens };
}

/** Compares by Unicode code point, like Rust `str` ordering. */
function compareCodePoints(left: string, right: string): number {
  const a = Array.from(left, (char) => char.codePointAt(0) ?? 0);
  const b = Array.from(right, (char) => char.codePointAt(0) ?? 0);
  for (let index = 0; index < Math.min(a.length, b.length); index += 1)
    if (a[index] !== b[index]) return a[index] - b[index];
  return a.length - b.length;
}

/**
 * SMAPI trims `{{…}}` token names and looks them up case-insensitively, and
 * Content Patcher tokens are case-insensitive too, so `{{ name }}`,
 * `{{name}}`, and `{{Name}}` are one placeholder. Each group keeps one
 * spelling as written: the first in code-point order from the English text,
 * else from the translation. Mirrors Rust `unify_placeholder_spellings`.
 */
function unifyPlaceholderSpellings(
  source: Map<string, number>,
  target: Map<string, number>,
): [Map<string, number>, Map<string, number>] {
  const spelling = new Map<string, string>();
  for (const counts of [source, target]) {
    const own = new Map<string, string>();
    for (const token of counts.keys()) {
      if (!token.startsWith("{{")) continue;
      const key = placeholderKey(token);
      if (spelling.has(key)) continue;
      const known = own.get(key);
      if (known === undefined || compareCodePoints(token, known) < 0)
        own.set(key, token);
    }
    for (const [key, token] of own) spelling.set(key, token);
  }
  const merge = (counts: Map<string, number>) => {
    const merged = new Map<string, number>();
    for (const [token, count] of counts) {
      const name = token.startsWith("{{")
        ? (spelling.get(placeholderKey(token)) ?? token)
        : token;
      merged.set(name, (merged.get(name) ?? 0) + count);
    }
    return merged;
  };
  return [merge(source), merge(target)];
}

/** Lowercase, with ASCII spaces removed right inside each `{{` and `}}`.
 * SMAPI only replaces `{{([ \w\.\-]+)}}`, so a tab, U+00A0, or U+3000 there
 * stays visible and keeps the token different. Mirrors Rust
 * `placeholder_key` character for character. */
function placeholderKey(token: string): string {
  const chars = Array.from(token.toLowerCase());
  const isSpace = (char: string | undefined) => char === " ";
  let key = "";
  let index = 0;
  while (index < chars.length) {
    if (chars[index] === "{" && chars[index + 1] === "{") {
      key += "{{";
      index += 2;
      while (isSpace(chars[index])) index += 1;
      continue;
    }
    if (isSpace(chars[index])) {
      let end = index;
      while (isSpace(chars[end])) end += 1;
      if (chars[end] === "}" && chars[end + 1] === "}") {
        index = end;
        continue;
      }
    }
    key += chars[index];
    index += 1;
  }
  return key;
}

/** A translation that drops `[ArticleFor [X]]` but keeps `[X]` itself (to
 * write its own article) loses only the article. The inner `[X]` is provided
 * by the dropped wrapper, so it is not also reported as added. Mirrors Rust
 * `allow_article_for_arguments`. */
function allowArticleForArguments(
  source: Map<string, number>,
  target: Map<string, number>,
) {
  const dropped = new Map<string, number>();
  for (const [token, count] of source) {
    const inner = articleForArgument(token);
    if (inner === null) continue;
    const lost = count - (target.get(token) ?? 0);
    if (lost > 0) dropped.set(inner, (dropped.get(inner) ?? 0) + lost);
  }
  for (const [inner, lost] of dropped) {
    const expected = source.get(inner) ?? 0;
    const extra = (target.get(inner) ?? 0) - expected;
    if (extra > 0) source.set(inner, expected + Math.min(lost, extra));
  }
}

/**
 * Every protected-token count difference between a source and its
 * translation, with the severity the export uses. The editor reads this to
 * colour its token chips; `validate` turns the same list into messages.
 */
export function tokenDifferences(
  source: string,
  target: string,
): TokenDifference[] {
  const { source: sourceTokens, target: targetTokens } = comparableTokenCounts(
    source,
    target,
  );
  const sourceHasGenderSwitch = [...sourceTokens.keys()].some(
    isGenderSwitchShape,
  );
  const introducesMultiplePortraits =
    pagesWithMultiplePortraits(target) > pagesWithMultiplePortraits(source);
  const differences: TokenDifference[] = [];
  const addDifference = (
    token: string,
    sourceCount: number,
    targetCount: number,
  ) =>
    differences.push({
      token,
      sourceCount,
      targetCount,
      severity: tokenSeverity(
        token,
        sourceCount,
        targetCount,
        introducesMultiplePortraits,
      ),
    });
  for (const [token, count] of sourceTokens) {
    const found = targetTokens.get(token) ?? 0;
    if (found < count) addDifference(token, count, found);
  }
  for (const [token, count] of targetTokens) {
    // A translation may introduce gender grammar when the source has no
    // switch at all. Once source switches exist, keep exact shape counts so
    // a changed source block cannot be masked by an extra target block.
    if (!sourceHasGenderSwitch && isGenderSwitchShape(token)) continue;
    const expected = sourceTokens.get(token) ?? 0;
    if (expected < count) addDifference(token, expected, count);
  }
  return differences;
}

export function validate(source: string, target: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  if (noTranslationNeeded(source, target)) return issues;

  if (target.length > 0) {
    const differences = tokenDifferences(source, target);
    for (const item of describeTokenIssue(differences, target)) {
      issues.push({
        ruleId: item.kind === "missing" ? "token-missing" : "token-added",
        severity: item.severity,
        message: item.message,
        ...(item.token === undefined ? {} : { token: item.token }),
      });
    }
    if (hasLoneSurrogate(target)) {
      issues.push({
        ruleId: "json-invalid",
        severity: "error",
        message:
          "Contains a broken character that can't be saved. Retype or delete it.",
      });
    }
    if (escapeSummary(source) !== escapeSummary(target)) {
      issues.push({
        ruleId: "escape-suspicious",
        severity: "warning",
        message:
          "Special codes like \\n differ from the English text. Check line breaks and quotes.",
      });
    }
  }
  return issues;
}

export function worstSeverity(issues: ValidationIssue[]): Severity | null {
  if (issues.some((issue) => issue.severity === "error")) return "error";
  if (issues.length > 0) return "warning";
  return null;
}
