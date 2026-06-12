# Export Overwrite Confirmation Plan

## Scope

Complete the remaining optional M3 acceptance item from `SPEC.md`:

- Ask for confirmation before an export overwrites existing target-language
  JSON files.
- Cover both selected-mod export and Export All.
- Keep the existing `.bak` backup and atomic Rust write path unchanged.

## Behavior

- Export starts immediately when none of the target files exists yet.
- When existing targets are present, show the number of affected files and,
  for Export All, affected mods.
- Explain that every overwritten file is backed up to `.json.bak`.
- Cancel performs no export command.
- Confirm continues through the existing export result dialog.
- After a successful first export, mark written targets as existing in the
  current scan state so a second export in the same session asks first.

## Verification

- Component tests for the confirmation dialog.
- App tests for cancel, confirm, no-overwrite fast path, and same-session state.
- Frontend tests, TypeScript build, formatting, and GitHub CI.
