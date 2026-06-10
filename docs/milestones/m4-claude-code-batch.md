# Milestone M4: Claude-Code Batch

## Goal

Implement the offline AI translation batch workflow, allowing users to export untranslated/outdated strings to a JSON batch, translate them externally using tools like Claude Code, and import the results back into the application.

## Scope

- **Batch Request Exporter:** Export a structured JSON file containing metadata, source language, target language, and a flat map of missing or outdated keys/values across selected mods.
- **Batch Response Importer:** Import a translated batch JSON file, matching keys back to their respective mods and strings.
- **Merge & Transition Logic:** Merge imported translations, set their status to **`review-needed`** (per [SPEC.md §11](../../SPEC.md) — imported AI results are never auto-marked done), track the source hash, and run token validation on import. Do not overwrite `done` strings without user confirmation.

## Out of Scope

- Direct API integrations (OpenAI, Anthropic, etc.) inside the application.
- Automated file watching/syncing.

## Acceptance Criteria

1. Exported JSON has a clear schema specifying: `sourceLang`, `targetLang`, `exportDate`, and `translations` (grouped by Mod ID / File Path / Key).
2. The export includes prompt templates or context instructions at the top of the file to guide external LLMs.
3. Import parses external JSON, validates keys, and updates the local state db.
4. Imported values get status `review-needed` and are run through the token validator; mismatches surface as validation issues (not auto-rejected).
5. Merging handles duplicate keys or missing metadata gracefully without corrupting database state.
6. The entire export/import cycle is covered by unit tests using mock batch files.

## Risks

- **LLM Formatting Errors:** External LLMs might break the JSON structure or corrupt key names during translation. (Mitigation: Provide strong instruction schemas in the exported file, and validate the JSON schema strictly on import).
- **Stale Batches:** User edits strings locally, then imports an older batch file. (Mitigation: Alert the user if the imported translation target doesn't match the current source string hash).

## Suggested Issue Breakdown

### Issue 13: Export Claude-Code translation batch JSON ✅

- Context-menu action **"Export for Claude Code (N)"** on the selection (same
  eligibility as the M6 AI batch: `untranslated`/`outdated` only; Ctrl+A =
  whole mod), save-dialog destination, embedded instruction block + glossary
  excerpt (matched terms only, capped at 60), strings grouped by i18n
  directory (`files`) so multi-i18n-folder mods stay unambiguous (SPEC §11).

### Issue 14: Import Claude-Code result JSON ✅

- Toolbar **"Import batch…"** (file picker, lenient JSON parse for LLM
  artifacts), per-directory key matching, all accepted values staged as
  `review-needed` in **one** atomic state write (`save_many`), table reload +
  fresh counts, summary dialog. Safety: `translated`/`not-translatable`
  strings are never overwritten (stale-batch protection, skipped + counted);
  dropped-token and identical-to-source values are imported but flagged; a
  batch file translated in place is accepted like a result file.

## Status (shipped vs. open)

**Complete.** Both issues shipped together: the batch exporter (context menu →
save dialog) and the result importer (toolbar → summary). Core logic lives in
`src-tauri/src/batch.rs` (`build_batch` / `apply_batch`, both pure and
unit-tested); dialogs in `src/claude/ClaudeBatchDialog.tsx`. The drag-and-drop
import variant from SPEC §11 was skipped (the toolbar button covers the flow;
revisit only on demand).

## Agent Handoff Notes

_The exported file contains the instruction block inline (`instructions`), so
the user can hand the whole file to Claude Code/Codex verbatim. Import accepts
both the `…-claude-result` format and an in-place-translated `…-claude-batch`
file. Reuse `batch::apply_batch` for any future import path — it enforces the
never-overwrite-manual-work rule and the flag-don't-reject validation._
