# LLM Batch Drag-and-Drop Implementation Plan

## Scope

Add the v1.1 drag-and-drop convenience path for external LLM batch results:

- Accept one JSON file dropped onto the app window.
- Require a selected mod before import.
- Reuse the existing lenient parser, key matching, overwrite protection,
  `review-needed` staging, and import summary.
- Show a clear full-window drop target and rejection diagnostics.
- Keep the toolbar file picker as an equivalent fallback.

## Implementation

1. Extract the Rust path-based import operation from the existing picker
   command and expose a second command for a known dropped path.
2. Listen to Tauri webview drag/drop events in the application shell.
3. Validate selection, file count, and `.json` extension before invoking Rust.
4. Display a drag overlay and route success/failure through the existing import
   summary dialog and table reload.
5. Add frontend tests and update SPEC, M4, and the v1.1 roadmap.

## Non-Goals

- Importing several mods or several result files in one drop.
- Guessing a target mod from filenames or batch metadata.
- Browser-native file uploads.
- File watching or automatic re-import.
