/**
 * SMAPI i18n target languages (SPEC Appendix A). Source is always English
 * (`default`) in v1.
 */
export interface Language {
  /** SMAPI i18n code, used for the `<lang>.json` filename. */
  code: string;
  label: string;
}

export const SOURCE_LANGUAGE_LABEL = "English (default)";

export const TARGET_LANGUAGES: Language[] = [
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
];
