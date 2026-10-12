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
  if (/^#\$[be][#$*]/.test(token))
    return "It starts a new dialogue box, so the page structure changes.";
  if ((token.startsWith("#$") || token.startsWith("$")) && token.endsWith("#"))
    return "It carries response ids, flags, or keys the game needs.";
  if (token.startsWith("%item") || token.startsWith("%action"))
    return missing
      ? "The attached item or reward would not be given."
      : "It adds an item or reward the English mail does not give.";
  if (token === "[#]") return "It separates the letter text from its title.";
  if (token === "%fork" || token.startsWith("%revealtaste"))
    return missing
      ? "The event branch or gift-taste reveal is lost."
      : "It changes event logic the English text does not have.";
  if (token.startsWith("{{") || /^\{\d+\}$/.test(token)) {
    if (missing) return "The value is left out. Fine if intended.";
    return token.startsWith("{{")
      ? "An unknown placeholder stays visible as raw text."
      : "A placeholder without a value breaks the text.";
  }
  if (token.toLowerCase().startsWith("[articlefor"))
    return missing
      ? "Only the a/an article is lost. Fine if intended."
      : "A changed or extra game token shows as raw text.";
  if (token.startsWith("["))
    return missing
      ? "The game would not insert this value or item."
      : "A changed or extra game token shows as raw text.";
  if (token.startsWith("$") && !isPortraitCommand(token))
    return "The game would show it as text or change the dialogue flow.";
  return severity === "warning" ? "Fine if intended." : "";
}

function genericMessage(difference: TokenDifference): string {
  const { token, sourceCount, targetCount, severity } = difference;
  const counts = `(English ${sourceCount}, translation ${targetCount})`;
  const missing = targetCount < sourceCount;
  const change = missing ? "is missing" : "was added";
  if (isGenderSwitchShape(token))
    return missing
      ? "A he/she variant ${…^…}$ was removed; everyone sees the same text. Fine if intended."
      : "The number or shape of he/she switches changed. Fine if intended.";
  if (isPortraitCommand(token))
    return severity === "error"
      ? `The portrait ${token} ${change} ${counts}: a second portrait on one dialogue page is shown as raw text.`
      : `The portrait ${token} ${change} ${counts}: the character shows a different face. Fine if intended.`;
  if (token === "@")
    return `The player name @ ${change} ${counts}. Fine if intended.`;
  if (token === "^")
    return `^ ${change} ${counts}. In dialogue, ^ splits the text into male and female versions; in a letter it is a line break.`;
  if (token === "{" || token === "}")
    return `A single ${token} ${change} ${counts}. The game treats single braces as commands and hides text.`;
  if (token === "#")
    return `# ${change} ${counts}. # separates dialogue boxes.`;
  const consequence = tokenConsequence(difference);
  return `${token} ${change} ${counts}.${consequence ? ` ${consequence}` : ""}`;
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
        "A he/she switch needs two or three variants separated by ^, like ${he^she}$.",
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
