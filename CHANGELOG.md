# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Per-release notes also live under [`docs/release/`](docs/release/).

## [Unreleased]

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
- Short localized **Translation Notes** generated from verified package,
  language, coverage, and installation details.
- Native startup guidance with the official Microsoft download link when the
  WebView2 Runtime is unavailable.

### Changed

- Related export and import actions are grouped into compact toolbar menus,
  while **Translation Notes** and **Settings** remain clearly separated.
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

[Unreleased]: https://github.com/Nana1873/stardew-i18n-translator/compare/v2.0.2...HEAD
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
