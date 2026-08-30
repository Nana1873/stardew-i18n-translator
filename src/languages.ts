/**
 * SMAPI i18n target languages. Source is always English (`default`) in v1.
 */
export interface Language {
  /** SMAPI i18n code, used for the `<lang>.json` filename. */
  code: string;
  label: string;
  /**
   * The game's content locale suffix (e.g. `de-DE`), mirroring the backend's
   * `glossary::game_locale_suffix`. Its **presence means Stardew natively ships
   * this language**, so an official glossary can be built. Curated custom
   * languages the game does not support omit it — that single omission marks
   * them as glossary-less unless a community language pack supplies terms.
   */
  gameLocale?: string;
}

export const SOURCE_LANGUAGE_LABEL = "English (default)";

export const TARGET_LANGUAGES: Language[] = [
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
  // Curated community-language-pack targets (SV 1.6 `Data/AdditionalLanguages`).
  // Stardew ships no native content for these, so no `gameLocale` → no official
  // glossary unless a compatible installed language pack supplies terms.
  { code: "vi", label: "Vietnamese (vi)" },
  { code: "id", label: "Indonesian (id)" },
  { code: "uk", label: "Ukrainian (uk)" },
  { code: "pl", label: "Polish (pl)" },
  { code: "fi", label: "Finnish (fi)" },
  { code: "nl", label: "Dutch (nl)" },
  { code: "cs", label: "Czech (cs)" },
  { code: "th", label: "Thai (th)" },
];

/**
 * Whether Stardew natively ships this language. Only natively supported
 * languages have official content, so only they can build an official glossary.
 * Custom languages still translate and export fully; they simply have no
 * official glossary hints unless a community language pack source is detected.
 */
export function gameSupportsLanguage(code: string): boolean {
  return TARGET_LANGUAGES.some(
    (language) => language.code === code && language.gameLocale != null,
  );
}
