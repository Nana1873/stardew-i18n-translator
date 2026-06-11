/**
 * Protected-token extraction for Stardew/SMAPI strings.
 *
 * Ported (and trimmed to raw-string output) from the previous project. These
 * are the tokens a translation MUST preserve or the mod breaks at runtime:
 *  - Content Patcher / i18n tokens: `{{...}}` (nested-aware)
 *  - gender switch: `${male^female}$`
 *  - mail commands: `[#]`, `%item ... %%`, `%action ... %%`
 *  - dialogue page break: `#$b#` (and `#$...#` variants)
 *  - bracket tokens: `[...]`
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

interface Token {
  raw: string;
  end: number;
}

export function extractProtectedTokens(value: string): string[] {
  const tokens: string[] = [];
  let offset = 0;

  while (offset < value.length) {
    const token =
      readContentPatcherToken(value, offset) ??
      readGenderSwitch(value, offset) ??
      readMailCommand(value, offset) ??
      readDialogueBreak(value, offset) ??
      readBracketToken(value, offset) ??
      readPositionalPlaceholder(value, offset) ??
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

/** A friendlier label for cryptic single-character tokens. */
export function describeToken(token: string): string {
  if (token === "@") return "@ (player name)";
  if (token === "^") return "^ (line break)";
  if (token === "#") return "# (dialogue/mail separator)";
  if (token === "'") return "' (quote delimiter)";
  if (token === "\n") return "newline";
  return token;
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

function readGenderSwitch(value: string, offset: number): Token | null {
  if (!value.startsWith("${", offset)) return null;
  const end = value.indexOf("}$", offset + 2);
  return end >= 0 ? token(value, offset, end + 2) : null;
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
  const end = value.indexOf("]", offset + 1);
  return end >= 0 ? token(value, offset, end + 1) : null;
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
