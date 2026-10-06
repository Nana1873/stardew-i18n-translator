import { describe, expect, it } from "vitest";
import {
  derivedStringStatus,
  hasTranslation,
  isBlankText,
  noTranslationNeeded,
} from "./status";

describe("derived blank source rule", () => {
  it.each(["", " ", "\t\r\n", "\u00a0", "\u0085"])(
    "uses Unicode White_Space without altering bytes: %j",
    (blank) => {
      expect(isBlankText(blank)).toBe(true);
      expect(noTranslationNeeded(blank, blank)).toBe(true);
      expect(derivedStringStatus(blank, blank, "untranslated")).toBe(
        "translated",
      );
      expect(derivedStringStatus("New title", blank, "translated")).toBe(
        blank === " " ? "translated" : "untranslated",
      );
      expect(derivedStringStatus("New title", blank, "outdated")).toBe(
        blank === " " ? "outdated" : "untranslated",
      );
    },
  );
  it("keeps BOM as text, matching native classification", () => {
    expect(isBlankText("\uFEFF")).toBe(false);
    expect(noTranslationNeeded("", "\uFEFF")).toBe(false);
    expect(derivedStringStatus("\uFEFF", "", "translated")).toBe(
      "untranslated",
    );
  });
  it.each(["translated", "review-needed", "outdated"] as const)(
    "preserves personal text with status %s",
    (status) => {
      expect(derivedStringStatus("", "My text", status)).toBe(status);
    },
  );
});

describe("intentional single-space targets", () => {
  it.each(["translated", "review-needed", "outdated"] as const)(
    "preserves saved %s and counts the raw space as a translation",
    (status) => {
      expect(derivedStringStatus("Tree", " ", status)).toBe(status);
      expect(hasTranslation("Tree", " ", status)).toBe(true);
      expect(noTranslationNeeded("Tree", " ")).toBe(false);
    },
  );
  it("keeps unsaved spaces and fully empty targets Open", () => {
    expect(derivedStringStatus("Tree", " ", "untranslated")).toBe(
      "untranslated",
    );
    expect(hasTranslation("Tree", " ", "untranslated")).toBe(false);
    expect(hasTranslation("Tree", "", "translated")).toBe(false);
  });
});
