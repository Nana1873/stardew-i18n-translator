# Milestone M2: String Table + Editor + Validation

## Goal
Implement the main workspace string table, search/filter capabilities, double-click editing dialog with glossary lookup, basic token/parameter validation, and the state model.

## Scope
* **String Table Grid:** A high-density grid showing keys, source strings, target strings, and current translation status.
* **Filter Toolbar:** Instant search (by key/text), filter by status (All, Missing, Warnings, Outdated).
* **String Editor Dialog:** A modal triggered by double-clicking a row. Shows original text, editable target field, token validation results, and glossary/context hints.
* **Basic Token Validation:** Warning checks to ensure target strings preserve formatting tokens like `{0}`, `{name}`, etc.
* **Status Model:** Implementation of state flags per string (Original, Translated, Outdated, Warning) and updates during editing.
* **Outdated Logic:** Detect modified source strings using hash checks (`sourceHash` / `sourceTextAtTranslation`).

## Out of Scope
* Exporters, file saving, backups, or JSON generation.
* Offline AI translations (Claude-Code batch export/import).
* API calls or browser search triggers.

## Acceptance Criteria
1. String table handles high-density data (up to 5,000 strings) without lag or memory leaks.
2. Double-clicking a row opens a modal dialog that correctly updates the table on save.
3. Token validation highlights missing or modified tokens (e.g. source has `{0}`, target does not).
4. Status of edited items changes from "Original" to "Translated" (or "Warning" if tokens fail).
5. Search bar filters results in real-time.
6. Validation rules are covered by comprehensive unit tests.

## Risks
* **Virtualization Requirements:** Large string counts can cause UI lag. (Mitigation: Use virtual list/grid rendering in the chosen UI stack).
* **Complex Token Syntax:** Some SMAPI mods use custom formatting parameters. (Mitigation: Implement simple brace matching `{...}` for v1 token validation).

## Suggested Issue Breakdown

### Issue 7: Implement string table
* **Goal:** Create the primary interactive grid component, bind it to scanner data, and implement filtering/sorting.
* **Suggested Agent:** Claude Code.

### Issue 8: Implement double-click string editor dialog
* **Goal:** Build the editing overlay modal, capture input, display original vs translation, and provide glossary tooltips.
* **Suggested Agent:** Antigravity (UI layout & validation wiring).

### Issue 9: Implement basic token validation
* **Goal:** Create utility regex/parser to validate brace tokens (`{0}`, `{name}`) between source and target, triggering warnings on mismatch.
* **Suggested Agent:** Codex.

### Issue 10: Implement status model and transitions
* **Goal:** Write logic for calculating string statuses (Original, Translated, Outdated, Warning) and handle data model transitions on edit. Include `sourceHash` tracking.
* **Suggested Agent:** Codex.

## Agent Handoff Notes
*Ensure keyboard shortcuts (Enter to save, Esc to cancel) are implemented on the editor dialog for power-user speed.*
