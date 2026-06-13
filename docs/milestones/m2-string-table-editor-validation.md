# Milestone M2: String Table + Editor + Validation

## Goal

Implement the main workspace string table, the double-click editing dialog,
protected-token validation, the persisted status model, and search/filter/sort.

## Scope

- **String Table Grid:** A high-density, virtualized grid showing key, source string, target string, and a per-row validation/status indicator (full-row status tint).
- **Filter Toolbar:** Instant search (by key/original/target text) and a filter by status (per [SPEC.md §9](../../SPEC.md): `untranslated`, `translated`, `outdated`, `review-needed`, or all).
- **String Editor Dialog:** A modal triggered by double-clicking a row. Shows original text, editable target field, live token validation, status badge, clickable token chips, and **glossary hints** (official game terms found in the source, click to insert the translation — SPEC §7.5).
- **Protected-Token Validation:** `token-missing` and `token-added` are errors; `newline-mismatch` remains a warning because `\n` is layout, not syntax. `empty-target` and `json-invalid` retain their existing behavior, while `identical-to-source` and `escape-suspicious` are high-signal warnings. A **"token" is any Stardew/SMAPI protected token**, not just `{{...}}`: Content Patcher `{{...}}` (nested-aware), gender switch `${male^female}$`, mail commands `[#]` / `%item … %%`, dialogue break `#$b#`, bracket tokens `[…]`, **positional placeholders `{0}`**, dialogue commands `$b`/`$s`/`$e`, structural `#`, balanced single-quote delimiters such as `'test'`, and single-char `@`/`^`. Apostrophes inside words such as `don't` are ordinary prose. Tokens are compared as **multisets** (counts matter). See `src/strings/protectedTokens.ts` and `src-tauri/src/tokens.rs`.
- **Status Model:** Implement the four statuses from [SPEC.md §9](../../SPEC.md) — `untranslated`, `translated`, `outdated`, and the AI-workflow status `review-needed` — and their transitions during editing. (`outdated` is derived automatically, never set by hand. Strings intentionally kept in English use the **Keep original** action and remain covered by `outdated` detection.)
- **Outdated Logic:** Detect modified source strings via per-string `sourceHash` (SHA-256 of the English source at save time), compared on re-scan.

## Out of Scope

- Exporters, file saving, backups, or JSON generation (that is M3).
- External LLM batch translations (export/import — M4).
- API calls.

## Acceptance Criteria

1. String table handles high-density data (thousands of strings) without lag (row virtualization). ✅
2. Double-clicking a row opens a modal dialog that correctly updates the table on save. ✅
3. Token validation flags missing/added protected tokens (e.g. source has `{{PlayerName}}` or `$b`, target drops it → `token-missing` error). ✅
4. Editing a string updates its status per SPEC §9 (saving sets `translated`; F2 **Keep original** copies the source as an explicit translation; token errors surface as validation issues, **not** statuses). ✅
5. Multi-select via Ctrl+Click (toggle), Shift+Click (range), and `Ctrl+A` (select all visible). ✅
6. Right-click context menu with the v1 bulk actions (Edit, Copy original/translation, Mark translated, Keep original, Clear translation). ✅
7. Search bar filters results in real-time (across key/original/target). ✅
8. Status filter shows only strings of the selected status. ✅
9. Sorting by column (Key / Original / Translation / File; click to cycle asc → desc → off). ✅
10. Validation rules are covered by unit tests. ✅
11. Editor glossary hints: matched official terms shown, click inserts the translation (when a glossary is built). ✅

## Status (shipped vs. open) — 2026-06-09

**Shipped (PRs #7–#24):** virtualized string table with full-row status tint, double-click editor (live validation, token chips, status badge, keyboard shortcuts Ctrl+Enter/Esc/Alt+←→/F2/F3/F4), the full protected-token taxonomy compared as multisets, the 4-status model with persisted per-string state and surgical `outdated` detection, multi-select (Ctrl/Shift-click), and the right-click context menu with bulk actions.

**Also shipped (post-audit, 2026-06-09):** toolbar text **search** across key/original/target, **status filter** dropdown, **Ctrl+A** select-all-visible, **column sorting**, and **editor glossary hints** (matched official terms, click to insert). Filtering/sorting operate on a visible view while selection/editor navigation keep stable data indices.

**Still open for v1:** none — M2 is functionally complete.

**Moved out of M2:** the **"Search Translation on Nexus"** action is deferred and
folded into the new [M5 — Nexus Translation Discovery & Download](m5-nexus-translation-download.md)
(the owner prefers the full SSE-AT-style assisted-download flow over a browser-search stopgap).

## Risks

- **Virtualization Requirements:** Large string counts can cause UI lag. (Mitigation: `@tanstack/react-virtual` row virtualization.)
- **Complex Token Syntax:** Real content mods (e.g. Ridgeside) lean heavily on dialogue/Content Patcher tokens, not just `{{...}}`. (Mitigation: the full taxonomy above is treated as protected and compared as multisets; no inner parsing of token contents.)

## Issue Breakdown (as shipped)

### Issue 7: String table ✅

Virtualized grid bound to scanner data, full-row status tint, selection.

### Issue 8: Double-click string editor dialog ✅

Editing overlay with original vs. translation, live validation, clickable token chips, status badge, keyboard shortcuts.

### Issue 9: Protected-token validation ✅

`extractProtectedTokens` reader for the full Stardew taxonomy; `token-missing`
and `token-added` are errors via **multiset** comparison; plus
`newline-mismatch`, `empty-target`, `json-invalid`, `identical-to-source`, and
`escape-suspicious`. The two quality rules warn but do not block.

### Issue 10: Status model and persistence ✅

The 4 v1 statuses and their transitions, with `sourceHash` tracking for
`outdated` detection. Translation state is persisted per target language and
mod (keyed by language code + UniqueID) separately from the mod's files.

### Issue 10b: Search / filter / sort ✅

Text search (key/original/target), status filter, and column sorting (asc → desc → off) for the string table — shipped post-audit; filtering/sorting operate on a visible view while selection/editor navigation keep stable data indices.

## Agent Handoff Notes

_Keep the status set at exactly 4 (SPEC §19 #2). `review-needed` is one of
those four and only the AI workflows set it. Keep all table work inside the
existing two-panel layout — no extra panels (SPEC §19 #5)._
