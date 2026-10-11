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

function genericMessage(difference: TokenDifference): string {
  const { token, sourceCount, targetCount } = difference;
  const counts = `(English ${sourceCount}, translation ${targetCount})`;
  const missing = targetCount < sourceCount;
  if (isGenderSwitchShape(token))
    return missing
      ? "A he/she variant ${…^…}$ was removed; everyone sees the same text. Fine if intended."
      : "The number of he/she variants changed. Fine if intended.";
  if (isPortraitCommand(token))
    return `The portrait ${token} ${missing ? "is missing" : "was added"} ${counts}: the character shows a different face. Fine if intended.`;
  if (token === "@")
    return `The player name @ ${missing ? "is missing" : "was added"} ${counts}.`;
  if (token === "^")
    return `^ ${missing ? "is missing" : "was added"} ${counts}. In dialogue, ^ splits the text into male and female versions.`;
  if (token === "{" || token === "}")
    return `A single ${token} ${missing ? "is missing" : "was added"} ${counts}. The game treats single braces as commands and hides text.`;
  if (token === "#")
    return `# ${missing ? "is missing" : "was added"} ${counts}. # separates dialogue boxes.`;
  return `${token} ${missing ? "is missing" : "was added"} ${counts}.`;
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
