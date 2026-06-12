# Milestone M4: External LLM Batch

## Goal

Implement the file-based AI translation batch workflow, allowing users to export untranslated/outdated strings to a JSON batch, translate them externally using ChatGPT, Claude, Gemini, or another file-capable LLM, and import the results back into the application.

## Scope

- **Batch Request Exporter:** Export a structured JSON file containing metadata, source language, target language, and a flat map of missing or outdated keys/values across selected mods.
- **Batch Response Importer:** Import a translated batch JSON file, matching keys back to their respective mods and strings.
- **Merge & Transition Logic:** Merge imported translations, set their status to **`review-needed`** (per [SPEC.md §11](../../SPEC.md) — imported AI results are never auto-confirmed), track the source hash, and run token validation on import. Never overwrite manually translated strings.

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

### Issue 13: Export external LLM translation batch JSON ✅

- Context-menu action **"Export LLM batch (N)"** on the selection (same
  eligibility as the M6 AI batch: `untranslated`/`outdated` only; Ctrl+A =
  whole mod), save-dialog destination, embedded instruction block + glossary
  excerpt (matched terms only, capped at 60), optional read-only section
  headings in a parallel `sections` map, and strings grouped by i18n directory
  (`files`) so multi-i18n-folder mods stay unambiguous (SPEC §11). Instructions
  require exact quote-character preservation: straight quotes/apostrophes must
  never be converted to typographic quotation marks. German batches additionally
  request Stardew-like simple, direct phrasing and forbid newly invented dash
  asides (`—`, `–`, or spaced `-`); existing or linguistically required
  hyphens remain allowed.

### Issue 14: Import external LLM result JSON ✅

- Toolbar **"Import batch…"** (file picker, lenient JSON parse for LLM
  artifacts), per-directory key matching, all accepted values staged as
  `review-needed` in **one** atomic state write (`save_many`), table reload +
  fresh counts, summary dialog. Safety: `translated` strings are never
  overwritten (stale-batch protection, skipped + counted);
  dropped-token and identical-to-source values are imported but flagged; a
  batch file translated in place is accepted like a result file.

## Status (shipped vs. open)

**Complete.** Both issues shipped together: the batch exporter (context menu →
save dialog) and the result importer (toolbar → summary). Core logic lives in
`src-tauri/src/batch.rs` (`build_batch` / `apply_batch`, both pure and
unit-tested); dialogs in `src/llm-batch/LlmBatchDialog.tsx`. The drag-and-drop
import variant from SPEC §11 was skipped (the toolbar button covers the flow;
revisit only on demand). The v1.5 follow-up is also delivered: section headings
from standalone `//` comments are exported as read-only context without
changing the import-compatible `files` structure.

## Agent Handoff Notes

_The exported file contains the instruction block inline (`instructions`), so
the user can upload the whole file to any file-capable LLM. The export dialog
documents the complete upload → prompt → download → import → review workflow.
New files use `…-llm-batch` / `…-llm-result`; import also accepts the legacy
`…-claude-batch` / `…-claude-result` markers. Reuse `batch::apply_batch` for
any future import path — it enforces the never-overwrite-manual-work rule and
the flag-don't-reject validation._
