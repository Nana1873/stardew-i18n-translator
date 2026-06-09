# Milestone M3: Export

## Goal
Implement safe export features to write translations back to `i18n/<lang>.json` files, with automatic file backup, preserved `default.json` key order, and error/warning handling.

## Scope
* **Clean JSON Generator:** Construct standard JSON for the target language. **Preserve the key order of `default.json`** (per [SPEC.md §15/M3](../../SPEC.md) — for diff-friendliness; do **not** sort alphabetically). UTF-8 without BOM, 2-space indentation.
* **Backup System:** Create automatic `.bak` copies of existing target files before overwriting them.
* **Export Validation Checks:** Check for critical issues before writing (e.g. broken JSON structure, fatal token mismatches).
* **Graceful Warnings:** Show warnings for missing translations or non-fatal token issues, but allow the user to proceed with the export anyway (no hard blocking).

## Out of Scope
* Automatic uploads, Git commits, or API synchronization.
* Bulk translate options.

## Acceptance Criteria
1. Export writes clean, valid JSON (2-space indent, UTF-8 without BOM, trailing newline). ✅
2. Existing files are safely copied to `<filename>.json.bak` in the same directory prior to saving. ✅
3. Export reports untranslated keys in the summary and completes the save anyway (untranslated keys are omitted, never blocking). ✅
4. Strings with **error-level** issues (`token-missing`) are **skipped** individually (not a hard block on the whole file); all other strings export normally, and the summary reports what was skipped and why. Untranslated and not-translatable strings are omitted (SMAPI falls back to `default.json`). See [SPEC.md §10 / §17 M3](../../SPEC.md). ✅ — *(`json-invalid` cannot occur from a Rust `String`, which is always valid UTF-8, so that error is moot at export time.)*
5. Key order matches `default.json`. ✅
6. File write + backup operations are covered by tests (real temp dirs). ✅
7. **Export all mods** (not just the selected mod). ❌ **Still open** — only single-selected-mod export is implemented.
8. **Overwrite-confirmation dialog.** ⚠️ Replaced by an automatic `.bak` backup + atomic temp-then-rename write (safer, no prompt). Revisit if an explicit confirm is wanted.

## Status (shipped vs. open) — 2026-06-09

**Shipped (PR #24):** per-mod export of saved translations to `i18n/<lang>.json` in `default.json` key order; UTF-8 no BOM, 2-space indent; `.bak` backup of an existing target; atomic write (`.tmp` → verify → rename); omit untranslated + not-translatable; skip + report `token-missing` keys; export outdated-but-present strings and flag them; Rust port of the protected-token reader (`tokens.rs`); toolbar **Export** button + **ExportDialog** summary. 9 new Rust tests + a frontend dialog test.

**Still open for v1:**
- **Export all mods** at once (currently exports the selected mod only).
- Optional explicit **overwrite confirmation** (currently silent `.bak` backup instead).

## Risks
* **Data Loss:** Buggy export could corrupt existing translations. (Mitigation: Write to temporary file first, verify syntax, then rename to target, preserving backup).
* **Character Encoding:** Mods might use special characters/accent marks. (Mitigation: Always write files in UTF-8 encoding).

## Suggested Issue Breakdown

### Issue 11: Export clean i18n/<lang>.json files
* **Goal:** Write out the translated key-value map in `default.json` key order as indented JSON (2-space, UTF-8 without BOM).
* **Suggested Agent:** Codex.

### Issue 12: Backup existing target files before overwrite
* **Goal:** Create a backup routine that copies the target `i18n/<lang>.json` to `i18n/<lang>.json.bak` safely, validating the copy before rewriting the main file.
* **Suggested Agent:** Codex or Claude Code.

## Agent Handoff Notes
*Ensure files are formatted with 2-space JSON indentation, UTF-8 without BOM, and keys in `default.json` order (per SPEC §17 M3).*
