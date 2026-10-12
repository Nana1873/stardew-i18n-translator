import {
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

/** Full-width look-alikes an LLM may write instead of ASCII token syntax. */
const FULL_WIDTH_LOOKALIKES = /[＄｛｝＾]/u;

export interface TokenIssueMessage {
  severity: TokenSeverity;
  /** Whether the message is about something missing or something added. */
  kind: "missing" | "added";
  message: string;
}

function delta(differences: TokenDifference[], token: string) {
  const difference = differences.find((item) => item.token === token);
  return difference ? difference.targetCount - difference.sourceCount : 0;
}

/** What a token difference does in the game, as one sentence. Errors name
 * the consequence; warnings end with "Fine if intended." Mirrors Rust
 * `tokens::token_consequence` word for word. */
export function tokenConsequence(difference: TokenDifference): string {
  const { token, sourceCount, targetCount, severity } = difference;
  const missing = targetCount < sourceCount;
  if (token === "${" || token === "}$")
    return severity === "error"
      ? "A he/she switch is not opened and closed properly, so the game would show broken text."
      : "Fine if intended.";
  if (/^#\$b[#$*]/.test(token))
    return "It starts a new dialogue box, so the text would be split into boxes differently.";
  if (/^#\$e[#$*]/.test(token))
    return "It ends today's conversation and saves the rest for next time, so the dialogue would play out differently.";
  if (
    token.startsWith("#$action") ||
    ((token.startsWith("#$") || token.startsWith("$")) && token.endsWith("#"))
  )
    return "The game needs it to run the dialogue (answers, flags, or events).";
  if (token.startsWith("%item") || token.startsWith("%action"))
    return missing
      ? "The attached item or reward would not be given."
      : "It adds an item or reward the English mail does not give.";
  if (token === "#$y")
    return "It starts the quick question in a new dialogue box; without it the game shows the command as text.";
  if (token === "*")
    return "In a quick-question reply it starts a new dialogue box, so the text would be split into boxes differently.";
  if (token === "_")
    return "It separates the question, answers, and replies of a quick question; without it the game mixes them up.";
  if (token === "[#]")
    return missing
      ? "The letter title would show as part of the letter text."
      : "Text after it would become the letter title.";
  if (token === "%fork" || token.startsWith("%revealtaste"))
    return missing
      ? "The event choice or gift-taste reveal would not happen."
      : "It adds event behaviour the English text does not have.";
  if (token.startsWith("{{") || /^\{\d+\}$/.test(token)) {
    if (missing)
      return "The game shows nothing in its place. Fine if intended.";
    return token.startsWith("{{")
      ? "The game would show it as raw text."
      : "The game has no value for it, so the text breaks.";
  }
  if (token.toLowerCase().startsWith("[articlefor"))
    return missing
      ? "Only the a/an article is lost. Fine if intended."
      : "The game would show it as raw text.";
  if (token.startsWith("["))
    return missing
      ? "The game would not insert this value or item."
      : "The game would show it as raw text.";
  if (token.startsWith("$") && !isPortraitCommand(token))
    return "The game would show it as text or change the dialogue flow.";
  return severity === "warning"
    ? "Fine if intended."
    : "The game would show it as raw text or misread the line.";
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

function genericMessage(difference: TokenDifference): string {
  const { token, sourceCount, targetCount, severity } = difference;
  const missing = targetCount < sourceCount;
  const change = changePhrase(sourceCount, targetCount);
  if (isGenderSwitchShape(token))
    return missing
      ? "A he/she variant ${…^…}$ was removed; everyone sees the same text. Fine if intended."
      : "The he/she switches differ from the English text. Fine if intended.";
  if (isPortraitCommand(token))
    return severity === "error"
      ? `The portrait ${token} ${change}: one dialogue box now has two different portraits, so the second shows as raw text.`
      : `The portrait ${token} ${change}: the character shows a different face. Fine if intended.`;
  if (token === "@") return `The player name @ ${change}. Fine if intended.`;
  if ((token === "^" || token === "#") && severity === "error")
    return `${token} ${change}: one dialogue box now has two different portraits, so the second shows as raw text.`;
  if (token === "^")
    return `^ ${change}. In dialogue, ^ splits the text into male and female versions; in a letter it is a line break. Fine if intended.`;
  if (token === "{" || token === "}")
    return `A single ${token} ${change}. The game treats single braces as commands and hides text.`;
  if (token === "#")
    return `# ${change}. In dialogue, # separates dialogue boxes; elsewhere it is plain text. Fine if intended.`;
  return `${token} ${change}. ${tokenConsequence(difference)}`;
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

  for (const difference of differences) {
    const { token } = difference;
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
      message: genericMessage(difference),
    });
  }

  if (
    messages.some((item) => item.severity === "error") &&
    FULL_WIDTH_LOOKALIKES.test(translation)
  ) {
    messages.push({
      severity: "error",
      kind: "added",
      message:
        "The text contains full-width characters such as ＄｛｝＾. Tokens must use the normal characters $ { } ^.",
    });
  }
  return messages;
}

/** True when any difference would break the game. */
export function hasTokenError(differences: TokenDifference[]): boolean {
  return differences.some((difference) => difference.severity === "error");
}
