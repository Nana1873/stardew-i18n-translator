import { describe, expect, it } from "vitest";

import { TARGET_LANGUAGES, gameSupportsLanguage } from "./languages";

describe("supported target languages", () => {
  it("matches the complete v1.4 compatibility matrix", () => {
    expect(TARGET_LANGUAGES).toEqual([
      { code: "de", label: "German (Deutsch)", gameLocale: "de-DE" },
      { code: "es", label: "Spanish (Español)", gameLocale: "es-ES" },
      { code: "fr", label: "French (Français)", gameLocale: "fr-FR" },
      { code: "hu", label: "Hungarian (Magyar)", gameLocale: "hu-HU" },
      { code: "it", label: "Italian (Italiano)", gameLocale: "it-IT" },
      { code: "ja", label: "Japanese (日本語)", gameLocale: "ja-JP" },
      { code: "ko", label: "Korean (한국어)", gameLocale: "ko-KR" },
      { code: "pt", label: "Portuguese (Português)", gameLocale: "pt-BR" },
      { code: "ru", label: "Russian (Русский)", gameLocale: "ru-RU" },
      { code: "tr", label: "Turkish (Türkçe)", gameLocale: "tr-TR" },
      { code: "zh", label: "Chinese (中文)", gameLocale: "zh-CN" },
      { code: "vi", label: "Vietnamese (Tiếng Việt)" },
      { code: "id", label: "Indonesian (Bahasa Indonesia)" },
      { code: "uk", label: "Ukrainian (Українська)" },
      { code: "pl", label: "Polish (Polski)" },
      { code: "fi", label: "Finnish (Suomi)" },
      { code: "nl", label: "Dutch (Nederlands)" },
      { code: "cs", label: "Czech (Čeština)" },
      { code: "th", label: "Thai (ไทย)" },
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
