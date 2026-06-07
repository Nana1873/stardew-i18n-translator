# Milestone M3: Export

## Goal
Implement safe export features to write translations back to `i18n/<lang>.json` files, with automatic file backup, sorting, and error/warning handling.

## Scope
* **Clean JSON Generator:** Construct standard JSON matching the layout of the source manifest. Ensure keys are written in alphabetical order (standard for SMAPI i18n files).
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
4. Export blocks and alerts the user if critical token errors exist (to prevent mod crashes).
5. All file write and backup operations are tested with mocked disk systems.

## Risks
* **Data Loss:** Buggy export could corrupt existing translations. (Mitigation: Write to temporary file first, verify syntax, then rename to target, preserving backup).
* **Character Encoding:** Mods might use special characters/accent marks. (Mitigation: Always write files in UTF-8 encoding).

## Suggested Issue Breakdown

### Issue 11: Export clean i18n/<lang>.json files
* **Goal:** Write out the translated key-value map as sorted, indented JSON. Ensure encoding is UTF-8.
* **Suggested Agent:** Codex.

### Issue 12: Backup existing target files before overwrite
* **Goal:** Create a backup routine that copies the target `i18n/<lang>.json` to `i18n/<lang>.json.bak` safely, validating the copy before rewriting the main file.
* **Suggested Agent:** Codex or Claude Code.

## Agent Handoff Notes
*Ensure files are formatted exactly with standard 2-space or 4-space JSON indentation matching the original mod file structure.*
