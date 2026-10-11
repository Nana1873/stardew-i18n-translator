import type { LlmImportTokenDifference } from "../tauri/commands";

const GENDER_SWITCH_SHAPES = new Set(["${^}$", "${^^}$", "${¦}$", "${¦¦}$"]);

/** Full-width look-alikes an LLM may write instead of ASCII token syntax. */
const FULL_WIDTH_LOOKALIKES = /[＄｛｝＾]/u;

function count(differences: LlmImportTokenDifference[], token: string) {
  const difference = differences.find((item) => item.token === token);
  return difference ? difference.targetCount - difference.sourceCount : 0;
}

/**
 * Plain-language explanations for one string's protected-token differences.
 * Gender-switch damage is reported as one structural problem instead of the
 * raw `${`, `}$`, and shape counts it produces.
 */
export function describeTokenIssue(
  differences: LlmImportTokenDifference[],
  importedText: string,
): string[] {
  const messages: string[] = [];
  const lostSwitches = differences
    .filter((item) => GENDER_SWITCH_SHAPES.has(item.token))
    .reduce(
      (total, item) => total + Math.max(0, item.sourceCount - item.targetCount),
      0,
    );
  const extraOpeners = count(differences, "${");
  const extraClosers = count(differences, "}$");
  const handled = new Set<string>();

  if (lostSwitches > 0 || extraOpeners > 0 || extraClosers > 0) {
    if (extraOpeners > 0 && extraClosers <= 0) {
      messages.push(
        "A gender switch ${…^…}$ is missing its closing }$, so the game cannot read it.",
      );
    } else if (extraClosers > 0 && extraOpeners <= 0) {
      messages.push(
        "A gender switch ${…^…}$ is missing its opening ${, so the game cannot read it.",
      );
    } else if (extraOpeners > 0 && extraClosers > 0) {
      messages.push(
        "A gender switch ${…}$ needs two or three variants separated by ^ (for example ${he^she}$).",
      );
    } else {
      messages.push(
        "A gender switch ${…^…}$ from the English text was removed or rewritten.",
      );
    }
    for (const shape of GENDER_SWITCH_SHAPES) handled.add(shape);
    handled.add("${");
    handled.add("}$");
    // The delimiter of a damaged switch is reported as a stray ^ or ¦.
    if (extraOpeners > 0 || extraClosers > 0) {
      handled.add("^");
      handled.add("¦");
    }
  }

  for (const difference of differences) {
    if (handled.has(difference.token)) continue;
    const delta = difference.targetCount - difference.sourceCount;
    messages.push(
      delta < 0
        ? `${difference.token} is missing (English ${difference.sourceCount}, import ${difference.targetCount}).`
        : `${difference.token} was added (English ${difference.sourceCount}, import ${difference.targetCount}).`,
    );
  }

  if (FULL_WIDTH_LOOKALIKES.test(importedText)) {
    messages.push(
      "The text contains full-width characters such as ＄｛｝＾. Tokens must use the normal ASCII characters $ { } ^.",
    );
  }
  return messages;
}
