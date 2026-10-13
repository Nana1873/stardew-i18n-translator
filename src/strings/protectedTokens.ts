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
 *  - dialogue page break: `#$b#` (and `#$...#` variants), with bounded
 *    recovery for malformed dollar-terminated markers like `#$b$`
 *  - documented bracket tokens such as `[FarmName]`, `[128]`, `[(O)163]`,
 *    and item pools like `[(O)198 (O)202 (O)727 (O)MossSoup]`
 *  - positional placeholders: `{0}`
 *  - dialogue commands: `$b`, `$s`, `$e`, `$1` ...
 *  - structural characters: `#`, paired `'` quote delimiters (quotes are
 *    classified but ignored by validation and editor token counts)
 *  - single-character tokens: `@` (player name), `^` / `\n` (line break)
 *  - dialogue placeholders such as `%spouse`, `%farm`, `%kid1`, and `%noturn`
 *
 * The order of the readers matters — more specific shapes are tried first.
 *
 * Note: `\n` is extracted (the editor shows it as a chip) but it is **layout,
 * not syntax** and is ignored by validation because translations rewrap
 * freely. Runtime line breaks such as `^` remain protected.
 */
const positionalPlaceholderPattern = /^\{\d+\}/;
const simpleDialogueCommandPattern = /^\$(?:[a-zA-Z]+|\d+)/;
const namespacedTokenNamePattern = /^[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)+$/;

/** Unicode White_Space, the set Rust `char::is_whitespace`, `trim`, and
 * `split_whitespace` use. JS `\s` and `trim()` differ: they include U+FEFF
 * but not U+0085, so the two readers would split tokens differently. */
const whiteSpace = /\p{White_Space}/u;
const whiteSpaceRun = /\p{White_Space}+/u;

function trimWhiteSpace(value: string): string {
  return value.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, "");
}

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

/** Dialogue commands that take arguments up to the next `#` when they open a
 * string, e.g. `$q 305/306 null#`, `$1 metHarvey#`, `$p 305#`, `$c 0.5#`,
 * `$d bus#`. Their arguments are response ids, flags, and keys, not prose. */
const leadingCommandPattern = /^\$(?:q|p|c|d|1) [^#]*#/;

export function extractProtectedTokens(value: string): string[] {
  const leading = leadingCommandPattern.exec(value);
  if (!leading) return extractTokens(value);
  // Arguments are split on spaces with empty entries removed by the game, so
  // only the spacing is canonicalized; every argument stays exact.
  const raw = leading[0];
  const command = `${raw.slice(0, -1).split(" ").filter(Boolean).join(" ")}#`;
  return [command, ...extractTokens(value.slice(raw.length))];
}

function extractTokens(value: string): string[] {
  const tokens: string[] = [];
  let offset = 0;

  while (offset < value.length) {
    const genderSwitch = readGenderSwitch(value, offset);
    if (genderSwitch) {
      tokens.push(
        genderSwitchShape(genderSwitch.separator, genderSwitch.branches.length),
      );
      genderSwitch.branches.forEach((branch) => {
        tokens.push(...extractTokens(branch));
      });
      offset = genderSwitch.end;
      continue;
    }

    // `#$y '…'`: the page break belongs to the quick response; without it the
    // game shows the command as text, so it is protected with it.
    if (value[offset] === "#" && quickResponseQuote(value, offset + 1) >= 0) {
      const quick = readQuickResponse(value, offset + 1);
      if (quick) {
        tokens.push("#$y", ...quick.tokens.slice(1));
        offset = quick.end;
        continue;
      }
    }
    const action =
      readBetasMessage(value, offset) ?? readQuickResponse(value, offset);
    if (action) {
      tokens.push(...action.tokens);
      offset = action.end;
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
      readEventCommand(value, offset) ??
      readPercentPlaceholder(value, offset) ??
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
  if (token === "_") return "_ (quick-response separator)";
  if (token === "*") return "* (quick-response page break)";
  if (token === "\n") return "newline";
  return token;
}

export type TokenSeverity = "error" | "warning";

/** Portrait/emotion commands only change the face; a missing sheet index
 * falls back to portrait 0 (DialogueBox bounds check). */
export function isPortraitCommand(token: string): boolean {
  return (
    ["$h", "$s", "$u", "$l", "$a"].includes(token) || /^\$\d+$/.test(token)
  );
}

/** The game applies one emotion per dialogue page and removes every copy of
 * it (`Dialogue.checkEmotions` uses `Replace`), so a repeated portrait is
 * harmless; a second, different one stays visible as raw text. Counts the
 * pages that show such raw text, for the player gender where most pages do
 * (each switch branch is what one player sees). Mirrors Rust
 * `pages_with_multiple_portraits`. */
export function pagesWithMultiplePortraits(value: string): number {
  return Math.max(
    ...[0, 1, 2].map(
      (branch) =>
        branchText(value, branch)
          .split("#")
          .map((page) => genderHalf(page, branch))
          .filter(
            (page) =>
              new Set(extractProtectedTokens(page).filter(isPortraitCommand))
                .size > 1,
          ).length,
    ),
  );
}

/** `Dialogue.applyGenderSwitch` also cuts a page at its first bare `^`: the
 * male player sees the left part, everyone else the right part. Letters have
 * no portraits, so this split never affects them. */
function genderHalf(page: string, branch: number): string {
  const caret = page.indexOf("^");
  if (caret < 0) return page;
  return branch === 0 ? page.slice(0, caret) : page.slice(caret + 1);
}

/** The text a player sees for one gender: every well-formed switch is
 * replaced by its branch `branch` (the last branch when it has fewer). */
export function branchText(value: string, branch: number): string {
  let text = "";
  let offset = 0;
  while (offset < value.length) {
    const genderSwitch = readGenderSwitch(value, offset);
    if (genderSwitch) {
      const branches = genderSwitch.branches;
      text += branchText(
        branches[Math.min(branch, branches.length - 1)],
        branch,
      );
      offset = genderSwitch.end;
      continue;
    }
    text += value[offset];
    offset += 1;
  }
  return text;
}

function isPlaceholder(token: string): boolean {
  return (
    (token.startsWith("{{") && token.endsWith("}}")) || /^\{\d+\}$/.test(token)
  );
}

/**
 * Severity of one token-count difference, verified against the Stardew 1.6
 * parsers (mirrors Rust `tokens::token_severity`). Errors break the game;
 * warnings are cosmetic or legitimate translation choices and never block.
 */
export function tokenSeverity(
  token: string,
  sourceCount: number,
  targetCount: number,
  introducesMultiplePortraits: boolean,
  pageSkip = false,
): TokenSeverity {
  const dropped = targetCount < sourceCount;
  const harmless =
    isGenderSwitchShape(token) ||
    token === "@" ||
    // The game fills in or drops these placeholders; a missing, extra, or
    // renamed one only changes or shows text.
    isPercentPlaceholder(token) ||
    // A bare `^` or `#` changes the page or gender split in dialogue but is
    // plain text in letters and UI strings; translators decide (PD-1), unless
    // the change puts two different portraits on one page.
    ((token === "^" || token === "#") && !introducesMultiplePortraits) ||
    (isPortraitCommand(token) && !introducesMultiplePortraits) ||
    // A missing placeholder only drops its value; a renamed or extra one
    // stays visible as literal `{{...}}` or breaks string.Format.
    (dropped && isPlaceholder(token)) ||
    (dropped && token.toLowerCase().startsWith("[articlefor")) ||
    // After `$1` or `$c` the game counts pages, so there it is an error.
    (isDialogueEnd(token) && !pageSkip);
  return harmless ? "warning" : "error";
}

/** `#$e#`: SDV 1.6 recognizes `$e` in `Dialogue.parseDialogueString` but does
 * nothing with it (the page is dropped; `Dialogue.dialogueEnd` is unused).
 * `#$e$` or `#$e*` is not that command and shows as text. Mirrors Rust
 * `is_dialogue_end`. */
export function isDialogueEnd(token: string): boolean {
  return token === "#$e#";
}

/** Whether a page starts with `$1 <flag>` or `$c <chance>`: the game then
 * jumps three pages ahead (`i += 3` in `Dialogue.parseDialogueString`), so
 * every page after it, an empty `$e` one included, is counted. Mirrors Rust
 * `has_page_skip`. */
export function hasPageSkip(value: string): boolean {
  return value
    .split("#")
    .some((page) => page.startsWith("$1 ") || page.startsWith("$c "));
}

/** Shape identities compare each well-formed switch as one block. They aren't
 * literal source substrings and must not be inserted at the editor cursor. */
export function isInsertableProtectedToken(token: string): boolean {
  return !isGenderSwitchShape(token);
}

/** True for a canonical well-formed gender-switch shape identity. */
export function isGenderSwitchShape(token: string): boolean {
  return parseGenderSwitchShape(token) !== null;
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

/** The game closes a switch at the first `}$` after `${` and does not nest
 * (Stardew 1.6 `Dialogue.applyGenderSwitchBlocks`), so a switch inside a
 * switch shows broken text. Such a block is not read as one switch; its
 * markers stay visible to validation. Mirrors Rust `find_switch_close`. */
function findGenderSwitchClose(value: string, offset: number): number | null {
  let index = offset + 2;
  while (index < value.length) {
    const contentPatcherToken = readContentPatcherToken(value, index);
    if (contentPatcherToken) {
      index = contentPatcherToken.end;
      continue;
    }
    if (value.startsWith("${", index)) return null;
    if (value.startsWith("}$", index)) return index;
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

// BETAS DialogueBox argument 2 accepts prose or a runtime translation key.
// NPC and remaining arguments stay literal; complex messages stay opaque.
function readBetasMessage(
  value: string,
  offset: number,
): { end: number; tokens: string[] } | null {
  const prefix = "#$action Spiderbuttons.BETAS_DialogueBox ";
  if (!value.startsWith(prefix, offset)) return null;
  let cursor = offset + prefix.length;
  const npcStart = cursor;
  while (cursor < value.length && !/[\p{White_Space}#"]/u.test(value[cursor]))
    cursor++;
  if (cursor === npcStart) return null;
  while (value[cursor] === " ") cursor++;
  const escapedQuote = String.fromCharCode(92, 34);
  const quote = value.startsWith(escapedQuote, cursor)
    ? escapedQuote
    : value[cursor] === '"'
      ? '"'
      : null;
  if (!quote) return null;
  const start = cursor + quote.length;
  const close = value.indexOf(quote, start);
  if (close < 0) return null;
  const body = value.slice(start, close);
  // Only the verified simple message subset is transparent. Argument-bearing
  // dialogue commands need their own grammar; keep the whole action opaque.
  if (/[\\"%]/.test(body) || /\$(?![0-9])/.test(body)) return null;
  const next = value.indexOf("#", close + quote.length);
  const end = next < 0 ? value.length : next;
  const suffix = value.slice(close + quote.length, end);
  if (/["|]/.test(suffix)) return null;
  // A quoted asset:key still resolves at runtime. Preserve its whole action,
  // including terminal actions without a closing #. URLs remain ordinary text.
  if (
    /^[^\p{White_Space}:]+:[^\p{White_Space}:]+$/u.test(body) &&
    !body.includes("://")
  ) {
    return { end, tokens: [value.slice(offset, end)] };
  }
  return {
    end,
    tokens: [
      value.slice(offset, start) + value.slice(close, end),
      ...extractTokens(body),
    ],
  };
}

/** Index of the opening quote when `$y` and spaces start a quick response
 * at `offset` (the game reads the command word, then the first `'`). */
function quickResponseQuote(value: string, offset: number): number {
  if (!value.startsWith("$y ", offset)) return -1;
  let index = offset + 3;
  while (value[index] === " ") index++;
  return value[index] === "'" ? index : -1;
}

/** `$y 'question_answer_reply_answer_reply'`: the game splits the quoted text
 * at `_` into a question and answer/reply pairs, so every separator is
 * protected. Underscores inside `{{tokens}}` or `[tokens]` are not separators.
 * A single `*` in a reply becomes a `#$b#` page break in the game (`**` is a
 * literal asterisk), so it is protected too. Mirrors Rust `read_quick_response`. */
function readQuickResponse(
  value: string,
  offset: number,
): { end: number; tokens: string[] } | null {
  const opening = quickResponseQuote(value, offset);
  if (opening < 0) return null;
  const start = opening + 1;
  // The last quote before the next page break closes it, so an apostrophe
  // such as "Don't" stays part of the text.
  const page = value.indexOf("#", start);
  const close = value.lastIndexOf("'", (page < 0 ? value.length : page) - 1);
  if (close < start) return null;
  const body = value.slice(start, close);
  const separators: string[] = [];
  // Segment 0 is the question, odd segments are answers, and even segments
  // from 2 on are replies; only replies turn `*` into a page break.
  let segment = 0;
  let index = 0;
  while (index < body.length) {
    const nested =
      readContentPatcherToken(body, index) ?? readBracketToken(body, index);
    if (nested) {
      index = nested.end;
      continue;
    }
    if (body.startsWith("**", index)) {
      index += 2;
      continue;
    }
    if (body[index] === "_") {
      separators.push("_");
      segment += 1;
    } else if (body[index] === "*" && segment >= 2 && segment % 2 === 0)
      separators.push("*");
    index += 1;
  }
  return {
    end: close + 1,
    tokens: ["$y", "'", "'", ...separators, ...extractTokens(body)],
  };
}

/** After `#$h|s|u|l|a`, an uppercase ASCII letter or any character that is
 * not an ASCII letter, digit, or `#` (CJK, `¡`, `«`, `Ä`, a space) starts the
 * page's prose. Lowercase ASCII would be a longer command such as `#$action`. */
function startsPagePortrait(next: string | undefined): boolean {
  if (next === undefined || next === "#") return false;
  return /[A-Z]/.test(next) || !/[A-Za-z0-9]/.test(next);
}

function readDialogueBreak(value: string, offset: number): Token | null {
  if (!value.startsWith("#$", offset)) return null;

  // Some real mods omit the closing `#` from the argumentless `#$b#` marker
  // and put prose directly after a `$` or `*`, e.g. `#$b$Text` or `#$b*Text`.
  // Keep that malformed prefix literal but stop before the prose; otherwise
  // the generic next-`#` reader would turn all following prose into one token.
  const command = readSimpleDialogueCommand(value, offset + 1);
  if (command && value[command.end] === "$") {
    return token(value, offset, command.end + 1);
  }
  if (command?.raw === "$b" && value[command.end] === "*") {
    return token(value, offset, command.end + 1);
  }
  // `#${He^She}$ ...` and `#$hSo happy!` start a new page with a gender switch
  // or a portrait followed by prose. Only `#` is the separator here; reading
  // up to the next `#` would turn the whole page into one opaque token.
  if (value[offset + 2] === "{") return null;
  // `#$y '…'` starts a quick response on a new page; its own reader protects
  // the separators instead of one opaque token for the whole page.
  if (quickResponseQuote(value, offset + 1) >= 0) return null;
  if (
    command &&
    /^\$[hsula]$/.test(command.raw) &&
    startsPagePortrait(value[command.end])
  )
    return null;

  // Only the first unquoted query branch separator may end action arguments.
  // A later pipe in an opaque action is not another branch delimiter.
  if (value.startsWith("#$action ", offset) && value.startsWith("$query ")) {
    const pipe = value.indexOf("|", offset + 2),
      hash = value.indexOf("#", offset + 2);
    if (
      pipe >= 0 &&
      value.indexOf("|") === pipe &&
      !value.slice(0, offset).includes('"') &&
      (hash < 0 || pipe < hash) &&
      !value.slice(offset, pipe).includes('"')
    )
      return token(value, offset, pipe + 1);
  }
  const end = value.indexOf("#", offset + 2);
  if (end < 0) return null;

  const raw = value.slice(offset, end + 1);
  return {
    raw: hasSpaceSplitArguments(raw)
      ? `#${raw.slice(1, -1).split(" ").filter(Boolean).join(" ")}#`
      : raw,
    end: end + 1,
  };
}

/** `Dialogue.parseDialogueString` splits a `$command` from its arguments and
 * the arguments on ASCII spaces with empty entries removed
 * (`ArgUtility.SplitBySpace`), so only the spacing is canonicalized; every
 * argument stays exact. `$y` reads its raw text, and quoted `$action` or
 * `$query` arguments keep their inner spaces, so those stay as written.
 * Mirrors Rust `has_space_split_arguments`. */
function hasSpaceSplitArguments(raw: string): boolean {
  return (
    /^#\$[A-Za-z0-9]+ /.test(raw) &&
    !raw.startsWith("#$y ") &&
    !raw.includes('"')
  );
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
    const itemId = argumentText.split(whiteSpaceRun, 1)[0] ?? "";
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
  const nameEnd = body.search(whiteSpace);
  return nameEnd < 0
    ? { arguments: "", name: body }
    : {
        arguments: trimWhiteSpace(body.slice(nameEnd)),
        name: body.slice(0, nameEnd),
      };
}

function atomicArguments(argumentsText: string): string[] {
  if (argumentsText.includes("[") || argumentsText.includes("]")) return [];
  return argumentsText.length === 0 ? [] : argumentsText.split(whiteSpaceRun);
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

/** The inner bracket token of `[ArticleFor [X]]`, i.e. `[X]`, or null when
 * the token is no such wrapper. Mirrors Rust `article_for_argument`. */
export function articleForArgument(token: string): string | null {
  if (!token.startsWith("[") || !token.endsWith("]")) return null;
  const { name, arguments: argumentText } = splitBracketName(
    token.slice(1, -1),
  );
  return name.toLowerCase() === "articlefor" &&
    isSingleProtectedBracketArgument(argumentText)
    ? argumentText
    : null;
}

function isSingleProtectedBracketArgument(argumentsText: string): boolean {
  if (argumentsText[0] !== "[") return false;
  const end = findBalancedBracketEnd(argumentsText, 0);
  return (
    end === argumentsText.length &&
    isProtectedBracketBody(trimWhiteSpace(argumentsText.slice(1, -1)))
  );
}

function isAsciiDigits(value: string): boolean {
  return /^\d+$/.test(value);
}

function isItemId(value: string): boolean {
  return isAsciiIdSegment(value) || isQualifiedItemId(value);
}

function isItemIdPool(value: string): boolean {
  if (trimWhiteSpace(value) !== value) return false;
  const itemIds = value.split(whiteSpaceRun);
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
  // The game strips these emotion tokens by substring (Dialogue.checkEmotions),
  // so `$sHallo` is portrait `$s` followed by prose.
  if (
    value[offset] === "$" &&
    /[hsula]/.test(value[offset + 1] ?? "") &&
    /[A-Z]/.test(value[offset + 2] ?? "")
  )
    return token(value, offset, offset + 2);
  const match = simpleDialogueCommandPattern.exec(value.slice(offset));
  return match ? token(value, offset, offset + match[0].length) : null;
}

/** Dialogue event/gift commands: `%fork` sets an event branch and
 * `%revealtaste:NPC:item` reveals a gift taste (Utility.ParseGiftReveals). */
function readEventCommand(value: string, offset: number): Token | null {
  if (value.startsWith("%fork", offset))
    return token(value, offset, offset + 5);
  if (!value.startsWith("%revealtaste", offset)) return null;
  let end = offset + "%revealtaste".length;
  while (end < value.length && !/[\p{White_Space}#%$^*{]/u.test(value[end]))
    end += 1;
  return token(value, offset, end);
}

/** Dialogue placeholders the game fills in (Stardew 1.6
 * `Dialogue.percentTokens`), plus `%noturn`, which the game removes and which
 * keeps the speaker from turning to the player. The game replaces them with
 * an exact, case-sensitive substring replace, so `%Spouse` stays literal text
 * and `50%` is never one. Longest names first. Mirrors Rust
 * `PERCENT_PLACEHOLDERS`. */
export const PERCENT_PLACEHOLDERS = [
  "%firstnameletter",
  "%favorite",
  "%season",
  "%spouse",
  "%noturn",
  "%place",
  "%band",
  "%book",
  "%farm",
  "%kid1",
  "%kid2",
  "%name",
  "%noun",
  "%time",
  "%year",
  "%adj",
  "%pet",
] as const;

export function isPercentPlaceholder(token: string): boolean {
  return (PERCENT_PLACEHOLDERS as readonly string[]).includes(token);
}

function readPercentPlaceholder(value: string, offset: number): Token | null {
  if (value[offset] !== "%") return null;
  const name = PERCENT_PLACEHOLDERS.find((candidate) =>
    value.startsWith(candidate, offset),
  );
  return name ? token(value, offset, offset + name.length) : null;
}

function readSingleCharacterToken(value: string, offset: number): Token | null {
  const char = value[offset];
  if (
    char === "@" ||
    char === "^" ||
    char === "#" ||
    char === "\n" ||
    // A stray `{` marks "continues on next screen" and a `}` turns the text
    // before it into a mail flag (Dialogue.cs); both hide dialogue text.
    char === "{" ||
    char === "}" ||
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
