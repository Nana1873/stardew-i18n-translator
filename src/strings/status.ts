import type { StringStatus } from "../tauri/commands";

/**
 * Labels, glyphs + colors for the v1 string statuses (SPEC §7.0/§9).
 *
 * Design rule: a status is always shown as hue + glyph (+ 3px row edge in the
 * table) — any one signal alone is sufficient. Gold is reserved for
 * brand/selection and must never appear here. `edge` is the row-edge color
 * (the resting states use a dimmed edge so worked-on rows stand out).
 */
export const STATUS_META: Record<
  StringStatus,
  { label: string; glyph: string; color: string; edge: string }
> = {
  untranslated: {
    label: "Untranslated",
    glyph: "○",
    color: "#9aa0a6",
    edge: "rgba(154, 160, 166, 0.5)",
  },
  translated: {
    label: "Translated",
    glyph: "✓",
    color: "#5ec488",
    edge: "#5ec488",
  },
  outdated: {
    label: "Outdated",
    glyph: "↻",
    color: "#b98cdb",
    edge: "#b98cdb",
  },
  "review-needed": {
    label: "Needs review",
    glyph: "⚑",
    color: "#ec8b3f",
    edge: "#ec8b3f",
  },
};

/** `#rrggbb` + alpha → `rgba()` (STATUS_META colors are all 6-digit hex). */
export function statusTint(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
