import type { StringStatus } from "../tauri/commands";

/** Labels + colors for the 6 string statuses (SPEC §9). */
export const STATUS_META: Record<StringStatus, { label: string; color: string }> = {
  untranslated: { label: "Untranslated", color: "#e06c6c" },
  imported: { label: "Imported", color: "#6ab0ff" },
  "review-needed": { label: "Review needed", color: "#d6a85f" },
  done: { label: "Done", color: "#4a9d6b" },
  outdated: { label: "Outdated", color: "#b07cd6" },
  "not-translatable": { label: "Not translatable", color: "#9aa0a6" },
};
