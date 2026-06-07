# Milestone M4: Claude-Code Batch

## Goal
Implement the offline AI translation batch workflow, allowing users to export untranslated/outdated strings to a JSON batch, translate them externally using tools like Claude Code, and import the results back into the application.

## Scope
* **Batch Request Exporter:** Export a structured JSON file containing metadata, source language, target language, and a flat map of missing or outdated keys/values across selected mods.
* **Batch Response Importer:** Import a translated batch JSON file, matching keys back to their respective mods and strings.
* **Merge & Transition Logic:** Merge imported translations, update statuses to "Translated", track the source hash, and flag any formatting/token warnings on import.

## Out of Scope
* Direct API integrations (OpenAI, Anthropic, etc.) inside the application.
* Automated file watching/syncing.

## Acceptance Criteria
1. Exported JSON has a clear schema specifying: `sourceLang`, `targetLang`, `exportDate`, and `translations` (grouped by Mod ID / File Path / Key).
2. The export includes prompt templates or context instructions at the top of the file to guide external LLMs.
3. Import parses external JSON, validates keys, and updates the local state db.
4. Imported values are run through the token validator; mismatches are flagged as "Warning".
5. Merging handles duplicate keys or missing metadata gracefully without corrupting database state.
6. The entire export/import cycle is covered by unit tests using mock batch files.

## Risks
* **LLM Formatting Errors:** External LLMs might break the JSON structure or corrupt key names during translation. (Mitigation: Provide strong instruction schemas in the exported file, and validate the JSON schema strictly on import).
* **Stale Batches:** User edits strings locally, then imports an older batch file. (Mitigation: Alert the user if the imported translation target doesn't match the current source string hash).

## Suggested Issue Breakdown

### Issue 13: Export Claude-Code translation batch JSON
* **Goal:** Create utility to extract all keys in "Original" or "Outdated" status into an offline batch JSON file, including translation context and instructions.
* **Suggested Agent:** Codex or Claude Code.

### Issue 14: Import Claude-Code result JSON
* **Goal:** Create parser to read the translated batch JSON, merge values back into the application store, and run post-import token validation.
* **Suggested Agent:** Claude Code.

## Agent Handoff Notes
*Make sure the exported file contains a markdown/text instruction block that the user can copy-paste directly to Claude Code/Codex to trigger the automated translation.*
