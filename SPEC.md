# Stardew i18n Translator — Product Reference

This document describes the durable behavior of the current application. It is
not a roadmap, release checklist, or issue tracker. Planned work belongs in
GitHub Issues.

## 1. Product Goal

Stardew i18n Translator is a portable Windows desktop app for translating
Stardew Valley and SMAPI mod localization files.

The app helps a translator scan installed mods, import existing work, edit and
review strings safely, and export valid target-language files without manually
working through large JSON documents.

## 2. Target Users

The primary users are mod translators, mod authors reviewing translations, and
players translating mods for personal use. The normal workflow must not require
Git, command-line tools, or knowledge of the app's internal data model.

## 3. Core Workflow

The durable product loop is:

1. Select or auto-detect the Stardew Valley and Mods folders.
2. Select a target language.
3. Scan mods and import available target-language files.
4. Browse, search, filter, edit, and review strings.
5. Validate protected Stardew and SMAPI tokens.
6. Export target-language `i18n` files or a translation package ZIP.

Glossary and AI features are optional additions to this loop. They must never
be required for ordinary translation and export. Manual translation and all
local-only workflows remain available without contacting a cloud service.

## 4. Setup and Languages

Setup stores the Stardew Valley folder, Mods folder, target language, and
non-secret AI preferences in the portable `data/` folder.

The source language is the mod's `i18n/default.json`, normally English.

Built-in Stardew target languages:

- German (`de`)
- Spanish (`es`)
- French (`fr`)
- Hungarian (`hu`)
- Italian (`it`)
- Japanese (`ja`)
- Korean (`ko`)
- Portuguese (`pt`)
- Russian (`ru`)
- Turkish (`tr`)
- Chinese (`zh`)

Curated custom-language targets:

- Vietnamese (`vi`)
- Indonesian (`id`)
- Ukrainian (`uk`)
- Polish (`pl`)
- Finnish (`fi`)
- Dutch (`nl`)
- Czech (`cs`)
- Thai (`th`)

Custom-language targets can be translated and exported normally, but Stardew
requires a matching custom-language mod before those files can be used in-game.

## 5. Glossary

The glossary provides high-confidence Stardew terms such as items, tools,
weapons, clothing, NPCs, locations, and seasons. It does not translate normal
prose.

For built-in game languages, the app reads glossary-relevant local
`Content/Strings/*.xnb` dictionaries. A compatible
`Content (unpacked)/Strings/*.json` folder remains a fallback.

For custom-language targets, an installed Content Patcher language pack may
supply glossary terms from its local `Strings` JSON or XNB dictionaries. Pack
inspection is read-only and narrowly limited to language registration and
string assets.

Glossaries are optional, stored per language in
`data/glossary/glossary-<lang>.json`, and never bundled with the app.

## 6. Mod Scan and Import

The scanner recursively finds mod manifests and nearby `i18n` folders. It:

- reads `manifest.json` metadata;
- groups components that belong to the same installed package;
- uses `default.json` as the source key inventory;
- imports the selected target-language file when present;
- accepts the relaxed JSON commonly found in real mods;
- requires source and existing target files to be flat string objects;
- silently ignores Content Patcher data under `assets/i18n`, which is not a
  standard SMAPI translation target;
- preserves source key order for later export;
- compares the decoded English source inventory with the preceding successful
  scan of the same Mods folder and reports changed, added, and removed strings;
- does not traverse links that escape the selected Mods folder;
- warns and skips only a malformed i18n component instead of inventing empty
  rows or stopping the complete scan.

A filesystem traversal error or reached traversal limit makes source-change
comparison unavailable and leaves the preceding complete baseline untouched.
Intentional exclusions such as outside-root links and Content Patcher
`assets/i18n` data do not make an otherwise successful scan incomplete.

A positive `Nexus:<id>` update key may be shown as an external link. Sentinel
values such as `Nexus:-1` are treated as no Nexus ID.

Source comparison uses component UniqueID, relative i18n directory, and exact
key as the stable identity. The first scan of a Mods folder creates the
baseline and therefore reports zero observed changes. The snapshot contains
hashes only; target-language changes do not affect it.

## 7. User Interface

The application has a dashboard home and a two-panel work view:

- the left side lists scanned packages and component mods;
- the right side shows the selected mod's strings;
- search, status filters, review queues, bulk actions, and keyboard navigation
  support large translation sets;
- Settings contains folders, language, glossary, AI backends, shortcuts,
  logging, and app information;
- the five latest completed backend operations, including exports, imports,
  LLM batches, AI runs, ZIP builds, and batch edits, remain available in a
  compact in-session result tray;
- the latest batch edit has one in-memory undo snapshot until a newer operation
  replaces it, and stale undo must never overwrite later string edits.

The UI should remain a focused translation tool rather than a general workspace
or project-management suite.

## 8. Editing Workflow

Strings can be edited in the table workflow and the full string editor. The app
supports manual translation, bulk actions, review navigation, and a
**Keep original** action that intentionally stores the source text as the target
text.

Saving work updates the portable translation state. Export remains an explicit
user action.

## 9. Translation Status

The app uses four string states:

- `untranslated`: no accepted target text;
- `translated`: manually saved or explicitly accepted;
- `outdated`: the source changed after the saved translation;
- `review-needed`: imported or generated AI output, including the result of AI
  review and terminology repair, that still needs human review.

**Keep original** is an action, not a fifth status.

## 10. Validation

Validation protects runtime-sensitive SMAPI, Content Patcher, dialogue, mail,
placeholder, and formatting tokens.

Token errors identify missing or added protected values and block export by
default. When a translator explicitly chooses **Save anyway** for a string, the
accepted mismatch no longer blocks direct export or translation-package ZIPs.
The acceptance applies only to that saved source revision; editing the target
or a changed English source requires confirmation again. Review warnings, such
as punctuation or newline differences, do not block export.

Untranslated strings do not block export. They are omitted so SMAPI can fall
back to `default.json`.

Before direct export confirmation, the backend performs a read-only preflight
over the complete selected mod or all-mod scope. It reports the first real
blocking key and the number of exact-source mismatch acceptances without
creating target, backup, temporary, or operation-history entries. The export
command freshly resolves each component UniqueID and its current i18n files,
then repeats path authorization and complete validation immediately before
writing; WebView paths, display names, and the preflight result are not
authorization tokens.

## 11. External LLM Batch

The app can export a self-contained JSON batch for a file-capable external LLM
and import the completed result.

The desktop app does not contact that service. The user transfers the file
manually. Imported values enter `review-needed`, validation runs immediately,
and already accepted local translations are not silently overwritten.

Batch format 2 contains only `format`, `version`, `metadata`, and `files`.
Metadata binds the selected mod ID and target language to one SHA-256 snapshot
over the sorted `[relative file path, key, English source]` list. It does not
carry per-string hashes. Import requires the same mod, language, file/key set,
and current English source snapshot, validates all protected tokens before the
first state write, skips empty values, and preserves every non-empty local
translation. Format 1 and unknown versions are rejected without changes.

## 12. Nexus and Translation Packages

The desktop app does not call the Nexus Mods API, store a Nexus API key, search
for translations, or download mods.

It may display a browser link derived from a mod's positive Nexus update key.

For sharing completed work, the app can build an installable translation ZIP
containing only generated target-language `i18n` files while preserving the
package's component folder structure. It can also generate short localized
publication notes from the same package data.

## 13. Supported Files

Translation, editing, import, and export support:

- `<mod>/i18n/default.json`
- `<mod>/i18n/<lang>.json`

The app is not a general parser or editor for `content.json`, arbitrary
`Data/*.json`, dialogue files outside SMAPI i18n, or arbitrary XNB files.

The glossary sources in section 5 are the only narrow read-only exception.

## 14. Data and Persistence

All application state is portable and stored beside the executable:

- `data/settings.json`
- `data/scan-source-snapshot.json`
- `data/glossary/glossary-<lang>.json`
- `data/language-state/<lang>/`
- `data/logs/`

Dashboard recency is part of the portable settings state; the app does not keep
workflow state in browser-local storage.

Result-tray history is bounded to five completed backend operations for the
running app session. Its single batch-undo snapshot is also memory-only; it is
not a hidden project log and is never written to portable state. Any later
successful edit to a touched component makes that snapshot permanently stale,
even when the edited value is changed back to the batch-written value.

Codex CLI authentication remains owned by the CLI; the app does not read, copy,
or persist its authentication files or tokens.

Translation state is separate from installed mods. The app does not modify mod
files until the user explicitly exports.

Windows-safe mod UniqueIDs retain their readable state filename. IDs that
cannot be represented without loss use `state-<sha256>.json`; a unique valid
legacy file is copied forward and retained, while ambiguous legacy collisions
and case-insensitive duplicate IDs are blocked from editing.

Exports validate and serialize the complete selected mod and prepare rollback
copies before the first write. Each file still uses a user-visible backup and
atomic replacement; if a later package write fails, every earlier target is
restored to its pre-export state. Portuguese imports prefer `pt-BR.json`, while
successful exports canonicalize to `pt.json` and back up/remove the fallback.
Release packages must not contain the user's `data/` folder.

## 15. Current Capabilities

The maintained product includes:

- setup and Stardew path detection;
- recursive mod scanning and package grouping;
- existing translation import;
- a virtualized string table and editor;
- search, filters, review queues, and bulk actions;
- protected-token validation;
- optional typed glossary hints;
- optional AI translation through a localhost endpoint or Codex CLI;
- external LLM batch export and import;
- target-file export with backups;
- translation package ZIP creation;
- localized translation notes;
- portable settings, progress, and logs.

This section records product behavior only. Release status and future work are
tracked outside this document.

## 16. Non-Goals

Unless a current user request explicitly changes the product direction, the app
does not provide:

- mod installation, activation, updating, profiles, or load-order management;
- automatic translation discovery or downloads;
- persisted cloud AI credentials, an AI provider marketplace or registry, or
  configurable custom cloud base URLs;
- Nexus API operations;
- internal Git repositories or project files;
- a general Content Patcher interpreter;
- arbitrary JSON or XNB editing;
- automatic publishing of translation mods from inside the desktop app.

## 17. Optional AI Backends

AI translation is optional. Manual translation and every local-only workflow
remain offline and usable when an AI backend is unavailable.

Local AI connects only to a user-configured localhost OpenAI-compatible
endpoint, such as Ollama or LM Studio.

The Codex CLI backend invokes an installed CLI and relies exclusively on that
CLI's own authentication. The app does not inspect, import, copy, or persist
Codex authentication files or tokens. Settings discovers the models currently
reported by the installed CLI and persists only the selected model id. The app
does not maintain its own Codex model catalogue. If discovery is unavailable or
no model has been selected, runs use the CLI's own default model.

An AI request sends the source text, its section context, and matching glossary
terms to the selected backend. A Codex translation run first produces an
initial draft. Every draft then receives a full AI review that corrects issues
in source meaning, natural phrasing in the target language, terminology,
grammar, register, speaker voice, and dialogue continuity; review is not
restricted to strings with token or glossary warnings. The review prompt still
contains every scheduled draft, but its structured response returns only
corrections; an omitted ID retains its existing draft. Only after that full
review, reviewed results with a conservatively detected glossary or terminology
candidate receive exactly one focused repair pass. The focused pass may retain
contextually correct inflections or compounds unchanged. No terminology repair
pass runs without such a candidate.

Codex groups contiguous selected strings into adaptive chunks of at most 100
items and additionally bounds the complete serialized prompt. Read-only
neighboring sources are pooled once per prompt and referenced in source order;
this representation must preserve the same section, glossary, and before/after
context as the unpooled request. A single long source may occupy its own chunk.

Each stage accepts only structurally valid output. A failed or oversized full
review leaves the affected chunk incomplete so it can be retried. If the
optional focused repair fails or returns unusable output, the fully reviewed
text is retained. Suggestions from each fully completed adaptive chunk are
saved together immediately as `review-needed`, including results that passed
both AI quality stages. Cancellation or a later provider error retains
previously completed chunks; the current in-flight chunk remains available for
a later retry. Token validation and human review remain the final safety gates.
Each CLI attempt has a five-minute ceiling. One transient failure may be
retried, and an invalid structured response gets one corrected attempt before
only that batch is halved until a failing string is isolated.

The running UI reports the real persisted-to-Review count, current quality
phase, adaptive outer batch, elapsed time, bounded retry/split activity, and
Codex-reported token usage when available. Whitelisted Codex JSONL activity
stages are forwarded while the subprocess is still running, and the UI shows
how long ago the latest stage arrived. Once at least one suggestion has been
persisted, remaining time is estimated from completed-string checkpoints and
kept stable until more work is saved. Raw CLI messages, reasoning text,
commands, paths, IDs, and errors are never forwarded. The app must not fabricate
within-call completion percentages.

When local diagnostic logging is enabled, AI runs emit bounded structured
metadata for run and batch starts/finishes, phases, durations, retries, splits,
cancellation, fixed outcome categories, and reported token totals. AI
diagnostics never include prompts, sources, translations, context/glossary
content, mod/string/file identities, target language, base URLs,
authentication data, raw stdout/stderr, executable or temporary paths, or raw
provider errors. Logging remains local, rotating, optional, and never creates
telemetry.

These are direct integrations. The product does not provide a provider
marketplace, provider registry, or configurable custom cloud base URL.

## 18. Technical Constraints

- Supported distribution: unsigned 64-bit portable Windows ZIP.
- Desktop stack: Tauri 2, Rust, React, TypeScript, and Vite.
- Runtime dependency: Microsoft Edge WebView2.
- Large mods require virtualized rendering and efficient scanning.
- Unicode, JSON key order, protected tokens, and package-relative paths must be
  preserved.
- Full-buffer JSON and state inputs must be size-bounded before parsing.
- File-system failures must be reported without leaving partial exports.
- Optional systems such as glossary, AI backends, logging, and Nexus publication
  automation must degrade without breaking the translation workflow.

## 19. Simplicity Principles

- Solve the current user problem before designing for hypothetical future use.
- Prefer existing modules and direct code over frameworks or provider layers.
- Add abstractions only after repeated concrete duplication makes them useful.
- Keep UI actions tied to the translation workflow.
- Keep documentation concise and current; do not mirror milestones or issue
  checklists in repository files.
- Use GitHub Issues for active planning and `CHANGELOG.md` plus release notes for
  release history.
