# Milestone M3: Export

## Goal

Implement safe export features to write translations back to `i18n/<lang>.json` files, with automatic file backup, preserved `default.json` key order, and error/warning handling.

## Scope

- **Clean JSON Generator:** Construct standard JSON for the target language. **Preserve the key order of `default.json`** (per [SPEC.md §15/M3](../../SPEC.md) — for diff-friendliness; do **not** sort alphabetically). UTF-8 without BOM, 2-space indentation.
- **Backup System:** Create automatic `.bak` copies of existing target files before overwriting them.
- **Export Validation Checks:** Check for critical issues before writing (e.g. broken JSON structure, fatal token mismatches).
- **Graceful Warnings:** Show warnings for missing translations or non-fatal token issues, but allow the user to proceed with the export anyway (no hard blocking).

## Out of Scope

- Automatic uploads, Git commits, or API synchronization.
- Bulk translate options.

## Acceptance Criteria

1. Export writes clean, valid JSON (2-space indent, UTF-8 without BOM, trailing newline). ✅
2. Existing files are safely copied to `<filename>.json.bak` in the same directory prior to saving. ✅
3. Export reports untranslated keys in the summary and completes the save anyway (untranslated keys are omitted, never blocking). ✅
4. A missing or additional protected-token occurrence blocks the complete
   affected mod export before any target or backup is written. The summary
   reports every affected file, key, token, expected count, and actual count.
   Untranslated strings are omitted and never block; kept-original strings
   export explicitly when their token counts remain valid. ✅
5. Key order matches `default.json`. ✅
6. File write + backup operations are covered by tests (real temp dirs). ✅
7. **Export all mods** (not just the selected mod). ✅ — toolbar "Export All" iterates every scanned mod and shows an aggregated summary.
8. **Overwrite-confirmation dialog.** ✅ Existing target files are counted
   before selected-mod and Export All runs. New targets export immediately;
   overwrites require explicit confirmation and explain the `.json.bak` backup.

## Status (shipped vs. open) — 2026-06-09

**Shipped (PR #24 and v1.1 quality update):** per-mod export in
`default.json` key order; UTF-8 no BOM, 2-space indent; `.bak` backup and atomic
write; omit untranslated strings; export kept-original strings explicitly;
preflight the complete mod and block every write when any protected-token count
differs; report each mismatch with expected and actual counts.

**Also shipped (post-audit):** **Export All** iterates every scanned mod,
continues past independently blocked mods, and shows one aggregated summary.

**Still open for v1:** none — M3 is complete.

## Risks

- **Data Loss:** Buggy export could corrupt existing translations. (Mitigation: Write to temporary file first, verify syntax, then rename to target, preserving backup).
- **Character Encoding:** Mods might use special characters/accent marks. (Mitigation: Always write files in UTF-8 encoding).

## Suggested Issue Breakdown

### Issue 11: Export clean i18n/<lang>.json files

- **Goal:** Write out the translated key-value map in `default.json` key order as indented JSON (2-space, UTF-8 without BOM).
- **Suggested Agent:** Codex.

### Issue 12: Backup existing target files before overwrite

- **Goal:** Create a backup routine that copies the target `i18n/<lang>.json` to `i18n/<lang>.json.bak` safely, validating the copy before rewriting the main file.
- **Suggested Agent:** Codex or Claude Code.

## Agent Handoff Notes

_Ensure files are formatted with 2-space JSON indentation, UTF-8 without BOM, and keys in `default.json` order (per SPEC §17 M3)._
