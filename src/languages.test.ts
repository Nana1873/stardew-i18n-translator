import { describe, expect, it } from "vitest";

import { TARGET_LANGUAGES, gameSupportsLanguage } from "./languages";

describe("supported target languages", () => {
  it("matches the complete v1.4 compatibility matrix", () => {
    expect(TARGET_LANGUAGES).toEqual([
      { code: "de", label: "German (de)", gameLocale: "de-DE" },
      { code: "es", label: "Spanish (es)", gameLocale: "es-ES" },
      { code: "fr", label: "French (fr)", gameLocale: "fr-FR" },
      { code: "hu", label: "Hungarian (hu)", gameLocale: "hu-HU" },
      { code: "it", label: "Italian (it)", gameLocale: "it-IT" },
      { code: "ja", label: "Japanese (ja)", gameLocale: "ja-JP" },
      { code: "ko", label: "Korean (ko)", gameLocale: "ko-KR" },
      { code: "pt", label: "Portuguese (pt)", gameLocale: "pt-BR" },
      { code: "ru", label: "Russian (ru)", gameLocale: "ru-RU" },
      { code: "tr", label: "Turkish (tr)", gameLocale: "tr-TR" },
      { code: "zh", label: "Chinese (zh)", gameLocale: "zh-CN" },
      { code: "vi", label: "Vietnamese (vi)" },
      { code: "id", label: "Indonesian (id)" },
      { code: "uk", label: "Ukrainian (uk)" },
      { code: "pl", label: "Polish (pl)" },
      { code: "fi", label: "Finnish (fi)" },
      { code: "nl", label: "Dutch (nl)" },
      { code: "cs", label: "Czech (cs)" },
      { code: "th", label: "Thai (th)" },
    ]);
    expect(new Set(TARGET_LANGUAGES.map(({ code }) => code)).size).toBe(19);
  });

  it("treats game-shipped languages as glossary-capable and custom languages as not", () => {
    expect(gameSupportsLanguage("de")).toBe(true);
    expect(gameSupportsLanguage("zh")).toBe(true);
    for (const code of ["vi", "id", "uk", "pl", "fi", "nl", "cs", "th"]) {
      expect(gameSupportsLanguage(code)).toBe(false);
      expect(TARGET_LANGUAGES.find((l) => l.code === code)?.gameLocale).toBe(
        undefined,
      );
    }
    expect(gameSupportsLanguage("xx")).toBe(false);
  });
});
