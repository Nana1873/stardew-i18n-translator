import { describe, expect, it } from "vitest";

import { TARGET_LANGUAGES } from "./languages";

describe("supported target languages", () => {
  it("matches the complete v1.1 compatibility matrix", () => {
    expect(TARGET_LANGUAGES).toEqual([
      { code: "de", label: "German (Deutsch)" },
      { code: "es", label: "Spanish (Español)" },
      { code: "fr", label: "French (Français)" },
      { code: "hu", label: "Hungarian (Magyar)" },
      { code: "it", label: "Italian (Italiano)" },
      { code: "ja", label: "Japanese (日本語)" },
      { code: "ko", label: "Korean (한국어)" },
      { code: "pt", label: "Portuguese (Português)" },
      { code: "ru", label: "Russian (Русский)" },
      { code: "tr", label: "Turkish (Türkçe)" },
      { code: "zh", label: "Chinese (中文)" },
    ]);
    expect(new Set(TARGET_LANGUAGES.map(({ code }) => code)).size).toBe(11);
  });
});
