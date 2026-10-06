# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Per-release notes also live under [`docs/release/`](docs/release/).

## [Unreleased]

## [2.3.0] - 2026-10-06

### Added

- **Enter model ID…** in ChatGPT settings. Enter an exact model ID such as
  `gpt-6.1-sol`, including models missing from the account's model list. Manual
  entry remains available while that list loads or when discovery fails.
- Parallel ChatGPT translation batches. **Parallel batches** offers 1, 2, 4, 6,
  or 8 concurrent batches, with four by default. Each batch completes its selected
  quality checks; repeated temporary errors reduce parallelism for that run.
- A workspace **Activity log** for scans, manual saves, explicit token-mismatch
  acceptances, batch edits, imports, exports, and AI results. Consecutive manual
  saves in the same mod are grouped, with dividers between operations.
- AI batch activity in the shared log: preparation, draft translation, quality
  review, terminology checks, token repair, retries, batch splits, and saved
  suggestions. Active-step indicators follow each batch and respect reduced
  motion settings.
- Activity log controls to expand, collapse, resize by mouse or keyboard, and
  **Copy log**. Scrolling up pauses automatic following; **Latest entries**
  returns to new entries.
- **Details** links from the log to operation results and the latest scan report.
  Older operation details remain accessible after leaving the five-result
  history; expired Undo actions are not restored.
- A bounded session log retaining up to 500 entries and protecting up to 100
  recent warnings/errors from routine progress. An omission notice reports when
  older entries are removed.
- Editable **Install folder** values in selected-mod and all-mod ZIP previews.
  Changing a component's folder updates its archive paths before export;
  invalid folders and path collisions block ZIP creation.
- Intentionally blank translations: saving exactly one normal space marks a
  nonblank source as Done and leaves its translation cell visually blank. For
  example, `"Tree": " "` suppresses an unwanted suffix. The space survives scans,
  restarts, JSON export, and both ZIP exports. Clearing it reopens the entry;
  later English source changes mark it Changed. Token validation still applies.

### Changed

- AI progress is a non-modal workspace notice, so editing can continue during a
  run. It shows the engine, mod scope, current activity, and cancellation control.
- **Saved to Review** and its progress bar count persisted suggestions only.
  Receiving a draft or finishing a provider request does not count as a save.
  Completed results expose available engine, model, reasoning, and token usage.
- The **Export…** menu is now **Files…**, with separate actions for JSON export
  into installed Mods folders and selected-mod/all-mod ZIPs for sharing.
- Result notices stack above the Activity log and show counts, failure causes,
  and actions such as **Open string**, **Open Review**, **Open folder**, and
  **Details**. Detailed export and ZIP previews remain available.
- **Issues** is now a separate view across Open, Changed, Review, and Done,
  preserving the current mod scope and search. Selecting a workflow status
  leaves Issues.
- Validation uses yellow warning triangles and red error circles, with tooltips
  explaining whether export is allowed. Explicitly accepted token mismatches
  stay visible as non-blocking warnings without changing a Done entry's status.
- Context and selection actions are grouped into compact menus; individual rows
  use an ellipsis action menu. Editor copy tools sit beside their text fields,
  with save/approval actions and token/glossary hints arranged consistently.
- ChatGPT settings prefill `gpt-6.1-sol` when no model is saved.
- Updated the Windows app icon, About panel, and browser sign-in confirmation
  page. The browser page directs users to **Continue in the app**, where the
  actual sign-in status is shown.
- ChatGPT draft and quality-review requests now include each string's key as
  additional context alongside its English source, section, and neighboring text.
- AI instructions distinguish enclosing quotation marks from apostrophes in
  possessives and contractions. Apostrophes can follow target-language grammar
  while the source's enclosing quotation style is preserved.

### Fixed

- Fixed incorrect ZIP export paths from the previous release that could break
  installation in Vortex and Mod Organizer 2. Default installation folders now
  use the component's manifest folder, excluding outer local staging folders.
- Preserve valid leading spaces in default and manually edited ZIP installation
  folders instead of silently changing the recipient's folder name.
- Saved or manually entered ChatGPT models are no longer silently replaced when
  missing from the account's model list, including after discovery errors/retries.
- Trim manually entered model IDs before saving and checking a known model's
  supported reasoning levels, so surrounding spaces cannot bypass those limits.
- Background AI updates no longer discard unsaved editor text or steal focus.
  A changed saved translation preserves the current draft until the user saves it.
- If English source text changes while editing, preserve the draft and require
  **Use updated source** before saving or continuing. Any token-mismatch
  acceptance must be checked again against the new source.
- Late saves, approvals, and out-of-order refresh responses no longer change a
  newer editor selection or overwrite its displayed state.
- Batch Undo stays tied to its original target language. Switching languages
  removes the invalid Undo action and cannot restore work into another language.
- An AI run keeps its original selection, engine, language, and Mods folder while
  other mods load or workspace settings change. Completion cannot replace a new
  workspace's strings; **Open Review** returns only to the run's own workspace.
- Cancelling before AI startup no longer launches a backend run. A failed
  cancellation request can be retried, and confirmed cancellation retains saved
  suggestions and the actual partial result.
- Scanning refreshes translations and validation findings even when the file
  paths are unchanged. Export/ZIP problems can open the exact affected string
  outside the current filtered scan view.
- Translations for blank English strings are preserved in JSON, selected-mod ZIPs,
  and all-mod ZIPs instead of disappearing from the combined archive.
- Local AI keeps leading/trailing spaces and line breaks through response parsing
  and saving to Review.
- Safely decode one layer of unambiguous JSON-quoted Local AI text, retaining real
  quotation marks, line breaks, backslashes, and protected tokens. Ambiguous
  responses remain unchanged for review.
- Local AI token repair now handles unexpected and duplicated tokens as well as
  missing ones. A retry replaces the first draft only when token counts improve
  without worsening another token; unresolved differences remain in Review.
- Community glossary extraction rejects linked files and folders outside the
  selected language-pack root, including fallback folder discovery.
- Glossary status, results, and errors from an earlier game folder or target
  language no longer appear after changing those settings.
- Keyboard navigation in dialogs includes expandable **Details** headings and
  skips their closed contents, hidden controls, and disabled controls.

### Removed

- The Overview page. The app now opens directly in the workspace after setup.

### Development

- Automated Nexus uploads now include the published GitHub release notes in the
  version changelog. A manual changelog-only option can add missing notes without
  uploading the portable ZIP again; drafts and prereleases remain blocked.
- Consolidated CI into four jobs, sharing Node dependency setup between
  documentation and frontend checks while retaining the required CI gate.
- Added an opt-in parallel ChatGPT comparison probe and expanded native desktop
  regression coverage for AI progress, editor refresh races, intentional spaces,
  ZIP installation paths, and portable upgrades.

## [2.2.0] - 2026-10-01

### Added

- Sign in with ChatGPT directly from the app, with account model discovery,
  reasoning controls, usage access, and an encrypted renewable Windows session.

### Changed

- Fit string columns to the available space, keep mod and file context under the
  key in narrow windows, and provide a control to reset manual column widths.
- Simplify settings, scan results, AI progress and export previews. Distinguish
  translation coverage from completed reviews.
- Preserve the source's tone, humor, emotional intent, and character voice across
  all AI translation languages and quality review.
- Reduce repeated file reads while saving AI suggestions and key lookups during
  batch import.

### Fixed

- Scan automatically after initial setup and after changing workspace settings
  through setup, while cancellation preserves the current workspace.
- Run Export again through a fresh preview and confirmation, including current
  validation, instead of repeating a previous write directly.
- Keep Escape and Tab available for keyboard navigation during shortcut capture.
- Preserve valid AI drafts and their quality-review warning when a review fails.
- Prevent simultaneous app instances from writing the same portable profile.
  Show damaged-settings recovery and incomplete ChatGPT sign-out warnings.
- Recheck the current package inventory before building a combined output ZIP.

### Removed

- The separately installed Codex CLI translation backend, replaced by native
  Sign in with ChatGPT.
- Translation Notes, including the menu, dialog and generated publication text.

## [2.1.0] - 2026-09-07

### Added

- Translation ZIP · all mods combines existing local translations and saved
  edits from all scanned mods into one locale-only ZIP.
- Scan, edit and export split locale folders such as `i18n/default/Dialogue.json`
  and `i18n/de/Dialogue.json`, including new language folders and obsolete keys.

### Changed

- Blank source/target pairs count as complete without a saved approval and reopen
  when source text is added. Progress reaches 100% only at exact completion.
- Keep unmatched translation keys in optional scan details without interrupting
  clean startup scans.
- Record operation IDs, durations, outcomes and counts for scan, string loading,
  import and export diagnostics, including failures during preparation.
- Reuse validation and search data for unchanged editor rows and calculate mod
  counts in one pass. Run string loading and export operations asynchronously
  to keep the interface responsive during native file work.
- Reorganized user and contributor documentation, including clearer portable
  update instructions and release preparation steps.

### Fixed

- Preserve runtime lookup keys while allowing translatable prose in supported
  dialogue commands, using matching frontend and backend token checks.
- Prevent delayed string loads from replacing newer manual edits, retain pending
  workspace settings during exports, and keep ZIP previews and result history
  bound to the correct operation.
- Treat split document filenames literally so names such as `pt.json` cannot
  trigger Portuguese locale migration or remove another split document.
- Portable packaging and release preflight now reject executables with a
  missing or mismatched embedded product version.

## [2.0.3] - 2026-09-03

### Fixed

- Malformed `#$b$...` and `#$b*` dialogue sequences no longer turn following
  prose into protected tokens.
- A valid target-language-only gender-switch shape no longer triggers an
  added-token error by itself, and harmless extra spaces in `$r` response
  commands are normalized.
- Removed the noisy quote-delimiter count warning; localized quote punctuation
  is now ignored.
- Source-identical translations no longer produce a validation warning, matching
  the intentional **Keep original** workflow.
- Removed the noisy physical line-break count warning; translated text can
  rewrap without appearing under **Validation issues**.

## [2.0.2] - 2026-09-02

### Fixed

- Codex CLI installations created by the official Windows installer are now
  detected even when the app process has not inherited the updated `PATH`.

## [2.0.1] - 2026-09-01

### Fixed

- Bracketed translation text such as `[Right]`, `[LEFT]`, and status messages
  is no longer mistaken for a protected token, while real Stardew token forms
  remain protected.
- Gender-switch branch text inside `${...}$` can now be translated while its
  delimiter structure and nested runtime tokens remain validated.

## [2.0.0] - 2026-08-30

### Added

- Added direct Codex CLI translation through the installed CLI and its existing
  sign-in, with model discovery and usage status when available, a configurable
  reasoning level, context-aware adaptive batches, live progress, cancellation,
  and Review-only results.
- Added optional Codex quality review and repair stages for meaning, natural
  language, terminology, grammar, register, speaker voice, dialogue continuity,
  and protected tokens. They can be disabled for a faster, lower-token first
  draft.
- Added scan-to-scan English source change counts and a compact five-result
  session history with **Latest result**, copyable details, follow-up actions,
  and one safe batch undo.

### Changed

- Redesigned the Windows interface around Overview and the two-panel Workspace,
  using real backend data throughout with multi-select, batch actions,
  resizable sortable columns, context menus, dialogs, and portable view state.
- Scan summaries now distinguish expected community-language-pack exclusions,
  unused target keys, and components that genuinely need attention. Incomplete
  scans preserve the last complete source baseline.
- Local AI now saves successful suggestions immediately in Review, continues
  after item-specific failures, and reports partial success clearly.
- Hybrid Qwen3 models in LM Studio now use non-thinking response mode
  automatically.
- External LLM import now preserves existing work and rejects stale or
  mismatched batches before applying suggestions.
- Direct export now uses read-only preflight data, revalidates the exact current
  scope before writing, and rolls back incomplete multi-file writes.

### Fixed

- Bounded scanner, JSON, AI, import, and export inputs; moved long scans off the
  UI thread; and restored earlier target files when a later export write fails.
- Corrected Portuguese fallback handling, glossary matching and isolation,
  portable recent-mod activity, and target-file status after export.
- Stopped expected community-language-pack exclusions from producing
  warning-level skipped-component diagnostics.

See [docs/release/v2.0.0.md](docs/release/v2.0.0.md) for the release summary.

## [1.4.3] - 2026-08-03

### Changed

- Translators can explicitly choose **Save anyway** for an individual string
  with protected-token errors. Each accepted mismatch is remembered for the
  current source revision and no longer blocks direct export or translation ZIP
  creation; all unaccepted mismatches remain blocking.

## [1.4.2] - 2026-07-29

### Changed

- External LLM exports now use the compact batch format 2. One source snapshot
  binds the selected mod, target language, file/key set, and current English
  text without adding hashes to individual translation values. Format 1 is no
  longer accepted.
- Translation sources and targets are parsed completely before export. Invalid
  components are isolated during scans, while direct exports and release ZIPs
  stop before changing files.
- Portuguese imports prefer `pt-BR.json`, while successful export remains
  canonical `pt.json` and safely backs up/removes the fallback file.

### Fixed

- Hardened language, local-AI URL/response, JSON, state-file, and XNB input
  boundaries so unsafe or oversized input fails without partial writes or large
  allocations.
- Preserved existing local translations during LLM import, prevented stale AI
  and model responses from replacing newer UI state, and delayed navigation
  until settings/editor persistence succeeds.
- Prevented ambiguous translation-state filename collisions and kept outdated
  AI text out of the review-needed count.
- Kept successful Export All results visible when a later mod fails, including
  the failed mod and the not-yet-started remainder.
- Completed keyboard navigation for Settings, mod rows, and virtualized string
  rows, and replaced undefined CSS color variables with checked semantic tokens.

### Security

- Updated vulnerable Rust dependencies, pinned the Nexus upload action to an
  immutable commit, and added recurring/manual Rust advisory checks.

See [docs/release/v1.4.2.md](docs/release/v1.4.2.md) for the full notes.

## [1.4.1] - 2026-06-19

### Added

- Vietnamese (`vi`), Indonesian (`id`), Ukrainian (`uk`), Polish (`pl`),
  Finnish (`fi`), Dutch (`nl`), and Czech (`cs`) are now selectable curated
  custom-language targets. They use the same SMAPI `i18n/<code>.json` workflow
  as the existing languages, including scan/import, saved edits, export,
  external LLM batches, and local-AI prompts.
- Glossary building now reads Stardew `Content/Strings/*.xnb` dictionaries
  directly for built-in game languages, with the previous
  `Content (unpacked)/Strings/*.json` layout retained as a compatibility
  fallback. Glossary setup remains optional and non-blocking.
- Installed community language packs can now supply glossary terms from either
  JSON `Strings/*.json` files or direct `Strings/*_<lang>.xnb` dictionaries.
  JSON remains preferred when both are present.
- GitHub release publication now includes a Nexus Mods upload workflow that uses
  the already attached portable ZIP after a normal GitHub release is published.

### Changed

- Setup can automatically build a glossary when a readable local game or
  community-pack source is available, while Settings keeps the manual rebuild
  action for game or pack updates.
- Nexus upload release text is shorter and focused on the portable package.

See [docs/release/v1.4.1.md](docs/release/v1.4.1.md) for the full notes.

## [1.4.0] - 2026-06-18

### Changed

- The glossary is now a typed, high-confidence set of official game terms
  (items, craftables, weapons, tools, clothing, NPCs, locations, seasons) rather
  than an untyped name→name map. Each term is extracted only from the matching
  content `Strings/*` asset and key, screened by a strict quality gate that
  excludes prose, descriptions, UI commands, and format strings, so editor hints
  and local-AI prompts no longer pick up borderline non-terms. Editor hints now
  show each term's category, and the longest matching term wins on overlap
  (`Iridium Ore` over `Ore`). Glossary caches from earlier versions are ignored
  and the UI recommends a one-click rebuild.
- The glossary is now cached per language (`data/glossary/glossary-<lang>.json`).
  Switching the target language loads that language's own glossary, so hints, the
  local-AI prompt, and batch exports never carry another language's official
  terms — and a game-unsupported language (e.g. Thai) simply gets none. A
  previously built language keeps its cache, so switching back needs no rebuild;
  older cache layouts are migrated automatically.
- The portable application-state folder created beside the executable is now
  named `data/` (previously `Data/`). On Windows this is the same folder, so
  existing installs keep working; settings, glossary, and translation state are
  unaffected.
- Installed community language packs are excluded from the scanned mod list (with
  a scan note) instead of appearing as bogus translation targets — a language pack
  is a translation, not something to translate.

### Added

- Thai (`th`) as a selectable target language. Stardew has no native Thai
  content, so it targets a custom-language mod (SV 1.6 `Data/AdditionalLanguages`)
  and has no official glossary; translation, export (`th.json`), batch, and
  local-AI all work, and the glossary build is disabled for it with an
  explanatory note. Languages the game does not ship are now distinguished by a
  data-driven `gameLocale` property, so future custom-language targets are a
  single list entry.
- Glossary building for a game-unsupported language from an installed community
  Content Patcher language pack. When a pack registers the target language
  (`Data/AdditionalLanguages`), the app pairs its bundled `Strings/*` with the
  English base to build a typed glossary cached as
  `data/glossary/glossary-<lang>.json`; untranslated terms are dropped and the
  provenance pack name is shown. Read-only, local, and never redistributed. With
  no pack, the language still gets no glossary. The same mechanism works for any
  future unsupported language with no extra code.

See [docs/release/v1.4.0.md](docs/release/v1.4.0.md) for the full notes.

## [1.3.0] - 2026-06-15

### Added

- Persistent result tray for export, external-LLM batch, import, and release ZIP
  outcomes without blocking the translation workspace.
- Installable translation ZIP creation that preserves the selected mod
  package's folder structure.
- Native startup guidance with the official Microsoft download link when the
  WebView2 Runtime is unavailable.

### Changed

- Related export and import actions are grouped into compact toolbar menus.
- External-LLM batch exports show the complete four-step handoff and an exact
  copyable prompt in the result tray.

See [docs/release/v1.3.0.md](docs/release/v1.3.0.md) for the full notes.

## [1.2.3] - 2026-06-14

### Changed

- Quote-delimiter differences now produce a review warning instead of blocking
  export or triggering a local-AI retry.
- GitHub Actions now runs the complete frontend and Windows Rust suite once on
  the exact `main` commit. Release drafts upload the locally verified portable
  ZIP instead of rebuilding it on a paid Windows runner.

### Fixed

- Settings writes are now atomic and keep the last valid configuration as
  `Data/settings.json.bak`; a corrupt main file recovers from that backup
  instead of silently resetting.
- Bulk **Mark as translated** no longer gives empty rows a translated status,
  keeping row status, progress counts, rescans, and export behavior consistent.
- Restored global string search across all scanned mods, including mod/file
  context and a direct return path from per-mod results.

See [docs/release/v1.2.3.md](docs/release/v1.2.3.md) for the full notes.

## [1.2.2] - 2026-06-14

### Added

- Added an **Open Mods Folder** action to the mod-list context menu.

### Changed

- Removed inline table editing so all translation edits use the validated
  String Editor dialog.
- Removed the unreliable Nexus browser-search stopgap; broader Nexus
  integration is deferred indefinitely with no target release.
- The toolbar string search is now shown only while a mod is open.
- Active planning and release scope are now tracked through GitHub Issues and
  Milestones instead of duplicated repository task-plan documents.
- CI now verifies synchronized version references and repository-local
  Markdown links, while PR labels drive documentation policy and generated
  release notes.

See [docs/release/v1.2.2.md](docs/release/v1.2.2.md) for the full notes.

## [1.2.1] - 2026-06-13

### Fixed

- Exporting a mod whose translations were **all cleared** now removes the stale
  `i18n/<lang>.json` (after a `.bak` backup) instead of leaving the old
  translation on disk, so SMAPI cleanly falls back to English.
- Scanning now **warns when two mods share the same UniqueID** instead of
  silently merging their saved translation progress into one state file. SMAPI
  itself will not load duplicate UniqueIDs, so the warning surfaces a broken or
  duplicated install.
- **Pre-existing translations can now go outdated.** A community `<lang>.json`
  you never edited in the app gains a source-text baseline the first time you
  open the mod, so it is flagged **outdated** when the mod's English source later
  changes. Previously such imported strings stayed "translated" indefinitely.

See [docs/release/v1.2.1.md](docs/release/v1.2.1.md) for the full notes.

## [1.2.0] - 2026-06-13

### Added

- An **Optional cleanup** section for unused keys that exist only in an old
  target-language file. It explains that SMAPI ignores them and lists the mod,
  file, and key without affecting progress or blocking export.
- A **Settings → About** switch for enabling or disabling rotating local
  diagnostic logs.

### Changed

- Diagnostic logging remains enabled by default for existing and new portable
  installations, but the preference is now stored locally in
  `Data/settings.json`.
- Nexus translation discovery and download are assigned to the separate v1.3
  milestone.

See [docs/release/v1.2.0.md](docs/release/v1.2.0.md) for the full notes.

## [1.1.1] - 2026-06-13

### Added

- Local diagnostic logging: a rotating, size-capped log file under `Data/logs/`
  captures backend and frontend errors so they can be attached to a bug report.
- **Settings → About → Open logs folder** button.

### Notes

- Logging is fully local — no network sink, no telemetry. The log may contain
  local folder paths; remove anything private before sharing.

See [docs/release/v1.1.1.md](docs/release/v1.1.1.md) for the full notes.

## [1.1.0] - 2026-06-13

Faster editing, safer exports, and verified multilingual workflows, while
keeping the app fully portable.

### Added

- Inline editing for short, single-line translations directly in the table.
- Configurable keyboard shortcuts with conflict detection and reset to defaults.
- Drag-and-drop import for external LLM batch-result JSON files.
- An About page (version, license, author, repository, technology).
- GPL-3.0-or-later licensing metadata.

### Changed

- Saved working translations are isolated by target language under
  `Data/language-state/<code>/translations/`, with a one-time migration of
  existing `Data/translations/` state into the upgrade language.
- A complete mod export is now blocked before any file or backup is written when
  protected-token counts differ.
- Verified scan/edit/batch/export across all 11 advertised target languages,
  including Portuguese `pt-BR.json` import with canonical `pt.json` export.
- Updated README and screenshots; improved CI and release build times.

See [docs/release/v1.1.0.md](docs/release/v1.1.0.md) for the full notes.

## [1.0.1] - 2026

Maintenance fixes following the initial release.

## [1.0.0] - 2026

Initial portable Windows release: mod scanning, the string table/editor with
validation, protected-token handling, local-AI translation, external LLM batch
export/import, optional glossary, and clean UTF-8 `i18n` export with backups.

[Unreleased]: https://github.com/Nana1873/stardew-i18n-translator/compare/v2.3.0...HEAD
[2.3.0]: https://github.com/Nana1873/stardew-i18n-translator/compare/v2.2.0...v2.3.0
[2.2.0]: https://github.com/Nana1873/stardew-i18n-translator/compare/v2.1.0...v2.2.0
[2.1.0]: https://github.com/Nana1873/stardew-i18n-translator/compare/v2.0.3...v2.1.0
[2.0.3]: https://github.com/Nana1873/stardew-i18n-translator/compare/v2.0.2...v2.0.3
[2.0.2]: https://github.com/Nana1873/stardew-i18n-translator/compare/v2.0.1...v2.0.2
[2.0.1]: https://github.com/Nana1873/stardew-i18n-translator/compare/v2.0.0...v2.0.1
[2.0.0]: https://github.com/Nana1873/stardew-i18n-translator/compare/v1.4.3...v2.0.0
[1.4.3]: https://github.com/Nana1873/stardew-i18n-translator/compare/v1.4.2...v1.4.3
[1.4.2]: https://github.com/Nana1873/stardew-i18n-translator/compare/v1.4.1...v1.4.2
[1.4.1]: https://github.com/Nana1873/stardew-i18n-translator/compare/v1.4.0...v1.4.1
[1.4.0]: https://github.com/Nana1873/stardew-i18n-translator/compare/v1.3.0...v1.4.0
[1.3.0]: https://github.com/Nana1873/stardew-i18n-translator/compare/v1.2.3...v1.3.0
[1.2.3]: https://github.com/Nana1873/stardew-i18n-translator/compare/v1.2.2...v1.2.3
[1.2.2]: https://github.com/Nana1873/stardew-i18n-translator/compare/v1.2.1...v1.2.2
[1.2.1]: https://github.com/Nana1873/stardew-i18n-translator/compare/v1.2.0...v1.2.1
[1.2.0]: https://github.com/Nana1873/stardew-i18n-translator/compare/v1.1.1...v1.2.0
[1.1.1]: https://github.com/Nana1873/stardew-i18n-translator/compare/v1.1.0...v1.1.1
[1.1.0]: https://github.com/Nana1873/stardew-i18n-translator/compare/v1.0.1...v1.1.0
[1.0.1]: https://github.com/Nana1873/stardew-i18n-translator/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/Nana1873/stardew-i18n-translator/releases/tag/v1.0.0
