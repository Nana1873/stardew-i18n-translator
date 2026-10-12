import type { StringStatus } from "../tauri/commands";

/**
 * Labels and glyphs for the current string statuses, matching the table and
 * filter labels.
 *
 * Design rule: a status is always shown as hue + glyph, and either signal
 * alone is sufficient. The hue comes from the shared CSS status colors
 * (`.translator-state.is-ready` / `is-change` / `is-review`), the same ones
 * the table and the status filters use. Gold is reserved for brand/selection
 * and must never appear here.
 */
export const STATUS_META: Record<
  StringStatus,
  { label: string; glyph: string }
> = {
  untranslated: { label: "Open", glyph: "○" },
  translated: { label: "Done", glyph: "✓" },
  outdated: { label: "Changed", glyph: "↻" },
  "review-needed": { label: "Review", glyph: "⚑" },
};

/** Unicode White_Space matches Rust str::trim, including NEL but excluding BOM. */
export function isBlankText(text: string): boolean {
  return /^\p{White_Space}*$/u.test(text);
}

/** This is derived from the current text, never a saved exemption. */
export function noTranslationNeeded(source: string, target: string): boolean {
  return isBlankText(source) && isBlankText(target);
}

/** A single ASCII space deliberately suppresses visible SMAPI translation text. */
export function isIntentionalBlankTarget(
  source: string,
  target: string,
): boolean {
  return !isBlankText(source) && target === " ";
}

export function hasTranslation(
  source: string,
  target: string,
  status: StringStatus,
): boolean {
  return (
    !isBlankText(target) ||
    (isIntentionalBlankTarget(source, target) && status !== "untranslated")
  );
}

export function derivedStringStatus(
  source: string,
  target: string,
  status: StringStatus,
): StringStatus {
  if (hasTranslation(source, target, status)) return status;
  return noTranslationNeeded(source, target) ? "translated" : "untranslated";
}
