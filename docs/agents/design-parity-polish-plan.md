# Design Parity Polish Plan

## Scope

Bring four deferred details from `docs/design/full-design.dc.html` into the
existing M2/M3 workflow without changing the underlying translation model:

1. Show stable review-session position and progress in the string editor.
2. Replace the unselected-mod placeholder with the designed actionable card.
3. Make skipped export entries navigate back to the affected table row.
4. Show the number of partially translated mods in the mod-panel header.

Configurable shortcuts remain deferred to a later settings task.

## Implementation

- Snapshot the visible editor queue when a string is opened so navigation and
  progress remain stable while edits change the active table filter.
- Add an optional review progress strip to `StringEditor`.
- Add a work-view empty-state action that returns to the dashboard review
  queue.
- Decorate export skips with UI-only mod metadata and expose navigation
  callbacks from `ExportDialog`.
- Reuse the dashboard definition of "in progress": translated keys between
  zero and the mod total.

## Verification

- Add focused component tests for review progress and export navigation.
- Extend app/table tests for the new empty state, header count, and stable
  editor session.
- Run formatting, frontend tests, and the production web build.
- Verify the work view and dialogs in the browser preview.
