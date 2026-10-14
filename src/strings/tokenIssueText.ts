import {
  countsPages,
  isEmptyBracket,
  isMalformedBreak,
  isPageCountingCommand,
  isPageToken,
  keepsMeaningInLetter,
  isPercentPlaceholder,
  isSkippedPage,
  isLetterFormat,
  isTextBracket,
  isGenderSwitchShape,
  isPortraitCommand,
  type TokenSeverity,
} from "./protectedTokens";

/** One protected-token count difference (editor, import, and AI results). */
export interface TokenDifference {
  token: string;
  sourceCount: number;
  targetCount: number;
  severity: TokenSeverity;
}

/** Token characters an LLM or a CJK keyboard may write as their full-width
 * look-alikes (U+FF01..U+FF5E, ASCII + 0xFEE0). Mirrors Rust
 * `FULL_WIDTH_LOOKALIKES`. */
const FULL_WIDTH_LOOKALIKES = "${}^#@%[]";

function fullWidth(char: string): string {
  return String.fromCharCode(char.charCodeAt(0) + 0xfee0);
}

/** A hint when the translation has the full-width form of a character of a
 * token that went missing or changed. `％［］` are ordinary CJK punctuation,
 * so they only count when such a token needs them. Mirrors Rust
 * `full_width_hint`. */
function fullWidthHint(
  differences: TokenDifference[],
  translation: string,
): string | null {
  const needed = new Set<string>();
  for (const { token, sourceCount, targetCount } of differences)
    if (targetCount < sourceCount) for (const char of token) needed.add(char);
  const found = [...FULL_WIDTH_LOOKALIKES].filter(
    (char) => needed.has(char) && translation.includes(fullWidth(char)),
  );
  if (found.length === 0) return null;
  return `The text contains full-width ${found.map(fullWidth).join("")} where the English text has ${found.join(" ")}. The game shows them as they are; use the normal characters.`;
}

export interface TokenIssueMessage {
  severity: TokenSeverity;
  /** Whether the message is about something missing or something added. */
  kind: "missing" | "added";
  message: string;
  /** The single token this message is about, when there is one. */
  token?: string;
}

/** What the game does with each dialogue placeholder (Stardew 1.6
 * `Dialogue.cs`). Mirrors Rust `PERCENT_PLACEHOLDERS`. */
const PERCENT_PLACEHOLDER_TEXT: Partial<Record<string, string>> = {
  "%adj": "The game puts a random adjective here.",
  "%noun": "The game puts a random noun here.",
  "%place": "The game puts a random place name here.",
  "%spouse": "The game puts the spouse's name here.",
  "%name": "The game puts a random name here.",
  "%firstnameletter": "The game puts the first half of the player's name here.",
  "%time": "The game puts the current time here.",
  "%band": "The game puts the name of Sam's band here.",
  "%book": "The game puts the name of Elliott's book here.",
  "%pet": "The game puts the pet's name here.",
  "%farm": "The game puts the farm's name here.",
  "%favorite": "The game puts the player's favorite thing here.",
  "%year": "The game puts the current year here.",
  "%kid1": "The game puts the first child's name here.",
  "%kid2": "The game puts the second child's name here.",
  "%season": "The game puts the current season here.",
  "%noturn":
    "At a festival it keeps the character from turning to face the player.",
};

function delta(differences: TokenDifference[], token: string) {
  const difference = differences.find((item) => item.token === token);
  return difference ? difference.targetCount - difference.sourceCount : 0;
}

/** Dialogue command names the game knows (Stardew 1.6 `Dialogue.cs`). The
 * game matches them case-sensitively, so `$B` is shown as text. Mirrors Rust
 * `DIALOGUE_COMMANDS`. */
const DIALOGUE_COMMANDS = new Set([
  "a",
  "action",
  "b",
  "c",
  "d",
  "e",
  "h",
  "k",
  "l",
  "neutral",
  "p",
  "q",
  "query",
  "r",
  "s",
  "t",
  "u",
  "v",
  "y",
]);

/** The correct-case form of a token that is a known dialogue command typed
 * in the wrong letter case, e.g. `#$B#` → `#$b#` or `$Q` → `$q`. Mirrors
 * Rust `case_variant_command`. */
function caseVariantCommand(token: string): string | null {
  const prefix = token.startsWith("#$")
    ? "#$"
    : token.startsWith("$")
      ? "$"
      : null;
  if (prefix === null) return null;
  const rest = token.slice(prefix.length);
  const name = /^[A-Za-z]*/.exec(rest)?.[0] ?? "";
  const lower = name.toLowerCase();
  if (name === lower || !DIALOGUE_COMMANDS.has(lower)) return null;
  return `${prefix}${lower}${rest.slice(name.length)}`;
}

/** The missing token that a wrong-case command most likely replaced: the
 * correct form itself, or that command with its arguments. */
function caseVariantPartner(
  differences: TokenDifference[],
  suggestion: string,
): TokenDifference | undefined {
  return differences.find(
    (item) =>
      item.targetCount < item.sourceCount &&
      (item.token === suggestion || item.token.startsWith(`${suggestion} `)),
  );
}

/** What a dialogue break or command does, or null for other tokens. Mirrors
 * Rust `dialogue_command_consequence`. */
function dialogueCommandConsequence(token: string): string | null {
  if (/^#\$b[#$*]/.test(token))
    return "It starts a new dialogue box, so the text would be split into boxes differently.";
  if (isSkippedPage(token))
    return "The game shows nothing for it, but like a bare # it ends the conversation there and the rest shows the next time. Fine if intended.";
  if (
    token.startsWith("#$action") ||
    ((token.startsWith("#$") || token.startsWith("$")) && token.endsWith("#"))
  )
    return "The game needs it to run the dialogue (answers, flags, or events).";
  return null;
}

/** One finding for a dialogue command typed in the wrong letter case. Only
 * when the correct command is missing from the translation is it suggested.
 * Mirrors Rust `case_variant_message`. */
function caseVariantMessage(
  token: string,
  partner: TokenDifference | undefined,
  error: boolean,
  letter: boolean,
): string {
  const text = `${token} is not a dialogue command the game knows, so it would show as text.`;
  // Only a letter, where dialogue commands are plain text anyway.
  if (!error) return `${text} Fine if intended.`;
  if (letter) return text;
  if (!partner) return text;
  // `#$e#` itself does nothing, so its purpose would only confuse here.
  const purpose = isSkippedPage(partner.token)
    ? null
    : dialogueCommandConsequence(partner.token);
  const suggestion = `${text} Did you mean ${partner.token}?`;
  return purpose ? `${suggestion} ${purpose}` : suggestion;
}

/** Whether the wrong-case command accounts for every missing copy of its
 * partner; otherwise the partner keeps its own message for the rest. */
function coversPartner(
  difference: TokenDifference,
  partner: TokenDifference,
): boolean {
  return (
    partner.sourceCount - partner.targetCount <=
    difference.targetCount - difference.sourceCount
  );
}

/** Warnings with their own explanation; any other warning is dialogue
 * syntax in a letter. Mirrors Rust `has_warning_text`. */
function hasWarningText(token: string): boolean {
  return (
    isSkippedPage(token) ||
    isMalformedBreak(token) ||
    (token.startsWith("$") && !isPortraitCommand(token)) ||
    token === "#$b#" ||
    token === "||" ||
    isLetterFormat(token) ||
    token === "*" ||
    token === "[#]" ||
    isPercentPlaceholder(token) ||
    (token.startsWith("{{") && token.endsWith("}}")) ||
    /^\{\d+\}$/.test(token) ||
    isTextBracket(token) ||
    isEmptyBracket(token)
  );
}

/** What the explanation knows about the whole translation. Mirrors Rust
 * `ExplainContext`. */
export interface ExplainContext {
  /** `$1`, `$c`, or `$d` count the dialogue pages. */
  pagesCounted: boolean;
  /** A letter with a `[#]` title (`LetterViewerMenu`). */
  letter: boolean;
  /** The translation has a he/she switch. */
  translationHasSwitch: boolean;
}

const NO_CONTEXT: ExplainContext = {
  pagesCounted: false,
  letter: false,
  translationHasSwitch: false,
};

/** What a token difference does in the game, as one sentence. Errors name
 * the consequence; warnings end with "Fine if intended." Mirrors Rust
 * `tokens::token_consequence` word for word. */
export function tokenConsequence(
  difference: TokenDifference,
  context: ExplainContext = NO_CONTEXT,
): string {
  const { token, sourceCount, targetCount, severity } = difference;
  const missing = targetCount < sourceCount;
  const { pagesCounted } = context;
  if (token === "${" || token === "}$")
    return severity === "error"
      ? "A he/she switch is not opened and closed properly, so the game would show broken text."
      : "The English text has no working he/she switch here, so nothing breaks without it. Fine if intended.";
  if (
    context.letter &&
    !keepsMeaningInLetter(token) &&
    !(severity === "error" && missing)
  )
    return severity === "error"
      ? "In a letter the game does not read it, so it shows as text."
      : "In a letter the game shows it as plain text. Fine if intended.";
  if (severity !== "error" && !hasWarningText(token))
    return "In a letter the game shows it as plain text. Fine if intended.";
  if (token === "|" && severity === "error")
    return 'In a $d dialogue it separates the two versions, so the game would show the wrong one or only "...".';
  if (isPageToken(token) && severity === "error" && pagesCounted)
    return "A $1, $c, or $d command here counts dialogue pages, so a different line or an empty box would show.";
  if (token === "#$b#")
    return severity === "error"
      ? "A # took its place, which ends the conversation there: the rest shows only the next time the player talks to the character, or never in an event."
      : "It starts a new dialogue box; without it the game still moves long text into extra boxes. Fine if intended.";
  if (isMalformedBreak(token) && severity === "error")
    return "The game does not read it as a command, so it would show as text.";
  if (isMalformedBreak(token))
    return "The game does not read it as a command and shows it as text, as in the English text. Fine if intended.";
  if (token === "||")
    return "In dialogue it splits the text into versions that change every week; elsewhere it is plain text. Fine if intended.";
  if (isEmptyBracket(token))
    return missing
      ? "The game could not read it in the English text either. Fine if intended."
      : 'The game cannot read an empty []: dialogue shows only "..." and a Mail Framework Mod letter cannot be opened.';
  const command = dialogueCommandConsequence(token);
  if (command !== null && (severity === "error" || isSkippedPage(token)))
    return command;
  if (token.startsWith("%item") || token.startsWith("%action"))
    return missing
      ? "The attached item or reward would not be given."
      : "It adds an item or reward the English mail does not give.";
  if (token === "#$y")
    return "It starts the quick question in a new dialogue box; without it the game shows the command as text.";
  if (token === "*")
    return "In a quick-question reply it starts a new dialogue box. Fine if intended.";
  if (token === "_")
    return 'It separates the question, answers, and replies of a quick question; an odd change makes the game show only "...", an even one mixes up answers and replies.';
  if (token === "[#]" && !missing && severity !== "error")
    return "The game shows only the letter text before the first [#], so text after another [#], such as a female version after ¦, never appears. Fine if intended.";
  if (token === "[#]")
    return missing
      ? "The letter title would show at the end of the letter text. Fine if intended."
      : "Text after it would become the letter title.";
  if (token === "%fork")
    return missing
      ? "The event choice would not happen."
      : "It adds an event choice the English text does not have.";
  if (token.startsWith("%revealtaste"))
    return missing
      ? "The gift-taste reveal would not happen."
      : "It reveals a gift taste the English text does not.";
  const percent = PERCENT_PLACEHOLDER_TEXT[token];
  if (percent) return `${percent} Fine if intended.`;
  if (token.startsWith("{{") || /^\{\d+\}$/.test(token)) {
    if (missing)
      return "The game shows nothing in its place. Fine if intended.";
    if (severity !== "error")
      return "The game fills in a value the English text already uses. Fine if intended.";
    return token.startsWith("{{")
      ? "The game would show it as raw text."
      : "The game has no value for it, so the text breaks.";
  }
  if (token.toLowerCase().startsWith("[articlefor"))
    return missing
      ? "Other languages have no a/an article here anyway. Fine if intended."
      : "The game puts no article here in other languages. Fine if intended.";
  if (isLetterFormat(token) && severity === "error")
    return "The game does not recognize this command, so it shows as text in the letter. Write the command word in lowercase and the background as a number, like in the English text.";
  if (isLetterFormat(token))
    return missing
      ? "The letter uses its default background or text color. Fine if intended."
      : "It sets the letter's background or text color; if it is not written like in the English text, the letter may show it as text. Fine if intended.";
  if (isTextBracket(token))
    return missing
      ? "The game would not insert this value. Fine if intended."
      : severity === "error"
        ? "If the game cannot resolve it, for example because its name or key was translated, players see it as raw text."
        : "The game fills it in. Fine if intended.";
  if (token.startsWith("["))
    return missing
      ? "The game would not give this item."
      : "It adds an item the English text does not give.";
  if (token.startsWith("$") && !isPortraitCommand(token))
    return severity === "error"
      ? "The game would show it as text or change the dialogue flow."
      : "The game does not read it here and shows it as text in the English line too. Fine if intended.";
  return "The game would show it as raw text or misread the line.";
}

/** How a token count differs, in words. Mirrors Rust `change_phrase`. */
function changePhrase(sourceCount: number, targetCount: number): string {
  const times = (n: number) => (n === 1 ? "1 time" : `${n} times`);
  if (targetCount < sourceCount)
    return targetCount === 0
      ? "is missing from the translation"
      : `appears ${times(targetCount)} in the translation instead of ${sourceCount}`;
  return sourceCount === 0
    ? "is not in the English text"
    : `appears ${times(targetCount)} in the translation instead of ${sourceCount}`;
}

function genericMessage(
  difference: TokenDifference,
  context: ExplainContext,
): string {
  const { token, sourceCount, targetCount, severity } = difference;
  const missing = targetCount < sourceCount;
  const change = changePhrase(sourceCount, targetCount);
  const { pagesCounted } = context;
  // In a letter only these keep their dialogue meaning.
  if (
    context.letter &&
    !keepsMeaningInLetter(token) &&
    !(severity === "error" && missing)
  )
    return `${token} ${change}. ${tokenConsequence(difference, context)}`;
  if (isGenderSwitchShape(token))
    return missing && !context.translationHasSwitch
      ? "A he/she variant ${…^…}$ was removed; everyone sees the same text. Fine if intended."
      : "The he/she switches differ from the English text. Fine if intended.";
  if (isPortraitCommand(token))
    return severity === "error"
      ? `The portrait ${token} ${change}: one dialogue box now has two different portraits, so the second shows as raw text.`
      : `The portrait ${token} ${change}: the character shows a different face. Fine if intended.`;
  if (token === "@") return `The player name @ ${change}. Fine if intended.`;
  if (token === "#" && severity === "error" && pagesCounted)
    return `# ${change}. A $1, $c, or $d command here counts dialogue pages, so a different line or an empty box would show.`;
  if ((token === "^" || token === "#") && severity === "error")
    return `${token} ${change}: one dialogue box now has two different portraits, so the second shows as raw text.`;
  if (token === "^")
    return `^ ${change}. In dialogue, ^ splits the text into male and female versions; in a letter it is a line break. Fine if intended.`;
  if (token === "}" && severity === "error" && missing)
    return `A single } ${change}. The game would show the text before it and no longer set the flag that text names.`;
  if (token === "}" && severity === "error")
    return `A single } ${change}. The game turns the text before it into a hidden flag, so that text disappears.`;
  if (token === "{" && severity === "error")
    return `A single { ${change}. Mods that fill in values such as {0} would fail on it, and dialogue reads it as a command.`;
  if (token === "{" && missing)
    return `A single { ${change}. In dialogue it keeps the conversation going into the next box. Fine if intended.`;
  if (token === "{")
    return `A single { ${change}. In dialogue it joins the next box to this one. Fine if intended.`;
  if (token === "}") return `A single } ${change}. Fine if intended.`;
  if (token === "#")
    return `# ${change}. In dialogue, # ends the conversation there and the rest shows the next time the player talks to the character; elsewhere it is plain text. Fine if intended.`;
  return `${token} ${change}. ${tokenConsequence(difference, context)}`;
}

/**
 * Plain-language explanations for one string's protected-token differences.
 * Gender-switch damage is reported as one structural error instead of the raw
 * `${`, `}$`, and `^` counts it produces. Mirrors Rust
 * `tokens::explain_differences` for the error wording.
 */
export function describeTokenIssue(
  differences: TokenDifference[],
  translation: string,
): TokenIssueMessage[] {
  const messages: TokenIssueMessage[] = [];
  // A page-counting command the translation broke still counts.
  const pagesCounted =
    countsPages(translation) ||
    differences.some((difference) => isPageCountingCommand(difference.token));
  // A letter is an English text with one `[#]` (`mailDifferences`): then the
  // translation keeps exactly one, or a `[#]` note names that one.
  const title = differences.find((difference) => difference.token === "[#]");
  const context: ExplainContext = {
    pagesCounted,
    letter:
      title === undefined
        ? translation.split("[#]").length - 1 === 1
        : title.sourceCount === 1 && title.severity !== "error",
    translationHasSwitch: translation.includes("${"),
  };
  const extraOpeners = delta(differences, "${");
  const extraClosers = delta(differences, "}$");
  const switchDamaged = extraOpeners > 0 || extraClosers > 0;

  if (extraOpeners > 0 && extraClosers <= 0) {
    messages.push({
      severity: "error",
      kind: "missing",
      message:
        "A he/she switch ${…^…}$ is missing its closing }$, so the game would show broken text.",
    });
  } else if (extraClosers > 0 && extraOpeners <= 0) {
    messages.push({
      severity: "error",
      kind: "missing",
      message:
        "A he/she switch ${…^…}$ is missing its opening ${, so the game would show broken text.",
    });
  } else if (switchDamaged) {
    messages.push({
      severity: "error",
      kind: "added",
      message:
        "A he/she switch needs two or three variants separated by ^, like ${he^she}$, and cannot contain another switch.",
    });
  }

  // A wrong-case command and the correct one it replaced are one finding.
  const merged = new Set<TokenDifference>();
  for (const difference of differences) {
    const { token } = difference;
    if (merged.has(difference)) continue;
    const suggestion =
      difference.targetCount > difference.sourceCount
        ? caseVariantCommand(token)
        : null;
    if (suggestion !== null) {
      const partner = caseVariantPartner(differences, suggestion);
      if (partner && coversPartner(difference, partner)) merged.add(partner);
      const error =
        difference.severity === "error" || partner?.severity === "error";
      messages.push({
        severity: error ? "error" : "warning",
        kind: "added",
        message: caseVariantMessage(token, partner, error, context.letter),
        token,
      });
      continue;
    }
    if (switchDamaged) {
      // The damaged switch is already explained; its leftover shape and extra
      // ^ are part of the same problem. A ^ that went missing is separate.
      if (token === "${" || token === "}$" || isGenderSwitchShape(token))
        continue;
      if (token === "^" && difference.targetCount > difference.sourceCount)
        continue;
    }
    messages.push({
      severity: difference.severity,
      kind:
        difference.targetCount < difference.sourceCount ? "missing" : "added",
      message: genericMessage(difference, context),
      token,
    });
  }

  // A look-alike explains a token difference but never adds one, so the hint
  // takes the strongest severity already present.
  const hint = fullWidthHint(differences, translation);
  if (messages.length > 0 && hint !== null) {
    messages.push({
      severity: messages.some((item) => item.severity === "error")
        ? "error"
        : "warning",
      kind: "added",
      message: hint,
    });
  }
  return messages;
}

/** True when any difference would break the game. */
export function hasTokenError(differences: TokenDifference[]): boolean {
  return differences.some((difference) => difference.severity === "error");
}
