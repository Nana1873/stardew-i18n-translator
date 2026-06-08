# Milestone M2: String Table + Editor + Validation

## Goal
Implement the main workspace string table, search/filter capabilities, double-click editing dialog with glossary lookup, basic token/parameter validation, and the state model.

## Scope
* **String Table Grid:** A high-density grid showing keys, source strings, target strings, and current translation status.
* **Filter Toolbar:** Instant search (by key/original/target text), filter by status (per [SPEC.md §9](../../SPEC.md): untranslated, review-needed, imported, done, outdated, not-translatable, or all).
* **String Editor Dialog:** A modal triggered by double-clicking a row. Shows original text, editable target field, token validation results, and glossary/context hints.
* **Basic Token Validation:** The 4 v1 rules from [SPEC.md §10](../../SPEC.md): `token-missing`, `token-added`, `empty-target`, `json-invalid`. SMAPI i18n tokens use **double curly braces** `{{token}}` (regex `\{\{([^}]+)\}\}`), compared as sets between source and target. (Not `{0}` / `{name}`.)
* **Status Model:** Implement the **6** string statuses from [SPEC.md §9](../../SPEC.md) (untranslated, review-needed, imported, done, outdated, not-translatable) and their transitions during editing.
* **Outdated Logic:** Detect modified source strings using hash checks (`sourceHash` / `sourceTextAtTranslation`).

## Out of Scope
* Exporters, file saving, backups, or JSON generation.
* Offline AI translations (Claude-Code batch export/import).
* API calls or browser search triggers.

## Acceptance Criteria
1. String table handles high-density data (up to 5,000 strings) without lag or memory leaks.
2. Double-clicking a row opens a modal dialog that correctly updates the table on save.
3. Token validation flags missing/added tokens (e.g. source has `{{PlayerName}}`, target does not → `token-missing` error).
4. Editing a string updates its status per SPEC §9 (e.g. saving sets `done`; token errors surface as a validation issue, not a status).
5. Search bar filters results in real-time.
6. Validation rules are covered by comprehensive unit tests.

## Risks
* **Virtualization Requirements:** Large string counts can cause UI lag. (Mitigation: Use virtual list/grid rendering in the chosen UI stack).
* **Complex Token Syntax:** Some SMAPI mods use advanced tokens (e.g. `{{Gender:male|female}}`). (Mitigation: v1 treats anything matching `\{\{([^}]+)\}\}` as one opaque token and compares source/target token sets; no inner parsing.)

## Suggested Issue Breakdown

### Issue 7: Implement string table
* **Goal:** Create the primary interactive grid component, bind it to scanner data, and implement filtering/sorting.
* **Suggested Agent:** Claude Code.

### Issue 8: Implement double-click string editor dialog
* **Goal:** Build the editing overlay modal, capture input, display original vs translation, and provide glossary tooltips.
* **Suggested Agent:** Antigravity (UI layout & validation wiring).

### Issue 9: Implement basic token validation
* **Goal:** Create utility regex/parser to validate SMAPI `{{token}}` placeholders (regex `\{\{([^}]+)\}\}`) between source and target as sets, raising `token-missing` (error) / `token-added` (warning) on mismatch.
* **Suggested Agent:** Codex.

### Issue 10: Implement status model and transitions
* **Goal:** Write logic for the 6 SPEC §9 string statuses (untranslated, review-needed, imported, done, outdated, not-translatable) and their transitions on edit/re-scan. Include `sourceTextAtTranslation` snapshot + `sourceHash` tracking for `outdated` detection.
* **Suggested Agent:** Codex.

## Agent Handoff Notes
*Ensure keyboard shortcuts (Enter to save, Esc to cancel) are implemented on the editor dialog for power-user speed.*
