/**
 * Protected-token extraction for Stardew/SMAPI strings.
 *
 * Ported from the previous project. Most results are literal tokens a
 * translation MUST preserve; a well-formed gender switch is represented by a
 * canonical per-block shape such as `${^}$` so separate blocks can't mask
 * each other's structural damage:
 *  - Content Patcher / i18n tokens: `{{...}}` (nested-aware)
 *  - gender-switch shapes: `${^}$`, `${^^}$`, `${¦}$`, `${¦¦}$`
 *    (branch prose is translatable; nested runtime tokens are extracted)
 *  - mail commands: `[#]`, `%item ... %%`, `%action ... %%`
 *  - dialogue page break: `#$b#` (and `#$...#` variants)
 *  - documented bracket tokens such as `[FarmName]`, `[128]`, `[(O)163]`,
 *    and item pools like `[(O)198 (O)202 (O)727 (O)MossSoup]`
 *  - positional placeholders: `{0}`
 *  - dialogue commands: `$b`, `$s`, `$e`, `$1` ...
 *  - structural characters: `#`, paired `'` quote delimiters
 *  - single-character tokens: `@` (player name), `^` / `\n` (line break)
 *
 * The order of the readers matters — more specific shapes are tried first.
 *
 * Note: `\n` is extracted (the editor shows it as a chip) but it is **layout,
 * not syntax** — validation reports a count difference as the soft
 * `newline-mismatch` warning, never as the blocking `token-missing` error
 * (translations rewrap freely; see validation.ts / the Rust tokens.rs).
 */
const positionalPlaceholderPattern = /^\{\d+\}/;
const simpleDialogueCommandPattern = /^\$(?:[a-zA-Z]+|\d+)/;
const namespacedTokenNamePattern = /^[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)+$/;

/** TokenizableString forms whose complete bracket expression is opaque: they
 * contain no visible prose arguments that a translation should rewrite. */
const argumentlessBracketTokens = new Set([
  "dayofmonth",
  "farmeruniqueid",
  "farmname",
  "season",
  "positiveadjective",
]);

/** These are genuine 1.6 TokenizableString forms, but their arguments may
 * contain visible text. Keep the complete expression protected for runtime
 * safety until the app has a typed representation for translatable arguments. */
const textArgumentBracketTokens = new Set([
  "genderedtext",
  "spousefarmertext",
  "spousegenderedtext",
  "capitalizefirstletter",
]);

interface Token {
  raw: string;
  end: number;
}

interface GenderSwitch {
  branches: string[];
  end: number;
  separator: "^" | "¦";
}

export function extractProtectedTokens(value: string): string[] {
  const tokens: string[] = [];
  let offset = 0;

  while (offset < value.length) {
    const genderSwitch = readGenderSwitch(value, offset);
    if (genderSwitch) {
      tokens.push(
        genderSwitchShape(genderSwitch.separator, genderSwitch.branches.length),
      );
      genderSwitch.branches.forEach((branch) => {
        tokens.push(...extractProtectedTokens(branch));
      });
      offset = genderSwitch.end;
      continue;
    }

    const token =
      readContentPatcherToken(value, offset) ??
      readMailCommand(value, offset) ??
      readDialogueBreak(value, offset) ??
      readBracketToken(value, offset) ??
      readPositionalPlaceholder(value, offset) ??
      readGenderSwitchFragment(value, offset) ??
      readSimpleDialogueCommand(value, offset) ??
      readSingleCharacterToken(value, offset);

    if (token) {
      tokens.push(token.raw);
      offset = token.end;
    } else {
      offset += 1;
    }
  }

  return tokens;
}

/** A friendlier label for cryptic tokens and switch-shape identities. */
export function describeToken(token: string): string {
  const switchShape = parseGenderSwitchShape(token);
  if (switchShape) {
    return `gender switch (${switchShape.branches} branches, ${switchShape.separator} separator)`;
  }
  if (token === "@") return "@ (player name)";
  if (token === "^") return "^ (switch separator / line break)";
  if (token === "¦") return "¦ (switch separator)";
  if (token === "${") return "${ (switch start)";
  if (token === "}$") return "}$ (switch end)";
  if (token === "#") return "# (dialogue/mail separator)";
  if (token === "'") return "' (quote delimiter)";
  if (token === "\n") return "newline";
  return token;
}

/** Shape identities compare each well-formed switch as one block. They aren't
 * literal source substrings and must not be inserted at the editor cursor. */
export function isInsertableProtectedToken(token: string): boolean {
  return parseGenderSwitchShape(token) === null;
}

function genderSwitchShape(separator: "^" | "¦", branchCount: number): string {
  return "${" + separator.repeat(branchCount - 1) + "}$";
}

function parseGenderSwitchShape(
  token: string,
): { branches: number; separator: "^" | "¦" } | null {
  const match = /^\$\{(\^{1,2}|¦{1,2})\}\$$/.exec(token);
  if (!match) return null;
  return {
    branches: match[1].length + 1,
    separator: match[1][0] as "^" | "¦",
  };
}

function token(value: string, start: number, end: number): Token {
  return { raw: value.slice(start, end), end };
}

function readContentPatcherToken(value: string, offset: number): Token | null {
  if (!value.startsWith("{{", offset)) return null;

  let depth = 0;
  let index = offset;
  while (index < value.length - 1) {
    const placeholder = positionalPlaceholderPattern.exec(value.slice(index));
    if (placeholder) {
      index += placeholder[0].length;
      continue;
    }
    const pair = value.slice(index, index + 2);
    if (pair === "{{") {
      depth += 1;
      index += 2;
      continue;
    }
    if (pair === "}}") {
      depth -= 1;
      index += 2;
      if (depth === 0) return token(value, offset, index);
      continue;
    }
    index += 1;
  }
  return null;
}

function readGenderSwitch(value: string, offset: number): GenderSwitch | null {
  if (!value.startsWith("${", offset)) return null;
  const closingStart = findGenderSwitchClose(value, offset);
  if (closingStart === null) return null;
  const delimiters = findTopLevelGenderDelimiters(
    value,
    offset + 2,
    closingStart,
  );
  if (!delimiters) return null;
  const { separator, offsets: separatorOffsets } = delimiters;

  const branches: string[] = [];
  let branchStart = offset + 2;
  for (const separatorOffset of separatorOffsets) {
    branches.push(value.slice(branchStart, separatorOffset));
    branchStart = separatorOffset + 1;
  }
  branches.push(value.slice(branchStart, closingStart));

  return { branches, end: closingStart + 2, separator };
}

function findGenderSwitchClose(value: string, offset: number): number | null {
  let depth = 1;
  let index = offset + 2;
  while (index < value.length) {
    const contentPatcherToken = readContentPatcherToken(value, index);
    if (contentPatcherToken) {
      index = contentPatcherToken.end;
      continue;
    }
    if (value.startsWith("${", index)) {
      depth += 1;
      index += 2;
      continue;
    }
    if (value.startsWith("}$", index)) {
      depth -= 1;
      if (depth === 0) return index;
      index += 2;
      continue;
    }
    index += 1;
  }
  return null;
}

function findTopLevelGenderDelimiters(
  value: string,
  start: number,
  end: number,
): { offsets: number[]; separator: "^" | "¦" } | null {
  const carets: number[] = [];
  const brokenBars: number[] = [];
  let depth = 0;
  let index = start;
  while (index < end) {
    const contentPatcherToken = readContentPatcherToken(value, index);
    if (contentPatcherToken) {
      index = contentPatcherToken.end;
      continue;
    }
    if (value.startsWith("${", index)) {
      depth += 1;
      index += 2;
      continue;
    }
    if (value.startsWith("}$", index) && depth > 0) {
      depth -= 1;
      index += 2;
      continue;
    }
    if (depth === 0 && value[index] === "^") carets.push(index);
    if (depth === 0 && value[index] === "¦") brokenBars.push(index);
    index += 1;
  }

  const separator: "^" | "¦" = brokenBars.length > 0 ? "¦" : "^";
  const offsets = separator === "¦" ? brokenBars : carets;
  return offsets.length >= 1 && offsets.length <= 2
    ? { offsets, separator }
    : null;
}

/** Keep malformed switch delimiters visible to validation instead of silently
 * accepting a broken translation. Valid switches are consumed before this. */
function readGenderSwitchFragment(value: string, offset: number): Token | null {
  if (value.startsWith("${", offset)) return token(value, offset, offset + 2);
  if (value.startsWith("}$", offset)) return token(value, offset, offset + 2);
  return null;
}

function readMailCommand(value: string, offset: number): Token | null {
  if (value.startsWith("[#]", offset)) return token(value, offset, offset + 3);
  if (
    !value.startsWith("%item ", offset) &&
    !value.startsWith("%action ", offset)
  ) {
    return null;
  }
  const end = value.indexOf("%%", offset);
  return end >= 0 ? token(value, offset, end + 2) : null;
}

function readDialogueBreak(value: string, offset: number): Token | null {
  if (!value.startsWith("#$", offset)) return null;
  const end = value.indexOf("#", offset + 2);
  return end >= 0 ? token(value, offset, end + 1) : null;
}

function readBracketToken(value: string, offset: number): Token | null {
  if (value[offset] !== "[") return null;
  const end = findBalancedBracketEnd(value, offset);
  if (end === null) return null;

  const body = value.slice(offset + 1, end - 1);
  if (!isProtectedBracketBody(body)) return null;
  return token(value, offset, end);
}

function findBalancedBracketEnd(value: string, offset: number): number | null {
  let depth = 0;
  for (let index = offset; index < value.length; index += 1) {
    if (value[index] === "[") depth += 1;
    if (value[index] !== "]") continue;
    depth -= 1;
    if (depth === 0) return index + 1;
  }
  return null;
}

function isProtectedBracketBody(body: string): boolean {
  if (
    body === "#" ||
    isAsciiDigits(body) ||
    isQualifiedItemId(body) ||
    isItemIdPool(body)
  )
    return true;

  const { name, arguments: argumentText } = splitBracketName(body);
  if (name.length === 0) return false;
  const normalizedName = name.toLowerCase();

  if (argumentlessBracketTokens.has(normalizedName))
    return argumentText.length === 0;
  if (
    [
      "farmerstat",
      "achievementname",
      "charactername",
      "locationname",
      "moviename",
      "specialordername",
      "numberwithseparators",
    ].includes(normalizedName)
  ) {
    return hasAtomicArgumentCount(argumentText, 1, 1);
  }
  if (normalizedName === "articlefor") {
    return (
      hasAtomicArgumentCount(argumentText, 1, 1) ||
      isSingleProtectedBracketArgument(argumentText)
    );
  }
  if (normalizedName === "suggesteditem")
    return hasAtomicArgumentCount(argumentText, 0, 2);
  if (normalizedName === "itemnamewithflavor")
    return hasAtomicArgumentCount(argumentText, 2, 2);
  if (normalizedName === "toolname")
    return hasAtomicArgumentCount(argumentText, 1, 2);
  if (normalizedName === "itemname") {
    const itemId = argumentText.split(/\s+/, 1)[0] ?? "";
    return isItemId(itemId);
  }
  if (normalizedName === "localizedtext") return argumentText.length > 0;
  if (normalizedName === "escapedtext") return true;
  if (textArgumentBracketTokens.has(normalizedName))
    return argumentText.length > 0;

  return namespacedTokenNamePattern.test(name);
}

function splitBracketName(body: string): {
  arguments: string;
  name: string;
} {
  const nameEnd = body.search(/\s/);
  return nameEnd < 0
    ? { arguments: "", name: body }
    : {
        arguments: body.slice(nameEnd).trim(),
        name: body.slice(0, nameEnd),
      };
}

function atomicArguments(argumentsText: string): string[] {
  if (argumentsText.includes("[") || argumentsText.includes("]")) return [];
  return argumentsText.length === 0 ? [] : argumentsText.split(/\s+/);
}

function hasAtomicArgumentCount(
  argumentsText: string,
  minimum: number,
  maximum: number,
): boolean {
  if (argumentsText.length === 0) return minimum === 0;
  if (argumentsText.includes("[") || argumentsText.includes("]")) return false;
  const argumentsList = atomicArguments(argumentsText);
  return argumentsList.length >= minimum && argumentsList.length <= maximum;
}

function isSingleProtectedBracketArgument(argumentsText: string): boolean {
  if (argumentsText[0] !== "[") return false;
  const end = findBalancedBracketEnd(argumentsText, 0);
  return (
    end === argumentsText.length &&
    isProtectedBracketBody(argumentsText.slice(1, -1).trim())
  );
}

function isAsciiDigits(value: string): boolean {
  return /^\d+$/.test(value);
}

function isItemId(value: string): boolean {
  return isAsciiIdSegment(value) || isQualifiedItemId(value);
}

function isItemIdPool(value: string): boolean {
  if (value.trim() !== value) return false;
  const itemIds = value.split(/\s+/);
  if (itemIds.length < 2) return false;

  // Bare string item IDs are indistinguishable from bracketed UI prose
  // without the game's item registry. Accept only numeric or qualified IDs
  // here so `[buff 5]`, `[(O)198 prose]`, and status labels stay translatable.
  return itemIds.every(
    (itemId) => isAsciiDigits(itemId) || isQualifiedItemId(itemId),
  );
}

function isQualifiedItemId(value: string): boolean {
  const closingParenthesis = value.indexOf(")");
  return (
    value.startsWith("(") &&
    closingParenthesis > 1 &&
    isAsciiIdSegment(value.slice(1, closingParenthesis)) &&
    isAsciiIdSegment(value.slice(closingParenthesis + 1))
  );
}

function isAsciiIdSegment(value: string): boolean {
  return /^[A-Za-z0-9_.]+$/.test(value);
}

function readPositionalPlaceholder(
  value: string,
  offset: number,
): Token | null {
  const match = positionalPlaceholderPattern.exec(value.slice(offset));
  return match ? token(value, offset, offset + match[0].length) : null;
}

function readSimpleDialogueCommand(
  value: string,
  offset: number,
): Token | null {
  const match = simpleDialogueCommandPattern.exec(value.slice(offset));
  return match ? token(value, offset, offset + match[0].length) : null;
}

function readSingleCharacterToken(value: string, offset: number): Token | null {
  const char = value[offset];
  if (
    char === "@" ||
    char === "^" ||
    char === "#" ||
    char === "\n" ||
    (char === "'" && isPairedQuoteDelimiter(value, offset))
  ) {
    return token(value, offset, offset + 1);
  }
  return null;
}

/** Apostrophes inside words (`don't`, `farmer's`) are prose, not syntax.
 * Standalone single quotes are protected only when they form a balanced pair,
 * e.g. `'test'`, so an isolated punctuation apostrophe is not overvalidated. */
function isPairedQuoteDelimiter(value: string, offset: number): boolean {
  if (value[offset] !== "'" || isWordApostrophe(value, offset)) return false;
  let delimiters = 0;
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === "'" && !isWordApostrophe(value, index))
      delimiters += 1;
  }
  return delimiters >= 2 && delimiters % 2 === 0;
}

function isWordApostrophe(value: string, offset: number): boolean {
  return (
    isLetterOrDigit(value[offset - 1]) && isLetterOrDigit(value[offset + 1])
  );
}

function isLetterOrDigit(char: string | undefined): boolean {
  return char !== undefined && /[\p{L}\p{N}]/u.test(char);
}
