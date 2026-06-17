/**
 * SMAPI i18n target languages (SPEC Appendix A). Source is always English
 * (`default`) in v1.
 */
export interface Language {
  /** SMAPI i18n code, used for the `<lang>.json` filename. */
  code: string;
  label: string;
  /**
   * The game's content locale suffix (e.g. `de-DE`), mirroring the backend's
   * `glossary::game_locale_suffix`. Its **presence means Stardew natively ships
   * this language**, so an official glossary can be built. Languages the game
   * does not support (playable only via a custom-language mod, e.g. Thai) omit
   * it — that single omission marks them as glossary-less.
   */
  gameLocale?: string;
}

export const SOURCE_LANGUAGE_LABEL = "English (default)";

export const TARGET_LANGUAGES: Language[] = [
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
  // Stardew has no native Thai content; playable only via a custom-language mod
  // (SV 1.6 `Data/AdditionalLanguages`, code `th`). No `gameLocale` → no glossary.
  { code: "th", label: "Thai (ไทย)" },
];

/**
 * Whether Stardew natively ships this language. Only natively supported
 * languages have official content, so only they can build an official glossary.
 * Languages the game does not support still translate and export fully; they
 * simply have no glossary hints.
 */
export function gameSupportsLanguage(code: string): boolean {
  return TARGET_LANGUAGES.some(
    (language) => language.code === code && language.gameLocale != null,
  );
}
