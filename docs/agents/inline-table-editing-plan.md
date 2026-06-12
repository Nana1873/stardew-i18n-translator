# Inline Table Editing Implementation Plan

## Scope

Implement the v1.1 fast path for short translations in the existing
virtualized string table:

- Double-click the translation cell to edit short, single-line strings inline.
- Keep the full String Editor for long or multiline strings and for
  double-clicks outside the translation cell.
- Save with Enter or focus loss (including Tab); cancel with Escape.
- Preserve live validation, status transitions, selection, counts, sorting,
  filtering, and persisted state.

## Implementation

1. Add a deterministic short-string eligibility helper.
2. Add one active inline-edit state to `StringTable`.
3. Render a compact input inside the translation cell with live validation.
4. Reuse `saveRow` so persistence and status/count updates remain identical to
   the full editor.
5. Add focused interaction tests and update SPEC, M2, and the v1.1 roadmap.

## Non-Goals

- Multiline editing in the table.
- Multiple simultaneous inline editors.
- Inline source/key editing.
- Replacing the full editor, glossary hints, token chips, or local-AI controls.
