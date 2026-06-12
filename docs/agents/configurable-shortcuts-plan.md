# Configurable Shortcuts Implementation Plan

## Scope

Implement the v1.1 configurable-shortcuts page from SPEC §7.7:

- Persist shortcut assignments in portable `Data/settings.json`.
- Cover the user-facing table and string-editor commands.
- Capture replacement key combinations in Settings.
- Reject unsupported, reserved, and duplicate assignments.
- Offer per-command and global reset to defaults.

## Implementation

1. Add a shared TypeScript shortcut catalog, defaults, event matching, display,
   and validation helpers.
2. Extend the Rust and TypeScript settings schemas with a backward-compatible
   shortcut map.
3. Add a Shortcuts page to the existing Settings left navigation.
4. Pass the resolved assignments into the string table and editor, including
   dynamic button hints.
5. Add focused frontend and Rust tests, then update SPEC and the v1.1 roadmap.

## Non-Goals

- Global OS shortcuts while the app is unfocused.
- Mouse gesture customization.
- Multiple shortcut profiles.
- Shortcuts for toolbar actions that currently have no keyboard command.
