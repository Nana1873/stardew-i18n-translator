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
1. Export writes clean, valid JSON formatted with indentation matching the mod's style.
2. Existing files are safely copied to `<filename>.json.bak` in the same directory prior to saving.
3. Export warns if there are untranslated keys, but completes the file save if confirmed.
4. Strings with **error-level** issues (`token-missing`, `json-invalid`) are **skipped** from the export (not a hard block on the whole file); all other strings export normally, and the summary reports what was skipped and why. Untranslated strings are omitted (SMAPI falls back to `default.json`). See [SPEC.md §10 / §17 M3](../../SPEC.md).
5. All file write and backup operations are tested with mocked disk systems.

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
