import type { StringStatus } from "../tauri/commands";

/** Labels + colors for the v1 string statuses (SPEC §9). */
export const STATUS_META: Record<
  StringStatus,
  { label: string; color: string }
> = {
  untranslated: { label: "Untranslated", color: "#e06c6c" },
  translated: { label: "Translated", color: "#5ec488" },
  outdated: { label: "Outdated", color: "#b07cd6" },
  "not-translatable": { label: "Not translatable", color: "#9aa0a6" },
  "review-needed": { label: "Needs review", color: "#e0a44e" },
};
