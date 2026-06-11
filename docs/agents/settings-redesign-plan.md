# Settings Left-Navigation Redesign Plan

## Scope

Implement the remaining SPEC §7.7 v1.5 Settings redesign only:

- Replace the flat settings list with left navigation.
- Keep exactly the approved pages: Folders & language, Local AI, Glossary.
- Add explicit Local AI connection states with response timing, diagnostics,
  and Retry.

## Implementation

1. Restructure `SettingsDialog` into an accessible tab-style navigation and
   page content area while preserving the current save behavior.
2. Measure the `/models` request duration in the frontend and render dedicated
   success, empty-model, and failure cards.
3. Restyle the modal to match `docs/design/full-design.dc.html` without adding
   the mockup-only Export defaults or Shortcuts pages.
4. Extend component tests for navigation and all connection-result states.
5. Run TypeScript, Vitest, Prettier, and Rust tests, then inspect the dialog in
   the local browser preview.

## Non-Goals

- Section context in AI prompts.
- Export defaults or shortcut settings.
- Changes to the persisted settings schema or Tauri commands.
- Other design-parity polish items.
