# Milestone M2: String Table + Editor + Validation

## Goal
Implement the main workspace string table, the double-click editing dialog, protected-token validation, the persisted status model, and (still open) search/filter/sort.

## Scope
* **String Table Grid:** A high-density, virtualized grid showing key, source string, target string, and a per-row validation/status indicator (full-row status tint).
* **Filter Toolbar:** Instant search (by key/original/target text) and a filter by status (per [SPEC.md §9](../../SPEC.md): `untranslated`, `translated`, `outdated`, `not-translatable`, or all). *(Still open — see Status below.)*
* **String Editor Dialog:** A modal triggered by double-clicking a row. Shows original text, editable target field, live token validation, status badge, and clickable token chips.
* **Protected-Token Validation:** The 4 v1 rules from [SPEC.md §10](../../SPEC.md): `token-missing` (error), `token-added` (warning), `empty-target` (warning), `json-invalid` (error). A **"token" is any Stardew/SMAPI protected token**, not just `{{...}}`: Content Patcher `{{...}}` (nested-aware), gender switch `${male^female}$`, mail commands `[#]` / `%item … %%`, dialogue break `#$b#`, bracket tokens `[…]`, **positional placeholders `{0}`**, dialogue commands `$b`/`$s`/`$e`, single-char `@`/`^`. Tokens are compared as **multisets** (counts matter), so a dropped *second* `$b` is caught too. See `src/strings/protectedTokens.ts` (and the Rust port `src-tauri/src/tokens.rs`).
* **Status Model:** Implement the **4** v1 string statuses from [SPEC.md §9](../../SPEC.md) — `untranslated`, `translated`, `outdated`, `not-translatable` — and their transitions during editing. (`outdated` is derived automatically, never set by hand. The earlier 6-status draft — `imported`/`done`/`review-needed` — was collapsed: `imported`/`done` → `translated`; `review-needed` returns only in M4.)
* **Outdated Logic:** Detect modified source strings via per-string `sourceHash` (SHA-256 of the English source at save time), compared on re-scan.

## Out of Scope
* Exporters, file saving, backups, or JSON generation (that is M3).
* Offline AI translations (Claude-Code batch export/import — M4).
* API calls.

## Acceptance Criteria
1. String table handles high-density data (thousands of strings) without lag (row virtualization). ✅
2. Double-clicking a row opens a modal dialog that correctly updates the table on save. ✅
3. Token validation flags missing/added protected tokens (e.g. source has `{{PlayerName}}` or `$b`, target drops it → `token-missing` error). ✅
4. Editing a string updates its status per SPEC §9 (saving sets `translated`; `not-translatable` via F2; token errors surface as a validation issue, **not** a status). ✅
5. Multi-select via Ctrl+Click (toggle), Shift+Click (range), and `Ctrl+A` (select all visible). ✅
6. Right-click context menu with the v1 bulk actions (Edit, Copy original/translation, Mark translated, Mark not-translatable, Clear translation). ✅ — "Search Translation on Nexus" mod-level action is **still open**.
7. Search bar filters results in real-time (across key/original/target). ✅
8. Status filter shows only strings of the selected status. ✅
9. Sorting by column. ❌ **Still open**.
10. Validation rules are covered by unit tests. ✅

## Status (shipped vs. open) — 2026-06-09

**Shipped (PRs #7–#24):** virtualized string table with full-row status tint, double-click editor (live validation, token chips, status badge, keyboard shortcuts Ctrl+Enter/Esc/Alt+←→/F2/F3/F4), the full protected-token taxonomy compared as multisets, the 4-status model with persisted per-string state and surgical `outdated` detection, multi-select (Ctrl/Shift-click), and the right-click context menu with bulk actions.

**Also shipped (post-audit, 2026-06-09):** toolbar text **search** across key/original/target, **status filter** dropdown, and **Ctrl+A** select-all-visible. Filtering operates on a visible view while selection/editor navigation keep stable data indices.

**Still open for v1 (tracked, not yet built):**
- **Column sorting**.
- **"Search Translation on Nexus"** mod-level context action (SPEC §7.6 / §12).
- **Scan progress dialog** is simplified to an inline "Scanning…" label (SPEC §7.2 describes a modal).

## Risks
* **Virtualization Requirements:** Large string counts can cause UI lag. (Mitigation: `@tanstack/react-virtual` row virtualization.)
* **Complex Token Syntax:** Real content mods (e.g. Ridgeside) lean heavily on dialogue/Content Patcher tokens, not just `{{...}}`. (Mitigation: the full taxonomy above is treated as protected and compared as multisets; no inner parsing of token contents.)

## Issue Breakdown (as shipped)

### Issue 7: String table ✅
Virtualized grid bound to scanner data, full-row status tint, selection.

### Issue 8: Double-click string editor dialog ✅
Editing overlay with original vs. translation, live validation, clickable token chips, status badge, keyboard shortcuts.

### Issue 9: Protected-token validation ✅
`extractProtectedTokens` reader for the full Stardew taxonomy; `token-missing` (error) / `token-added` (warning) via **multiset** comparison; plus `empty-target` and `json-invalid`.

### Issue 10: Status model and persistence ✅
The 4 v1 statuses and their transitions, with `sourceHash` tracking for `outdated` detection. Translation state persisted per mod (keyed by UniqueID) separately from the mod's files.

### Issue 10b: Search / filter / sort ❌ (still open)
Text search, status filter, and column sorting for the string table — deferred; see Status above.

## Agent Handoff Notes
*Keep the status set at exactly 4 (SPEC §19). `review-needed` is reintroduced only in M4. When building the open search/filter/sort work, keep it inside the existing two-panel layout — no extra panels (SPEC §19 #5).*
